import { mkdir } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { test, expect, type Page } from '@playwright/test';
import { OWNER, seedOwnerAndHousehold } from '../fixtures';
import { pool } from '../../apps/server/src/db/client';
import { HOUSEHOLD_NAME, IN_THE_CART, PASTED_RECIPE, PLANNED_DINNERS, RECIPES } from './demo-data';

/**
 * Seeds the invented demo kitchen in `hearth_demo` and photographs the real app.
 *
 * Seeding goes through the app's own tRPC endpoints, from the signed-in browser, so the pictures
 * show what the app really does with this data and the seed cannot drift from the schema.
 */
const OUT = resolve(dirname(fileURLToPath(import.meta.url)), '../../docs/screenshots');
const DESKTOP = { width: 1280, height: 800 };
// Tall enough for a whole week, because the planner scrolls to today and hides the top row.
const TALL = { width: 1280, height: 1120 };
const PHONE = { width: 390, height: 844 };

// `seedOwnerAndHousehold` truncates every table, so this has to be the demo database.
if (!/\/hearth_demo(\?|$)/.test(process.env.DATABASE_URL ?? '')) {
  throw new Error('Refusing to run: DATABASE_URL is not hearth_demo. Use `pnpm screenshots`.');
}

/** One tRPC call from inside the page, so it carries the session cookie and the app's origin. */
async function trpc<T>(
  page: Page,
  path: string,
  input: unknown,
  type: 'query' | 'mutation' = 'mutation',
): Promise<T> {
  const result = await page.evaluate(
    async ({ path, input, type }) => {
      const url =
        type === 'query'
          ? `/trpc/${path}?input=${encodeURIComponent(JSON.stringify(input))}`
          : `/trpc/${path}`;
      const response = await fetch(
        url,
        type === 'query'
          ? {}
          : {
              method: 'POST',
              headers: { 'content-type': 'application/json' },
              body: JSON.stringify(input),
            },
      );
      return { status: response.status, body: await response.text() };
    },
    { path, input, type },
  );
  if (result.status !== 200) throw new Error(`${path}: ${result.status} ${result.body}`);
  return (JSON.parse(result.body) as { result: { data: T } }).result.data;
}

const isoDay = (date: Date) =>
  `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;

/** The first day of the week holding today, for a week that starts on `startDay` (0 = Sunday). */
function weekStart(startDay: number): Date {
  const day = new Date();
  day.setDate(day.getDate() - ((day.getDay() - startDay + 7) % 7));
  return day;
}

async function seed(page: Page) {
  const ids = new Map<string, string>();
  for (const { rating, ...recipe } of RECIPES) {
    const created = await trpc<{ id: string }>(page, 'recipe.create', recipe);
    ids.set(recipe.title, created.id);
    if (rating !== null) await trpc(page, 'recipe.setRating', { id: created.id, rating });
  }

  const start = await trpc<unknown>(page, 'plan.weekStart', undefined, 'query');
  const first = weekStart(typeof start === 'number' ? start : start === 'sunday' ? 0 : 1);
  for (const [offset, title] of PLANNED_DINNERS.entries()) {
    if (!title) continue;
    const date = new Date(first);
    date.setDate(first.getDate() + offset);
    await trpc(page, 'plan.add', {
      date: isoDay(date),
      meal: 'dinner',
      recipeId: ids.get(title),
      servings: 4,
    });
  }
  await trpc(page, 'plan.buildList', { start: isoDay(first) });

  const { items } = await trpc<{ items: { id: string; name: string }[] }>(
    page,
    'shoppingList.get',
    undefined,
    'query',
  );
  for (const item of items) {
    if (IN_THE_CART.some((word) => item.name.toLowerCase().includes(word))) {
      await trpc(page, 'shoppingList.toggleChecked', { itemId: item.id, checked: true });
    }
  }
}

async function shoot(page: Page, name: string, fullPage = false) {
  await page.waitForLoadState('networkidle');
  // Fonts arrive after the first paint; a shot taken before then shows the fallback.
  await page.evaluate(() => document.fonts.ready);
  await page.screenshot({ path: resolve(OUT, `${name}.png`), fullPage });
}

test('photograph the demo kitchen', async ({ page }) => {
  test.setTimeout(120_000);
  await mkdir(OUT, { recursive: true });

  await seedOwnerAndHousehold();
  await pool.query('update "organization" set name = $1', [HOUSEHOLD_NAME]);

  await page.setViewportSize(DESKTOP);
  await page.goto('/');
  await page.getByLabel('Email address', { exact: true }).fill(OWNER.email);
  await page.getByLabel('Password', { exact: true }).fill(OWNER.password);
  await page.getByRole('button', { name: 'Sign in' }).click();
  await expect(page.getByRole('heading', { name: 'Recipes' })).toBeVisible();
  await seed(page);

  await page.goto('/recipes');
  await expect(page.getByText('Weeknight Lemon Chicken')).toBeVisible();
  await shoot(page, 'library');

  await page.setViewportSize(TALL);
  await page.getByText('Weeknight Lemon Chicken').first().click();
  await expect(page.getByRole('heading', { name: 'Weeknight Lemon Chicken' })).toBeVisible();
  await shoot(page, 'recipe');

  await page.goto('/plan');
  await expect(page.getByRole('heading', { name: 'Plan', exact: true })).toBeVisible();
  await expect(page.getByText('Black Bean Tacos').first()).toBeVisible();
  await shoot(page, 'plan');

  await page.setViewportSize(DESKTOP);
  await page.goto('/import');
  await page.getByRole('button', { name: 'Text' }).click();
  await page.getByLabel('Recipe text').fill(PASTED_RECIPE);
  await page.getByRole('button', { name: 'Import', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'What you pasted said' })).toBeVisible();
  await shoot(page, 'import-review');

  await page.setViewportSize(PHONE);
  await page.goto('/shop');
  await expect(page.getByRole('listitem').first()).toBeVisible();
  await shoot(page, 'shopping-phone');

  await page.goto('/recipes/weeknight-lemon-chicken/cook');
  await expect(page.getByText('Heat the oven to 425°F').first()).toBeVisible();
  await shoot(page, 'cook-phone');
});
