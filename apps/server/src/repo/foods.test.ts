import { describe, it, expect, beforeEach } from 'vitest';
import { resetDb } from '../../test/db';
import { createHousehold, liftHouseholdCap } from '../../test/factories';
import { food } from '../db/schema';
import { withHousehold } from './tenant';
import { findOrCreateFood, searchFoods, FOOD_SUGGESTION_LIMIT } from './foods';

describe('food repository (tenant isolation)', () => {
  beforeEach(async () => {
    await resetDb();
  });

  it('findOrCreateFood normalizes the name and assigns a department', async () => {
    const a = await createHousehold();
    const f = await withHousehold(a, (tx) => findOrCreateFood(tx, a, 'Tomatoes'));
    expect(f.name).toBe('Tomatoes');
    expect(f.normalizedName).toBe('tomato');
    expect(f.department).toBe('Produce');
    expect(f.householdId).toBe(a);
  });

  it('dedupes by normalized name within a household', async () => {
    const a = await createHousehold();
    const first = await withHousehold(a, (tx) => findOrCreateFood(tx, a, 'Tomatoes'));
    const second = await withHousehold(a, (tx) => findOrCreateFood(tx, a, 'tomato'));
    expect(second.id).toBe(first.id);

    const rows = await withHousehold(a, (tx) => tx.select().from(food));
    expect(rows).toHaveLength(1);
  });

  it('keeps foods separate per household and blocks cross-household reads', async () => {
    // Two tenants, which the household cap forbids: isolation is the rule that must hold in
    // the world where that cap is lifted, so the test lifts it.
    await liftHouseholdCap();
    const a = await createHousehold();
    const b = await createHousehold();
    const fa = await withHousehold(a, (tx) => findOrCreateFood(tx, a, 'tomato'));
    const fb = await withHousehold(b, (tx) => findOrCreateFood(tx, b, 'tomato'));
    expect(fa.id).not.toBe(fb.id);

    // RLS: household B sees only its own food, even with no app-layer filter.
    const rowsForB = await withHousehold(b, (tx) => tx.select().from(food));
    expect(rowsForB).toHaveLength(1);
    expect(rowsForB[0]!.id).toBe(fb.id);
  });
});

describe('food repository (prefix suggestions)', () => {
  beforeEach(async () => {
    await resetDb();
  });

  async function seedFoods(householdId: string, names: string[]) {
    for (const name of names) {
      await withHousehold(householdId, (tx) => findOrCreateFood(tx, householdId, name));
    }
  }

  it('matches on the canonical name by prefix, alphabetically', async () => {
    const a = await createHousehold();
    await seedFoods(a, ['Tomatoes', 'Tomato paste', 'Onion', 'Tofu']);

    expect((await searchFoods(a, 'tom')).map((f) => f.name)).toEqual(['Tomatoes', 'Tomato paste']);
    // The plural a cook types is normalized the same way the stored name was, so it still hits -
    // and so does everything else under that prefix, which is what an autocomplete is for.
    expect((await searchFoods(a, 'Tomatoes')).map((f) => f.normalizedName)).toEqual([
      'tomato',
      'tomato paste',
    ]);
  });

  it('returns nothing for a blank query rather than the whole pantry', async () => {
    const a = await createHousehold();
    await seedFoods(a, ['Tomatoes', 'Onion']);

    expect(await searchFoods(a, '')).toEqual([]);
    expect(await searchFoods(a, '   ')).toEqual([]);
  });

  it('caps the suggestions it returns', async () => {
    const a = await createHousehold();
    await seedFoods(
      a,
      Array.from({ length: FOOD_SUGGESTION_LIMIT + 5 }, (_, i) => `Bean variety ${i}`),
    );

    expect(await searchFoods(a, 'bean')).toHaveLength(FOOD_SUGGESTION_LIMIT);
  });

  it("never suggests another household's foods", async () => {
    await liftHouseholdCap();
    const a = await createHousehold();
    const b = await createHousehold();
    await seedFoods(a, ['Tomatoes']);
    await seedFoods(b, ['Tomatoes']);

    const forA = await searchFoods(a, 'tom');
    const forB = await searchFoods(b, 'tom');
    expect(forA).toHaveLength(1);
    expect(forB).toHaveLength(1);
    // Same name, different rows: the ids are what prove neither side reached the other's.
    expect(forA[0]!.id).not.toBe(forB[0]!.id);
  });
});
