# Hosting @vidcall/server next to a Ruby on Rails app

Rails is Ruby — @vidcall/server is a Node component that speaks plain
REST + WebSocket JSON. The recommended pattern is the **sidecar**: run the
component as a tiny Node process and let Rails proxy the `/vidcall/` prefix
(or put it behind the same domain with nginx).

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
  PostgresStore,
} from '@vidcall/server';

const store = new PostgresStore(process.env.DATABASE_URL); // reuse your PG
await store.bootstrap();
const server = createNodeServer(createServices({ store }));
attachWebSocketRelay(server, createServices({ store }));
server.listen(8787);
```

## 2. Proxy from Rails

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

### Option B — Rails controller proxy (dev / single process)

```ruby
# config/routes.rb
match '/vidcall/*path', to: 'vidcall#proxy', via: :all

# app/controllers/vidcall_controller.rb
class VidcallController < ApplicationController
  skip_before_action :verify_authenticity_token
  SIDECAR = URI(ENV.fetch('VIDCALL_SIDECAR', 'http://127.0.0.1:8787'))

  def proxy
    return head(:unauthorized) unless current_user

    target = URI.join(SIDECAR, params[:path].to_s)
    http = Net::HTTP.new(target.host, target.port)
    http.read_timeout = 60
    resp = http.request(build_request(target))
    render json: resp.body, status: resp.code.to_i
  end

  private

  def build_request(target)
    req_class = { 'POST' => Net::HTTP::Post, 'GET' => Net::HTTP::Get,
                  'PUT' => Net::HTTP::Put, 'DELETE' => Net::HTTP::Delete }[request.method]
    req = req_class.new(target.request_uri)
    request.headers.each { |k, v| req[k] = v unless %w[host].include?(k.downcase) }
    req.body = request.body.read
    req
  end
end
```

## 3. Auth in Rails

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
`?token=<token>` (WS). Rails mints a room-scoped participant token per user
in a controller — the `adminToken` header is the server-to-server credential:

```ruby
# app/controllers/vidcall_tokens_controller.rb
class VidcallTokensController < ApplicationController
  before_action :authenticate_user!

  def create
    room_id = params.require(:room_id)
    unless current_user.rooms.exists?(room_id: room_id)   # your check
      render json: { error: { code: "forbidden" } }, status: :forbidden
      return
    end
    resp = Net::HTTP.start(
      ENV.fetch("VIDCALL_SIDECAR_HOST"), ENV.fetch("VIDCALL_SIDECAR_PORT")
    ) do |http|
      http.post(
        "/auth/token",
        { roomId: room_id, participantId: current_user.id.to_s }.to_json,
        "Content-Type" => "application/json",
        "adminToken" => ENV.fetch("VIDCALL_ADMIN_TOKEN"),
      )
    end
    render json: JSON.parse(resp.body), status: resp.code.to_i # { token, ... }
  end
end
```

Route it (`resources :vidcall_tokens, only: :create`), hand `{ token }` to the
browser, and the client uses `Authorization: Bearer ...` for `/vidcall/...`
and `?token=...` on `/ws?roomId=...`. Keep your `current_user` and room
membership checks as the first line of defense — the sidecar tokens are
room-scoped and identity-bound on top of them.

## 4. Action Cable note

The sidecar's `/ws` endpoint is the signaling relay; Rails' own Action Cable
is not involved. If you also need server-push from Rails into a room, publish
through the REST API (`POST /rooms/:id/signal`) or add a small pub/sub bridge
later — the Store contract is the seam for that.
