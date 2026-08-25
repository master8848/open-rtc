# Implementing a Store for any database

@mbsks/server's core is a set of **pure functions** that take a `Store` as
their first argument (`createRoom(store, ...)`, `joinRoom(store, ...)`,
`handleSignal(store, envelope)`, ...). A `Store` is a minimal async KV +
query surface — about ten methods — so _any_ database can host the component:
SQLite, Postgres, MySQL (shipped), or MongoDB, DynamoDB, Firestore, Redis,
CockroachDB, TiDB, ... (your implementation).

## The contract

```ts
interface Store {
  // rooms — one row/document per room
  getRoom(roomId: string): Promise<Room | null>;
  putRoom(room: Room): Promise<void>;
  deleteRoom?(roomId: string): Promise<void>;

  // participants — one row per (roomId, participantId)
  getParticipant(roomId: string, participantId: string): Promise<Participant | null>;
  putParticipant(participant: Participant): Promise<void>;
  deleteParticipant(roomId: string, participantId: string): Promise<void>;
  listParticipants(roomId: string): Promise<Participant[]>;

  // signals — append-only per-room log of protocol envelopes
  putSignal(signal: {
    roomId: string;
    envelope: Envelope;
    receivedAt: number;
  }): Promise<StoredSignal>;
  listSignals(roomId: string, since: number): Promise<StoredSignal[]>;

  // recordings — metadata only (bytes go to RecordingStorage)
  putRecording(recording: RecordingSession): Promise<void>;
  listRecordings(roomId: string): Promise<RecordingSession[]>;
  getRecording(sessionId: string): Promise<RecordingSession | null>;
}
```

## Rules of the road

1. **JSON documents round-trip verbatim.** Store `Room`, `Participant`,
   `RecordingSession` as a JSON document (text column / JSONB / document) and
   parse on read. Never reorder or drop fields — tests deep-compare nested
   `metadata`.
2. **`putSignal` assigns the `seq`.** The Store owns the per-room monotonic
   sequence and returns the stored signal. Make the assignment atomic:
   - SQLite: `SELECT COALESCE(MAX(seq),0)+1` inside a transaction;
   - Postgres: `BIGINT GENERATED ALWAYS AS IDENTITY` (per-room monotonic
     automatically);
   - MySQL: `AUTO_INCREMENT` column;
   - MongoDB/DynamoDB: `$inc` / `UpdateExpression ADD` on a per-room counter.
3. **`listSignals(roomId, since)`** returns signals with `seq > since`,
   ascending by seq (the client engine replays the log from its last seq).
4. **All methods are async**, even for in-memory stores — callers never care
   which database is behind the interface.
5. **`deleteRoom` is optional** but recommended (cleanup of participants +
   signals + recordings in one transaction).

## Minimal example (MongoDB)

