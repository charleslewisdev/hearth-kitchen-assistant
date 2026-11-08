import { test, expect, type Page } from '@playwright/test';
import { OWNER, seedOwnerAndHousehold } from './fixtures';

// Changing an amount on the list in place (#12, D54): on a phone-sized screen, through a dropped
// signal, and against an edit from a second phone. Seeding as grocery-mvp.spec.ts explains.
test.beforeAll(async () => {
  await seedOwnerAndHousehold();
});

test.use({ viewport: { width: 390, height: 844 }, hasTouch: true });

async function signIn(page: Page) {
  await page.goto('/');
  await page.getByLabel('Email address', { exact: true }).fill(OWNER.email);
  await page.getByLabel('Password', { exact: true }).fill(OWNER.password);
  await page.getByRole('button', { name: 'Sign in' }).click();
  await expect(page.getByRole('heading', { name: 'Recipes' })).toBeVisible();
}

async function serverAmounts(page: Page) {
  const res = await page.request.get('/trpc/shoppingList.get');
  const body = (await res.json()) as {
    result: { data: { items: { name: string; quantity: number | null; unit: string | null }[] } };
  };
  return body.result.data.items.map(({ name, quantity, unit }) => ({ name, quantity, unit }));
}

test('change an amount in place, offline too, and hear about a clash', async ({
  page,
  context,
}) => {
  await signIn(page);
  await page.goto('/shop');
  await page.getByLabel('Add a staple').fill('6 eggs');
  await page.getByRole('button', { name: 'Add', exact: true }).click();
  const eggs = page.getByRole('button', { name: '6, change amount of eggs' });
  await expect(eggs).toBeEnabled();

  // Tap the amount, type a new one with a unit, and save.
  await eggs.tap();
  await page.getByRole('textbox', { name: 'Amount of eggs' }).fill('1 dozen');
  await page.getByRole('button', { name: 'Save' }).tap();
  await expect(page.getByRole('button', { name: '1 dozen, change amount of eggs' })).toBeVisible();
  await expect
    .poll(() => serverAmounts(page))
    .toEqual([{ name: 'eggs', quantity: 1, unit: 'dozen' }]);

  // With no signal the change shows at once and reaches the server on reconnect.
  await context.setOffline(true);
  await expect(page.getByText('You’re offline')).toBeVisible();
  await page.getByRole('button', { name: '1 dozen, change amount of eggs' }).tap();
  await page.getByRole('textbox', { name: 'Amount of eggs' }).fill('18');
  await page.getByRole('textbox', { name: 'Amount of eggs' }).press('Enter');
  await expect(page.getByRole('button', { name: '18, change amount of eggs' })).toBeVisible();
  await context.setOffline(false);
  await expect(page.getByText('You’re offline')).toHaveCount(0);
  await expect
    .poll(() => serverAmounts(page))
    .toEqual([{ name: 'eggs', quantity: 18, unit: null }]);

  // A second phone saves first; this phone's edit, started from 18, is refused and says so.
  await page.getByRole('button', { name: '18, change amount of eggs' }).tap();
  const other = await context.newPage();
  await other.goto('/shop');
  await other.getByRole('button', { name: '18, change amount of eggs' }).tap();
  await other.getByRole('textbox', { name: 'Amount of eggs' }).fill('24');
  await other.getByRole('button', { name: 'Save' }).tap();
  await expect
    .poll(() => serverAmounts(page))
    .toEqual([{ name: 'eggs', quantity: 24, unit: null }]);

  await page.getByRole('textbox', { name: 'Amount of eggs' }).fill('20');
  await page.getByRole('button', { name: 'Save' }).tap();
  await expect(page.getByRole('alert')).toContainText('changed on another phone');
  await expect(page.getByRole('button', { name: '24, change amount of eggs' })).toBeVisible();
  expect(await serverAmounts(page)).toEqual([{ name: 'eggs', quantity: 24, unit: null }]);
  await other.close();
});
