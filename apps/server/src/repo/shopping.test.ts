import { describe, it, expect, beforeEach } from 'vitest';
import { eq } from 'drizzle-orm';
import { resetDb } from '../../test/db';
import { createHousehold, liftHouseholdCap } from '../../test/factories';
import { shoppingList, shoppingListItem } from '../db/schema';
import { withHousehold } from './tenant';
import { createRecipe, deleteRecipe, searchRecipes } from './recipes';
import {
  getActiveList,
  addRecipeToList,
  addManualItem,
  updateItem,
  setChecked,
  removeItem,
  clearChecked,
} from './shopping';

describe('shopping-list repository (active list)', () => {
  beforeEach(async () => {
    await resetDb();
  });

  it('creates exactly one list on first access and reuses it on the next', async () => {
    const a = await createHousehold();

    const first = await getActiveList(a);
    expect(first.list).toBeDefined();
    expect(first.list.householdId).toBe(a);
    expect(first.items).toHaveLength(0);

    const second = await getActiveList(a);
    expect(second.list.id).toBe(first.list.id);

    // Only one shopping_list row exists for the household.
    const rows = await withHousehold(a, (tx) =>
      tx.select().from(shoppingList).where(eq(shoppingList.householdId, a)),
    );
    expect(rows).toHaveLength(1);
  });
});

describe('shopping-list repository (add recipe: scaling)', () => {
  beforeEach(async () => {
    await resetDb();
  });

  it('scales linear quantities and leaves "to taste" unquantified', async () => {
    const a = await createHousehold();
    const { id } = await createRecipe(a, {
      title: 'Broth Base',
      servings: 2,
      ingredientLines: ['1 cup broth', 'salt to taste'],
    });

    const { items } = await addRecipeToList(a, id, 4);

    const broth = items.find((i) => i.name === 'broth');
    expect(broth).toBeDefined();
    // 1 cup at 2 servings -> 2 cups at 4 servings.
    expect(broth!.quantity).toBe(2);
    expect(broth!.unit).toBe('cup');
    expect(broth!.source).toBe('recipe');
    expect(broth!.sourceRecipeId).toBe(id);

    const salt = items.find((i) => i.name === 'salt');
    expect(salt).toBeDefined();
    expect(salt!.quantity).toBeNull();
  });
});

describe('shopping-list repository (add recipe: water)', () => {
  beforeEach(async () => {
    await resetDb();
  });

  it('never puts water on the list, however the recipe describes it', async () => {
    const a = await createHousehold();
    const { id } = await createRecipe(a, {
      title: 'Bread',
      servings: 1,
      ingredientLines: [
        '3 cups flour',
        '1 1/4 cups warm tap water',
        '2 cups boiling water',
        'water',
        '1 cup sparkling water',
      ],
    });

    const { items } = await addRecipeToList(a, id, 1);

    expect(items.map((i) => i.name).sort()).toEqual(['flour', 'sparkling water']);
  });
});

