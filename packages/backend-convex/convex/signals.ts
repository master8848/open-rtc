/**
 * vidcall signaling functions (reference) — copy into your convex/ dir.
 * Matches the mutation/subscription names the adapter calls:
 *   signals:send / signals:list
 */
import { mutation, query } from './_generated/server';
import { v } from 'convex/values';

export const send = mutation({
  args: { roomId: v.string(), frame: v.string() },
  handler: async (ctx, args) => {
    await ctx.db.insert('signals', { roomId: args.roomId, frame: args.frame });
  },
});

export const list = query({
  args: { roomId: v.string() },
  handler: async (ctx, args) => {
    return await ctx.db
      .query('signals')
      .withIndex('by_room', (q) => q.eq('roomId', args.roomId))
      .collect();
  },
});
