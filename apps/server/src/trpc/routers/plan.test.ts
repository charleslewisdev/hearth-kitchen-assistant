import { describe, it, expect, beforeEach } from 'vitest';
import { appRouter } from './index';
import { auth } from '../../auth';
import { createRecipe } from '../../repo/recipes';
import { resetDb } from '../../../test/db';
import { ownerWithHousehold } from '../../../test/session';
import { testContext } from '../../../test/trpc';

async function callerFor(headers: Headers) {
  const session = await auth.api.getSession({ headers });
  if (session === null) throw new Error('the fixture produced no session');
  return appRouter.createCaller(
    testContext({ session, householdId: session.session.activeOrganizationId ?? null, headers }),
  );
}

async function codeOf(call: Promise<unknown>): Promise<string | null> {
  try {
    await call;
    return null;
  } catch (err) {
    return (err as { code?: string }).code ?? 'UNKNOWN';
  }
}

describe('plan router', () => {
  let headers: Headers;
  let householdId: string;

  beforeEach(async () => {
    await resetDb();
    ({ headers, householdId } = await ownerWithHousehold());
  });

  it('plans a week and builds the list from it', async () => {
    const caller = await callerFor(headers);
    const soup = await createRecipe(householdId, {
      title: 'Soup',
      servings: 2,
      ingredientLines: ['1 cup rice'],
    });
    await caller.plan.setWeekStart({ weekStart: 1 });
    await caller.plan.add({ date: '2026-09-23', meal: 'dinner', recipeId: soup.id, servings: 4 });

    const week = await caller.plan.week({ date: '2026-09-23' });
    expect(week.start).toBe('2026-09-21');
    expect(week.entries).toHaveLength(1);

    expect(await caller.plan.buildList({ start: week.start })).toEqual({ added: 1 });
    const list = await caller.shoppingList.get();
    expect(list.items.find((i) => i.name === 'rice')?.quantity).toBe(2);
  });

  it('refuses dates that do not exist, bad servings and bad week starts as BAD_REQUEST', async () => {
    const caller = await callerFor(headers);
    const soup = await createRecipe(householdId, { title: 'Soup' });
    const entry = { meal: 'dinner' as const, recipeId: soup.id, servings: 2 };
    expect(await codeOf(caller.plan.week({ date: '2026-02-30' }))).toBe('BAD_REQUEST');
    expect(await codeOf(caller.plan.week({ date: '09/23/2026' }))).toBe('BAD_REQUEST');
    expect(await codeOf(caller.plan.add({ ...entry, date: '2026-09-23', servings: 0 }))).toBe(
      'BAD_REQUEST',
    );
    expect(await codeOf(caller.plan.add({ ...entry, date: '2026-13-01' }))).toBe('BAD_REQUEST');
    expect(await codeOf(caller.plan.setWeekStart({ weekStart: 7 }))).toBe('BAD_REQUEST');
    // A recipe can be a sauce; a plan slot cannot.
    expect(
      await codeOf(caller.plan.add({ ...entry, date: '2026-09-23', meal: 'sauce' as never })),
    ).toBe('BAD_REQUEST');
  });

  it('answers NOT_FOUND for a recipe id that does not exist', async () => {
    const caller = await callerFor(headers);
    const missing = '00000000-0000-4000-8000-000000000000';
    expect(
      await codeOf(
        caller.plan.add({ date: '2026-09-23', meal: 'dinner', recipeId: missing, servings: 2 }),
      ),
    ).toBe('NOT_FOUND');
  });

  it('requires a session', async () => {
    const anon = appRouter.createCaller(testContext());
    expect(await codeOf(anon.plan.week({ date: '2026-09-23' }))).toBe('UNAUTHORIZED');
  });
});
