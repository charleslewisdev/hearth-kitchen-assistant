import { describe, it, expect, beforeEach } from 'vitest';
import { resetDb } from '../../test/db';
import { createHousehold, liftHouseholdCap } from '../../test/factories';
import { createRecipe, deleteRecipe } from './recipes';
import { getActiveList, setChecked, updateItem } from './shopping';
import {
  addEntry,
  buildListForWeek,
  getWeek,
  getWeekStart,
  removeEntry,
  setWeekStart,
  syncListServings,
  updateEntry,
} from './plan';

// 2026-09-23 is a Wednesday; its Sunday-start week is 09-20..09-26.
const WED = '2026-09-23';

describe('plan repository: settings', () => {
  beforeEach(async () => {
    await resetDb();
  });

  it('starts weeks on Sunday until the household says otherwise', async () => {
    const a = await createHousehold();
    expect(await getWeekStart(a)).toBe(0);
    await setWeekStart(a, 1);
    expect(await getWeekStart(a)).toBe(1);
    await setWeekStart(a, 6);
    expect(await getWeekStart(a)).toBe(6);
  });

  it('computes the week from the household setting', async () => {
    const a = await createHousehold();
    expect((await getWeek(a, WED)).start).toBe('2026-09-20');
    await setWeekStart(a, 1);
    const week = await getWeek(a, WED);
    expect(week.start).toBe('2026-09-21');
    expect(week.weekStart).toBe(1);
  });
});

describe('plan repository: entries', () => {
  beforeEach(async () => {
    await resetDb();
  });

  it('adds entries and returns only the ones inside the week, in date order', async () => {
    const a = await createHousehold();
    const soup = await createRecipe(a, { title: 'Soup', servings: 4 });
    await addEntry(a, { date: '2026-09-26', meal: 'dinner', recipeId: soup.id, servings: 2 });
    await addEntry(a, { date: '2026-09-20', meal: 'lunch', recipeId: soup.id, servings: 4 });
    // Outside the week on both sides.
    await addEntry(a, { date: '2026-09-19', meal: 'dinner', recipeId: soup.id, servings: 4 });
    await addEntry(a, { date: '2026-09-27', meal: 'dinner', recipeId: soup.id, servings: 4 });

    const { entries } = await getWeek(a, WED);
    expect(entries.map((e) => [e.date, e.meal, e.servings])).toEqual([
      ['2026-09-20', 'lunch', 4],
      ['2026-09-26', 'dinner', 2],
    ]);
    expect(entries[0]!.recipe).toEqual({ id: soup.id, slug: 'soup', title: 'Soup', servings: 4 });
    expect(entries[0]!.onList).toBe(false);
  });

  it('updates servings, day and meal, and removes', async () => {
    const a = await createHousehold();
    const soup = await createRecipe(a, { title: 'Soup', servings: 4 });
    const e = await addEntry(a, { date: WED, meal: 'dinner', recipeId: soup.id, servings: 4 });

    const moved = await updateEntry(a, e.id, { servings: 6, date: '2026-09-24', meal: 'lunch' });
    expect(moved).toMatchObject({ date: '2026-09-24', meal: 'lunch', servings: 6 });

    expect(await removeEntry(a, e.id)).toBe(true);
    expect(await removeEntry(a, e.id)).toBe(false);
    expect((await getWeek(a, WED)).entries).toHaveLength(0);
  });

  it('refuses a recipe from another household', async () => {
    await liftHouseholdCap();
    const a = await createHousehold();
    const b = await createHousehold();
    const theirs = await createRecipe(b, { title: 'Theirs' });
    await expect(
      addEntry(a, { date: WED, meal: 'dinner', recipeId: theirs.id, servings: 2 }),
    ).rejects.toMatchObject({ code: 'NOT_FOUND' });
  });

  it("cannot see, change or remove another household's entries", async () => {
    await liftHouseholdCap();
    const a = await createHousehold();
    const b = await createHousehold();
    const theirs = await createRecipe(b, { title: 'Theirs' });
    const e = await addEntry(b, { date: WED, meal: 'dinner', recipeId: theirs.id, servings: 2 });

    expect((await getWeek(a, WED)).entries).toHaveLength(0);
    expect(await updateEntry(a, e.id, { servings: 9 })).toBeNull();
    expect(await removeEntry(a, e.id)).toBe(false);
    expect((await getWeek(b, WED)).entries[0]!.servings).toBe(2);
  });

  it('drops entries when their recipe is deleted', async () => {
    const a = await createHousehold();
    const soup = await createRecipe(a, { title: 'Soup' });
    await addEntry(a, { date: WED, meal: 'dinner', recipeId: soup.id, servings: 2 });
    await deleteRecipe(a, soup.id);
    expect((await getWeek(a, WED)).entries).toHaveLength(0);
  });
});

