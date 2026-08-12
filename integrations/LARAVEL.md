# Hosting @vidcall/server next to a Laravel app

Laravel is PHP — @vidcall/server is a Node component that speaks plain
REST + WebSocket JSON. The recommended pattern is the **sidecar**: run the
component as a tiny Node process and have Laravel proxy the `/vidcall/`
prefix (or put it behind the same domain with nginx).

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

const store = new SqliteStore(new Database(storage_path('vidcall.db')));
await store.bootstrap();
const server = createNodeServer(createServices({ store }));
attachWebSocketRelay(server, createServices({ store }));
server.listen(8787);
```

## 2. Proxy from Laravel

### Option A — nginx (recommended, covers WebSockets)

```nginx
location /vidcall/ {
    proxy_pass http://127.0.0.1:8787/;
    proxy_set_header Host $host;
}
location /ws {
    proxy_pass http://127.0.0.1:8787;
    proxy_http_version 1.1;
    proxy_set_header Upgrade $http_upgrade;
    proxy_set_header Connection "upgrade";
    proxy_read_timeout 3600s;
}
```

### Option B — Laravel HTTP client proxy (dev)

```php
// routes/web.php (or api.php)
use Illuminate\Support\Facades\Http;
use Illuminate\Http\Request;
use Illuminate\Support\Facades\Route;

Route::any('vidcall/{path}', function (Request $request, string $path) {
    if (! $request->user()) {
        return response()->json(['error' => ['code' => 'unauthorized']], 401);
    }
    $resp = Http::withHeaders($request->headers->all())
        ->send($request->method(), "http://127.0.0.1:8787/{$path}", [
            'body' => $request->getContent(),
        ]);
    return response($resp->body(), $resp->status())
        ->header('Content-Type', 'application/json');
})->where('path', '.*');
```

## 3. Auth in Laravel

Gate access at the proxy route with your normal middleware (`auth:sanctum`,
policies, room membership checks) before forwarding — the sidecar itself
stays auth-agnostic (it trusts the host).

## 4. Queue/octane notes

- The sidecar is stateless on the DB side (SQLite file or Postgres), so it
  survives `php artisan octane:reload` without dropping rooms.
- For horizontal scale, point the sidecar at Postgres (`PostgresStore`) and
  run one sidecar per instance behind a load balancer; the WS hub is
  per-process, so pin a client's `/ws` connection to one instance (sticky
  sessions) or move to a shared pub/sub relay later.
