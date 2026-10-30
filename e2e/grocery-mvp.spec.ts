import { test, expect } from '@playwright/test';
import { OWNER, seedOwnerAndHousehold } from './fixtures';

// End-to-end happy path for the Grocery MVP, against the real running stack
// (Vite web -> proxied /api + /trpc -> Fastify/tRPC + Better Auth -> Postgres):
//   sign in -> create a recipe -> scale servings -> add to shopping list ->
//   add a manual staple -> check off -> clear checked.
//
// It starts signed out at the sign-in screen and no longer signs anyone up, because after
// Phase D and Phase F it cannot: sign-up returns no session (`requireEmailVerification`), there
// is no create-account affordance to click (Hearth is invite-only), and the household it used to
// create can only be created once per database (`organization_singleton_uidx`). The owner and
// the household are seeded instead - see e2e/fixtures.ts for what that does and why.
test.beforeAll(async () => {
  await seedOwnerAndHousehold();
});

test('grocery mvp happy path: recipe -> list -> staple -> check off', async ({ page }) => {
  // 1. Sign in as the household owner. The first screen is the only screen: invite-only, so
  //    there is nothing else on it to click.
  await page.goto('/');
  // `exact`, because the first-boot disclosure below the form has "Your email address" and
  // "Choose a password" on the same screen. It is closed, which hides those fields from a
  // person and not from a locator.
  await page.getByLabel('Email address', { exact: true }).fill(OWNER.email);
  await page.getByLabel('Password', { exact: true }).fill(OWNER.password);
  await page.getByRole('button', { name: 'Sign in' }).click();

  // The seeded membership is what the session opens in (`session.create.before`), so a signed-in
  // owner lands in the app shell rather than on Onboarding.
  await expect(page.getByRole('heading', { name: 'Recipes' })).toBeVisible();

  // 2. Create a recipe via /recipes/new.
  await page
    .getByRole('link', { name: /New recipe/ })
    .first()
    .click();
  await expect(page.getByRole('heading', { name: 'New recipe' })).toBeVisible();

  await page.getByLabel('Title').fill('E2E Soup');
  await page.getByLabel('Servings').fill('4');
  await page.getByRole('checkbox', { name: 'dinner' }).check();

  // One line WITH a unit, one that scales, and one "to taste".
  await page
    .getByLabel('Ingredients, one per line')
    .fill('2 cups broth\n3 cloves garlic\nsalt to taste');

  await page.getByRole('textbox', { name: 'Step 1' }).fill('Simmer the broth and garlic.');
  await page.getByRole('button', { name: /Add step/ }).click();
  await page.getByRole('textbox', { name: 'Step 2' }).fill('Season with salt and serve.');

  await page.getByRole('button', { name: 'Save' }).click();

  // 3. Land on the recipe view; verify it renders, then double servings (4 -> 8)
  //    and assert a numeric amount changed (broth 2 cups -> 4 cups).
  await expect(page.getByRole('heading', { name: 'E2E Soup' })).toBeVisible();
  await expect(page).toHaveURL(/\/recipes\/e2e-soup/);

  const brothIngredient = page.getByRole('listitem').filter({ hasText: 'broth' });
  await expect(brothIngredient).toContainText('2 cups');

  const increase = page.getByRole('button', { name: 'Increase servings' });
  await increase.click();
  await increase.click();
  await increase.click();
  await increase.click();
  await expect(page.getByLabel('Servings', { exact: true })).toHaveText('8');
  await expect(brothIngredient).toContainText('4 cups');

  // 4. Add the (scaled) recipe to the shopping list.
  await page.getByRole('button', { name: 'Add to list' }).click();
  await expect(page.getByRole('status')).toContainText('Added to your shopping list.');

  // 5. Go to the shopping list; assert department-grouped recipe items appear and
  //    the broth reflects the scaled amount (4 cups, not the base 2).
  await page.goto('/shop');
  await expect(page.getByRole('heading', { name: 'Shopping list' })).toBeVisible();

  await expect(page.getByRole('heading', { name: 'Produce' })).toBeVisible(); // garlic
  await expect(page.getByRole('heading', { name: 'Pantry' })).toBeVisible(); // salt
  await expect(page.getByText('garlic')).toBeVisible();
  await expect(page.getByText('salt')).toBeVisible();

  const brothItem = page.getByRole('listitem').filter({ hasText: 'broth' });
  await expect(brothItem).toBeVisible();
  await expect(brothItem).toContainText('4 cups');

  // 6. Add a manual staple via the add bar.
  await page.getByLabel('Add a staple').fill('paper towels');
  await page.getByRole('button', { name: 'Add', exact: true }).click();
  await expect(page.getByText('paper towels')).toBeVisible();

  // 7. Check the staple off -> it moves into the collapsible "Done" group.
  await page.getByRole('checkbox', { name: 'Check paper towels' }).click();
  const doneGroup = page.locator('details');
  await expect(doneGroup).toContainText('Done (1)');
  await expect(doneGroup.getByText('paper towels')).toBeVisible();

  // ...then "Clear checked" removes it entirely.
  await page.getByRole('button', { name: 'Clear checked' }).click();
  await expect(page.getByText('paper towels')).toHaveCount(0);
});