describe('plan repository: build shopping list', () => {
  beforeEach(async () => {
    await resetDb();
  });

  it('adds the week scaled by each entry and aggregates across entries', async () => {
    const a = await createHousehold();
    const soup = await createRecipe(a, {
      title: 'Soup',
      servings: 2,
      ingredientLines: ['1 cup rice', '2 parsnips'],
    });
    const pilaf = await createRecipe(a, {
      title: 'Pilaf',
      servings: 4,
      ingredientLines: ['2 cup rice'],
    });
    await addEntry(a, { date: '2026-09-21', meal: 'dinner', recipeId: soup.id, servings: 4 });
    await addEntry(a, { date: '2026-09-22', meal: 'dinner', recipeId: pilaf.id, servings: 2 });

    expect(await buildListForWeek(a, '2026-09-20')).toEqual({ added: 2 });

    const { items } = await getActiveList(a);
    // Soup at 4 of 2 servings gives 2 cups; pilaf at 2 of 4 gives 1. One merged row.
    const rice = items.filter((i) => i.name === 'rice');
    expect(rice).toHaveLength(1);
    expect(rice[0]!.quantity).toBe(3);
    expect(items.find((i) => i.name.startsWith('parsnip'))?.quantity).toBe(4);

    const { entries } = await getWeek(a, WED);
    expect(entries.every((e) => e.onList)).toBe(true);
  });

  it('adds nothing the second time, and only new entries after the plan changes', async () => {
    const a = await createHousehold();
    const soup = await createRecipe(a, {
      title: 'Soup',
      servings: 1,
      ingredientLines: ['1 cup rice'],
    });
    await addEntry(a, { date: WED, meal: 'dinner', recipeId: soup.id, servings: 1 });
    await buildListForWeek(a, '2026-09-20');
    expect(await buildListForWeek(a, '2026-09-20')).toEqual({ added: 0 });
    expect((await getActiveList(a)).items.find((i) => i.name === 'rice')?.quantity).toBe(1);

    await addEntry(a, { date: '2026-09-24', meal: 'lunch', recipeId: soup.id, servings: 2 });
    expect(await buildListForWeek(a, '2026-09-20')).toEqual({ added: 1 });
    expect((await getActiveList(a)).items.find((i) => i.name === 'rice')?.quantity).toBe(3);
  });

  it('keeps a moved meal on the list and buys nothing again (drag between slots, #18)', async () => {
    const a = await createHousehold();
    const soup = await createRecipe(a, {
      title: 'Soup',
      servings: 1,
      ingredientLines: ['1 cup rice'],
    });
    const e = await addEntry(a, { date: WED, meal: 'dinner', recipeId: soup.id, servings: 1 });
    await buildListForWeek(a, '2026-09-20');

    const moved = await updateEntry(a, e.id, { date: '2026-09-25', meal: 'lunch' });
    expect(moved).toMatchObject({ date: '2026-09-25', meal: 'lunch', onList: true });
    expect(await buildListForWeek(a, '2026-09-20')).toEqual({ added: 0 });
    expect((await getActiveList(a)).items.find((i) => i.name === 'rice')?.quantity).toBe(1);
  });

  it('leaves other weeks alone', async () => {
    const a = await createHousehold();
    const soup = await createRecipe(a, { title: 'Soup', ingredientLines: ['1 cup rice'] });
    const next = await addEntry(a, {
      date: '2026-09-27',
      meal: 'dinner',
      recipeId: soup.id,
      servings: 1,
    });
    expect(await buildListForWeek(a, '2026-09-20')).toEqual({ added: 0 });
    expect((await getActiveList(a)).items).toHaveLength(0);

    // Moving it into the week makes it eligible.
    await updateEntry(a, next.id, { date: WED });
    expect(await buildListForWeek(a, '2026-09-20')).toEqual({ added: 1 });
  });

  it("does not build another household's entries", async () => {
    await liftHouseholdCap();
    const a = await createHousehold();
    const b = await createHousehold();
    const theirs = await createRecipe(b, { title: 'Theirs', ingredientLines: ['1 cup rice'] });
    await addEntry(b, { date: WED, meal: 'dinner', recipeId: theirs.id, servings: 1 });
    expect(await buildListForWeek(a, '2026-09-20')).toEqual({ added: 0 });
    expect((await getWeek(b, WED)).entries[0]!.onList).toBe(false);
  });
});

