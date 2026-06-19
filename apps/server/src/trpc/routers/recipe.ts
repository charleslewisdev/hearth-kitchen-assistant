import { z } from 'zod';
import { router, protectedProcedure } from '../trpc';
import { listRecipes, createRecipe } from '../../repo/recipes';

export const recipeRouter = router({
  list: protectedProcedure.query(({ ctx }) => listRecipes(ctx.householdId)),
  create: protectedProcedure
    .input(z.object({ title: z.string().min(1) }))
    .mutation(({ ctx, input }) => createRecipe(ctx.householdId, input)),
});
