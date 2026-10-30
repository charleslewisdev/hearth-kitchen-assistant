import { describe, it, expect, beforeEach } from 'vitest';
import { appRouter } from './index';
import { MAX_SEARCH_LENGTH } from './recipe';
import { auth } from '../../auth';
import { createRecipe } from '../../repo/recipes';
import { findOrCreateFood, FOOD_SUGGESTION_LIMIT } from '../../repo/foods';
import { withHousehold } from '../../repo/tenant';
import { createLogger } from '../../log';
import { resetDb } from '../../../test/db';
import { ownerWithHousehold } from '../../../test/session';
import { testContext } from '../../../test/trpc';
import { capture } from '../../../test/logs';
import type { Context } from '../context';

/**
 * A caller bound to a real session, assembled the way `createContext` assembles one. Same
 * reasoning as `household.test.ts`: the household id under test is the one Better Auth put on
 * the session, so a hand-built one would prove nothing about the tenancy the app runs on.
 */
async function callerFor(headers: Headers, over: Partial<Context> = {}) {
  const session = await auth.api.getSession({ headers });
  if (session === null) throw new Error('the fixture produced no session');
  return appRouter.createCaller(
    testContext({
      session,
      householdId: session.session.activeOrganizationId ?? null,
      headers,
      ...over,
    }),
  );
}

/** The tRPC error code a rejected call produced, or null if it resolved. */
async function codeOf(call: Promise<unknown>): Promise<string | null> {
  try {
    await call;
    return null;
  } catch (err) {
    return (err as { code?: string }).code ?? 'UNKNOWN';
  }
}

describe('recipe.list search parameters', () => {
  let headers: Headers;
  let householdId: string;

  beforeEach(async () => {
    await resetDb();
    ({ headers, householdId } = await ownerWithHousehold());
    await createRecipe(householdId, {
      title: 'White Bean Soup',
      mealTypes: ['dinner'],
      tags: ['Quick'],
      ingredientLines: ['2 cups white beans'],
      steps: ['Simmer'],
    });
    await createRecipe(householdId, {
      title: 'Morning Oats',
      mealTypes: ['breakfast'],
      tags: ['Vegetarian'],
      ingredientLines: ['1 cup oats'],
      steps: ['Stir'],
    });
  });

  it('returns the whole library when called with no input at all', async () => {
    const caller = await callerFor(headers);
    expect((await caller.recipe.list()).map((c) => c.title)).toEqual([
      'Morning Oats',
      'White Bean Soup',
    ]);
  });

  it('forwards each parameter to the search', async () => {
    const caller = await callerFor(headers);

    expect((await caller.recipe.list({ text: 'soup' })).map((c) => c.title)).toEqual([
      'White Bean Soup',
    ]);
    expect((await caller.recipe.list({ ingredient: 'oats' })).map((c) => c.title)).toEqual([
      'Morning Oats',
    ]);
    expect((await caller.recipe.list({ mealType: 'breakfast' })).map((c) => c.title)).toEqual([
      'Morning Oats',
    ]);
    expect((await caller.recipe.list({ tag: 'Quick' })).map((c) => c.title)).toEqual([
      'White Bean Soup',
    ]);
    expect(
      (await caller.recipe.list({ text: 'soup', mealType: 'dinner' })).map((c) => c.title),
    ).toEqual(['White Bean Soup']);
  });

  it('rejects an over-long query rather than handing it to Postgres', async () => {
    const caller = await callerFor(headers);
    const tooLong = 'a'.repeat(MAX_SEARCH_LENGTH + 1);

    expect(await codeOf(caller.recipe.list({ text: tooLong }))).toBe('BAD_REQUEST');
    expect(await codeOf(caller.recipe.list({ ingredient: tooLong }))).toBe('BAD_REQUEST');
    expect(await codeOf(caller.recipe.list({ tag: tooLong }))).toBe('BAD_REQUEST');
    // The boundary itself is accepted, so the cap is a cap and not an off-by-one.
    expect(await codeOf(caller.recipe.list({ text: 'a'.repeat(MAX_SEARCH_LENGTH) }))).toBeNull();
  });

  it('rejects a meal type that is not one of the five', async () => {
    const caller = await callerFor(headers);
    expect(await codeOf(caller.recipe.list({ mealType: 'brunch' as 'dinner' }))).toBe(
      'BAD_REQUEST',
    );
  });

  it('refuses every search parameter to a caller with no session', async () => {
    const anonymous = appRouter.createCaller(testContext());
    expect(await codeOf(anonymous.recipe.list({ text: 'soup' }))).toBe('UNAUTHORIZED');
    expect(await codeOf(anonymous.food.list({ q: 'oat' }))).toBe('UNAUTHORIZED');
    expect(await codeOf(anonymous.recipe.tagCounts())).toBe('UNAUTHORIZED');
  });

  // D38: a search query is what someone typed. It never reaches a log line.
  it('logs the call without the search text or the ingredient', async () => {
    const { sink, lines } = capture();
    const log = createLogger({ level: 'info', pretty: false, destination: sink });
    const caller = await callerFor(headers, { log });

    await caller.recipe.list({ text: 'grandmas secret chili', ingredient: 'anchovy' });

    // The line has to exist first: "the text is absent" is trivially true of a log nobody wrote.
    expect(lines().filter((l) => l.msg === 'trpc')[0]).toMatchObject({
      path: 'recipe.list',
      ok: true,
    });
    expect(JSON.stringify(lines())).not.toContain('grandmas secret chili');
    expect(JSON.stringify(lines())).not.toContain('anchovy');
  });
});

