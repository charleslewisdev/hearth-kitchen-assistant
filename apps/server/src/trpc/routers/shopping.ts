import { z } from 'zod';
import { TRPCError } from '@trpc/server';
import { MAX_LIST_AMOUNT_LENGTH, parseListAmount } from '@hearth/shared';
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
  // Change one item's amount in place from what the cook typed (D54). `seen` is the amount the
  // edit started from; the repo refuses the edit with CONFLICT if the item no longer has it.
  setAmount: protectedProcedure
    .input(
      z.object({
        itemId: z.string().uuid(),
        // Room for surrounding spaces; the parser takes MAX_LIST_AMOUNT_LENGTH once trimmed.
        text: z.string().max(MAX_LIST_AMOUNT_LENGTH * 2),
        seen: z.object({
          quantity: z.number().finite().nullable(),
          unit: z.string().max(MAX_LIST_AMOUNT_LENGTH).nullable(),
        }),
      }),
    )
    .mutation(({ ctx, input }) => {
      const amount = parseListAmount(input.text);
      // The text stays out of the message (D38).
      if (!amount) throw new TRPCError({ code: 'BAD_REQUEST', message: 'Not an amount' });
      return shopping.setItemAmount(ctx.householdId, input.itemId, amount, input.seen);
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
