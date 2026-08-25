# vidcall server — integration guides

`@mbsks/openrtc-server` is a small Node service that does your video-call plumbing:
rooms, participant rosters, and the signaling relay. Three ways to run it —
pick the row that matches your stack:

- **Node app (Express/Fastify)?** Mount it in-process. No extra service.
- **Python / PHP / Ruby backend?** Run it as a tiny Node sidecar behind your
  usual web server or proxy.
- **Your own database?** Implement the ~10-method `Store` contract instead of
  using the built-in stores.

| Host                | Native or sidecar?                              | Guide                        |
| ------------------- | ----------------------------------------------- | ---------------------------- |
| **Express** (Node)  | Native — mount the router + WS relay in-process | [EXPRESS.md](EXPRESS.md)     |
| **Fastify** (Node)  | Native — register the plugin + WS relay         | [FASTIFY.md](FASTIFY.md)     |
| **Django** (Python) | Sidecar — Node process + nginx/Django proxy     | [DJANGO.md](DJANGO.md)       |
| **Laravel** (PHP)   | Sidecar — Node process + nginx/Laravel proxy    | [LARAVEL.md](LARAVEL.md)     |
| **Ruby on Rails**   | Sidecar — Node process + nginx/Rails proxy      | [RAILS.md](RAILS.md)         |
| **Any database**    | Implement the ~10-method `Store` contract       | [DATABASES.md](DATABASES.md) |

All hosts share one language-agnostic contract: the REST endpoints + the
`/ws?roomId=...` relay from `packages/server/README.md`, with protocol
envelopes per `protocol/schema.json`.
