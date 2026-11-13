import { readFileSync } from 'node:fs';
import { test, expect, type Page } from '@playwright/test';
// fflate is a dependency of the server and the web app, not of the repo root, so it is reached
// through the server's own node_modules rather than added here a fourth time.
import {
  strFromU8,
  strToU8,
  unzipSync,
  zipSync,
} from '../apps/server/node_modules/fflate/esm/index.mjs';
import { OWNER, seedOwnerAndHousehold } from './fixtures';

/*
  End-to-end for the recipe zip with its photos (issue #37, D62), against the real running stack:
  build a zip of two linked recipes and a photo -> import it through the Markdown tile -> the
  link and the cover are there -> export the whole library -> the photo is in the zip and the
  Markdown names it -> import that zip again, and nothing is duplicated.

  The recipes are invented, and the photo is drawn on a canvas in the page at test time, so it is
  a JPEG the browser itself made and can certainly decode again. Seeded rather than driven
  through the first-boot screens, like markdown.spec.ts; the seed empties the database, which is
  why this file is rerunnable.
*/

const FOLDER = 'hearth-recipes-2026-01-01';

const DOUGH_MD = `---
hearth_format: 1
title: "Pizza Dough"
servings: 2
prep_minutes: 15
types: ["base"]
tags: ["bread"]
source_name: "Invented for the end-to-end suite"
---

# Pizza Dough

## Ingredients

- 300g bread flour
- 200g water
- 6g salt
- 2g instant yeast

## Method

1. Mix everything and knead until smooth.
2. Leave covered overnight in the fridge.
`;

const PIZZA_MD = `---
hearth_format: 1
title: "Pizza"
servings: 2
cook_minutes: 10
types: ["dinner"]
source_name: "Invented for the end-to-end suite"
photos: ["pizza/photo-1.jpg"]
cover: "pizza/photo-1.jpg"
---

# Pizza

## Ingredients

- 1 [[Pizza Dough]]
- 100g passata
- 125g mozzarella

## Method

1. Stretch the dough and top it.
2. Bake as hot as the oven goes.
`;

test.beforeAll(async () => {
  await seedOwnerAndHousehold();
});

async function signIn(page: Page) {
  await page.goto('/');
  await page.getByLabel('Email address', { exact: true }).fill(OWNER.email);
  await page.getByLabel('Password', { exact: true }).fill(OWNER.password);
  await page.getByRole('button', { name: 'Sign in' }).click();
  await expect(page.getByRole('heading', { name: 'Recipes' })).toBeVisible();
}

/** A small JPEG drawn by the page's own canvas, so `prepareImage` can decode it. */
async function drawJpeg(page: Page): Promise<Buffer> {
  const dataUrl = await page.evaluate(() => {
    const canvas = document.createElement('canvas');
    canvas.width = 64;
    canvas.height = 48;
    const ctx = canvas.getContext('2d')!;
    ctx.fillStyle = '#c0392b';
    ctx.fillRect(0, 0, 64, 48);
    ctx.fillStyle = '#f5d76e';
    ctx.beginPath();
    ctx.arc(32, 24, 16, 0, Math.PI * 2);
    ctx.fill();
    return canvas.toDataURL('image/jpeg', 0.9);
  });
  return Buffer.from(dataUrl.slice(dataUrl.indexOf(',') + 1), 'base64');
}

/** Give a zip to the Markdown tile, which hands it to the zip import screen. */
async function chooseZip(page: Page, name: string, bytes: Uint8Array) {
  await page.goto('/import');
  await page.getByLabel('Markdown').setInputFiles({
    name,
    mimeType: 'application/zip',
    buffer: Buffer.from(bytes),
  });
  await expect(page.getByRole('heading', { name: 'Import a recipe zip' })).toBeVisible();
}

/** The library's cards titled exactly this. */
const cards = (page: Page, title: string) =>
  page.getByRole('heading', { level: 2, name: title, exact: true });

