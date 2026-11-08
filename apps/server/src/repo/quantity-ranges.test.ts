import { describe, it, expect, beforeEach } from 'vitest';
import { eq } from 'drizzle-orm';
import { resetDb } from '../../test/db';
import { createHousehold } from '../../test/factories';
import { importDraft, recipe, recipeIngredient } from '../db/schema';
import { withHousehold } from './tenant';
import { createRecipe, getRecipe, searchRecipes, updateRecipe } from './recipes';
import { addManualItem, addRecipeToList } from './shopping';
import { backfillQuantityRanges } from './quantity-ranges';

/** The SQLSTATE of whatever a statement threw: drizzle wraps the driver's error in `cause`. */
async function sqlState(work: Promise<unknown>): Promise<string | undefined> {
  try {
    await work;
    return undefined;
  } catch (err) {
    const e = err as { code?: string; cause?: { code?: string } };
    return e.cause?.code ?? e.code;
  }
}

describe('quantity ranges on a recipe (D53)', () => {
  beforeEach(async () => {
    await resetDb();
  });

  it('saves both ends of an ingredient range and reads them back', async () => {
    const a = await createHousehold();
    const { id } = await createRecipe(a, {
      title: 'Garlic Bread',
      ingredientLines: ['2-3 cloves garlic', '4 to 5 tablespoons butter', '1 baguette'],
    });
    const saved = await getRecipe(a, id);
    expect(saved!.ingredients.map((i) => [i.quantity, i.quantityHigh, i.unit])).toEqual([
      [2, 3, 'clove'],
      [4, 5, 'tbsp'],
      [1, null, null],
    ]);
  });

  it('saves a servings range, reads it back and shows it on the card', async () => {
    const a = await createHousehold();
    const { id } = await createRecipe(a, { title: 'Chili', servings: 4, servingsHigh: 6 });
    expect(await getRecipe(a, id)).toMatchObject({ servings: 4, servingsHigh: 6 });
    const [card] = await searchRecipes(a, {});
    expect(card).toMatchObject({ servings: 4, servingsHigh: 6 });
  });

  it('stores a servings high end that does not rise as none', async () => {
    const a = await createHousehold();
    const { id } = await createRecipe(a, { title: 'Chili', servings: 4, servingsHigh: 4 });
    expect((await getRecipe(a, id))!.servingsHigh).toBeNull();
  });

  it('keeps the high end on an update that does not send it, while it is still above', async () => {
    const a = await createHousehold();
    const { id } = await createRecipe(a, { title: 'Chili', servings: 4, servingsHigh: 6 });

    await updateRecipe(a, id, { title: 'Chili', servings: 5 });
    expect(await getRecipe(a, id)).toMatchObject({ servings: 5, servingsHigh: 6 });

    // Raised to the high end or past it, the range is gone rather than upside down.
    await updateRecipe(a, id, { title: 'Chili', servings: 6 });
    expect(await getRecipe(a, id)).toMatchObject({ servings: 6, servingsHigh: null });
  });

  it('sets and clears the high end on an update that sends it', async () => {
    const a = await createHousehold();
    const { id } = await createRecipe(a, { title: 'Chili', servings: 4 });
    await updateRecipe(a, id, { title: 'Chili', servings: 4, servingsHigh: 8 });
    expect((await getRecipe(a, id))!.servingsHigh).toBe(8);
    await updateRecipe(a, id, { title: 'Chili', servings: 4, servingsHigh: null });
    expect((await getRecipe(a, id))!.servingsHigh).toBeNull();
  });
});