describe('plan repository: servings changed after the build (#12)', () => {
  beforeEach(async () => {
    await resetDb();
  });

  async function plannedSoup() {
    const a = await createHousehold();
    const soup = await createRecipe(a, {
      title: 'Soup',
      servings: 2,
      ingredientLines: ['1 cup rice', '2 onions', 'salt to taste'],
    });
    const entry = await addEntry(a, { date: WED, meal: 'dinner', recipeId: soup.id, servings: 2 });
    return { a, soup, entry };
  }

  it('remembers the servings the list holds, and shows the gap after a change', async () => {
    const { a, entry } = await plannedSoup();
    expect((await getWeek(a, WED)).entries[0]!.listServings).toBeNull();
    await buildListForWeek(a, '2026-09-20');
    expect((await getWeek(a, WED)).entries[0]!.listServings).toBe(2);

    const changed = await updateEntry(a, entry.id, { servings: 6 });
    expect(changed).toMatchObject({ servings: 6, listServings: 2 });
  });

  it('adds the difference to the list on update', async () => {
    const { a, entry } = await plannedSoup();
    await buildListForWeek(a, '2026-09-20');
    await updateEntry(a, entry.id, { servings: 6 });

    const synced = await syncListServings(a, entry.id, 'update');
    expect(synced).toMatchObject({ servings: 6, listServings: 6 });
    const { items } = await getActiveList(a);
    expect(items.filter((i) => i.name === 'rice')).toEqual([
      expect.objectContaining({ quantity: 3, unit: 'cup' }),
    ]);
    expect(items.find((i) => i.name.startsWith('onion'))?.quantity).toBe(6);
    // "to taste" does not scale and is not added again.
    expect(items.filter((i) => i.name === 'salt')).toHaveLength(1);
  });

  it('takes the difference off unchecked items and never off checked ones', async () => {
    const { a, soup, entry } = await plannedSoup();
    // A second meal keeps some rice on the list.
    await addEntry(a, { date: '2026-09-24', meal: 'lunch', recipeId: soup.id, servings: 2 });
    await buildListForWeek(a, '2026-09-20');
    const onions = (await getActiveList(a)).items.find((i) => i.name.startsWith('onion'))!;
    expect(onions.quantity).toBe(4);
    await setChecked(a, onions.id, true); // already bought

    await updateEntry(a, entry.id, { servings: 1 });
    await syncListServings(a, entry.id, 'update');

    const { items } = await getActiveList(a);
    expect(items.find((i) => i.name === 'rice')?.quantity).toBe(1.5);
    // Bought is bought: a checked item is never taken from.
    expect(items.find((i) => i.name.startsWith('onion'))).toMatchObject({
      quantity: 4,
      checked: true,
    });
  });

  it('takes the difference off an item kept in another unit of the family', async () => {
    const a = await createHousehold();
    const spoons = await createRecipe(a, {
      title: 'Roux',
      servings: 2,
      ingredientLines: ['4 tbsp flour'],
    });
    const cups = await createRecipe(a, { title: 'Bread', servings: 1, ingredientLines: ['1 cup flour'] });
    const entry = await addEntry(a, { date: WED, meal: 'dinner', recipeId: spoons.id, servings: 2 });
    await addEntry(a, { date: WED, meal: 'lunch', recipeId: cups.id, servings: 1 });
    await buildListForWeek(a, '2026-09-20');
    // 4 tbsp + 1 cup, kept in cups (D58).
    expect((await getActiveList(a)).items.find((i) => i.name === 'flour')).toMatchObject({
      quantity: 1.25,
      unit: 'cup',
    });

    await updateEntry(a, entry.id, { servings: 1 }); // 2 tbsp fewer
    await syncListServings(a, entry.id, 'update');
    expect((await getActiveList(a)).items.find((i) => i.name === 'flour')).toMatchObject({
      quantity: 1.125,
      unit: 'cup',
    });
  });

  it('removes an item whose amount reaches zero', async () => {
    const a = await createHousehold();
    const soup = await createRecipe(a, { title: 'Soup', servings: 2, ingredientLines: ['1 cup rice'] });
    const entry = await addEntry(a, { date: WED, meal: 'dinner', recipeId: soup.id, servings: 2 });
    await buildListForWeek(a, '2026-09-20');
    // Hand-edit the rice down, so taking 0.5 cup off empties it.
    const rice = (await getActiveList(a)).items.find((i) => i.name === 'rice')!;
    await updateItem(a, rice.id, { quantity: 0.5 });
    await updateEntry(a, entry.id, { servings: 1 });
    await syncListServings(a, entry.id, 'update');
    expect((await getActiveList(a)).items.find((i) => i.name === 'rice')).toBeUndefined();
  });

  it('leaves the list alone on leave, and stops asking', async () => {
    const { a, entry } = await plannedSoup();
    await buildListForWeek(a, '2026-09-20');
    await updateEntry(a, entry.id, { servings: 6 });

    expect(await syncListServings(a, entry.id, 'leave')).toMatchObject({ listServings: 6 });
    expect((await getActiveList(a)).items.find((i) => i.name === 'rice')?.quantity).toBe(1);
  });

  it('does nothing for a meal not on the list, or already in step', async () => {
    const { a, entry } = await plannedSoup();
    expect(await syncListServings(a, entry.id, 'update')).toMatchObject({ listServings: null });
    expect((await getActiveList(a)).items).toHaveLength(0);

    await buildListForWeek(a, '2026-09-20');
    await syncListServings(a, entry.id, 'update');
    expect((await getActiveList(a)).items.find((i) => i.name === 'rice')?.quantity).toBe(1);
  });
});
