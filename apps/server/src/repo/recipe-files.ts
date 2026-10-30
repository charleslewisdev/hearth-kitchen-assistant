import { and, asc, eq, sql } from 'drizzle-orm';
import { TRPCError } from '@trpc/server';
import {
  MAX_FILES_PER_RECIPE,
  MAX_IMAGE_BYTES,
  MAX_PDF_BYTES,
  MAX_PHOTO_BYTES,
  MAX_THUMB_BYTES,
} from '@hearth/shared';
import { recipe, recipeFile } from '../db/schema';
import { removeFiles, writeFileVariant } from '../files';
import { withHousehold, type Tx } from './tenant';
import { cookLogBelongsTo } from './cook-log';

export type RecipeFileKind = 'photo' | 'source_page' | 'source_pdf';

/** A file as the recipe screen needs it: enough to lay it out and ask for its bytes. */
export interface RecipeFileView {
  id: string;
  kind: RecipeFileKind;
  width: number | null;
  height: number | null;
  position: number;
}

export interface AddRecipeFileInput {
  recipeId: string;
  kind: RecipeFileKind;
  full: Buffer;
  /** Required for a photo or a page, absent for a PDF. */
  thumb?: Buffer;
  width?: number;
  height?: number;
  /** A photo taken for this cook-log entry, which must be the same recipe's. */
  cookLogId?: string;
}

const isJpeg = (b: Buffer) => b.length > 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff;
const isPdf = (b: Buffer) => b.subarray(0, 5).toString('latin1') === '%PDF-';

/**
 * What a kind may hold, checked on the bytes rather than on anything the client said about
 * them. Images arrive as JPEG because the browser re-encodes every photo before sending it,
 * which is also what strips its EXIF (a phone photo's GPS position included).
 */
function checkBytes(input: AddRecipeFileInput): string {
  const refuse = (message: string) => new TRPCError({ code: 'BAD_REQUEST', message });
  if (input.kind === 'source_pdf') {
    if (!isPdf(input.full)) throw refuse('That file is not a PDF.');
    if (input.full.length > MAX_PDF_BYTES) throw refuse('That PDF is too large to keep.');
    if (input.thumb) throw refuse('A PDF has no thumbnail.');
    return 'application/pdf';
  }
  const cap = input.kind === 'photo' ? MAX_PHOTO_BYTES : MAX_IMAGE_BYTES;
  if (!isJpeg(input.full)) throw refuse('That photo could not be read. Try a JPEG.');
  if (input.full.length > cap) throw refuse('That photo is too large.');
  if (!input.thumb || !isJpeg(input.thumb) || input.thumb.length > MAX_THUMB_BYTES) {
    throw refuse('That photo arrived without a usable thumbnail.');
  }
  return 'image/jpeg';
}

async function ownRecipe(tx: Tx, householdId: string, recipeId: string) {
  const [row] = await tx
    .select({ id: recipe.id, coverFileId: recipe.coverFileId })
    .from(recipe)
    .where(and(eq(recipe.householdId, householdId), eq(recipe.id, recipeId)));
  if (!row) throw new TRPCError({ code: 'NOT_FOUND', message: 'Recipe not found' });
  return row;
}

/**
 * Keep a file with a recipe. The row and the bytes go together: the bytes are written inside
 * the transaction that inserts the row, so a failed write rolls the row back, and a row never
 * points at nothing. A recipe's first photo becomes its cover.
 */
export async function addRecipeFile(
  householdId: string,
  userId: string | null,
  input: AddRecipeFileInput,
  dataDir?: string,
): Promise<RecipeFileView> {
  const contentType = checkBytes(input);
  return withHousehold(householdId, async (tx) => {
    const owner = await ownRecipe(tx, householdId, input.recipeId);
    if (input.cookLogId !== undefined) {
      const fits =
        input.kind === 'photo' &&
        (await cookLogBelongsTo(tx, householdId, input.cookLogId, input.recipeId));
      if (!fits) throw new TRPCError({ code: 'NOT_FOUND', message: 'Cook log entry not found' });
    }
    const [counts] = await tx
      .select({
        total: sql<number>`count(*)::int`,
        next: sql<number>`coalesce(max(${recipeFile.position}) filter (where ${recipeFile.kind} = ${input.kind}), -1)::int + 1`,
      })
      .from(recipeFile)
      .where(eq(recipeFile.recipeId, input.recipeId));
    if ((counts?.total ?? 0) >= MAX_FILES_PER_RECIPE) {
      throw new TRPCError({
        code: 'BAD_REQUEST',
        message: `A recipe keeps at most ${MAX_FILES_PER_RECIPE} photos and pages.`,
      });
    }
    const [row] = await tx
      .insert(recipeFile)
      .values({
        householdId,
        recipeId: input.recipeId,
        kind: input.kind,
        contentType,
        width: input.width ?? null,
        height: input.height ?? null,
        bytes: input.full.length,
        position: counts?.next ?? 0,
        createdBy: userId,
        cookLogId: input.cookLogId ?? null,
      })
      .returning();
    const file = row!;
    await writeFileVariant(householdId, file.id, 'full', input.full, dataDir);
    if (input.thumb) await writeFileVariant(householdId, file.id, 'thumb', input.thumb, dataDir);

    if (input.kind === 'photo' && owner.coverFileId === null) {
      await tx
        .update(recipe)
        .set({ coverFileId: file.id })
        .where(and(eq(recipe.householdId, householdId), eq(recipe.id, input.recipeId)));
    }
    return toView(file);
  });
}

