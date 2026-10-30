import { and, eq, isNull, notInArray, sql } from 'drizzle-orm';
import type { RecipeDraft } from '@hearth/enrichment';
import { importDraft, importDraftIngredient, importDraftStep, importReading } from '../db/schema';
import { MAX_KEPT } from '../import-failures';
import { withHousehold, type Tx } from './tenant';

/**
 * The importer's first draft of a photo or PDF, kept for studying the parser.
 *
 * The import writes it before the cook sees the review screen, and saving the recipe links it
 * (`linkImportDraft`), so the draft sits beside what the cook corrected it to. An import the cook
 * abandons is never saved; those drafts are the ones capped, the newest `MAX_UNSAVED_DRAFTS` per
 * household. Nothing in the app reads drafts yet: they are read over psql.
 */

export type ImportReading = (typeof importReading.enumValues)[number];

/** Unsaved drafts kept per household: the same cap as kept failed imports. */
export const MAX_UNSAVED_DRAFTS = MAX_KEPT;

export interface KeepImportDraftInput {
  draft: RecipeDraft;
  /** The text the parser was given. */
  text: string;
  reading: ImportReading;
}

/**
 * Postgres `text` refuses NUL, which a PDF's text layer and OCR can both produce. Dropped here
 * rather than refused: the draft is kept for exactly the odd files that carry it.
 */
const noNul = (s: string) => s.replaceAll('\u0000', '');
const noNulOrNull = (s: string | null) => (s === null ? null : noNul(s));

/** Keep a draft and return its id. */
export async function keepImportDraft(
  householdId: string,
  userId: string | null,
  input: KeepImportDraftInput,
): Promise<string> {
  const { draft } = input;
  const toCheck = new Set(draft.amountsToCheck);
  return withHousehold(householdId, async (tx) => {
    const [row] = await tx
      .insert(importDraft)
      .values({
        householdId,
        createdBy: userId,
        reading: input.reading,
        sourceText: noNul(input.text),
        title: noNul(draft.title.value),
        titleConfidence: draft.title.confidence,
        titleRaw: noNulOrNull(draft.title.raw),
        servings: draft.servings.value,
        servingsConfidence: draft.servings.confidence,
        servingsRaw: noNulOrNull(draft.servings.raw),
        ingredientsConfidence: draft.ingredientLines.confidence,
        stepsConfidence: draft.steps.confidence,
        description: noNulOrNull(draft.details.description),
        prepMinutes: draft.details.prepMinutes,
        cookMinutes: draft.details.cookMinutes,
      })
      .returning({ id: importDraft.id });
    const draftId = row!.id;

    if (draft.ingredientLines.value.length > 0) {
      await tx.insert(importDraftIngredient).values(
        draft.ingredientLines.value.map((line, position) => ({
          householdId,
          draftId,
          position,
          text: noNul(line),
          amountToCheck: toCheck.has(line),
        })),
      );
    }
    if (draft.steps.value.length > 0) {
      await tx.insert(importDraftStep).values(
        draft.steps.value.map((step, position) => ({
          householdId,
          draftId,
          position,
          text: noNul(step),
        })),
      );
    }

    await pruneUnsaved(tx, householdId);
    return draftId;
  });
}

async function pruneUnsaved(tx: Tx, householdId: string): Promise<void> {
  const unsaved = and(eq(importDraft.householdId, householdId), isNull(importDraft.savedAt));
  const newest = tx
    .select({ id: importDraft.id })
    .from(importDraft)
    .where(unsaved)
    .orderBy(sql`${importDraft.createdAt} desc`, sql`${importDraft.id} desc`)
    .limit(MAX_UNSAVED_DRAFTS);
  await tx.delete(importDraft).where(and(unsaved, notInArray(importDraft.id, newest)));
}

/**
 * Point a draft at the recipe saved from it, inside the save's own transaction. Only an unsaved
 * draft of the same household is linked; any other id, including one pruned since the import, is
 * ignored. It runs in a savepoint and swallows its own failure, because the recipe is what the
 * cook asked for and the draft is only for study: a failed link must not roll the save back.
 */
export async function linkImportDraft(
  tx: Tx,
  householdId: string,
  draftId: string,
  recipeId: string,
): Promise<void> {
  await tx
    .transaction(async (savepoint) => {
      await savepoint
        .update(importDraft)
        .set({ recipeId, savedAt: sql`now()` })
        .where(
          and(
            eq(importDraft.householdId, householdId),
            eq(importDraft.id, draftId),
            isNull(importDraft.savedAt),
          ),
        );
    })
    .catch(() => undefined);
}
