/**
 * @mbsks/server — public API (zero-database core).
 *
 * A backend component for vidcall that attaches to OTHER backends:
 *  - core room/session/recording logic (pure functions over a `Store`);
 *  - the function-based `Store` contract + the zero-dependency
 *    `InMemoryStore` (reference implementation, dev/tests);
 *  - framework-agnostic REST + WebSocket relay (node:http standalone;
 *    sidecar proxy for Django/Laravel/Rails);
 *  - recording byte storage (Disk + S3 via minimal SigV4 fetch client).
 *
 * Everything with a heavy/native dependency lives behind a subpath export,
 * so installing `@mbsks/server` alone pulls in only `@mbsks/protocol`
 * and the pure-JS `ws` package (see "Dependencies" in README.md):
 *
 *  - `@mbsks/server/express`         → createExpressRouter (needs express)
 *  - `@mbsks/server/fastify`         → createFastifyPlugin (types only)
 *  - `@mbsks/server/stores/sqlite`   → SqliteStore   (+ better-sqlite3)
 *  - `@mbsks/server/stores/postgres` → PostgresStore (+ pg)
 *  - `@mbsks/server/stores/mysql`    → MysqlStore    (+ mysql2)
 */

// Core domain
export * from './types.ts';
export * from './errors.ts';
export * from './core.ts';
export * from './store.ts';

// Auth (HMAC room tokens)
export * from './auth.ts';
export { issueTurnCredentials, toIceServers } from './turn.ts';
export type { TurnConfig as TurnServerConfig, TurnCredentials } from './turn.ts';

// Service wiring + hosting
export * from './services.ts';
export * from './http.ts';
export * from './ws.ts';
export * from './recording.ts';

// Store implementations: InMemoryStore here; SQL-backed stores behind
// subpath exports so no database driver is loaded from this entry.
export { InMemoryStore } from './stores/InMemoryStore.ts';

// Shared test suite (also importable from '@mbsks/server/shared-tests')
export { runStoreTestSuite, type StoreHarness } from './shared-tests.ts';
