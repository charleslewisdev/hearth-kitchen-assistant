import { describe, it, expect, beforeEach } from 'vitest';
import { resetDb } from '../../test/db';
import { createHousehold, liftHouseholdCap } from '../../test/factories';
import { createRecipe, getRecipe, updateRecipe } from './recipes';
import { deleteTag, deleteUnusedTags, listTags, mergeTags, renameTag, setTagColor } from './tags';

async function tagNamed(householdId: string, name: string) {
  const tags = await listTags(householdId);
  const found = tags.find((t) => t.name === name);
  if (!found) throw new Error(`no tag called ${name}: ${tags.map((t) => t.name).join(', ')}`);
  return found;
}

describe('the Tags screen', () => {
  beforeEach(resetDb);

  it('lists every tag by name with how many recipes carry it, unused ones included', async () => {
    const a = await createHousehold();
    const { id } = await createRecipe(a, { title: 'One', tags: ['Vegan', 'Italian'] });
    await createRecipe(a, { title: 'Two', tags: ['Italian'] });
    // Editing the tag off leaves the row behind.
    await updateRecipe(a, id, { title: 'One', tags: ['Italian'] });
    expect((await listTags(a)).map((t) => [t.name, t.uses, t.color])).toEqual([
      ['Italian', 2, null],
      ['Vegan', 0, null],
    ]);
  });

  it('renames a tag, allows a change of case, and refuses a clash with CONFLICT', async () => {
    const a = await createHousehold();
    const { slug } = await createRecipe(a, { title: 'One', tags: ['palak chicken', 'Chicken'] });
    const palak = await tagNamed(a, 'palak chicken');
    await renameTag(a, palak.id, 'Palak Chicken');
    expect((await getRecipe(a, slug))!.tags).toContain('Palak Chicken');
    await expect(renameTag(a, palak.id, 'chicken')).rejects.toMatchObject({ code: 'CONFLICT' });
  });

  it('sets a colour and clears it back to the default', async () => {
    const a = await createHousehold();
    await createRecipe(a, { title: 'One', tags: ['Vegan'] });
    const vegan = await tagNamed(a, 'Vegan');
    await setTagColor(a, vegan.id, 'plum');
    expect((await tagNamed(a, 'Vegan')).color).toBe('plum');
    await setTagColor(a, vegan.id, null);
    expect((await tagNamed(a, 'Vegan')).color).toBeNull();
  });

  it('merges one tag into another, keeping one link on a recipe that had both', async () => {
    const a = await createHousehold();
    const both = await createRecipe(a, { title: 'Both', tags: ['chicken saag', 'Indian'] });
    const one = await createRecipe(a, { title: 'One', tags: ['chicken saag'] });
    const saag = await tagNamed(a, 'chicken saag');
    const indian = await tagNamed(a, 'Indian');

    await mergeTags(a, saag.id, indian.id);
    expect((await getRecipe(a, both.slug))!.tags).toEqual(['Indian']);
    expect((await getRecipe(a, one.slug))!.tags).toEqual(['Indian']);
    expect((await listTags(a)).map((t) => [t.name, t.uses])).toEqual([['Indian', 2]]);
    await expect(mergeTags(a, indian.id, indian.id)).rejects.toMatchObject({ code: 'BAD_REQUEST' });
  });

  it('deletes a tag off its recipes, and deletes every unused tag at once', async () => {
    const a = await createHousehold();
    const { slug } = await createRecipe(a, { title: 'One', tags: ['easy', 'Pork'] });
    await deleteTag(a, (await tagNamed(a, 'easy')).id);
    expect((await getRecipe(a, slug))!.tags).toEqual(['Pork']);

    await createRecipe(a, { title: 'Two', tags: ['homemade'] }).then(({ id }) =>
      updateRecipe(a, id, { title: 'Two' }),
    );
    expect(await deleteUnusedTags(a)).toBe(1);
    expect((await listTags(a)).map((t) => t.name)).toEqual(['Pork']);
  });

  it('cannot see or touch another household’s tags', async () => {
    await liftHouseholdCap();
    const a = await createHousehold();
    const b = await createHousehold();
    await createRecipe(a, { title: 'One', tags: ['Vegan'] });
    const vegan = await tagNamed(a, 'Vegan');
    expect(await listTags(b)).toEqual([]);
    await expect(renameTag(b, vegan.id, 'Mine')).rejects.toMatchObject({ code: 'NOT_FOUND' });
    await expect(setTagColor(b, vegan.id, 'red')).rejects.toMatchObject({ code: 'NOT_FOUND' });
    expect(await deleteTag(b, vegan.id)).toBe(false);
    expect((await tagNamed(a, 'Vegan')).color).toBeNull();
  });
});
