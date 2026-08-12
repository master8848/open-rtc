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

Check `current_user` (and room membership for `rooms/:id/*` paths) in
`VidcallController` before forwarding — the sidecar stays auth-agnostic.

## 4. Action Cable note

The sidecar's `/ws` endpoint is the signaling relay; Rails' own Action Cable
is not involved. If you also need server-push from Rails into a room, publish
through the REST API (`POST /rooms/:id/signal`) or add a small pub/sub bridge
later — the Store contract is the seam for that.
