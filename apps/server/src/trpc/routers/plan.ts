import { z } from 'zod';
import { isIsoDate } from '@hearth/shared';
import { router, protectedProcedure } from '../trpc';
import * as plan from '../../repo/plan';

// A calendar day as the client names it. Refined rather than a bare regex so 2026-02-30 is a 400
// here and not a 500 from Postgres.
const isoDate = z.string().max(10).refine(isIsoDate, 'Expected a YYYY-MM-DD date');
const meal = z.enum(['breakfast', 'lunch', 'dinner', 'snack', 'dessert']);
// The scaler's own bound would do, but nobody plans a meal for more than this many people.
const servings = z.number().int().positive().max(100);

export const planRouter = router({
  week: protectedProcedure
    .input(z.object({ date: isoDate }))
    .query(({ ctx, input }) => plan.getWeek(ctx.householdId, input.date)),
  add: protectedProcedure
    .input(z.object({ date: isoDate, meal, recipeId: z.string().uuid(), servings }))
    .mutation(({ ctx, input }) => plan.addEntry(ctx.householdId, input)),
  update: protectedProcedure
    .input(
      z.object({
        id: z.string().uuid(),
        date: isoDate.optional(),
        meal: meal.optional(),
        servings: servings.optional(),
      }),
    )
    .mutation(({ ctx, input }) => {
      const { id, ...patch } = input;
      return plan.updateEntry(ctx.householdId, id, patch);
    }),
  remove: protectedProcedure
    .input(z.object({ id: z.string().uuid() }))
    .mutation(({ ctx, input }) => plan.removeEntry(ctx.householdId, input.id)),
  buildList: protectedProcedure
    .input(z.object({ start: isoDate }))
    .mutation(({ ctx, input }) => plan.buildListForWeek(ctx.householdId, input.start)),
  weekStart: protectedProcedure.query(({ ctx }) => plan.getWeekStart(ctx.householdId)),
  setWeekStart: protectedProcedure
    .input(z.object({ weekStart: z.number().int().min(0).max(6) }))
    .mutation(({ ctx, input }) => plan.setWeekStart(ctx.householdId, input.weekStart)),
});
