import { test, expect } from '@playwright/test';
import { OWNER, seedOwnerAndHousehold } from './fixtures';

// A store with no signal: a tick made offline shows at once and reaches the server when the
// phone reconnects, rather than doing nothing. Seeding as grocery-mvp.spec.ts explains.
test.beforeAll(async () => {
  await seedOwnerAndHousehold();
});

test('tick items off with no signal, and they sync when it comes back', async ({ page, context }) => {
  await page.goto('/');
  await page.getByLabel('Email address', { exact: true }).fill(OWNER.email);
  await page.getByLabel('Password', { exact: true }).fill(OWNER.password);
  await page.getByRole('button', { name: 'Sign in' }).click();
  await expect(page.getByRole('heading', { name: 'Recipes' })).toBeVisible();

  await page.goto('/shop');
  await page.getByLabel('Add a staple').fill('coffee beans');
  await page.getByRole('button', { name: 'Add', exact: true }).click();
  // Enabled once the server has confirmed it, which is when it has an id to tick.
  await expect(page.getByRole('checkbox', { name: 'Check coffee beans' })).toBeEnabled();

  await context.setOffline(true);
  await expect(page.getByText('You’re offline')).toBeVisible();
  await page.getByRole('checkbox', { name: 'Check coffee beans' }).click();
  // Shown as done straight away, although nothing has reached the server.
  await expect(page.locator('details')).toContainText('Done (1)');

  await context.setOffline(false);
  await expect(page.getByText('You’re offline')).toHaveCount(0);
  // The paused change is sent on reconnect: a fresh load reads it back from the server.
  await expect
    .poll(async () => {
      const res = await page.request.get('/trpc/shoppingList.get');
      const body = (await res.json()) as { result: { data: { items: { checked: boolean }[] } } };
      return body.result.data.items.map((i) => i.checked);
    })
    .toEqual([true]);
});
