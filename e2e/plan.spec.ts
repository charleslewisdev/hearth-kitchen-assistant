import { test, expect, type Page } from '@playwright/test';
import { OWNER, seedOwnerAndHousehold } from './fixtures';

// The planner's reason to exist: two recipes planned for this week become one shopping list,
// with a shared ingredient merged across them. Seeding as grocery-mvp.spec.ts explains.
test.beforeAll(async () => {
  await seedOwnerAndHousehold();
});

async function createRecipe(page: Page, title: string, ingredients: string) {
  await page.goto('/recipes/new');
  await page.getByLabel('Title').fill(title);
  await page.getByLabel('Servings').fill('2');
  await page.getByLabel('Ingredients, one per line').fill(ingredients);
  await page.getByRole('textbox', { name: 'Step 1' }).fill('Cook it.');
  await page.getByRole('button', { name: 'Save' }).click();
  await expect(page.getByRole('heading', { name: title })).toBeVisible();
}

async function planToday(page: Page, meal: 'Lunch' | 'Dinner', title: string) {
  // The Plan screen's day is the browser's local day, which is also what this reads.
  const weekday = new Date().toLocaleDateString('en-US', { weekday: 'long' });
  await page.getByRole('button', { name: `Add to ${weekday} ${meal}` }).click();
  const sheet = page.getByRole('dialog');
  await sheet.getByLabel('Search your recipes').fill(title);
  await sheet.getByRole('button', { name: new RegExp(title) }).click();
  await sheet.getByRole('button', { name: 'Add to plan' }).click();
  await expect(sheet).toHaveCount(0);
}

test('plan a week and build the shopping list from it', async ({ page }) => {
  await page.goto('/');
  await page.getByLabel('Email address', { exact: true }).fill(OWNER.email);
  await page.getByLabel('Password', { exact: true }).fill(OWNER.password);
  await page.getByRole('button', { name: 'Sign in' }).click();
  await expect(page.getByRole('heading', { name: 'Recipes' })).toBeVisible();

  await createRecipe(page, 'Plan Soup', '1 cup rice\n2 parsnips');
  await createRecipe(page, 'Plan Pilaf', '2 cups rice');

  await page.goto('/plan');
  await expect(page.getByRole('heading', { name: 'Plan', exact: true })).toBeVisible();
  await planToday(page, 'Lunch', 'Plan Soup');
  await planToday(page, 'Dinner', 'Plan Pilaf');

  const build = page.getByRole('button', { name: /Build shopping list \(2 new\)/ });
  await build.click();
  await expect(page.getByRole('status')).toContainText('Added 2 meals to your list.');
  await expect(page.getByRole('button', { name: /Build shopping list/ })).toBeDisabled();

  await page.goto('/shop');
  const rice = page.getByRole('listitem').filter({ hasText: 'rice' });
  await expect(rice).toHaveCount(1);
  await expect(rice).toContainText(/3 cups?/);
});
