# Hosting @vidcall/server next to a Django app

Django apps are Python — @vidcall/server is a Node component that speaks
plain REST + WebSocket JSON. The recommended pattern is the **sidecar**: run
the component as a tiny Node process next to your Django deployment and let
Django proxy the `/vidcall/` prefix to it (or point clients straight at the
sidecar URL in production behind the same domain).

## 1. Run the sidecar (Node)

```bash
npm install @vidcall/server better-sqlite3
```

```js
// sidecar.mjs
import http from 'node:http';
import {
  attachWebSocketRelay,
  createNodeServer,
  createServices,
  SqliteStore,
} from '@vidcall/server';
import Database from 'better-sqlite3';

const store = new SqliteStore(new Database('/var/lib/vidcall/vidcall.db'));
await store.bootstrap();

const server = createNodeServer(createServices({ store }));
attachWebSocketRelay(server, createServices({ store })); // /ws?roomId=
server.listen(8787, () => console.log('vidcall sidecar on :8787'));
```

Run it with your process manager (systemd unit below).

## 2. Proxy from Django

### Option A — same origin via a reverse proxy (recommended)

Put nginx in front of Django and route `/vidcall/` (and the WS path) to the
sidecar. Clients keep using your domain, so cookies/CORS stay simple.

```nginx
# /etc/nginx/sites-available/vidcall.conf
location /vidcall/ {
    proxy_pass http://127.0.0.1:8787/;          # strip the prefix
    proxy_set_header Host $host;
    proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
}
location /ws {
    proxy_pass http://127.0.0.1:8787;
    proxy_http_version 1.1;
    proxy_set_header Upgrade $http_upgrade;
    proxy_set_header Connection "upgrade";
    proxy_read_timeout 3600s;
}
```

### Option B — Django-side reverse proxy (dev / single process)

```python
# urls.py
from django.urls import re_path
from django.views.decorators.csrf import csrf_exempt
from django.http import HttpResponse
import httpx

VIDCALL_SIDECAR = "http://127.0.0.1:8787"

@csrf_exempt
def vidcall_proxy(request, path):
    """Minimal REST proxy: forward method/headers/body to the sidecar."""
    url = f"{VIDCALL_SIDECAR}/{path}"
    body = request.body
    headers = {k: v for k, v in request.headers.items() if k.lower() not in {"host"}}
    resp = httpx.request(request.method, url, content=body or None, headers=headers)
    return HttpResponse(resp.content, status=resp.status_code,
                        content_type=resp.headers.get("content-type", "application/json"))

urlpatterns = [
    # ... your existing urls ...
    re_path(r"^vidcall/(?P<path>.*)$", vidcall_proxy),
]
```

WebSockets can't be proxied through Django itself — use Option A for the `/ws`
path (or configure Django Channels' `ProtocolTypeRouter` with a websocket
consumer that forwards to the sidecar).

## 3. Auth in Django

Run the sidecar with token auth enabled (a shared HMAC secret + an
`adminToken` that only your backend knows):

```js
// sidecar.mjs
const services = createServices({
  store,
  auth: {
    secret: process.env.VIDCALL_SECRET,
    adminToken: process.env.VIDCALL_ADMIN_TOKEN,
  },
});
const server = createNodeServer(services);
attachWebSocketRelay(server, services);
server.listen(8787);
```

Room routes now require `Authorization: Bearer <token>` (REST) or
`?token=<token>` (WS). Django mints a room-scoped participant token per user
in a view — the `adminToken` header is the server-to-server credential:

```python
# views.py
import httpx
from django.conf import settings
from django.http import JsonResponse

def vidcall_token(request):
    """Mint a room-scoped participant token for request.user."""
    room_id = request.POST.get("room_id")
    if not request.user.is_authenticated:
        return JsonResponse({"error": {"code": "unauthorized"}}, status=401)
    if not request.user.rooms.filter(room_id=room_id).exists():  # your check
        return JsonResponse({"error": {"code": "forbidden"}}, status=403)
    resp = httpx.post(
        f"{settings.VIDCALL_SIDECAR}/auth/token",
        headers={"adminToken": settings.VIDCALL_ADMIN_TOKEN},
        json={"roomId": room_id, "participantId": str(request.user.id)},
    )
    return JsonResponse(resp.json(), status=resp.status_code)  # { token, ... }
```

The browser gets `{ token }` from that view and uses it for `/vidcall/...`
calls (`Authorization: Bearer ...`) and the `/ws?roomId=...&token=...`
connection. Keep your Django middleware as a first line of defense (session
check, room membership) — the sidecar tokens are room-scoped and
identity-bound on top of it:

```python
@csrf_exempt
def vidcall_proxy(request, path):
    if not request.user.is_authenticated:
        return HttpResponse('{"error":{"code":"unauthorized"}}', status=401)
    # ... forward as above ...
```

## 4. Client wiring (Python-free)

The browser client talks to `/vidcall/...` (REST) and `/ws?roomId=...` (WS) —
same origin, so cookies apply. The client-side signaling adapter only needs
`POST /vidcall/rooms/:id/signal` + the `/ws` relay.

## 5. systemd unit (example)

```ini
# /etc/systemd/system/vidcall-sidecar.service
[Unit]
Description=vidcall signaling sidecar
After=network.target

[Service]
WorkingDirectory=/srv/vidcall
ExecStart=/usr/bin/node sidecar.mjs
Restart=on-failure
Environment=NODE_ENV=production

[Install]
WantedBy=multi-user.target
```
