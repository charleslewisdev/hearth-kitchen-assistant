import { test, expect } from '@playwright/test';
import { OWNER, seedOwnerAndHousehold } from './fixtures';

// Print on the Shop tab: on paper the list is the sheet alone, with no app chrome and nothing
// already in the basket. Seeding as grocery-mvp.spec.ts explains.
test.beforeAll(async () => {
  await seedOwnerAndHousehold();
});

test('prints what is left to buy, and nothing else', async ({ page }) => {
  await page.goto('/');
  await page.getByLabel('Email address', { exact: true }).fill(OWNER.email);
  await page.getByLabel('Password', { exact: true }).fill(OWNER.password);
  await page.getByRole('button', { name: 'Sign in' }).click();
  await expect(page.getByRole('heading', { name: 'Recipes' })).toBeVisible();

  await page.goto('/shop');
  for (const staple of ['2 dozen eggs', 'paper towels', 'coffee beans']) {
    await page.getByLabel('Add a staple').fill(staple);
    await page.getByRole('button', { name: 'Add', exact: true }).click();
  }
  // Enabled once the server has confirmed each one.
  for (const name of ['eggs', 'paper towels', 'coffee beans']) {
    await expect(page.getByRole('checkbox', { name: `Check ${name}` })).toBeEnabled();
  }
  await page.getByRole('checkbox', { name: 'Check coffee beans' }).click();
  await expect(page.locator('details')).toContainText('Done (1)');

  // Labelled and reachable from the keyboard.
  const print = page.getByRole('button', { name: 'Print' });
  await print.focus();
  await expect(print).toBeFocused();

  const sheet = page.locator('[data-print-sheet]');
  await expect(sheet).toBeHidden();

  await page.emulateMedia({ media: 'print' });
  await expect(sheet).toBeVisible();
  await expect(sheet.getByRole('heading', { level: 1, includeHidden: true })).toHaveText(
    'Shopping list',
  );
  await expect(sheet).toContainText('eggs');
  await expect(sheet).toContainText('paper towels');
  await expect(sheet).not.toContainText('coffee beans');
  // The screen, its navigation included, is not printed.
  await expect(page.getByRole('navigation').first()).toBeHidden();
  await expect(page.getByLabel('Add a staple')).toBeHidden();

  await page.emulateMedia({ media: 'screen' });
  await expect(sheet).toBeHidden();
});
