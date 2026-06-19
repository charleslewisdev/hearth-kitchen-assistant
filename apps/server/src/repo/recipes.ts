import { and, desc, eq, sql } from 'drizzle-orm';
import { slugify } from '@hearth/shared';
import { db } from '../db/client';
import { recipes, type Recipe } from '../db/schema';

// The Drizzle transaction handle type, derived from the client.
type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0];

// Run `fn` inside a transaction scoped to one household. Two things happen first,
// both transaction-local (reset on commit/rollback, so pooled connections stay clean):
//   1. SET LOCAL ROLE hearth_app — drop from the owner/superuser (which bypasses RLS)
//      to the unprivileged role the recipes policy actually applies to.
//   2. set the `app.current_household` GUC the RLS policy compares against.
// This is the structural half of tenant isolation (Decision 31); the per-query
// `where(householdId)` below is the app-layer half. Either alone would suffice for
// correct callers — together they also survive a caller mistake.
export async function withHousehold<T>(
  householdId: string,
  fn: (tx: Tx) => Promise<T>,
): Promise<T> {
  return db.transaction(async (tx) => {
    await tx.execute(sql`set local role hearth_app`);
    await tx.execute(sql`select set_config('app.current_household', ${householdId}, true)`);
    return fn(tx);
  });
}

export async function listRecipes(householdId: string): Promise<Recipe[]> {
  return withHousehold(householdId, (tx) =>
    tx
      .select()
      .from(recipes)
      .where(eq(recipes.householdId, householdId))
      .orderBy(desc(recipes.createdAt)),
  );
}

export async function createRecipe(
  householdId: string,
  input: { title: string },
): Promise<Recipe> {
  return withHousehold(householdId, async (tx) => {
    const [row] = await tx
      .insert(recipes)
      .values({ householdId, title: input.title, slug: slugify(input.title) })
      .returning();
    return row!;
  });
}

export async function getRecipe(householdId: string, id: string): Promise<Recipe | null> {
  return withHousehold(householdId, async (tx) => {
    const [row] = await tx
      .select()
      .from(recipes)
      .where(and(eq(recipes.id, id), eq(recipes.householdId, householdId)));
    return row ?? null;
  });
}
