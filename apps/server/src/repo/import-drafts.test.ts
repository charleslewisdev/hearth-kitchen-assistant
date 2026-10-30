import { describe, it, expect, beforeEach } from 'vitest';
import { asc, eq, sql } from 'drizzle-orm';
import type { RecipeDraft } from '@hearth/enrichment';
import { resetDb } from '../../test/db';
import { createHousehold, createUser, db, liftHouseholdCap } from '../../test/factories';
import { importDraft, importDraftIngredient, importDraftStep } from '../db/schema';
import { createRecipe, deleteRecipe, getRecipe } from './recipes';
import { keepImportDraft, MAX_UNSAVED_DRAFTS } from './import-drafts';

beforeEach(resetDb);

function ocrDraft(): RecipeDraft {
  return {
    title: { value: 'Parsnip Soup', confidence: 'low', raw: 'PARSNIP SOUP' },
    servings: { value: 4, confidence: 'low', raw: 'Serves 4' },
    mealTypes: { value: [], confidence: 'low', raw: null },
    tags: { value: [], confidence: 'low', raw: null },
    ingredientLines: {
      value: ['2 lb parsnips', '½ cup cream'],
      confidence: 'low',
      raw: null,
    },
    steps: { value: ['Peel the parsnips.', 'Simmer and blend.'], confidence: 'low', raw: null },
    details: { description: 'A winter soup.', prepMinutes: 10, cookMinutes: null },
    amountsToCheck: ['½ cup cream'],
    source: { kind: 'image' },
  };
}

const OCR_TEXT = 'PARSNIP SOUP\nServes 4\n\n2 lb parsnips\n%2 cup cream\n\n1 Peel the parsnips.';

// Read as the table owner, past RLS: these tests are about what was written, not who may see it.
const draftRow = async (id: string) =>
  (await db.select().from(importDraft).where(eq(importDraft.id, id)))[0];

describe('keeping an import draft', () => {
  it('keeps the text the parser read, and what it made of it, line by line', async () => {
    const household = await createHousehold();
    const cook = await createUser('cook@example.com');
    const id = await keepImportDraft(household, cook, {
      draft: ocrDraft(),
      text: OCR_TEXT,
      reading: 'photo_ocr',
    });

    expect(await draftRow(id)).toMatchObject({
      householdId: household,
      recipeId: null,
      createdBy: cook,
      reading: 'photo_ocr',
      sourceText: OCR_TEXT,
      title: 'Parsnip Soup',
      titleConfidence: 'low',
      titleRaw: 'PARSNIP SOUP',
      savedAt: null,
      servings: 4,
      servingsRaw: 'Serves 4',
      description: 'A winter soup.',
      prepMinutes: 10,
      cookMinutes: null,
    });
    const lines = await db
      .select()
      .from(importDraftIngredient)
      .where(eq(importDraftIngredient.draftId, id))
      .orderBy(asc(importDraftIngredient.position));
    expect(lines.map((l) => [l.text, l.amountToCheck])).toEqual([
      ['2 lb parsnips', false],
      ['½ cup cream', true],
    ]);
    const steps = await db
      .select()
      .from(importDraftStep)
      .where(eq(importDraftStep.draftId, id))
      .orderBy(asc(importDraftStep.position));
    expect(steps.map((s) => s.text)).toEqual(['Peel the parsnips.', 'Simmer and blend.']);
  });

  it('keeps a draft with no ingredients or steps', async () => {
    const household = await createHousehold();
    const draft = ocrDraft();
    draft.ingredientLines.value = [];
    draft.steps.value = [];
    const id = await keepImportDraft(household, null, { draft, text: 'x', reading: 'pdf_text' });
    expect((await draftRow(id))?.reading).toBe('pdf_text');
  });

  it('drops NUL, which Postgres text refuses and a PDF text layer can carry', async () => {
    const household = await createHousehold();
    const draft = ocrDraft();
    draft.ingredientLines.value = ['2 lb pars\u0000nips'];
    const id = await keepImportDraft(household, null, {
      draft,
      text: 'PARSNIP\u0000 SOUP',
      reading: 'pdf_text',
    });
    expect((await draftRow(id))?.sourceText).toBe('PARSNIP SOUP');
    const [line] = await db
      .select()
      .from(importDraftIngredient)
      .where(eq(importDraftIngredient.draftId, id));
    expect(line?.text).toBe('2 lb parsnips');
  });
});

