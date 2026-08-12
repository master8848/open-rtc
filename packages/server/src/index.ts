/**
 * @vidcall/server — public API.
 *
 * A backend component for vidcall that attaches to OTHER backends:
 *  - core room/session/recording logic (pure functions over a `Store`);
 *  - the function-based `Store` contract + 4 implementations
 *    (InMemory / SQLite / Postgres / MySQL);
 *  - framework-agnostic REST + WebSocket relay (node:http standalone,
 *    Express router, Fastify plugin; sidecar proxy for Django/Laravel/Rails);
 *  - recording byte storage (Disk + S3 via minimal SigV4 fetch client).
 */

// Core domain
export * from './types.ts';
export * from './errors.ts';
export * from './core.ts';
export * from './store.ts';

// Auth (HMAC room tokens)
export * from './auth.ts';

// Service wiring + hosting
export * from './services.ts';
export * from './http.ts';
export * from './ws.ts';
export * from './recording.ts';
export { createExpressRouter } from './express.ts';
export { createFastifyPlugin } from './fastify.ts';

// Store implementations
export * from './stores/index.ts';

// Shared test suite (also importable from '@vidcall/server/shared-tests')
export { runStoreTestSuite, type StoreHarness } from './shared-tests.ts';
