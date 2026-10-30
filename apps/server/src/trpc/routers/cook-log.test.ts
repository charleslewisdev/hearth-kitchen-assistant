import { describe, it, expect, beforeEach, vi } from 'vitest';

// Building a session sends a verification mail; keep it in memory.
vi.mock('../../mail', async () => {
  const actual = await vi.importActual<typeof import('../../mail/mailer')>('../../mail/mailer');
  return { mailer: new actual.MemoryMailer() };
});

const { appRouter } = await import('./index');
const { auth } = await import('../../auth');
const { resetDb } = await import('../../../test/db');
const { ownerWithHousehold } = await import('../../../test/session');
const { testContext } = await import('../../../test/trpc');
const { createRecipe } = await import('../../repo/recipes');

async function callerFor(headers: Headers) {
  const session = await auth.api.getSession({ headers });
  if (session === null) throw new Error('the fixture produced no session');
  return appRouter.createCaller(
    testContext({ session, householdId: session.session.activeOrganizationId ?? null, headers }),
  );
}

describe('cook log router', () => {
  beforeEach(resetDb);

  it('logs a cook under the member who logged it, by name, and rates the recipe', async () => {
    const owner = await ownerWithHousehold();
    const caller = await callerFor(owner.headers);
    const { id } = await createRecipe(owner.householdId, { title: 'Osso Buco' });

    await caller.cookLog.add({ recipeId: id, cookedOn: '2026-09-20', rating: 5, servings: 4 });
    const [entry] = await caller.cookLog.list({ recipeId: id });
    expect(entry).toMatchObject({ cookedOn: '2026-09-20', rating: 5, loggedBy: owner.name });

    await caller.recipe.setRating({ id, rating: 4 });
    expect((await caller.recipe.get({ idOrSlug: id }))!.rating).toBe(4);
  });

  it('refuses a date that does not exist and a rating out of range', async () => {
    const owner = await ownerWithHousehold();
    const caller = await callerFor(owner.headers);
    const { id } = await createRecipe(owner.householdId, { title: 'Soup' });
    await expect(caller.cookLog.add({ recipeId: id, cookedOn: '2026-02-30' })).rejects.toThrow();
    await expect(
      caller.cookLog.add({ recipeId: id, cookedOn: '2026-09-01', rating: 6 }),
    ).rejects.toThrow();
    await expect(caller.recipe.setRating({ id, rating: 0 })).rejects.toThrow();
  });
});
