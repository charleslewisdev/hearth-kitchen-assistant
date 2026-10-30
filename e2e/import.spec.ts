import { fileURLToPath } from 'node:url';
import { test, expect, type Page } from '@playwright/test';
import { OWNER, seedOwnerAndHousehold } from './fixtures';

/*
  End-to-end for recipe import (C2), against the real running stack:
  sign in -> hand over a file or a paste -> review what came back -> correct a flagged field ->
  save -> find the recipe in the library.

  WHY THERE IS NO URL IMPORT IN HERE. The plan's sketch was "a checked-in fixture served
  locally", and the SSRF fetcher refuses exactly that: a page served from this machine is on a
  loopback address, which `fetch-page.ts` rejects on purpose, and it is the single most
  important rule in this milestone. Weakening it so a test could pass would be trading the
  thing being protected for a green tick. The URL path is covered by `import.test.ts` against
  the real `appRouter` (it watches a loopback URL get refused) and by `from-html.test.ts`
  against seven saved pages; what only an end-to-end run can show is a real file crossing a real
  HTTP body into a real review screen, and that is what this does.

  Seeded rather than driven through the first-boot screens, for the reasons written up in
  e2e/fixtures.ts. The seed empties the database, which is what makes this file rerunnable and
  why playwright.config.ts pins `workers: 1`.
*/

/** The PDF the enrichment suite reads. Uploading the real file is the point of doing this here. */
const COOKBOOK_PDF = fileURLToPath(
  new URL('../packages/enrichment/test/fixtures/cookbook-page.pdf', import.meta.url),
);

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

test('import a PDF, correct what was guessed, and save it', async ({ page }) => {
  await signIn(page);

  // 1. The import screen, with its permanent promise on it (D14).
  await page.goto('/import');
  await expect(page.getByRole('heading', { name: 'Add a recipe' })).toBeVisible();
  await expect(page.getByText(/Works offline\. No API key/)).toBeVisible();

  // 2. Hand over the file. `setInputFiles` puts the real bytes through the real input, so what
  //    crosses the wire is the base64 body the browser builds, not a fixture the server read.
  await page.getByLabel('PDF').setInputFiles(COOKBOOK_PDF);

  // 3. The review screen. Nothing has been written yet: this is a draft.
  await expect(page.getByRole('heading', { name: 'Check this over' })).toBeVisible({
    timeout: 30_000,
  });
  await expect(page.getByRole('heading', { name: 'What the PDF said' })).toBeVisible();
  await expect(page.getByLabel('Title')).toHaveValue('Skillet Cornbread');
  await expect(page.getByLabel('Ingredients, one per line')).toHaveValue(
    /1 1\/2 cups yellow cornmeal[\s\S]*Flaky salt, for serving/,
  );

  // 4. A PDF states nothing, so every field is flagged, and the lede says how many.
  await expect(page.getByText(/fields were worked out rather than stated/)).toBeVisible();
  const titleFlag = page.getByText('Taken from the first line of the PDF.');
  await expect(titleFlag).toBeVisible();

  // 5. Correct a flagged field. The flag goes, because the cook has now said what it should be.
  await page.getByLabel('Title').fill('Skillet Cornbread, my way');
  await expect(titleFlag).toBeHidden();

  // The meal type nothing could have known, which is the other thing review is for.
  await page.getByRole('checkbox', { name: 'dinner' }).check();

  // 6. Save. This is the ordinary `recipe.create`, the same one a typed recipe goes through.
  await page.getByRole('button', { name: 'Save recipe' }).click();

  // 7. Land on the saved recipe, with the ingredients parsed the way a typed one would be.
  await expect(page.getByRole('heading', { name: 'Skillet Cornbread, my way' })).toBeVisible();
  await expect(page).toHaveURL(/\/recipes\/skillet-cornbread-my-way/);
  await expect(page.getByRole('listitem').filter({ hasText: 'yellow cornmeal' })).toContainText(
    '1 ½ cups',
  );
  await page.getByRole('tab', { name: 'Steps' }).click();
  // Within the app: the print sheet, a sibling of #root, holds the steps too.
  await expect(page.locator('#root').getByText(/Heat the oven to 425F/)).toBeVisible();

  // 8. And it is in the library, indistinguishable from one typed by hand.
  await page.goto('/recipes');
  await expect(page.getByRole('link', { name: /Skillet Cornbread, my way/ })).toBeVisible();
});

test('import pasted text, which is the path that always works', async ({ page }) => {
  await signIn(page);
  await page.goto('/import');

  // The tile opens its field inline rather than navigating, so choosing wrong costs nothing.
  await page.getByRole('button', { name: 'Text' }).click();
  await page.getByLabel('Recipe text').fill(
    `Weeknight Lentil Soup

Serves 4

2 Tbsp olive oil
1 onion, diced
1 cup brown lentils
4 cups vegetable stock
Salt and pepper

Soften the onion in the oil over a low heat for ten minutes.

Add the lentils and the stock, bring it to a boil, then simmer for half an hour.`,
  );
  await page.getByRole('button', { name: 'Import', exact: true }).click();

  await expect(page.getByRole('heading', { name: 'Check this over' })).toBeVisible({
    timeout: 30_000,
  });
  await expect(page.getByRole('heading', { name: 'What you pasted said' })).toBeVisible();
  await expect(page.getByLabel('Title')).toHaveValue('Weeknight Lentil Soup');
  await expect(page.getByLabel('Servings')).toHaveValue('4');

  // The parser preview: the amount, the unit and the food Hearth made of a line, shown before
  // it is saved and drawn by the same `parseIngredientLine` that will store it.
  await expect(page.getByText('1 · cup · brown lentils')).toBeVisible();

  await page.getByRole('button', { name: 'Save recipe' }).click();
  await expect(page.getByRole('heading', { name: 'Weeknight Lentil Soup' })).toBeVisible();
  await expect(page.getByRole('listitem').filter({ hasText: 'brown lentils' })).toContainText(
    '1 cup',
  );

  await page.goto('/recipes');
  await expect(page.getByRole('link', { name: /Weeknight Lentil Soup/ })).toBeVisible();
});
