# vidcall server — integration guides

`@vidcall/server` attaches to other backends. Pick your host:

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