describe('shopping-list repository (add recipe: aggregation)', () => {
  beforeEach(async () => {
    await resetDb();
  });

  it('sums a shared food+unit across two adds into ONE item', async () => {
    const a = await createHousehold();
    const { id } = await createRecipe(a, {
      title: 'Flour Only',
      servings: 1,
      ingredientLines: ['2 cups flour'],
    });

    await addRecipeToList(a, id, 1);
    const { items } = await addRecipeToList(a, id, 1);

    const flour = items.filter((i) => i.name === 'flour');
    expect(flour).toHaveLength(1);
    expect(flour[0]!.quantity).toBe(4); // 2 + 2
  });

  it('re-rounds a float-noisy merged sum (0.1 + 0.2 -> exactly 0.3)', async () => {
    const a = await createHousehold();
    // Scaling 1 cup flour from 10 servings down to 1 yields 0.1; 2 cups -> 0.2.
    // Both share the same food ("flour") + unit ("cup"), so the second add merges.
    const tenth = await createRecipe(a, {
      title: 'One Tenth Flour',
      servings: 10,
      ingredientLines: ['1 cup flour'],
    });
    const fifth = await createRecipe(a, {
      title: 'Two Tenths Flour',
      servings: 10,
      ingredientLines: ['2 cups flour'],
    });

    await addRecipeToList(a, tenth.id, 1); // 0.1 cup flour
    const { items } = await addRecipeToList(a, fifth.id, 1); // merge: 0.1 + 0.2

    const flour = items.filter((i) => i.name === 'flour');
    expect(flour).toHaveLength(1);
    // Without re-rounding this would be 0.30000000000000004.
    expect(flour[0]!.quantity).toBe(0.3);

    // And the stored numeric column is the clean value, not float noise.
    const rows = await withHousehold(a, (tx) =>
      tx.select().from(shoppingListItem).where(eq(shoppingListItem.foodId, flour[0]!.foodId!)),
    );
    expect(rows).toHaveLength(1);
    expect(Number(rows[0]!.quantity)).toBe(0.3);
  });

  it('keeps the same food in DIFFERENT units as TWO items', async () => {
    const a = await createHousehold();
    const { id } = await createRecipe(a, {
      title: 'Flour Two Ways',
      servings: 1,
      // "2 cups flour" (unit=cup) and "3 flour" (unit=null) — same food, different unit.
      ingredientLines: ['2 cups flour', '3 flour'],
    });

    const { items } = await addRecipeToList(a, id, 1);
    const flour = items.filter((i) => i.name === 'flour');
    expect(flour).toHaveLength(2);
    const units = flour.map((i) => i.unit);
    expect(units).toContain('cup');
    expect(units).toContain(null);
  });

  it('never merges a new add into a CHECKED-OFF item (keeps the done row, adds a fresh active one)', async () => {
    const a = await createHousehold();
    const first = await createRecipe(a, {
      title: 'Flour A',
      servings: 1,
      ingredientLines: ['2 cups flour'],
    });
    const second = await createRecipe(a, {
      title: 'Flour B',
      servings: 1,
      ingredientLines: ['3 cups flour'],
    });

    // Add recipe A -> a flour item appears, unchecked.
    const afterA = await addRecipeToList(a, first.id, 1);
    const flourA = afterA.items.find((i) => i.name === 'flour');
    expect(flourA).toBeDefined();
    expect(flourA!.quantity).toBe(2);

    // User checks the flour item off (it sinks into the "Done" group).
    await setChecked(a, flourA!.id, true);

    // Add recipe B (same food+unit) -> must NOT top up the checked row.
    await addRecipeToList(a, second.id, 1);

    const { items } = await getActiveList(a);
    const flour = items.filter((i) => i.name === 'flour');
    // Two rows now: the original checked one (unchanged) + a new active one.
    expect(flour).toHaveLength(2);

    const done = flour.find((i) => i.checked);
    expect(done).toBeDefined();
    expect(done!.id).toBe(flourA!.id); // same row
    expect(done!.quantity).toBe(2); // NOT topped up to 5

    const active = flour.find((i) => !i.checked);
    expect(active).toBeDefined();
    expect(active!.id).not.toBe(flourA!.id); // a fresh row
    expect(active!.quantity).toBe(3); // the newly-needed cups are visible
  });

  it('never merges "to taste" (null quantity) items', async () => {
    const a = await createHousehold();
    const { id } = await createRecipe(a, {
      title: 'Salt Only',
      servings: 1,
      ingredientLines: ['salt to taste'],
    });

    await addRecipeToList(a, id, 1);
    const { items } = await addRecipeToList(a, id, 1);

    const salt = items.filter((i) => i.name === 'salt');
    expect(salt).toHaveLength(2);
    expect(salt.every((i) => i.quantity === null)).toBe(true);
  });
});

