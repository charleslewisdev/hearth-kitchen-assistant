import { z } from 'zod';
import { router, protectedProcedure } from '../trpc';
import * as shopping from '../../repo/shopping';

export const shoppingRouter = router({
  get: protectedProcedure.query(({ ctx }) => shopping.getActiveList(ctx.householdId)),
  addRecipe: protectedProcedure
    .input(z.object({ recipeId: z.string().uuid(), servings: z.number().int().positive() }))
    .mutation(({ ctx, input }) =>
      shopping.addRecipeToList(ctx.householdId, input.recipeId, input.servings),
    ),
  addItem: protectedProcedure
    .input(z.object({ text: z.string().min(1) }))
    .mutation(({ ctx, input }) => shopping.addManualItem(ctx.householdId, input.text)),
  updateItem: protectedProcedure
    .input(
      z.object({
        itemId: z.string().uuid(),
        name: z.string().min(1).optional(),
        quantity: z.number().nullable().optional(),
        unit: z.string().nullable().optional(),
        department: z.string().nullable().optional(),
        position: z.number().int().optional(),
      }),
    )
    .mutation(({ ctx, input }) => {
      const { itemId, ...patch } = input;
      return shopping.updateItem(ctx.householdId, itemId, patch);
    }),
  toggleChecked: protectedProcedure
    .input(z.object({ itemId: z.string().uuid(), checked: z.boolean() }))
    .mutation(({ ctx, input }) =>
      shopping.setChecked(ctx.householdId, input.itemId, input.checked),
    ),
  removeItem: protectedProcedure
    .input(z.object({ itemId: z.string().uuid() }))
    .mutation(({ ctx, input }) => shopping.removeItem(ctx.householdId, input.itemId)),
  clearChecked: protectedProcedure.mutation(({ ctx }) => shopping.clearChecked(ctx.householdId)),
});