function toView(row: typeof recipeFile.$inferSelect): RecipeFileView {
  return {
    id: row.id,
    kind: row.kind,
    width: row.width,
    height: row.height,
    position: row.position,
  };
}

/** A recipe's files, photos then pages then the PDF, each in its own order. */
export async function listRecipeFiles(tx: Tx, recipeId: string): Promise<RecipeFileView[]> {
  const rows = await tx
    .select()
    .from(recipeFile)
    .where(eq(recipeFile.recipeId, recipeId))
    .orderBy(asc(recipeFile.kind), asc(recipeFile.position), asc(recipeFile.createdAt));
  return rows.map(toView);
}

/** One file's row, for serving its bytes: null when it is not this household's. */
export async function findRecipeFile(householdId: string, id: string) {
  return withHousehold(householdId, async (tx) => {
    const [row] = await tx
      .select()
      .from(recipeFile)
      .where(and(eq(recipeFile.householdId, householdId), eq(recipeFile.id, id)));
    return row ?? null;
  });
}

/**
 * Delete a file. When it was the cover, the recipe's oldest remaining photo takes over, so a
 * recipe that still has photos keeps showing one. The bytes go after the row has.
 */
export async function deleteRecipeFile(
  householdId: string,
  id: string,
  dataDir?: string,
): Promise<boolean> {
  const deleted = await withHousehold(householdId, async (tx) => {
    const [row] = await tx
      .delete(recipeFile)
      .where(and(eq(recipeFile.householdId, householdId), eq(recipeFile.id, id)))
      .returning();
    if (!row) return null;
    const owner = await ownRecipe(tx, householdId, row.recipeId);
    if (owner.coverFileId === null && row.kind === 'photo') {
      const [next] = await tx
        .select({ id: recipeFile.id })
        .from(recipeFile)
        .where(and(eq(recipeFile.recipeId, row.recipeId), eq(recipeFile.kind, 'photo')))
        .orderBy(asc(recipeFile.position), asc(recipeFile.createdAt))
        .limit(1);
      if (next) {
        await tx
          .update(recipe)
          .set({ coverFileId: next.id })
          .where(and(eq(recipe.householdId, householdId), eq(recipe.id, row.recipeId)));
      }
    }
    return row;
  });
  if (!deleted) return false;
  await removeFiles(householdId, [deleted.id], dataDir);
  return true;
}

/** Make one of a recipe's own photos its cover. */
export async function setRecipeCover(
  householdId: string,
  recipeId: string,
  fileId: string,
): Promise<void> {
  return withHousehold(householdId, async (tx) => {
    await ownRecipe(tx, householdId, recipeId);
    const [file] = await tx
      .select({ id: recipeFile.id })
      .from(recipeFile)
      .where(
        and(
          eq(recipeFile.recipeId, recipeId),
          eq(recipeFile.id, fileId),
          eq(recipeFile.kind, 'photo'),
        ),
      );
    if (!file) throw new TRPCError({ code: 'NOT_FOUND', message: 'Photo not found' });
    await tx
      .update(recipe)
      .set({ coverFileId: fileId })
      .where(and(eq(recipe.householdId, householdId), eq(recipe.id, recipeId)));
  });
}

/** The ids of a recipe's files, so deleting the recipe can take the bytes with it. */
export async function recipeFileIds(tx: Tx, recipeId: string): Promise<string[]> {
  const rows = await tx
    .select({ id: recipeFile.id })
    .from(recipeFile)
    .where(eq(recipeFile.recipeId, recipeId));
  return rows.map((r) => r.id);
}
