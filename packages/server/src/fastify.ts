/**
 * @vidcall/server — Fastify adapter.
 *
 * `createFastifyPlugin(services)` returns a Fastify plugin registering the
 * shared `dispatch()` handlers. fastify is an optional peer dependency:
 *
 * ```ts
 * import Fastify from 'fastify';
 * import { createFastifyPlugin, createServices, InMemoryStore } from '@vidcall/server';
 *
 * const app = Fastify();
 * await app.register(createFastifyPlugin(createServices({ store: new InMemoryStore() })));
 * await app.listen({ port: 3000 });
 * ```
 *
 * Recording chunk uploads use `application/octet-stream` (raw buffer), so
 * the plugin registers a buffer content-type parser for that media type.
 */

import type { FastifyInstance, FastifyPluginCallback, FastifyRequest } from 'fastify';
import { dispatch, type RouteContext } from './http.ts';
import type { Services } from './services.ts';

export function createFastifyPlugin(services: Services): FastifyPluginCallback {
  return async (app: FastifyInstance) => {
    app.addContentTypeParser('application/octet-stream', { parseAs: 'buffer' }, (_req, body, done) => {
      done(null, body);
    });

    app.post('/rooms', async (req, reply) => {
      const result = await dispatch(services, fastifyContext(req));
      return reply.code(result.status).send(result.body);
    });
    app.post('/rooms/:id/join', async (req, reply) => {
      const result = await dispatch(services, fastifyContext(req));
      return reply.code(result.status).send(result.body);
    });
    app.post('/rooms/:id/leave', async (req, reply) => {
      const result = await dispatch(services, fastifyContext(req));
      return reply.code(result.status).send(result.body);
    });
    app.post('/rooms/:id/signal', async (req, reply) => {
      const result = await dispatch(services, fastifyContext(req));
      return reply.code(result.status).send(result.body);
    });
    app.get('/rooms/:id/state', async (req, reply) => {
      const result = await dispatch(services, fastifyContext(req));
      return reply.code(result.status).send(result.body);
    });
    app.get('/rooms/:id/recordings', async (req, reply) => {
      const result = await dispatch(services, fastifyContext(req));
      return reply.code(result.status).send(result.body);
    });
    app.post('/recordings/:sessionId/chunks', async (req, reply) => {
      const result = await dispatch(services, fastifyContext(req));
      return reply.code(result.status).send(result.body);
    });
    app.post('/recordings/:sessionId/finalize', async (req, reply) => {
      const result = await dispatch(services, fastifyContext(req));
      return reply.code(result.status).send(result.body);
    });
  };
}

function fastifyContext(req: FastifyRequest): RouteContext {
  return {
    method: req.method,
    path: req.url.split('?')[0] ?? '/',
    query: new URL(req.url, 'http://localhost').searchParams,
    params: (req.params ?? {}) as Record<string, string>,
    body: req.body,
    rawBody: req.body instanceof Buffer ? req.body : undefined,
    header: (name) => req.headers[name.toLowerCase()] as string | undefined,
  };
}
