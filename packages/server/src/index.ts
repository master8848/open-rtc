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
export * from './types.js';
export * from './errors.js';
export * from './core.js';
export * from './store.js';

// Service wiring + hosting
export * from './services.js';
export * from './http.js';
export * from './ws.js';
export * from './recording.js';
export { createExpressRouter } from './express.js';
export { createFastifyPlugin } from './fastify.js';

// Store implementations
export * from './stores/index.js';

// Shared test suite (also importable from '@vidcall/server/shared-tests')
export { runStoreTestSuite, type StoreHarness } from './shared-tests.js';
