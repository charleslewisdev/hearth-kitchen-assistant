import { and, asc, desc, eq, inArray } from 'drizzle-orm';
import { TRPCError } from '@trpc/server';
import { cookLogEntry, recipe, recipeFile } from '../db/schema';
import { withHousehold, type Tx } from './tenant';

/** One entry as the recipe screen shows it, with the photos taken for it. */
export interface CookLogView {
  id: string;
  cookedOn: string;
  /** The member who logged it, by user id; the router puts their name to it. */
  loggedById: string | null;
  servings: number | null;
  rating: number | null;
  notes: string | null;
  photoIds: string[];
}

export interface CookLogInput {
  cookedOn: string;
  servings?: number | null;
  rating?: number | null;
  notes?: string | null;
}

function notesOrNull(value: string | null | undefined): string | null {
  const trimmed = value?.trim() ?? '';
  return trimmed === '' ? null : trimmed;
}

async function ownRecipe(tx: Tx, householdId: string, recipeId: string) {
  const [row] = await tx
    .select({ id: recipe.id })
    .from(recipe)
    .where(and(eq(recipe.householdId, householdId), eq(recipe.id, recipeId)));
  if (!row) throw new TRPCError({ code: 'NOT_FOUND', message: 'Recipe not found' });
}

/** A recipe's log, most recent cook first; two on one day, the later-logged first. */
export async function listCookLog(householdId: string, recipeId: string): Promise<CookLogView[]> {
  return withHousehold(householdId, async (tx) => {
    const rows = await tx
      .select({
        id: cookLogEntry.id,
        cookedOn: cookLogEntry.cookedOn,
        loggedById: cookLogEntry.loggedBy,
        servings: cookLogEntry.servings,
        rating: cookLogEntry.rating,
        notes: cookLogEntry.notes,
      })
      .from(cookLogEntry)
      .where(and(eq(cookLogEntry.householdId, householdId), eq(cookLogEntry.recipeId, recipeId)))
      .orderBy(desc(cookLogEntry.cookedOn), desc(cookLogEntry.createdAt));
    const ids = rows.map((r) => r.id);
    const photos =
      ids.length === 0
        ? []
        : await tx
            .select({ id: recipeFile.id, entry: recipeFile.cookLogId })
            .from(recipeFile)
            .where(inArray(recipeFile.cookLogId, ids))
            .orderBy(asc(recipeFile.position), asc(recipeFile.createdAt));
    return rows.map((r) => ({
      id: r.id,
      cookedOn: r.cookedOn,
      loggedById: r.loggedById,
      servings: r.servings,
      rating: r.rating,
      notes: r.notes,
      photoIds: photos.filter((p) => p.entry === r.id).map((p) => p.id),
    }));
  });
}

export async function addCookLog(
  householdId: string,
  userId: string | null,
  recipeId: string,
  input: CookLogInput,
): Promise<{ id: string }> {
  return withHousehold(householdId, async (tx) => {
    await ownRecipe(tx, householdId, recipeId);
    const [row] = await tx
      .insert(cookLogEntry)
      .values({
        householdId,
        recipeId,
        cookedOn: input.cookedOn,
        loggedBy: userId,
        servings: input.servings ?? null,
        rating: input.rating ?? null,
        notes: notesOrNull(input.notes),
      })
      .returning({ id: cookLogEntry.id });
    return row!;
  });
}

/** Change an entry. Who logged it stays as it was: an edit is not a new cook. */
export async function updateCookLog(
  householdId: string,
  id: string,
  input: CookLogInput,
): Promise<boolean> {
  return withHousehold(householdId, async (tx) => {
    const updated = await tx
      .update(cookLogEntry)
      .set({
        cookedOn: input.cookedOn,
        servings: input.servings ?? null,
        rating: input.rating ?? null,
        notes: notesOrNull(input.notes),
      })
      .where(and(eq(cookLogEntry.householdId, householdId), eq(cookLogEntry.id, id)))
      .returning({ id: cookLogEntry.id });
    return updated.length > 0;
  });
}

/** Delete an entry. Its photos stay in the recipe's gallery. */
export async function deleteCookLog(householdId: string, id: string): Promise<boolean> {
  return withHousehold(householdId, async (tx) => {
    const deleted = await tx
      .delete(cookLogEntry)
      .where(and(eq(cookLogEntry.householdId, householdId), eq(cookLogEntry.id, id)))
      .returning({ id: cookLogEntry.id });
    return deleted.length > 0;
  });
}

/** The household's overall rating of a recipe, or `null` to clear it. */
export async function setRecipeRating(
  householdId: string,
  recipeId: string,
  rating: number | null,
): Promise<void> {
  return withHousehold(householdId, async (tx) => {
    await ownRecipe(tx, householdId, recipeId);
    await tx
      .update(recipe)
      .set({ rating })
      .where(and(eq(recipe.householdId, householdId), eq(recipe.id, recipeId)));
  });
}

/** The entry a new photo is for, checked to belong to the same recipe in the same household. */
export async function cookLogBelongsTo(
  tx: Tx,
  householdId: string,
  entryId: string,
  recipeId: string,
): Promise<boolean> {
  const [row] = await tx
    .select({ id: cookLogEntry.id })
    .from(cookLogEntry)
    .where(
      and(
        eq(cookLogEntry.householdId, householdId),
        eq(cookLogEntry.id, entryId),
        eq(cookLogEntry.recipeId, recipeId),
      ),
    );
  return row !== undefined;
}
