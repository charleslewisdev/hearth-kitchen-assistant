import { describe, it, expect, beforeEach } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { MAX_FILES_PER_RECIPE } from '@hearth/shared';
import { resetDb } from '../../test/db';
import { createHousehold, liftHouseholdCap } from '../../test/factories';
import { createRecipe, deleteRecipe, getRecipe } from './recipes';
import { addRecipeFile, deleteRecipeFile, findRecipeFile, setRecipeCover } from './recipe-files';
import { readFileVariant } from '../files';

/** The smallest bytes each check accepts: a JPEG's and a PDF's magic numbers. */
const jpeg = (tag = 'x') =>
  Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.from(tag)]);
const pdf = () => Buffer.from('%PDF-1.7 fake');

let data: string;
beforeEach(async () => {
  await resetDb();
  data = mkdtempSync(join(tmpdir(), 'hearth-recipe-files-'));
});

const addPhoto = (householdId: string, recipeId: string, tag = 'x') =>
  addRecipeFile(
    householdId,
    null,
    { recipeId, kind: 'photo', full: jpeg(tag), thumb: jpeg('t') },
    data,
  );

describe('recipe files', () => {
  it('keeps a photo, makes the first one the cover, and lists it on the recipe', async () => {
    const a = await createHousehold();
    const { id, slug } = await createRecipe(a, { title: 'Osso Buco' });
    const first = await addPhoto(a, id, 'one');
    const second = await addPhoto(a, id, 'two');

    const recipe = await getRecipe(a, slug);
    expect(recipe!.coverFileId).toBe(first.id);
    expect(recipe!.files.map((f) => [f.kind, f.position])).toEqual([
      ['photo', 0],
      ['photo', 1],
    ]);
    expect(readFileVariant(a, second.id, 'thumb', data)).not.toBeNull();

    await setRecipeCover(a, id, second.id);
    expect((await getRecipe(a, slug))!.coverFileId).toBe(second.id);
  });

  it('hands the cover to the next photo when the cover is deleted, and removes the bytes', async () => {
    const a = await createHousehold();
    const { id, slug } = await createRecipe(a, { title: 'Soup' });
    const first = await addPhoto(a, id, 'one');
    const second = await addPhoto(a, id, 'two');

    expect(await deleteRecipeFile(a, first.id, data)).toBe(true);
    expect((await getRecipe(a, slug))!.coverFileId).toBe(second.id);
    expect(readFileVariant(a, first.id, 'full', data)).toBeNull();

    await deleteRecipeFile(a, second.id, data);
    expect((await getRecipe(a, slug))!.coverFileId).toBeNull();
  });

  it('keeps source pages and a PDF apart from the photos, never as the cover', async () => {
    const a = await createHousehold();
    const { id, slug } = await createRecipe(a, { title: 'Carnitas' });
    const page = await addRecipeFile(
      a,
      null,
      { recipeId: id, kind: 'source_page', full: jpeg(), thumb: jpeg() },
      data,
    );
    await addRecipeFile(a, null, { recipeId: id, kind: 'source_pdf', full: pdf() }, data);
    const recipe = (await getRecipe(a, slug))!;
    expect(recipe.coverFileId).toBeNull();
    expect(recipe.files.map((f) => f.kind).sort()).toEqual(['source_page', 'source_pdf']);
    await expect(setRecipeCover(a, id, page.id)).rejects.toMatchObject({ code: 'NOT_FOUND' });
  });

  it('checks the bytes, not what the client says they are', async () => {
    const a = await createHousehold();
    const { id } = await createRecipe(a, { title: 'Soup' });
    const png = Buffer.from([0x89, 0x50, 0x4e, 0x47]);
    await expect(
      addRecipeFile(a, null, { recipeId: id, kind: 'photo', full: png, thumb: jpeg() }, data),
    ).rejects.toMatchObject({ code: 'BAD_REQUEST' });
    await expect(
      addRecipeFile(a, null, { recipeId: id, kind: 'photo', full: jpeg() }, data),
    ).rejects.toMatchObject({ code: 'BAD_REQUEST' });
    await expect(
      addRecipeFile(a, null, { recipeId: id, kind: 'source_pdf', full: jpeg() }, data),
    ).rejects.toMatchObject({ code: 'BAD_REQUEST' });
  });

  it('stops at the per-recipe limit', async () => {
    const a = await createHousehold();
    const { id } = await createRecipe(a, { title: 'Soup' });
    for (let i = 0; i < MAX_FILES_PER_RECIPE; i++) await addPhoto(a, id);
    await expect(addPhoto(a, id)).rejects.toMatchObject({ code: 'BAD_REQUEST' });
  });

  it('takes the file rows with the recipe', async () => {
    const a = await createHousehold();
    const { id } = await createRecipe(a, { title: 'Soup' });
    const file = await addPhoto(a, id);
    await deleteRecipe(a, id);
    expect(await findRecipeFile(a, file.id)).toBeNull();
  });

  it('cannot reach another household’s recipe or file', async () => {
    await liftHouseholdCap();
    const a = await createHousehold();
    const b = await createHousehold();
    const { id } = await createRecipe(a, { title: 'Soup' });
    const file = await addPhoto(a, id);
    await expect(addPhoto(b, id)).rejects.toMatchObject({ code: 'NOT_FOUND' });
    expect(await findRecipeFile(b, file.id)).toBeNull();
    expect(await deleteRecipeFile(b, file.id, data)).toBe(false);
    await expect(setRecipeCover(b, id, file.id)).rejects.toMatchObject({ code: 'NOT_FOUND' });
    expect(await findRecipeFile(a, file.id)).not.toBeNull();
  });
});
