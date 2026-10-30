import { pool } from '../src/db/client';

/**
 * Put the one-household-per-instance index (migration 0004) back, if a test dropped it.
 *
 * Called from two places, and it needs both. `resetDb()` runs it before each test, which is
 * what keeps a lifted cap from leaking between files. The global teardown runs it after the
 * last file, which is what keeps it from leaking out of the run entirely: the placement in
 * `resetDb` means the final state of the database is whatever the last file left, and the
 * isolation tests are files that lift it. Verified before this existed - after a clean
 * `pnpm test`, `organization_singleton_uidx` was gone from the dev database and a two-row
 * insert into `organization` succeeded. Production never sees this (migrations run at boot,
 * tests do not run there), but local development then runs against a weaker schema than
 * production, which is exactly the difference that hides a bug until it ships.
 */
export async function restoreHouseholdCap(): Promise<void> {
  await pool.query(
    'create unique index if not exists organization_singleton_uidx on "organization" ((true));',
  );
}

// Truncate all app tables between test runs. Order respects FKs via CASCADE.
export async function resetDb(): Promise<void> {
  await pool.query(`
    truncate table import_draft_step, import_draft_ingredient, import_draft, meal_plan_entry, household_settings, shopping_list_item, shopping_list, recipe_tags, tag, recipe_step,
      recipe_ingredient, recipe, food,
      "member", "invitation", "organization", "session", "account", "verification", "user"
      restart identity cascade;
  `);
  // Put the household cap back, in case a test lifted it (see liftHouseholdCap). Restoring it
  // here rather than in that test's own teardown is deliberate: a file that lifts the cap and
  // then fails partway would otherwise leak the lifted state into whatever runs next, and the
  // tests it would silently disarm are the ones about the cap.
  await restoreHouseholdCap();
}

/**
 * The `ip_address` Better Auth recorded when it created this user's session.
 *
 * That column is the only place Better Auth's own view of the client is observable, and it is
 * the same value its rate limiter keys on (`getIp`), so it is what a test asserting on client-IP
 * attribution has to read. Joined through the user rather than taken as "the newest row",
 * because two sign-ups in one test can land in the same millisecond.
 */
export async function sessionIpFor(email: string): Promise<string | null> {
  const { rows } = await pool.query<{ ip_address: string | null }>(
    'select s.ip_address from "session" s join "user" u on u.id = s.user_id where u.email = $1',
    [email],
  );
  return rows[0]?.ip_address ?? null;
}

/**
 * Whether Better Auth has this address recorded as verified.
 *
 * Read from the column rather than from a sign-up response, because the decision under test is
 * made in a `databaseHooks.user.create.before` hook: the response would show what the endpoint
 * returned, and the row shows what was actually written.
 */
export async function emailVerifiedFor(email: string): Promise<boolean | null> {
  const { rows } = await pool.query<{ email_verified: boolean }>(
    'select email_verified from "user" where email = $1',
    [email.toLowerCase()],
  );
  return rows[0]?.email_verified ?? null;
}

/**
 * Do to an account what clicking the verification link does.
 *
 * `requireEmailVerification` is on (D36's companion: verification is wired and required), so an
 * account that has not been through this cannot sign in - which means almost every fixture that
 * needs a session needs this first. Straight SQL rather than a `/verify-email` round-trip,
 * because a token exchange is not what any of the tests using it are about, and the tests that
 * ARE about verification assert on the column this writes.
 */
export async function verifyEmail(email: string): Promise<void> {
  await pool.query('update "user" set email_verified = true where email = $1', [
    email.toLowerCase(),
  ]);
}