describe('shopping-list repository (manual items)', () => {
  beforeEach(async () => {
    await resetDb();
  });

  it('adds a quantified staple with a resolved department', async () => {
    const a = await createHousehold();
    const item = await addManualItem(a, '2 dozen eggs');

    expect(item.source).toBe('manual');
    expect(item.quantity).toBe(2);
    expect(item.department).toBe('Dairy');
    expect(item.sourceRecipeId).toBeNull();
  });

  it('adds an unquantified item with null quantity/unit', async () => {
    const a = await createHousehold();
    const item = await addManualItem(a, 'paper towels');

    expect(item.source).toBe('manual');
    expect(item.quantity).toBeNull();
    expect(item.unit).toBeNull();
    expect(item.name).toBe('paper towels');
  });

  it('does NOT aggregate manual items into recipe items', async () => {
    const a = await createHousehold();
    const { id } = await createRecipe(a, {
      title: 'Flour Recipe',
      servings: 1,
      ingredientLines: ['2 cups flour'],
    });
    await addRecipeToList(a, id, 1);
    // A hand-added "2 cups flour" stays its own row (manual never merges).
    await addManualItem(a, '2 cups flour');

    const { items } = await getActiveList(a);
    const flour = items.filter((i) => i.name === 'flour');
    expect(flour).toHaveLength(2);
    expect(flour.some((i) => i.source === 'recipe')).toBe(true);
    expect(flour.some((i) => i.source === 'manual')).toBe(true);
  });
});

describe('shopping-list repository (mutations)', () => {
  beforeEach(async () => {
    await resetDb();
  });

  it('checks, clears checked, removes, and updates items', async () => {
    const a = await createHousehold();
    const eggs = await addManualItem(a, '2 dozen eggs');
    const towels = await addManualItem(a, 'paper towels');

    // setChecked -> reflected in getActiveList
    const checked = await setChecked(a, eggs.id, true);
    expect(checked).not.toBeNull();
    expect(checked!.checked).toBe(true);
    const afterCheck = await getActiveList(a);
    expect(afterCheck.items.find((i) => i.id === eggs.id)!.checked).toBe(true);

    // updateItem changes a scalar field
    const renamed = await updateItem(a, towels.id, { name: 'kitchen towels', quantity: 3 });
    expect(renamed).not.toBeNull();
    expect(renamed!.name).toBe('kitchen towels');
    expect(renamed!.quantity).toBe(3);

    // clearChecked removes checked items and returns the count
    const cleared = await clearChecked(a);
    expect(cleared).toBe(1);
    const afterClear = await getActiveList(a);
    expect(afterClear.items.find((i) => i.id === eggs.id)).toBeUndefined();

    // removeItem deletes
    const removed = await removeItem(a, towels.id);
    expect(removed).toBe(true);
    const afterRemove = await getActiveList(a);
    expect(afterRemove.items).toHaveLength(0);
  });
});

describe('shopping-list repository (tenant isolation)', () => {
  beforeEach(async () => {
    await resetDb();
  });

  it('household B cannot read, check, update, or delete household A items', async () => {
    // Two tenants, which the household cap forbids: isolation is the rule that must hold in
    // the world where that cap is lifted, so the test lifts it.
    await liftHouseholdCap();
    const a = await createHousehold();
    const b = await createHousehold();

    const item = await addManualItem(a, '2 dozen eggs');

    // B's active list is a different, empty list.
    const bList = await getActiveList(b);
    expect(bList.list.id).not.toBe((await getActiveList(a)).list.id);
    expect(bList.items).toHaveLength(0);

    // B cannot see A's item via a raw query (RLS).
    const rawForB = await withHousehold(b, (tx) =>
      tx.select().from(shoppingListItem).where(eq(shoppingListItem.id, item.id)),
    );
    expect(rawForB).toHaveLength(0);

    // B's mutations on A's item are no-ops.
    expect(await setChecked(b, item.id, true)).toBeNull();
    expect(await updateItem(b, item.id, { name: 'hijacked' })).toBeNull();
    expect(await removeItem(b, item.id)).toBe(false);
    expect(await clearChecked(b)).toBe(0);

    // A's item is untouched.
    const aList = await getActiveList(a);
    const aItem = aList.items.find((i) => i.id === item.id);
    expect(aItem).toBeDefined();
    expect(aItem!.name).toBe('eggs');
    expect(aItem!.checked).toBe(false);
  });
});

