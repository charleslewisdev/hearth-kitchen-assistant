import { z } from 'zod';
import { router, protectedProcedure } from '../trpc';
import { DEPARTMENTS } from '@hearth/shared';
import {
  deleteAllUnusedFoods,
  deleteUnusedFood,
  listFoods,
  mergeFoods,
  renameFood,
  searchFoods,
  setFoodDepartment,
} from '../../repo/foods';
import { MAX_SEARCH_LENGTH } from './recipe';

export const foodRouter = router({
  /**
   * Prefix suggestions for the Library's `contains {ingredient}` token.
   *
   * Its whole job is turning what a cook is typing into one of the household's canonical foods,
   * which is what makes the ingredient filter match the food row rather than a spelling. The
   * Foods screen has its own procedures below; this one stays a prefix lookup.
   *
   * `q` is required and non-empty, because a suggestion list for an empty box is the pantry.
   * The length cap is the recipe search box's own, since that box is what feeds this.
   */
  list: protectedProcedure
    .input(z.object({ q: z.string().min(1).max(MAX_SEARCH_LENGTH) }))
    .query(({ ctx, input }) => searchFoods(ctx.householdId, input.q)),

  // The Foods screen: every food with its usage, and the four ways to tidy one (D48).
  all: protectedProcedure.query(({ ctx }) => listFoods(ctx.householdId)),
  rename: protectedProcedure
    .input(z.object({ id: z.string().uuid(), name: z.string().trim().min(1).max(100) }))
    .mutation(({ ctx, input }) => renameFood(ctx.householdId, input.id, input.name)),
  setDepartment: protectedProcedure
    .input(
      z.object({
        id: z.string().uuid(),
        department: z.enum(DEPARTMENTS as [string, ...string[]]).nullable(),
      }),
    )
    .mutation(({ ctx, input }) => setFoodDepartment(ctx.householdId, input.id, input.department)),
  merge: protectedProcedure
    .input(z.object({ fromId: z.string().uuid(), intoId: z.string().uuid() }))
    .mutation(({ ctx, input }) => mergeFoods(ctx.householdId, input.fromId, input.intoId)),
  remove: protectedProcedure
    .input(z.object({ id: z.string().uuid() }))
    .mutation(({ ctx, input }) => deleteUnusedFood(ctx.householdId, input.id)),
  removeUnused: protectedProcedure.mutation(({ ctx }) => deleteAllUnusedFoods(ctx.householdId)),
});
