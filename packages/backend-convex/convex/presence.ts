/**
 * vidcall presence functions (reference) — copy into your convex/ dir.
 * Matches the mutation/subscription names the adapter calls:
 *   presence:upsert / presence:remove / presence:list
 */
import { mutation, query } from './_generated/server';
import { v } from 'convex/values';

export const upsert = mutation({
  args: {
    roomId: v.string(),
    userId: v.string(),
    state: v.string(),
    metadata: v.optional(v.any()),
    lastSeen: v.number(),
  },
  handler: async (ctx, args) => {
    const existing = await ctx.db
      .query('presence')
      .withIndex('by_room', (q) => q.eq('roomId', args.roomId))
      .filter((q) => q.eq(q.field('userId'), args.userId))
      .first();
    if (existing) {
      await ctx.db.replace(existing._id, {
        roomId: args.roomId,
        userId: args.userId,
        state: args.state,
        metadata: args.metadata,
        lastSeen: args.lastSeen,
      });
    } else {
      await ctx.db.insert('presence', {
        roomId: args.roomId,
        userId: args.userId,
        state: args.state,
        metadata: args.metadata,
        lastSeen: args.lastSeen,
      });
    }
  },
});

export const remove = mutation({
  args: { roomId: v.string(), userId: v.string() },
  handler: async (ctx, args) => {
    const existing = await ctx.db
      .query('presence')
      .withIndex('by_room', (q) => q.eq('roomId', args.roomId))
      .filter((q) => q.eq(q.field('userId'), args.userId))
      .first();
    if (existing) await ctx.db.delete(existing._id);
  },
});

export const list = query({
  args: { roomId: v.string() },
  handler: async (ctx, args) => {
    return await ctx.db
      .query('presence')
      .withIndex('by_room', (q) => q.eq('roomId', args.roomId))
      .collect();
  },
});
