/**
 * Integration tests — run only when VIDCALL_TEST_POSTGRES_URL is set:
 *
 *   VIDCALL_TEST_POSTGRES_URL=postgres://user:pass@localhost:5432/vidcall \
 *   npx vitest run test/integration.test.ts
 *
 * Creates (if needed) the vidcall_presence table and runs the full shared
 * adapter matrix against a real PostgreSQL.
 *
 * NOTE: uses a DEDICATED pg.Client (never a pool) — LISTEN must live on the
 * connection that runs it.
 */
import { describe, it } from 'vitest';
import pg from 'pg';
import { PostgresBackend } from '../src/PostgresBackend.js';
import { runAdapterTestSuite, type AdapterHarness } from '@mbsks/openrtc-transport/shared-tests';
import type { SignalingTransport } from '@mbsks/openrtc-transport';

const url = process.env.VIDCALL_TEST_POSTGRES_URL;
const enabled = Boolean(url);
const describeIf = enabled ? describe : describe.skip;
const { Client } = pg;

const PRESENCE_DDL = `
CREATE TABLE IF NOT EXISTS vidcall_presence (
  room TEXT NOT NULL,
  user_id TEXT NOT NULL,
  state TEXT NOT NULL DEFAULT 'online',
  metadata JSONB,
  last_seen BIGINT NOT NULL,
  PRIMARY KEY (room, user_id)
);`;

describeIf('PostgresBackend integration', () => {
  it('creates the presence table and runs the shared matrix', async () => {
    const admin = new Client({ connectionString: url! });
    await admin.connect();
    await admin.query(PRESENCE_DDL);
    await admin.end();

    runAdapterTestSuite({
      name: 'postgres (live)',
      createPeer: async (): Promise<SignalingTransport> => {
        const client = new Client({ connectionString: url! });
        await client.connect();
        return new PostgresBackend({ client: client as unknown as pg.Client });
      },
      destroyPeer: async (p) => p.dispose(),
      supportsLargePayload: true,
      roomPrefix: 'pg-live',
    } satisfies AdapterHarness);
  });
});