```ts
import { MongoClient } from 'mongodb';
import type { Store, SignalInput } from '@mbsks/server';
import type { Envelope } from '@mbsks/protocol';

export class MongoStore implements Store {
  constructor(private db: MongoClient['db']) {}
  private rooms = () => this.db.collection('vidcall_rooms');
  private parts = () => this.db.collection('vidcall_participants');
  private signals = () => this.db.collection('vidcall_signals');
  private recs = () => this.db.collection('vidcall_recordings');

  async getRoom(roomId: string) {
    return (await this.rooms().findOne({ _id: roomId }))?.doc ?? null;
  }
  async putRoom(room: any) {
    await this.rooms().updateOne({ _id: room.roomId }, { $set: { doc: room } }, { upsert: true });
  }
  async deleteRoom(roomId: string) {
    await this.rooms().deleteOne({ _id: roomId });
    await this.parts().deleteMany({ roomId });
    await this.signals().deleteMany({ roomId });
    await this.recs().deleteMany({ roomId });
  }

  async getParticipant(roomId: string, participantId: string) {
    return (await this.parts().findOne({ _id: `${roomId}\u0000${participantId}` }))?.doc ?? null;
  }
  async putParticipant(p: any) {
    await this.parts().updateOne(
      { _id: `${p.roomId}\u0000${p.participantId}` },
      { $set: { doc: p, roomId: p.roomId } },
      { upsert: true },
    );
  }
  async deleteParticipant(roomId: string, participantId: string) {
    await this.parts().deleteOne({ _id: `${roomId}\u0000${participantId}` });
  }
  async listParticipants(roomId: string) {
    return (await this.parts().find({ roomId }).sort({ 'doc.joinedAt': 1 }).toArray()).map(
      (r: any) => r.doc,
    );
  }

  async putSignal(s: SignalInput) {
    const seq = await this.signals().findOneAndUpdate(
      { _id: s.roomId },
      { $inc: { seq: 1 } },
      { upsert: true, returnDocument: 'after' },
    );
    const stored = {
      roomId: s.roomId,
      seq: seq!.seq,
      envelope: s.envelope,
      receivedAt: s.receivedAt,
    };
    await this.signals().insertOne({ ...stored, _id: `${s.roomId}\u0000${stored.seq}` });
    return stored;
  }
  async listSignals(roomId: string, since: number) {
    return this.signals()
      .find({ roomId, seq: { $gt: since } })
      .sort({ seq: 1 })
      .toArray();
  }

  async putRecording(r: any) {
    await this.recs().updateOne(
      { _id: r.sessionId },
      { $set: { doc: r, roomId: r.roomId } },
      { upsert: true },
    );
  }
  async listRecordings(roomId: string) {
    return (await this.recs().find({ roomId }).toArray()).map((r: any) => r.doc);
  }
  async getRecording(sessionId: string) {
    return (await this.recs().findOne({ _id: sessionId }))?.doc ?? null;
  }
}
```

Then prove it against the **shared test suite**:

```ts
// test/MongoStore.test.ts
import { runStoreTestSuite } from '@mbsks/server/shared-tests';
runStoreTestSuite({
  name: 'mongodb',
  createStore: async () =>
    new MongoStore((await new MongoClient(process.env.MONGO_URL!).connect()).db('vidcall_test')),
  destroyStore: async (store) => {
    /* close client */
  },
});
```

## Databases shipped

Each SQL-backed store is a **subpath export** whose driver is an optional
peer dependency — installing `@mbsks/server` alone pulls in no database
driver at all. Import the store you use and install only its driver:

```sh
npm install @mbsks/server            # core + InMemoryStore, zero drivers
npm install @mbsks/server better-sqlite3   # + SQLite (native addon)
npm install @mbsks/server pg               # + PostgreSQL
npm install @mbsks/server mysql2           # + MySQL
```

| Store           | Import from                       | Driver         | Install                | Tables / notes                                                     |
| --------------- | --------------------------------- | -------------- | ---------------------- | ------------------------------------------------------------------ |
| `InMemoryStore` | `@mbsks/server`                 | —              | —                      | reference impl, dev/tests, single-process                          |
| `SqliteStore`   | `@mbsks/server/stores/sqlite`   | better-sqlite3 | `npm i better-sqlite3` | 4 tables, JSON docs; bootstrap() idempotent; WAL for multi-process |
| `PostgresStore` | `@mbsks/server/stores/postgres` | pg             | `npm i pg`             | 4 tables, JSONB; identity seq for signals                          |
| `MysqlStore`    | `@mbsks/server/stores/mysql`    | mysql2         | `npm i mysql2`         | 4 tables, JSON; auto-increment seq                                 |

```ts
// SQLite: the driver handle is injected (never imported by this package)
import Database from 'better-sqlite3';
import { SqliteStore } from '@mbsks/server/stores/sqlite';
const store = new SqliteStore(new Database('vidcall.db'));

// Postgres/MySQL: pass a connection string or pool; the driver loads lazily
import { PostgresStore } from '@mbsks/server/stores/postgres';
const store = new PostgresStore(process.env.DATABASE_URL);

await store.bootstrap();
```

If the optional peer is missing, the store fails fast with an error naming
the install command (`npm i pg`, `npm i mysql2`, `npm i better-sqlite3`).

Every store passes the same shared suite (`packages/server/test/*Store.test.ts`);
the Postgres/MySQL suites run against live servers when
`VIDCALL_TEST_POSTGRES_URL` / `VIDCALL_TEST_MYSQL_URL` are set, and skip
gracefully otherwise.
