/**
 * @vidcall/server — Express adapter.
 *
 * `createExpressRouter(services)` returns an `express.Router` mounting the
 * shared `dispatch()` handlers. express is an optional peer dependency —
 * add it to your app, then:
 *
 * ```ts
 * import express from 'express';
 * import { createExpressRouter, createServices, InMemoryStore } from '@vidcall/server';
 *
 * const app = express();
 * app.use('/vidcall', createExpressRouter(createServices({ store: new InMemoryStore() })));
 * app.listen(3000);
 * ```
 *
 * Recording chunk uploads arrive as `application/octet-stream`; the router
 * attaches `express.raw` only to that route (JSON routes keep the JSON
 * parser).
 */

import express from 'express';
import { dispatch, type RouteContext } from './http.ts';
import type { Services } from './services.ts';

export function createExpressRouter(services: Services): express.Router {
  const router = express.Router();

  router.post('/auth/token', express.json({ limit: '4mb' }), async (req, res) => {
    const result = await dispatch(services, expressContext(req));
    res.status(result.status).json(result.body);
  });

  router.post('/rooms', express.json({ limit: '4mb' }), async (req, res) => {
    const result = await dispatch(services, expressContext(req));
    res.status(result.status).json(result.body);
  });

  router.post('/rooms/:id/join', express.json({ limit: '4mb' }), async (req, res) => {
    const result = await dispatch(services, expressContext(req));
    res.status(result.status).json(result.body);
  });

  router.post('/rooms/:id/leave', express.json({ limit: '4mb' }), async (req, res) => {
    const result = await dispatch(services, expressContext(req));
    res.status(result.status).json(result.body);
  });

  router.post('/rooms/:id/signal', express.json({ limit: '8mb' }), async (req, res) => {
    const result = await dispatch(services, expressContext(req));
    res.status(result.status).json(result.body);
  });

  router.post('/rooms/:id/close', express.json({ limit: '4mb' }), async (req, res) => {
    const result = await dispatch(services, expressContext(req));
    res.status(result.status).json(result.body);
  });

  router.delete('/rooms/:id', async (req, res) => {
    const result = await dispatch(services, expressContext(req));
    res.status(result.status).json(result.body);
  });

  router.get('/rooms/:id/state', async (req, res) => {
    const result = await dispatch(services, expressContext(req));
    res.status(result.status).json(result.body);
  });

  router.get('/rooms/:id/recordings', async (req, res) => {
    const result = await dispatch(services, expressContext(req));
    res.status(result.status).json(result.body);
  });

  router.post(
    '/recordings/:sessionId/chunks',
    express.raw({ type: () => true, limit: '64mb' }),
    async (req, res) => {
      const result = await dispatch(services, expressContext(req));
      res.status(result.status).json(result.body);
    },
  );

  router.post(
    '/recordings/:sessionId/finalize',
    express.json({ limit: '1mb' }),
    async (req, res) => {
      const result = await dispatch(services, expressContext(req));
      res.status(result.status).json(result.body);
    },
  );

  return router;
}

function expressContext(req: express.Request): RouteContext {
  return {
    method: req.method,
    path: req.path,
    query: new URLSearchParams(
      Object.entries(req.query as Record<string, string | string[]>).flatMap(([k, v]) =>
        Array.isArray(v) ? v.map((vv) => [k, vv]) : [[k, String(v)]],
      ),
    ),
    params: { ...req.params } as Record<string, string>,
    body: req.body,
    rawBody: req.body instanceof Buffer ? req.body : undefined,
    header: (name) => req.header(name),
  };
}
