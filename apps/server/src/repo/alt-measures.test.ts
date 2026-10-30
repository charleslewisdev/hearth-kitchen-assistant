import { describe, it, expect, beforeEach } from 'vitest';
import { eq } from 'drizzle-orm';
import { resetDb } from '../../test/db';
import { createHousehold } from '../../test/factories';
import { recipeIngredient } from '../db/schema';
import { withHousehold } from './tenant';
import { createRecipe, getRecipe } from './recipes';
import { backfillAltMeasures } from './alt-measures';

describe('an ingredient\'s second measure', () => {
  beforeEach(async () => {
    await resetDb();
  });

  it('is saved from the line and read back with the recipe', async () => {
    const a = await createHousehold();
    const { id } = await createRecipe(a, {
      title: 'English Muffin Toasting Bread',
      ingredientLines: ['3 cups (360g) unbleached all-purpose flour, plus more for dusting', '2 eggs'],
      steps: ['Mix.'],
    });
    const saved = await getRecipe(a, id);
    const [flour, eggs] = saved!.ingredients;
    expect(flour).toMatchObject({
      quantity: 3,
      unit: 'cup',
      altQuantity: 360,
      altUnit: 'g',
      note: 'plus more for dusting',
    });
    expect(eggs).toMatchObject({ altQuantity: null, altUnit: null });
  });

  it('is filled in for a line saved before it had a column, and only the note changes', async () => {
    const a = await createHousehold();
    const { id } = await createRecipe(a, {
      title: 'Tomato Soup',
      ingredientLines: [
        '7 cups (1,587 g) tomato sauce',
        '1 tablespoon (15 g) plus 2 teaspoons (10 g) sea salt',
      ],
      steps: ['Simmer.'],
    });
    // As migration 0014 found it: the grams in the note and no second measure.
    await withHousehold(a, async (tx) => {
      await tx
        .update(recipeIngredient)
        .set({ altQuantity: null, altUnit: null, note: 'canned; 1,587 g' })
        .where(eq(recipeIngredient.position, 0));
    });

    expect(await backfillAltMeasures()).toBe(1);
    const [sauce, salt] = (await getRecipe(a, id))!.ingredients;
    // The rest of the note is kept as saved, even though the line itself says nothing of it.
    expect(sauce).toMatchObject({
      quantity: 7,
      unit: 'cup',
      altQuantity: 1587,
      altUnit: 'g',
      note: 'canned',
    });
    // Two metric asides say more than one second measure can: left as it was.
    expect(salt).toMatchObject({ altQuantity: null, note: '15 g; 10 g; plus 2 teaspoons' });

    // A second start finds nothing more to do.
    expect(await backfillAltMeasures()).toBe(0);
  });
});
