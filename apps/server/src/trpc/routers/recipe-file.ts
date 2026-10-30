import { z } from 'zod';
import { TRPCError } from '@trpc/server';
import {
  base64Length,
  MAX_IMAGE_BYTES,
  MAX_PDF_BYTES,
  MAX_PHOTO_BYTES,
  MAX_THUMB_BYTES,
} from '@hearth/shared';
import { router, protectedProcedure } from '../trpc';
import { addRecipeFile, deleteRecipeFile, setRecipeCover } from '../../repo/recipe-files';

const largestFull = Math.max(MAX_PDF_BYTES, MAX_IMAGE_BYTES, MAX_PHOTO_BYTES);

// Base64 only: a character outside the alphabet is refused rather than silently skipped by
// `Buffer.from`, which would decode something other than what was sent.
function decode(encoded: string): Buffer {
  if (!/^[A-Za-z0-9+/]*={0,2}$/.test(encoded)) {
    throw new TRPCError({ code: 'BAD_REQUEST', message: 'That file could not be read.' });
  }
  return Buffer.from(encoded, 'base64');
}

const dimension = z.number().int().min(1).max(20_000);

/**
 * A recipe's photos and source files.
 *
 * Uploads travel as base64 inside tRPC, like the import endpoints, so they share its auth and
 * its body limit (`MAX_IMPORT_BODY_BYTES` already covers the largest file here). The browser
 * has already shrunk a photo and made its thumbnail; the bytes are checked again in the repo.
 * Reading a file's bytes back is the `/api/files/:id/:variant` route in server.ts.
 */
export const recipeFileRouter = router({
  upload: protectedProcedure
    .input(
      z.object({
        recipeId: z.string().uuid(),
        kind: z.enum(['photo', 'source_page', 'source_pdf']),
        fullBase64: z.string().min(1).max(base64Length(largestFull)),
        thumbBase64: z.string().min(1).max(base64Length(MAX_THUMB_BYTES)).optional(),
        width: dimension.optional(),
        height: dimension.optional(),
        cookLogId: z.string().uuid().optional(),
      }),
    )
    .mutation(({ ctx, input }) =>
      addRecipeFile(ctx.householdId, ctx.session.user.id, {
        recipeId: input.recipeId,
        kind: input.kind,
        full: decode(input.fullBase64),
        ...(input.thumbBase64 ? { thumb: decode(input.thumbBase64) } : {}),
        ...(input.width ? { width: input.width } : {}),
        ...(input.height ? { height: input.height } : {}),
        ...(input.cookLogId ? { cookLogId: input.cookLogId } : {}),
      }),
    ),

  remove: protectedProcedure
    .input(z.object({ id: z.string().uuid() }))
    .mutation(({ ctx, input }) => deleteRecipeFile(ctx.householdId, input.id)),

  setCover: protectedProcedure
    .input(z.object({ recipeId: z.string().uuid(), fileId: z.string().uuid() }))
    .mutation(({ ctx, input }) => setRecipeCover(ctx.householdId, input.recipeId, input.fileId)),
});