describe('the range columns refuse a range that does not rise (migration 0016)', () => {
  beforeEach(async () => {
    await resetDb();
  });

  it('refuses an ingredient high end at or below the low end, or with no low end', async () => {
    const a = await createHousehold();
    const { id } = await createRecipe(a, { title: 'Soup', ingredientLines: ['2 cups stock'] });
    const setHigh = (quantity: string | null, quantityHigh: string) =>
      withHousehold(a, (tx) =>
        tx
          .update(recipeIngredient)
          .set({ quantity, quantityHigh })
          .where(eq(recipeIngredient.recipeId, id)),
      );
    expect(await sqlState(setHigh('2', '2'))).toBe('23514');
    expect(await sqlState(setHigh('2', '1'))).toBe('23514');
    expect(await sqlState(setHigh(null, '3'))).toBe('23514');
    expect(await sqlState(setHigh('2', '3'))).toBeUndefined();
  });

  it('refuses a recipe or draft servings high end at or below its servings', async () => {
    const a = await createHousehold();
    const { id } = await createRecipe(a, { title: 'Soup', servings: 4 });
    expect(
      await sqlState(
        withHousehold(a, (tx) =>
          tx.update(recipe).set({ servingsHigh: 4 }).where(eq(recipe.id, id)),
        ),
      ),
    ).toBe('23514');
    expect(
      await sqlState(
        withHousehold(a, (tx) =>
          tx.insert(importDraft).values({
            householdId: a,
            reading: 'photo_ocr',
            sourceText: 'x',
            title: 'x',
            titleConfidence: 'low',
            servings: 4,
            servingsHigh: 3,
            servingsConfidence: 'low',
            ingredientsConfidence: 'low',
            stepsConfidence: 'low',
          }),
        ),
      ),
    ).toBe('23514');
  });
});

describe('a range on the shopping list (D53)', () => {
  beforeEach(async () => {
    await resetDb();
  });

  it('buys the high end, scaled from the low end of a servings range', async () => {
    const a = await createHousehold();
    const { id } = await createRecipe(a, {
      title: 'Garlic Bread',
      servings: 4,
      servingsHigh: 6,
      ingredientLines: ['2-3 cloves garlic', '1/4-1/2 cup butter'],
    });
    const { items } = await addRecipeToList(a, id, 8);
    const byName = Object.fromEntries(items.map((i) => [i.name, i.quantity]));
    // Base 4 (the low end of "Serves 4-6") to 8 doubles the high ends: 3 -> 6, 1/2 -> 1.
    expect(byName).toEqual({ garlic: 6, butter: 1 });
  });

  it('adds a range to a single amount of the same food and unit as one number', async () => {
    const a = await createHousehold();
    const first = await createRecipe(a, {
      title: 'Garlic Bread',
      servings: 2,
      ingredientLines: ['2-3 cloves garlic'],
    });
    const second = await createRecipe(a, {
      title: 'Aioli',
      servings: 2,
      ingredientLines: ['2 cloves garlic'],
    });
    await addRecipeToList(a, first.id, 2);
    const { items } = await addRecipeToList(a, second.id, 2);
    const garlic = items.filter((i) => i.name === 'garlic');
    expect(garlic).toHaveLength(1);
    expect(garlic[0]!.quantity).toBe(5);
  });

  it('buys the high end of a range typed onto the list', async () => {
    const a = await createHousehold();
    const item = await addManualItem(a, '2-3 limes');
    expect(item).toMatchObject({ name: 'limes', quantity: 3 });
  });
});

describe('backfillQuantityRanges', () => {
  beforeEach(async () => {
    await resetDb();
  });

  it('fills the high end of lines saved before it had a column, and only those it reads the same', async () => {
    const a = await createHousehold();
    const { id } = await createRecipe(a, {
      title: 'Stew',
      ingredientLines: [
        '2-3 cloves garlic',
        '4 to 5 tablespoons olive oil',
        '1 14-ounce can tomatoes',
        '2 cups stock',
        '1-2 tsp salt',
      ],
    });
    // As migration 0016 found them: no high ends. The last line was saved under a reading the
    // parser no longer gives (a hand-fixed amount, say), so it must be left alone.
    await withHousehold(a, async (tx) => {
      await tx
        .update(recipeIngredient)
        .set({ quantityHigh: null })
        .where(eq(recipeIngredient.recipeId, id));
      await tx
        .update(recipeIngredient)
        .set({ quantity: '1.5' })
        .where(eq(recipeIngredient.position, 4));
    });

    expect(await backfillQuantityRanges()).toBe(2);
    const lines = (await getRecipe(a, id))!.ingredients;
    expect(lines.map((i) => [i.quantity, i.quantityHigh])).toEqual([
      [2, 3],
      [4, 5],
      [1, null],
      [2, null],
      [1.5, null],
    ]);

    // A second start finds nothing more to do, and changes nothing.
    expect(await backfillQuantityRanges()).toBe(0);
    expect((await getRecipe(a, id))!.ingredients).toEqual(lines);
  });
});
