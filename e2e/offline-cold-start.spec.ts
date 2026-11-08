import { test, expect, type Page } from '@playwright/test';
import { PREVIEW_ORIGIN } from './env';
import { OWNER, seedOwnerAndHousehold, type SeededHousehold } from './fixtures';
import { pool } from '../apps/server/src/db/client';

/*
  A store basement (D56): the app was opened here before, signed in, and is now started from the
  home screen with no signal at all. The list must open from what this phone last saw, take ticks,
  keep them across another restart, and send them when the signal comes back.

  Runs against the production preview (PREVIEW_ORIGIN), because only a build has the service
  worker that serves the app itself with no network. Seeding as grocery-mvp.spec.ts explains.
*/
let seeded: SeededHousehold;
test.beforeAll(async () => {
  seeded = await seedOwnerAndHousehold();
});

/** Sign in on the dev origin, the one Better Auth trusts; the cookie holds on the preview too. */
async function signIn(page: Page) {
  await page.goto('/');
  await page.getByLabel('Email address', { exact: true }).fill(OWNER.email);
  await page.getByLabel('Password', { exact: true }).fill(OWNER.password);
  await page.getByRole('button', { name: 'Sign in' }).click();
  await expect(page.getByRole('heading', { name: 'Recipes' })).toBeVisible();
}

async function serverChecks(page: Page): Promise<Record<string, boolean>> {
  const res = await page.request.get(`${PREVIEW_ORIGIN}/trpc/shoppingList.get`);
  const body = (await res.json()) as {
    result: { data: { items: { name: string; checked: boolean }[] } };
  };
  return Object.fromEntries(body.result.data.items.map((i) => [i.name, i.checked]));
}

test('the list opens with no signal, takes ticks, and sends them on reconnect', async ({
  page,
  context,
}) => {
  await signIn(page);

  await page.goto(`${PREVIEW_ORIGIN}/shop`);
  for (const name of ['coffee beans', 'paper towels']) {
    await page.getByLabel('Add a staple').fill(name);
    await page.getByRole('button', { name: 'Add', exact: true }).click();
    await expect(page.getByRole('checkbox', { name: `Check ${name}` })).toBeEnabled();
  }
  // The worker has the app shell cached once it is active.
  await page.evaluate(() => navigator.serviceWorker.ready.then(() => undefined));

  await context.setOffline(true);
  await page.reload();

  await expect(page.getByRole('heading', { name: 'Shopping list' })).toBeVisible();
  await expect(page.getByRole('checkbox', { name: 'Check coffee beans' })).toBeEnabled();
  await expect(page.getByRole('status')).toContainText('Showing your list from');

  await page.getByRole('checkbox', { name: 'Check coffee beans' }).click();
  await expect(page.locator('details')).toContainText('Done (1)');

  // Closed and opened again before the signal returns: the tick is still there, still queued.
  await page.reload();
  await expect(page.getByRole('checkbox', { name: 'Uncheck coffee beans' })).toBeVisible();
  expect(await serverChecks(page)).toEqual({ 'coffee beans': false, 'paper towels': false });

  await context.setOffline(false);
  await expect
    .poll(() => serverChecks(page))
    .toEqual({ 'coffee beans': true, 'paper towels': false });
  await expect(page.getByRole('status')).toHaveCount(0);
});

test('signing out removes this phone’s copy of the list', async ({ page, context }) => {
  await signIn(page);
  await page.goto(`${PREVIEW_ORIGIN}/shop`);
  await page.getByLabel('Add a staple').fill('paper towels');
  await page.getByRole('button', { name: 'Add', exact: true }).click();
  await expect(page.getByRole('checkbox', { name: 'Check paper towels' })).toBeEnabled();
  const stored = () =>
    page.evaluate(() => Object.keys(localStorage).filter((k) => k.startsWith('hearth.offline.')));
  await expect.poll(stored).not.toEqual([]);

  // Signed out on the dev origin (the only one Better Auth takes a sign-out from), which shares
  // nothing in localStorage with the preview; so sign out by hand there and check this origin
  // forgets on its next start, when the server says no one is signed in.
  const dev = await context.newPage();
  await dev.goto('/more');
  await dev.getByRole('button', { name: 'Sign out' }).click();
  await expect(dev.getByRole('button', { name: 'Sign in' })).toBeVisible();
  await expect
    .poll(() =>
      dev.evaluate(() => Object.keys(localStorage).filter((k) => k.startsWith('hearth.offline.'))),
    )
    .toEqual([]);

  await page.reload();
  await expect(page.getByRole('button', { name: 'Sign in' })).toBeVisible();
  await expect.poll(stored).toEqual([]);

  // And with no signal, a signed-out phone shows the sign-in screen, not the old list.
  await context.setOffline(true);
  await page.reload();
  await expect(page.getByRole('button', { name: 'Sign in' })).toBeVisible();
  await expect(page.getByText('paper towels')).toHaveCount(0);
});

test('a change queued offline is refused once the household is gone, and the copy goes', async ({
  page,
  context,
}) => {
  await signIn(page);
  await page.goto(`${PREVIEW_ORIGIN}/shop`);
  await page.getByLabel('Add a staple').fill('oat milk');
  await page.getByRole('button', { name: 'Add', exact: true }).click();
  await expect(page.getByRole('checkbox', { name: 'Check oat milk' })).toBeEnabled();
  await page.evaluate(() => navigator.serviceWorker.ready.then(() => undefined));

  await context.setOffline(true);
  await page.reload();
  await page.getByRole('checkbox', { name: 'Check oat milk' }).click();
  await expect(page.getByRole('checkbox', { name: 'Uncheck oat milk' })).toBeVisible();

  // What removing a member does to their sessions (migration 0006), while this phone is away.
  const revoke = (household: string | null) =>
    pool.query('UPDATE session SET active_organization_id = $1 WHERE user_id = $2', [
      household,
      seeded.ownerId,
    ]);
  await revoke(null);
  try {
    await context.setOffline(false);
    await expect(page.getByRole('heading', { name: /household/ })).toBeVisible();
    await expect(page.getByText('oat milk')).toHaveCount(0);
    await expect
      .poll(() =>
        page.evaluate(() =>
          Object.keys(localStorage).filter((k) => k.startsWith('hearth.offline.')),
        ),
      )
      .toEqual([]);
  } finally {
    await revoke(seeded.householdId);
  }
  // The queued tick was refused, not applied late.
  expect((await serverChecks(page))['oat milk']).toBe(false);
});