describe('linking a draft to the recipe saved from it', () => {
  it('links it on create, and still counts it as saved when the recipe is deleted', async () => {
    const household = await createHousehold();
    const draftId = await keepImportDraft(household, null, {
      draft: ocrDraft(),
      text: OCR_TEXT,
      reading: 'photo_ocr',
    });
    const { id } = await createRecipe(household, { title: 'Parsnip Soup', importDraftId: draftId });
    expect((await draftRow(draftId))?.recipeId).toBe(id);

    expect((await draftRow(draftId))?.savedAt).toBeInstanceOf(Date);

    await deleteRecipe(household, id);
    const after = await draftRow(draftId);
    expect(after?.recipeId).toBeNull();
    expect(after?.savedAt).toBeInstanceOf(Date);
  });

  it('saves the recipe even when linking the draft fails in the database', async () => {
    const household = await createHousehold();
    // Not a uuid, so Postgres refuses the link's UPDATE: the savepoint takes the failure.
    const { id } = await createRecipe(household, { title: 'Soup', importDraftId: 'not-a-uuid' });
    expect(await getRecipe(household, id)).toMatchObject({ title: 'Soup' });
  });

  it("ignores another household's draft, an unknown one, and one already linked", async () => {
    await liftHouseholdCap();
    const mine = await createHousehold();
    const theirs = await createHousehold();
    const theirDraft = await keepImportDraft(theirs, null, {
      draft: ocrDraft(),
      text: OCR_TEXT,
      reading: 'photo_ocr',
    });
    await createRecipe(mine, { title: 'Soup', importDraftId: theirDraft });
    expect((await draftRow(theirDraft))?.recipeId).toBeNull();

    await createRecipe(mine, {
      title: 'Soup',
      importDraftId: '00000000-0000-4000-8000-000000000000',
    });

    const myDraft = await keepImportDraft(mine, null, {
      draft: ocrDraft(),
      text: OCR_TEXT,
      reading: 'photo_ocr',
    });
    const first = await createRecipe(mine, { title: 'Soup', importDraftId: myDraft });
    await createRecipe(mine, { title: 'Soup again', importDraftId: myDraft });
    expect((await draftRow(myDraft))?.recipeId).toBe(first.id);
  });
});

describe('the cap on abandoned drafts', () => {
  it(`keeps the newest ${MAX_UNSAVED_DRAFTS} unsaved ones, and every saved one`, async () => {
    const household = await createHousehold();
    const keep = () =>
      keepImportDraft(household, null, { draft: ocrDraft(), text: 't', reading: 'photo_ocr' });

    const linkedDraft = await keep();
    await createRecipe(household, { title: 'Kept', importDraftId: linkedDraft });
    // Saved, then the recipe deleted: still not an abandoned import, so never pruned.
    const deletedDraft = await keep();
    const deleted = await createRecipe(household, { title: 'Gone', importDraftId: deletedDraft });
    await deleteRecipe(household, deleted.id);
    const oldest = await keep();
    // Backdate it, so "newest" does not hang on rows written in the same millisecond.
    await db
      .update(importDraft)
      .set({ createdAt: sql`now() - interval '1 day'` })
      .where(eq(importDraft.id, oldest));
    for (let i = 0; i < MAX_UNSAVED_DRAFTS; i++) await keep();

    const rows = await db
      .select({ id: importDraft.id, savedAt: importDraft.savedAt })
      .from(importDraft);
    expect(rows.filter((r) => r.savedAt === null)).toHaveLength(MAX_UNSAVED_DRAFTS);
    expect(rows.map((r) => r.id)).toContain(linkedDraft);
    expect(rows.map((r) => r.id)).toContain(deletedDraft);
    expect(rows.map((r) => r.id)).not.toContain(oldest);
    // Its lines went with it.
    const orphans = await db
      .select()
      .from(importDraftIngredient)
      .where(eq(importDraftIngredient.draftId, oldest));
    expect(orphans).toEqual([]);
  }, 60_000);
});
