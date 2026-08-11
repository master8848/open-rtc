/**
 * Reference Convex schema for vidcall signaling (copy into your project's
 * convex/schema.ts, or merge with your existing schema).
 *
 *   npx convex dev   # then:
 *   cp packages/backend-convex/convex/*.ts convex/
 */
import { defineSchema, defineTable } from 'convex/server';
import { v } from 'convex/values';

export default defineSchema({
  /** one row per signal frame (an envelope or a chunk part), append-only */
  signals: defineTable({
    roomId: v.string(),
    /** JSON string of the wire frame (Envelope or ChunkFrame). */
    frame: v.string(),
  }).index('by_room', ['roomId']),

  /** heartbeat presence rows, one per (room, user) */
  presence: defineTable({
    roomId: v.string(),
    userId: v.string(),
    state: v.string(),
    metadata: v.optional(v.any()),
    lastSeen: v.number(),
  }).index('by_room', ['roomId']),
});