describe('food.list suggestions', () => {
  let headers: Headers;
  let householdId: string;

  beforeEach(async () => {
    await resetDb();
    ({ headers, householdId } = await ownerWithHousehold());
  });

  it('suggests the household own foods by prefix', async () => {
    await withHousehold(householdId, async (tx) => {
      await findOrCreateFood(tx, householdId, 'Tomatoes');
      await findOrCreateFood(tx, householdId, 'Tofu');
      await findOrCreateFood(tx, householdId, 'Onion');
    });
    const caller = await callerFor(headers);

    expect((await caller.food.list({ q: 'to' })).map((f) => f.name)).toEqual(['Tofu', 'Tomatoes']);
  });

  it('caps what it returns, so the token list cannot grow without bound', async () => {
    await withHousehold(householdId, async (tx) => {
      for (let i = 0; i < FOOD_SUGGESTION_LIMIT + 5; i++) {
        await findOrCreateFood(tx, householdId, `Bean variety ${i}`);
      }
    });
    const caller = await callerFor(headers);

    expect(await caller.food.list({ q: 'bean' })).toHaveLength(FOOD_SUGGESTION_LIMIT);
  });

  it('rejects an empty or over-long query', async () => {
    const caller = await callerFor(headers);
    expect(await codeOf(caller.food.list({ q: '' }))).toBe('BAD_REQUEST');
    expect(await codeOf(caller.food.list({ q: 'a'.repeat(MAX_SEARCH_LENGTH + 1) }))).toBe(
      'BAD_REQUEST',
    );
  });
});

describe('recipe.tagCounts', () => {
  beforeEach(async () => {
    await resetDb();
  });

  it('returns the chips the Library offers, most used first', async () => {
    const { headers, householdId } = await ownerWithHousehold();
    await createRecipe(householdId, { title: 'One', tags: ['Quick'], steps: ['Go'] });
    await createRecipe(householdId, { title: 'Two', tags: ['Quick', 'Baking'], steps: ['Go'] });
    const caller = await callerFor(headers);

    expect(await caller.recipe.tagCounts()).toEqual([
      { name: 'Quick', normalizedName: 'quick', count: 2 },
      { name: 'Baking', normalizedName: 'baking', count: 1 },
    ]);
  });
});
