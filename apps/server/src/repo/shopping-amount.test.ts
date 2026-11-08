import { describe, it, expect, beforeEach } from 'vitest';
import { resetDb } from '../../test/db';
import { createHousehold, liftHouseholdCap } from '../../test/factories';
import { createRecipe } from './recipes';
import {
  addManualItem,
  addRecipeToList,
  getActiveList,
  setChecked,
  setItemAmount,
  type ShoppingItem,
} from './shopping';

const seenOf = (item: ShoppingItem) => ({ quantity: item.quantity, unit: item.unit });

async function codeOf(call: Promise<unknown>): Promise<string | null> {
  try {
    await call;
    return null;
  } catch (err) {
    return (err as { code?: string }).code ?? 'UNKNOWN';
  }
}

async function itemNamed(householdId: string, name: string, unit?: string | null) {
  const { items } = await getActiveList(householdId);
  return items.filter((i) => i.name === name && (unit === undefined || i.unit === unit));
}

describe('setItemAmount', () => {
  let a: string;

  beforeEach(async () => {
    await resetDb();
    a = await createHousehold();
  });

  it('changes a staple’s amount and unit in place', async () => {
    const eggs = await addManualItem(a, '6 eggs');
    const updated = await setItemAmount(a, eggs.id, { quantity: 1, unit: 'dozen' }, seenOf(eggs));

    expect(updated).toMatchObject({ id: eggs.id, quantity: 1, unit: 'dozen', name: 'eggs' });
    const [row] = await itemNamed(a, 'eggs');
    expect(row).toMatchObject({ id: eggs.id, quantity: 1, unit: 'dozen', source: 'manual' });
  });

  it('gives an item an amount, and takes one away', async () => {
    const towels = await addManualItem(a, 'paper towels');
    const two = await setItemAmount(a, towels.id, { quantity: 2, unit: 'package' }, seenOf(towels));
    expect(two).toMatchObject({ quantity: 2, unit: 'package' });

    const none = await setItemAmount(a, towels.id, { quantity: null, unit: null }, seenOf(two));
    expect(none).toMatchObject({ quantity: null, unit: null });
  });

  it('adds a later recipe onto the edited amount', async () => {
    const { id } = await createRecipe(a, {
      title: 'Rice Bowl',
      servings: 2,
      ingredientLines: ['1 cup rice'],
    });
    await addRecipeToList(a, id, 2);
    const [rice] = await itemNamed(a, 'rice');
    await setItemAmount(a, rice!.id, { quantity: 3, unit: 'cup' }, seenOf(rice!));

    await addRecipeToList(a, id, 2);

    const rows = await itemNamed(a, 'rice');
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ id: rice!.id, quantity: 4, unit: 'cup' });
  });

  it('merges into the same food in the new unit when the unit changes', async () => {
    const { id } = await createRecipe(a, {
      title: 'Two Butters',
      servings: 1,
      ingredientLines: ['2 tbsp butter', '1 stick butter'],
    });
    await addRecipeToList(a, id, 1);
    const [stick] = await itemNamed(a, 'butter', 'stick');
    const [tbsp] = await itemNamed(a, 'butter', 'tbsp');

    const merged = await setItemAmount(a, stick!.id, { quantity: 8, unit: 'tbsp' }, seenOf(stick!));

    // The tablespoon row takes the edit and the stick row is gone.
    expect(merged).toMatchObject({ id: tbsp!.id, quantity: 10, unit: 'tbsp' });
    const rows = await itemNamed(a, 'butter');
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ id: tbsp!.id, quantity: 10, unit: 'tbsp' });
  });

  it('merges into the same food with no unit, and never merges an amount taken away', async () => {
    const { id } = await createRecipe(a, {
      title: 'Lemons',
      servings: 1,
      ingredientLines: ['2 lemons', '1 bag lemons', '1 jar lemons'],
    });
    await addRecipeToList(a, id, 1);
    const [bare] = await itemNamed(a, 'lemons', null);
    const [bag] = await itemNamed(a, 'lemons', 'bag');
    const [jar] = await itemNamed(a, 'lemons', 'jar');

    const merged = await setItemAmount(a, bag!.id, { quantity: 6, unit: null }, seenOf(bag!));
    expect(merged).toMatchObject({ id: bare!.id, quantity: 8, unit: null });

    // Clearing an amount leaves the row on its own, with no amount.
    const cleared = await setItemAmount(a, jar!.id, { quantity: null, unit: null }, seenOf(jar!));
    expect(cleared).toMatchObject({ id: jar!.id, quantity: null, unit: null });
    expect(await itemNamed(a, 'lemons')).toHaveLength(2);
  });

  it('does not merge a changed unit into a checked-off row or a staple', async () => {
    const { id } = await createRecipe(a, {
      title: 'Two Butters',
      servings: 1,
      ingredientLines: ['2 tbsp butter', '1 stick butter'],
    });
    await addRecipeToList(a, id, 1);
    const [stick] = await itemNamed(a, 'butter', 'stick');
    const [tbsp] = await itemNamed(a, 'butter', 'tbsp');
    await setChecked(a, tbsp!.id, true);
    const staple = await addManualItem(a, '1 cup butter');

    await setItemAmount(a, stick!.id, { quantity: 8, unit: 'tbsp' }, seenOf(stick!));
    // A staple whose unit changes to match a recipe row keeps its own row too.
    await setItemAmount(a, staple.id, { quantity: 8, unit: 'tbsp' }, seenOf(staple));

    const rows = await itemNamed(a, 'butter', 'tbsp');
    expect(rows).toHaveLength(3);
    expect(rows.map((r) => r.quantity).sort()).toEqual([2, 8, 8]);
  });

  it('does not merge rows when only the amount changes', async () => {
    const { id } = await createRecipe(a, {
      title: 'Rice Bowl',
      servings: 1,
      ingredientLines: ['1 cup rice'],
    });
    await addRecipeToList(a, id, 1);
    const [first] = await itemNamed(a, 'rice');
    // A second unchecked row of the same food and unit: what un-ticking a bought item leaves.
    await setChecked(a, first!.id, true);
    await addRecipeToList(a, id, 1);
    await setChecked(a, first!.id, false);
    const [, second] = await itemNamed(a, 'rice');

    await setItemAmount(a, second!.id, { quantity: 2, unit: 'cup' }, seenOf(second!));

    const rows = await itemNamed(a, 'rice');
    expect(rows).toHaveLength(2);
  });

  it('refuses an edit made over an amount that has changed since', async () => {
    const { id } = await createRecipe(a, {
      title: 'Rice Bowl',
      servings: 2,
      ingredientLines: ['1 cup rice'],
    });
    await addRecipeToList(a, id, 2);
    const [seen] = await itemNamed(a, 'rice');
    // Another phone adds the recipe again before this edit lands.
    await addRecipeToList(a, id, 2);

    expect(
      await codeOf(setItemAmount(a, seen!.id, { quantity: 3, unit: 'cup' }, seenOf(seen!))),
    ).toBe('CONFLICT');
    const [rice] = await itemNamed(a, 'rice');
    expect(rice).toMatchObject({ quantity: 2, unit: 'cup' });
  });

  it('lets only one of two edits made at once from the same amount win', async () => {
    const eggs = await addManualItem(a, '6 eggs');

    const results = await Promise.allSettled([
      setItemAmount(a, eggs.id, { quantity: 12, unit: null }, seenOf(eggs)),
      setItemAmount(a, eggs.id, { quantity: 18, unit: null }, seenOf(eggs)),
    ]);

    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    const refused = results.find((r) => r.status === 'rejected') as PromiseRejectedResult;
    expect((refused.reason as { code: string }).code).toBe('CONFLICT');
  });

  it('never loses a recipe added at the same moment as an edit', async () => {
    const { id } = await createRecipe(a, {
      title: 'Rice Bowl',
      servings: 1,
      ingredientLines: ['1 cup rice'],
    });
    await addRecipeToList(a, id, 1);
    const [rice] = await itemNamed(a, 'rice');

    const [edit] = await Promise.allSettled([
      setItemAmount(a, rice!.id, { quantity: 5, unit: 'cup' }, seenOf(rice!)),
      addRecipeToList(a, id, 1),
    ]);

    const [after] = await itemNamed(a, 'rice');
    // Edit first, then the add on top of it; or the add first and the edit refused.
    if (edit.status === 'fulfilled') expect(after!.quantity).toBe(6);
    else expect(after!.quantity).toBe(2);
  });

  it('accepts the same edit twice, as a resent request would', async () => {
    const eggs = await addManualItem(a, '6 eggs');
    const target = { quantity: 12, unit: null };
    await setItemAmount(a, eggs.id, target, seenOf(eggs));

    const again = await setItemAmount(a, eggs.id, target, seenOf(eggs));
    expect(again).toMatchObject({ id: eggs.id, quantity: 12, unit: null });
  });

  it('is NOT_FOUND for an item that is gone or in another household', async () => {
    await liftHouseholdCap();
    const b = await createHousehold();
    const eggs = await addManualItem(a, '6 eggs');

    expect(await codeOf(setItemAmount(b, eggs.id, { quantity: 1, unit: null }, seenOf(eggs)))).toBe(
      'NOT_FOUND',
    );
    expect(
      await codeOf(
        setItemAmount(
          a,
          '00000000-0000-4000-8000-000000000000',
          { quantity: 1, unit: null },
          seenOf(eggs),
        ),
      ),
    ).toBe('NOT_FOUND');
    const [row] = await itemNamed(a, 'eggs');
    expect(row).toMatchObject({ quantity: 6 });
  });
});
