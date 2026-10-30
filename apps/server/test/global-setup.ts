import { pool } from '../src/db/client';
import { resetDb } from './db';

/**
 * What the suite owes the database when it is finished.
 *
 * `resetDb()` restores the household cap at the START of each test, which is the right place
 * for it: a file that lifts the cap and then fails partway would otherwise disarm the tests
 * that come after it. But it leaves the run's final state as whatever the last file did, and
 * the tenant-isolation files are the ones that lift the cap - so a green `pnpm test` used to
 * end with `organization_singleton_uidx` missing from the developer's database, where the next
 * `pnpm dev` would happily create a second household that production's schema forbids.
 *
 * The whole reset rather than the index alone, and that is not tidiness: the index is
 * `unique (true)`, so it cannot be created while the two households those tests just built are
 * still in the table. Restoring the cap therefore means clearing what the cap forbids, which
 * `resetDb()` already does in the right order. The database is left as a test finds it -
 * empty, migrated, capped - rather than holding the last test's rows.
 *
 * A vitest global teardown rather than an `afterAll` in the files that lift the cap, because
 * this has to survive a file that fails partway, and because there is no last file to hang it
 * on. It runs in vitest's own process, so the pool it opens is not one a worker is using, and
 * it is closed here rather than left for the process to outlive.
 *
 * No `setup` counterpart: migrations are what create this index (`pnpm db:migrate`), and
 * creating it at setup as well would let the suite paper over a database nobody had migrated.
 */
export async function teardown(): Promise<void> {
  try {
    await resetDb();
  } finally {
    await pool.end();
  }
}
