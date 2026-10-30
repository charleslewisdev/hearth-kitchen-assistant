import { describe, it, expect, beforeEach } from 'vitest';
import { resetDb } from '../../test/db';
import { createHousehold, liftHouseholdCap } from '../../test/factories';
import { createRecipe, deleteRecipe } from './recipes';
import { getActiveList } from './shopping';
import {
  addEntry,
  buildListForWeek,
  getWeek,
  getWeekStart,
  removeEntry,
  setWeekStart,
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
