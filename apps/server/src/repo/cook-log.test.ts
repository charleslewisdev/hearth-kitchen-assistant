import { describe, it, expect, beforeEach } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { resetDb } from '../../test/db';
import { createHousehold, createUser, liftHouseholdCap } from '../../test/factories';
import { createRecipe, getRecipe, searchRecipes } from './recipes';
import { addCookLog, deleteCookLog, listCookLog, setRecipeRating, updateCookLog } from './cook-log';
import { addRecipeFile } from './recipe-files';

const jpeg = () => Buffer.from([0xff, 0xd8, 0xff, 0xe0, 1]);

beforeEach(resetDb);

describe('the cook log', () => {
  it('lists entries newest cook first, with who logged each', async () => {
    const a = await createHousehold();
    const cook = await createUser('cook@example.com');
    const { id } = await createRecipe(a, { title: 'Osso Buco' });
    await addCookLog(a, cook, id, { cookedOn: '2026-09-01', rating: 3, notes: ' more gremolata ' });
    await addCookLog(a, cook, id, { cookedOn: '2026-09-20', servings: 4, rating: 5 });

    const log = await listCookLog(a, id);
    expect(log.map((e) => [e.cookedOn, e.rating, e.servings, e.notes])).toEqual([
      ['2026-09-20', 5, 4, null],
      ['2026-09-01', 3, null, 'more gremolata'],
    ]);
    expect(log[0]!.loggedById).toBe(cook);
  });

  it('edits and deletes an entry, keeping its photo in the gallery', async () => {
    const a = await createHousehold();
    const { id, slug } = await createRecipe(a, { title: 'Soup' });
    const entry = await addCookLog(a, null, id, { cookedOn: '2026-09-01' });
    const data = mkdtempSync(join(tmpdir(), 'hearth-log-'));
    const photo = await addRecipeFile(
      a,
      null,
      { recipeId: id, kind: 'photo', full: jpeg(), thumb: jpeg(), cookLogId: entry.id },
      data,
    );
    expect((await listCookLog(a, id))[0]!.photoIds).toEqual([photo.id]);

    expect(await updateCookLog(a, entry.id, { cookedOn: '2026-09-02', rating: 4 })).toBe(true);
    expect((await listCookLog(a, id))[0]).toMatchObject({ cookedOn: '2026-09-02', rating: 4 });

    expect(await deleteCookLog(a, entry.id)).toBe(true);
    expect(await listCookLog(a, id)).toEqual([]);
    expect((await getRecipe(a, slug))!.files.map((f) => f.id)).toEqual([photo.id]);
  });

  it('refuses a photo for an entry of a different recipe', async () => {
    const a = await createHousehold();
    const one = await createRecipe(a, { title: 'One' });
    const two = await createRecipe(a, { title: 'Two' });
    const entry = await addCookLog(a, null, one.id, { cookedOn: '2026-09-01' });
    await expect(
      addRecipeFile(
        a,
        null,
        { recipeId: two.id, kind: 'photo', full: jpeg(), thumb: jpeg(), cookLogId: entry.id },
        mkdtempSync(join(tmpdir(), 'hearth-log-')),
      ),
    ).rejects.toMatchObject({ code: 'NOT_FOUND' });
  });

  it('gives each card its rating, how many times it was cooked and when last', async () => {
    const a = await createHousehold();
    const { id } = await createRecipe(a, { title: 'Osso Buco' });
    await createRecipe(a, { title: 'Never Cooked' });
    await setRecipeRating(a, id, 4);
    await addCookLog(a, null, id, { cookedOn: '2026-08-01' });
    await addCookLog(a, null, id, { cookedOn: '2026-09-20' });

    const cards = await searchRecipes(a);
    const osso = cards.find((c) => c.title === 'Osso Buco')!;
    expect([osso.rating, osso.cookCount, osso.lastCookedOn]).toEqual([4, 2, '2026-09-20']);
    const never = cards.find((c) => c.title === 'Never Cooked')!;
    expect([never.rating, never.cookCount, never.lastCookedOn]).toEqual([null, 0, null]);

    await setRecipeRating(a, id, null);
    expect((await searchRecipes(a)).find((c) => c.title === 'Osso Buco')!.rating).toBeNull();
  });

  it('holds ratings to 1 to 5 in the database itself', async () => {
    const a = await createHousehold();
    const { id } = await createRecipe(a, { title: 'Soup' });
    await expect(setRecipeRating(a, id, 6)).rejects.toThrow();
    await expect(addCookLog(a, null, id, { cookedOn: '2026-09-01', rating: 0 })).rejects.toThrow();
  });

  it('cannot see or change another household’s log', async () => {
    await liftHouseholdCap();
    const a = await createHousehold();
    const b = await createHousehold();
    const { id } = await createRecipe(a, { title: 'Soup' });
    const entry = await addCookLog(a, null, id, { cookedOn: '2026-09-01' });
    expect(await listCookLog(b, id)).toEqual([]);
    await expect(addCookLog(b, null, id, { cookedOn: '2026-09-01' })).rejects.toMatchObject({
      code: 'NOT_FOUND',
    });
    expect(await updateCookLog(b, entry.id, { cookedOn: '2026-01-01' })).toBe(false);
    expect(await deleteCookLog(b, entry.id)).toBe(false);
    await expect(setRecipeRating(b, id, 5)).rejects.toMatchObject({ code: 'NOT_FOUND' });
    expect(await listCookLog(a, id)).toHaveLength(1);
  });
});