test('import a recipe zip with a photo, export it, and import the export without duplicates', async ({
  page,
}) => {
  await signIn(page);

  // 1. A zip in Hearth's export shape: a folder, a Markdown file per recipe, and the photo
  //    under the recipe's stem. Pizza is listed first, so the import has to reorder it.
  const jpeg = await drawJpeg(page);
  expect([...jpeg.subarray(0, 3)]).toEqual([0xff, 0xd8, 0xff]);
  const zip = zipSync({
    [`${FOLDER}/pizza.md`]: strToU8(PIZZA_MD),
    [`${FOLDER}/pizza/photo-1.jpg`]: new Uint8Array(jpeg),
    [`${FOLDER}/pizza-dough.md`]: strToU8(DOUGH_MD),
  });

  // 2. The summary: two recipes, one photo, nothing skipped.
  await chooseZip(page, `${FOLDER}.zip`, zip);
  await expect(page.getByText('2 recipes, 1 photo or scan.')).toBeVisible();
  await expect(page.getByRole('region', { name: /skipped/ })).toHaveCount(0);

  // 3. Import. Both save, and nothing is reported as missing.
  await page.getByRole('button', { name: 'Import 2 recipes' }).click();
  await expect(page.getByText('Saved 2 recipes.')).toBeVisible({ timeout: 30_000 });
  await expect(page.getByRole('region', { name: 'Files not added' })).toHaveCount(0);
  await expect(page.getByRole('region', { name: 'Recipes not saved' })).toHaveCount(0);
  await expect(page.getByRole('region', { name: 'Links saved as text' })).toHaveCount(0);

  // 4. Pizza's dough is a link to the recipe, and its photo is the cover, served and decoded.
  await page.getByRole('link', { name: 'Open the Library' }).click();
  await cards(page, 'Pizza').click();
  await expect(page.getByRole('heading', { level: 1, name: 'Pizza' })).toBeVisible();
  const link = page.getByRole('link', { name: 'Made from Pizza Dough' });
  await expect(link).toBeVisible();
  await expect(link).toHaveAttribute('href', '/recipes/pizza-dough');
  const cover = page.locator('img[src^="/api/files/"]').first();
  await expect(cover).toBeVisible();
  await expect
    .poll(() => cover.evaluate((img: HTMLImageElement) => img.complete && img.naturalWidth))
    .toBeGreaterThan(0);

  // 5. The whole library, from the Household screen. The photo is in it, under Pizza's stem,
  //    and Pizza's Markdown names it as a photo and as the cover.
  await page.goto('/more');
  const [download] = await Promise.all([
    page.waitForEvent('download'),
    page.getByRole('link', { name: 'Export all recipes' }).click(),
  ]);
  const exported = new Uint8Array(readFileSync((await download.path())!));
  const entries = unzipSync(exported);
  const names = Object.keys(entries);
  const photoPath = names.find((n) => n.endsWith('/pizza/photo-1.jpg'));
  expect(photoPath, `entries: ${names.join(', ')}`).toBeDefined();
  const folder = photoPath!.slice(0, -'/pizza/photo-1.jpg'.length);
  expect(folder).toMatch(/^hearth-recipes-\d{4}-\d{2}-\d{2}$/);
  const photo = entries[photoPath!]!;
  expect(photo.length).toBeGreaterThan(0);
  expect([...photo.subarray(0, 3)]).toEqual([0xff, 0xd8, 0xff]);
  expect(names).toContain(`${folder}/pizza-dough.md`);
  const pizzaMd = strFromU8(entries[`${folder}/pizza.md`]!);
  expect(pizzaMd).toContain('photos: ["pizza/photo-1.jpg"]');
  expect(pizzaMd).toContain('cover: "pizza/photo-1.jpg"');
  // The link comes back as the editor shows it: the line's text, then the token.
  expect(pizzaMd).toMatch(/^- 1 .{0,40}\[\[Pizza Dough\]\]$/m);

  // 6. The export, imported again: both are already here, so there is nothing to do.
  await chooseZip(page, download.suggestedFilename(), exported);
  const skipped = page.getByRole('region', { name: 'Already in your library, so skipped' });
  await expect(skipped.getByRole('listitem')).toHaveCount(2);
  await expect(skipped.getByRole('listitem').filter({ hasText: /^Pizza Dough$/ })).toHaveCount(1);
  await expect(skipped.getByRole('listitem').filter({ hasText: /^Pizza$/ })).toHaveCount(1);
  await expect(page.getByText('There is nothing new to import.')).toBeVisible();
  await expect(page.getByRole('button', { name: /^Import \d/ })).toHaveCount(0);

  // And the library still holds one of each.
  await page.goto('/');
  await expect(cards(page, 'Pizza Dough')).toHaveCount(1);
  await expect(cards(page, 'Pizza')).toHaveCount(1);
});