describe('shopping-list repository (add recipe: linked recipes)', () => {
  beforeEach(async () => {
    await resetDb();
  });

  it('adds one full batch of a linked recipe in place of the line', async () => {
    const a = await createHousehold();
    const dough = await createRecipe(a, {
      title: 'Pizza Dough',
      servings: 4,
      ingredientLines: ['500 g flour', '1 tsp yeast', '325 ml water'],
    });
    const { id } = await createRecipe(a, {
      title: 'Binulati',
      servings: 2,
      ingredientLines: ['1 pizza dough [[Pizza Dough]]', '200 g mozzarella'],
    });

    const { items } = await addRecipeToList(a, id, 2);

    expect(items.map((i) => i.name).sort()).toEqual(['flour', 'mozzarella', 'yeast']);
    const flour = items.find((i) => i.name === 'flour')!;
    expect(flour.quantity).toBe(500);
    expect(flour.sourceRecipeId).toBe(dough.id);
    expect(items.find((i) => i.name === 'mozzarella')!.sourceRecipeId).toBe(id);
  });

  it('scales the batches with the recipe and with the line quantity', async () => {
    const a = await createHousehold();
    await createRecipe(a, { title: 'Dough', servings: 4, ingredientLines: ['500 g flour'] });
    const { id } = await createRecipe(a, {
      title: 'Calzone',
      servings: 2,
      ingredientLines: ['2 doughs [[Dough]]'],
    });

    // Doubling the calzone doubles its two batches: four batches of 500 g.
    const { items } = await addRecipeToList(a, id, 4);
    expect(items.find((i) => i.name === 'flour')!.quantity).toBe(2000);
  });

  it('follows a chain of links and merges what the recipes share', async () => {
    const a = await createHousehold();
    await createRecipe(a, { title: 'Poolish', ingredientLines: ['100 g flour', '1 g yeast'] });
    await createRecipe(a, {
      title: 'Dough',
      ingredientLines: ['1 poolish [[Poolish]]', '400 g flour'],
    });
    const { id } = await createRecipe(a, { title: 'Pizza', ingredientLines: ['dough [[Dough]]'] });

    const { items } = await addRecipeToList(a, id, 1);
    expect(items.find((i) => i.name === 'flour')!.quantity).toBe(500);
    expect(items.find((i) => i.name === 'yeast')!.quantity).toBe(1);
  });

  it('adds the line itself once the linked recipe is gone', async () => {
    const a = await createHousehold();
    const dough = await createRecipe(a, { title: 'Dough', ingredientLines: ['500 g flour'] });
    const { id } = await createRecipe(a, {
      title: 'Pizza',
      ingredientLines: ['1 pizza dough [[Dough]]'],
    });
    await deleteRecipe(a, dough.id);

    const { items } = await addRecipeToList(a, id, 1);
    expect(items.map((i) => i.name)).toEqual(['pizza dough']);
  });
});

describe('shopping-list repository (add recipe: linked recipes with units and fan-out)', () => {
  beforeEach(async () => {
    await resetDb();
  });

  it('counts one batch for a linked line with a unit', async () => {
    const a = await createHousehold();
    await createRecipe(a, { title: 'Starter', ingredientLines: ['100 g flour'] });
    const { id } = await createRecipe(a, {
      title: 'Loaf',
      ingredientLines: ['250 g sourdough starter [[Starter]]'],
    });

    const { items } = await addRecipeToList(a, id, 1);
    expect(items.find((i) => i.name === 'flour')!.quantity).toBe(100);
  });

  it('stops expanding past its budget and adds the rest as lines', async () => {
    const a = await createHousehold();
    // Each level links the one below it on eight lines: 8 + 64 + 512 expansions uncapped.
    await createRecipe(a, { title: 'L0', ingredientLines: ['1 g salt'] });
    for (const [name, below] of [
      ['L1', 'L0'],
      ['L2', 'L1'],
      ['L3', 'L2'],
    ]) {
      await createRecipe(a, {
        title: name!,
        ingredientLines: Array.from({ length: 8 }, (_, i) => `${i + 1} part [[${below}]]`),
      });
    }
    const top = await searchRecipes(a, { text: 'L3' });

    const { items } = await addRecipeToList(a, top[0]!.id, 1);
    const salt = items.find((i) => i.name === 'salt');
    expect(salt).toBeDefined();
    expect(items.some((i) => i.name === 'part')).toBe(true);
  });
});
