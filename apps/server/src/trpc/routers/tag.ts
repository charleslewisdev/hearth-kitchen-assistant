import { z } from 'zod';
import { TAG_COLORS } from '@hearth/shared';
import { router, protectedProcedure } from '../trpc';
import {
  deleteTag,
  deleteUnusedTags,
  listTags,
  mergeTags,
  renameTag,
  setTagColor,
} from '../../repo/tags';

// The Tags screen (Recipes → Tags): every tag with its recipe count, and the ways to tidy one.
export const tagRouter = router({
  all: protectedProcedure.query(({ ctx }) => listTags(ctx.householdId)),
  rename: protectedProcedure
    .input(z.object({ id: z.string().uuid(), name: z.string().trim().min(1).max(60) }))
    .mutation(({ ctx, input }) => renameTag(ctx.householdId, input.id, input.name)),
  setColor: protectedProcedure
    .input(z.object({ id: z.string().uuid(), color: z.enum(TAG_COLORS).nullable() }))
    .mutation(({ ctx, input }) => setTagColor(ctx.householdId, input.id, input.color)),
  merge: protectedProcedure
    .input(z.object({ fromId: z.string().uuid(), intoId: z.string().uuid() }))
    .mutation(({ ctx, input }) => mergeTags(ctx.householdId, input.fromId, input.intoId)),
  remove: protectedProcedure
    .input(z.object({ id: z.string().uuid() }))
    .mutation(({ ctx, input }) => deleteTag(ctx.householdId, input.id)),
  removeUnused: protectedProcedure.mutation(({ ctx }) => deleteUnusedTags(ctx.householdId)),
});
