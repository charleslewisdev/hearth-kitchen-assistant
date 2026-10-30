import { test, expect } from '@playwright/test';
import { OWNER, seedOwnerAndHousehold } from './fixtures';

/*
  End-to-end for cook mode (D26), against the real running stack:
  sign in -> create a recipe whose steps mention a duration -> scale it -> start cooking ->
  check a step off -> peek at the ingredients and see the SCALED amounts -> start a timer and
  watch it survive scrolling away from the step that started it.

  Seeded rather than driven through the first-boot screens, for the reasons written up in
  e2e/fixtures.ts. The seed empties the database, which is what makes this file rerunnable and
  why playwright.config.ts pins `workers: 1`.
*/
test.beforeAll(async () => {
  await seedOwnerAndHousehold();
});

test('cook mode: scaled peek, checked steps and a timer that outlives its step', async ({
  page,
}) => {
  // 1. Sign in as the household owner.
  await page.goto('/');
  await page.getByLabel('Email address', { exact: true }).fill(OWNER.email);
  await page.getByLabel('Password', { exact: true }).fill(OWNER.password);
  await page.getByRole('button', { name: 'Sign in' }).click();
  await expect(page.getByRole('heading', { name: 'Recipes' })).toBeVisible();

  // 2. Create a recipe. Both steps mention a duration, which is what cook mode turns into a
  //    tappable timer phrase.
  await page
    .getByRole('link', { name: /New recipe/ })
    .first()
    .click();
  await expect(page.getByRole('heading', { name: 'New recipe' })).toBeVisible();

  await page.getByLabel('Title').fill('Cook Mode Stew');
  await page.getByLabel('Servings').fill('4');
  await page.getByRole('checkbox', { name: 'dinner' }).check();
  await page
    .getByLabel('Ingredients, one per line')
    .fill('2 cups broth\n3 cloves garlic\nsalt to taste');

  /*
    Eight steps, not two. The last part of this spec asserts that the tray is still there after
    the cook has scrolled away from the step that started the timer, and a two-step recipe does
    not fill a 720px-tall desktop viewport: the scroll would be a no-op and the assertion would
    pass without ever testing anything.
  */
  const STEPS = [
    'Simmer the broth for 20 minutes.',
    'Whisk in the cream for 30 seconds, then serve.',
    'Chop the garlic finely and set it aside in a small bowl.',
    'Warm a heavy pot over a medium flame until a drop of water skitters.',
    'Soften the onion in the pot, stirring so it colours evenly all over.',
    'Add the garlic and stir it through until you can smell it clearly.',
    'Season, taste, and season again if the broth still tastes flat.',
    'Ladle into warm bowls and finish with a turn of black pepper.',
  ];
  for (const [index, text] of STEPS.entries()) {
    if (index > 0) await page.getByRole('button', { name: /Add step/ }).click();
    await page.getByRole('textbox', { name: `Step ${index + 1}` }).fill(text);
  }
  await page.getByRole('button', { name: 'Save' }).click();

  // 3. On the recipe, scale 4 -> 8, then start cooking. The servings have to travel with it.
  await expect(page.getByRole('heading', { name: 'Cook Mode Stew' })).toBeVisible();
  const increase = page.getByRole('button', { name: 'Increase servings' });
  for (let click = 0; click < 4; click += 1) await increase.click();
  await expect(page.getByLabel('Servings', { exact: true })).toHaveText('8');

  await page.getByRole('link', { name: 'Start cooking' }).click();
  await expect(page).toHaveURL(/\/recipes\/cook-mode-stew\/cook\?servings=8/);
  await expect(page.getByRole('heading', { name: 'Cook Mode Stew' })).toBeVisible();
  await expect(page.getByText(`Step 1 of ${STEPS.length}`)).toBeVisible();

  // 4. Start a timer from the phrase inside step 1.
  await page.getByRole('button', { name: /Start a timer for 20 minutes, step 1/ }).click();
  const tray = page.getByRole('list', { name: 'Running timers' });
  await expect(tray).toBeVisible();
  await expect(tray).toContainText('Step 1 · 20 minutes');
  await expect(tray).toContainText(/\d+:\d\d/);

  // Starting a timer must not also tick the step off: the phrase is its own target.
  const firstStep = page.getByRole('checkbox').first();
  await expect(firstStep).toHaveAttribute('aria-checked', 'false');

  // 5. Check step 1 off. The current step moves on.
  await firstStep.click();
  await expect(firstStep).toHaveAttribute('aria-checked', 'true');
  await expect(page.getByText(`Step 2 of ${STEPS.length}`)).toBeVisible();

  // 6. Peek at the ingredients: 8 servings, so the broth reads 4 cups and not the base 2.
  await page.getByRole('button', { name: 'Ingredients' }).click();
  const sheet = page.getByRole('dialog');
  await expect(sheet).toContainText('8 servings');
  await expect(sheet).toContainText('4 cups');
  await expect(sheet).not.toContainText('2 cups');
  await expect(sheet).toContainText('garlic');

  // Dismissible by keyboard, which is the one a11y property a bottom sheet usually loses.
  await page.keyboard.press('Escape');
  await expect(sheet).toBeHidden();

  // 7. Scroll to the end of the recipe. The tray is the reason a timer is still reachable
  //    from here, so it has to still be on screen with its countdown running.
  await page.getByRole('checkbox').last().scrollIntoViewIfNeeded();
  // Proof that the scroll happened, so the assertions below are about the tray staying put and
  // not about a page that never moved.
  await expect.poll(async () => page.evaluate(() => window.scrollY)).toBeGreaterThan(0);
  await expect(
    page.getByRole('button', { name: /Start a timer for 20 minutes, step 1/ }),
  ).not.toBeInViewport();
  await expect(tray).toBeInViewport();
  await expect(tray).toContainText('Step 1 · 20 minutes');

  // 8. Stop it, and the tray goes away with it.
  await page.getByRole('button', { name: /Stop Step 1 · 20 minutes/ }).click();
  await expect(tray).toBeHidden();

  // 9. Back out to the recipe.
  await page.getByRole('link', { name: 'Back to recipe' }).click();
  await expect(page).toHaveURL(/\/recipes\/cook-mode-stew$/);
  await expect(page.getByRole('button', { name: 'Add to list' })).toBeVisible();
});
