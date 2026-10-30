import { sql } from 'drizzle-orm';
import { db } from '../db/client';

// The Drizzle transaction handle type, derived from the client.
export type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0];

// Run `fn` inside a transaction scoped to one household. Two things happen first,
// both transaction-local (reset on commit/rollback, so pooled connections stay clean):
//   1. SET LOCAL ROLE hearth_app — drop from the owner/superuser (which bypasses RLS)
//      to the unprivileged role the RLS policies actually apply to.
//   2. set the `app.current_household` GUC the RLS policy compares against.
// This is the structural half of tenant isolation (Decision 31); the per-query
// `where(householdId)` in each repo is the app-layer half. Either alone would suffice
// for correct callers — together they also survive a caller mistake.
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
