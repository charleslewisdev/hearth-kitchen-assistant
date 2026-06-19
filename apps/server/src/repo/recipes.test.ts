import { describe, it, expect, beforeEach } from 'vitest';
import { eq } from 'drizzle-orm';
import { resetDb } from '../../test/db';
import { createHousehold } from '../../test/factories';
import { recipes } from '../db/schema';
import { listRecipes, createRecipe, getRecipe, withHousehold } from './recipes';

describe('recipe repository (tenant isolation)', () => {
  beforeEach(async () => {
    await resetDb();
  });

  it('createRecipe stores a slug and scopes to the household', async () => {
    const h = await createHousehold();
    const r = await createRecipe(h, { title: 'White Bean Soup' });
    expect(r.slug).toBe('white-bean-soup');
    expect(r.householdId).toBe(h);
  });

  it('listRecipes returns only the calling household rows', async () => {
    const a = await createHousehold();
    const b = await createHousehold();
    await createRecipe(a, { title: 'A Soup' });
    await createRecipe(b, { title: 'B Stew' });
    const listA = await listRecipes(a);
    expect(listA).toHaveLength(1);
    expect(listA[0]!.title).toBe('A Soup');
  });

  it('getRecipe returns null for a recipe owned by another household', async () => {
    const a = await createHousehold();
    const b = await createHousehold();
    const r = await createRecipe(a, { title: 'Secret' });
    expect(await getRecipe(b, r.id)).toBeNull();
    expect(await getRecipe(a, r.id)).not.toBeNull();
  });

  // Defense-in-depth (Decision 31): even if a query FORGETS the household WHERE
  // clause, Postgres Row-Level Security must still scope rows to the active
  // household. This selects ALL recipes with no app-layer filter, inside B's RLS
  // context, and asserts only B's rows come back.
  it('RLS blocks cross-household reads even without an app-layer filter', async () => {
    const a = await createHousehold();
    const b = await createHousehold();
    await createRecipe(a, { title: 'A only' });
    await createRecipe(b, { title: 'B only' });

    const rowsForB = await withHousehold(b, (tx) => tx.select().from(recipes));
    expect(rowsForB).toHaveLength(1);
    expect(rowsForB[0]!.title).toBe('B only');

    // And a forgotten-filter UPDATE cannot touch another household's row.
    const r = await createRecipe(a, { title: 'A private' });
    await withHousehold(b, (tx) =>
      tx.update(recipes).set({ title: 'hijacked' }).where(eq(recipes.id, r.id)),
    );
    expect((await getRecipe(a, r.id))?.title).toBe('A private');
  });
});
