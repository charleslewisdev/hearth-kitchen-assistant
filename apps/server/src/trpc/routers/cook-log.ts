import { z } from 'zod';
import { isIsoDate } from '@hearth/shared';
import { router, protectedProcedure } from '../trpc';
import { auth } from '../../auth';
import { addCookLog, deleteCookLog, listCookLog, updateCookLog } from '../../repo/cook-log';

// A calendar day as the client names it, as the planner takes one.
const isoDate = z.string().max(10).refine(isIsoDate, 'Expected a YYYY-MM-DD date');
const rating = z.number().int().min(1).max(5).nullable().optional();

const entry = z.object({
  cookedOn: isoDate,
  servings: z.number().int().positive().max(1000).nullable().optional(),
  rating,
  notes: z.string().max(5000).nullable().optional(),
});

/**
 * The cook log: each time a recipe was cooked, logged by hand (from the recipe screen, or with
 * "Cooked it" on a planned meal). Any member may add, change or delete any entry.
 */
export const cookLogRouter = router({
  /**
   * A recipe's log, newest first, each entry with the name of the member who logged it.
   *
   * Names come from Better Auth's member list rather than a join: the app's database role has
   * no grant on the `user` table, and should not get one for this. Someone who has since left
   * the household keeps their entries, under no name.
   */
  list: protectedProcedure
    .input(z.object({ recipeId: z.string().uuid() }))
    .query(async ({ ctx, input }) => {
      const entries = await listCookLog(ctx.householdId, input.recipeId);
      const { members } = await auth.api.listMembers({
        query: { organizationId: ctx.householdId },
        headers: ctx.headers,
      });
      const names = new Map(members.map((m) => [m.userId, m.user.name]));
      return entries.map(({ loggedById, ...entry }) => ({
        ...entry,
        loggedBy: loggedById ? (names.get(loggedById) ?? null) : null,
      }));
    }),
  add: protectedProcedure
    .input(entry.extend({ recipeId: z.string().uuid() }))
    .mutation(({ ctx, input }) => {
      const { recipeId, ...rest } = input;
      return addCookLog(ctx.householdId, ctx.session.user.id, recipeId, rest);
    }),
  update: protectedProcedure
    .input(entry.extend({ id: z.string().uuid() }))
    .mutation(({ ctx, input }) => {
      const { id, ...rest } = input;
      return updateCookLog(ctx.householdId, id, rest);
    }),
  remove: protectedProcedure
    .input(z.object({ id: z.string().uuid() }))
    .mutation(({ ctx, input }) => deleteCookLog(ctx.householdId, input.id)),
});
