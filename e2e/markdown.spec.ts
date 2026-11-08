import { readFileSync } from 'node:fs';
import { test, expect, type Page } from '@playwright/test';
import { OWNER, seedOwnerAndHousehold } from './fixtures';

/*
  End-to-end for Markdown export and import (D52), against the real running stack:
  paste a recipe in Hearth's Markdown format -> save it -> download it as Markdown -> delete it
  -> import the downloaded file through the Markdown tile -> download it again, and the two files
  are the same bytes. Then the whole library as a zip from the Household screen (/more).

  The recipe is invented. Seeded rather than driven through the first-boot screens, like
  import.spec.ts; the seed empties the database, which is why this file is rerunnable.
*/

const MARKDOWN = `---
hearth_format: 1
title: "Smoky Barley Bowl"
servings: 3
servings_high: 5
prep_minutes: 10
cook_minutes: 30
types: ["dinner", "side"]
tags: ["grains", "make ahead"]
rating: 4
source_name: "Invented for the end-to-end suite"
source_url: "https://example.com/barley-bowl"
---

# Smoky Barley Bowl

## Ingredients

- 1 cup (200g) pearl barley
- 2 tbsp olive oil, divided
- 1 tsp smoked paprika

## Method

1. Simmer the barley until tender.
   Drain it well.
2. Toss with the oil and paprika.

## Notes

Keeps for three days.
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

/** Save the review screen, landing on the recipe. */
async function saveReviewed(page: Page) {
  await expect(page.getByRole('heading', { name: 'What the file said' })).toBeVisible();
  // A file states everything outright: nothing is flagged.
  await expect(
    page.getByText('The file said all of this outright.', { exact: false }),
  ).toBeVisible();
  await page.getByRole('button', { name: 'Save recipe' }).click();
  await expect(page.getByRole('heading', { name: 'Smoky Barley Bowl' })).toBeVisible();
}

/** Download the recipe on screen as Markdown and read the file. */
async function downloadMarkdown(page: Page): Promise<{ name: string; text: string }> {
  const [download] = await Promise.all([
    page.waitForEvent('download'),
    page.getByRole('link', { name: 'Download as Markdown' }).click(),
  ]);
  return {
    name: download.suggestedFilename(),
    text: readFileSync((await download.path())!, 'utf8'),
  };
}

test('export a recipe as Markdown, import it back, and export the same file again', async ({
  page,
}) => {
  await signIn(page);

  // 1. Paste the Markdown into the Text tile: front matter routes it to the Markdown reader.
  await page.goto('/import');
  await page.getByRole('button', { name: /^Text/ }).click();
  await page.getByLabel('Recipe text').fill(MARKDOWN);
  await page.getByRole('button', { name: 'Import' }).click();
  await expect(page.getByLabel('Title')).toHaveValue('Smoky Barley Bowl');
  await expect(page.getByLabel('Source link')).toHaveValue('https://example.com/barley-bowl');
  // The servings range fills both boxes, so it survives the save and the export.
  await expect(page.getByLabel('Servings', { exact: true })).toHaveValue('3');
  await expect(page.getByLabel(/^Up to/)).toHaveValue('5');
  await saveReviewed(page);

  // 2. Download it. The file is the pasted text, field for field.
  const first = await downloadMarkdown(page);
  expect(first.name).toBe('smoky-barley-bowl.md');
  expect(first.text).toBe(MARKDOWN);

  // 3. Delete it, so the import below cannot be confused with the original.
  await page.getByRole('button', { name: 'Delete recipe' }).click();
  await page.getByRole('button', { name: 'Yes, delete' }).click();
  await expect(page.getByRole('heading', { name: 'Recipes' })).toBeVisible();

  // 4. Import the downloaded file through the Markdown tile.
  await page.goto('/import');
  await page.getByLabel('Markdown').setInputFiles({
    name: first.name,
    mimeType: 'text/markdown',
    buffer: Buffer.from(first.text),
  });
  await saveReviewed(page);

  // 5. Exported again, it is the same file.
  const second = await downloadMarkdown(page);
  expect(second.text).toBe(first.text);

  // 6. The whole library, as a zip, from the Household screen (/more).
  await page.goto('/more');
  const [zip] = await Promise.all([
    page.waitForEvent('download'),
    page.getByRole('link', { name: 'Export all recipes' }).click(),
  ]);
  expect(zip.suggestedFilename()).toMatch(/^hearth-recipes-\d{4}-\d{2}-\d{2}\.zip$/);
  // "PK", a zip's local file header.
  expect(
    readFileSync((await zip.path())!)
      .subarray(0, 2)
      .toString(),
  ).toBe('PK');
});
