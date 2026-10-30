import { randomUUID } from 'node:crypto';
import { pool } from '../src/db/client';

/**
 * Re-exported for the one test that has to assert WHICH connection a query ran on (that
 * `acceptPendingInvitation` reads the invitation on its own transaction, never on the pooled
 * client). `pool` is deliberately not re-exported: raw SQL belongs in this file, behind a named
 * helper, rather than spread through test bodies.
 */
export { db } from '../src/db/client';

let n = 0;
// Insert a minimal organization row directly; returns its id (the household id).
// Column names match the generated auth-schema: `created_at` (snake_case, no default).
export async function createHousehold(): Promise<string> {
  const id = `hh_${++n}_${Date.now()}`;
  await pool.query(
    `insert into "organization" (id, name, slug, created_at) values ($1, $2, $3, now())`,
    [id, `House ${n}`, `house-${n}-${Date.now()}`],
  );
  return id;
}

/**
 * Insert a `user` row directly and return its id.
 *
 * Direct SQL rather than a sign-up call, because the sign-up path is the thing under test in
 * `auth-invite.test.ts` and a fixture that goes through it cannot set up the state (a household
 * that already has an owner) that the interesting cases need.
 *
 * The email is stored lowercased because that is what Better Auth stores: `signUpEmail` writes
 * `email.toLowerCase()` and `internalAdapter.createUser` lowercases it a second time. A fixture
 * that stored the raw string would let a case-sensitivity bug pass here and fail in production.
 */
export async function createUser(email: string): Promise<string> {
  const id = `usr_${++n}_${Date.now()}`;
  await pool.query(
    `insert into "user" (id, name, email, email_verified, created_at, updated_at)
     values ($1, $2, $3, true, now(), now())`,
    [id, email, email.toLowerCase()],
  );
  return id;
}

/**
 * Insert an `invitation` row directly and return its id.
 *
 * `status` and `expiresAt` are parameters because the states worth testing - expired, already
 * accepted, canceled - are precisely the ones the API refuses to produce on demand.
 *
 * The email is NOT lowercased here, unlike `createUser`. Better Auth's `createInvitation` does
 * lowercase it, so a well-formed row always holds a lowercase address; leaving the factory
 * literal is what lets a test write a mixed-case row on purpose and assert that the lookup does
 * not silently match it.
 */
export async function createInvitation(opts: {
  householdId: string;
  inviterId: string;
  email: string;
  status?: 'pending' | 'accepted' | 'rejected' | 'canceled';
  expiresAt?: Date;
  role?: string;
  /** When it was issued, for a test about ORDER. See `createMember` for why that is needed. */
  createdAt?: Date;
}): Promise<string> {
  const id = `inv_${++n}_${Date.now()}`;
  const expiresAt = opts.expiresAt ?? new Date(Date.now() + 48 * 60 * 60 * 1000);
  await pool.query(
    `insert into "invitation"
       (id, organization_id, email, role, status, expires_at, created_at, inviter_id)
     values ($1, $2, $3, $4, $5, $6, coalesce($7::timestamp, now()), $8)`,
    [
      id,
      opts.householdId,
      opts.email,
      opts.role ?? 'member',
      opts.status ?? 'pending',
      expiresAt,
      opts.createdAt ?? null,
      opts.inviterId,
    ],
  );
  return id;
}

/** Put `userId` in `householdId` directly, without going through an invitation. */
export async function createMember(opts: {
  householdId: string;
  userId: string;
  role?: 'owner' | 'member';
  /**
   * When they joined, for a test about ORDER.
   *
   * Without it every fixture row is written in the order it was inserted with a `now()` that
   * agrees, so a list that is merely returned in physical order is indistinguishable from one
   * that was sorted. Setting this lets a test insert an older row last, which is the only
   * arrangement the two can be told apart in.
   */
  createdAt?: Date;
}): Promise<string> {
  // randomUUID rather than a timestamp: two calls in the same millisecond collide on the
  // primary key, and a fixture that fails only when the machine is fast is worse than no
  // fixture at all.
  const id = randomUUID();
  await pool.query(
    `insert into "member" (id, organization_id, user_id, role, created_at)
     values ($1, $2, $3, $4, coalesce($5::timestamp, now()))`,
    [id, opts.householdId, opts.userId, opts.role ?? 'member', opts.createdAt ?? null],
  );
  return id;
}

/** An existing household with an owner in it, built without touching the sign-up path. */
export async function householdWithOwner(
  ownerEmail = 'owner@example.com',
): Promise<{ householdId: string; ownerId: string }> {
  const householdId = await createHousehold();
  const ownerId = await createUser(ownerEmail);
  await createMember({ householdId, userId: ownerId, role: 'owner' });
  return { householdId, ownerId };
}

/** The status of one invitation row, which is how "was it consumed" is asserted. */
export async function invitationStatus(invitationId: string): Promise<string | null> {
  const { rows } = await pool.query<{ status: string }>(
    'select status from "invitation" where id = $1',
    [invitationId],
  );
  return rows[0]?.status ?? null;
}

/** Every household `email` belongs to, with the role it holds there. */
export async function membershipsOf(
  email: string,
): Promise<{ householdId: string; role: string }[]> {
  const { rows } = await pool.query<{ household_id: string; role: string }>(
    `select m.organization_id as household_id, m.role from "member" m
     join "user" u on u.id = m.user_id where u.email = $1 order by m.created_at`,
    [email.toLowerCase()],
  );
  return rows.map((r) => ({ householdId: r.household_id, role: r.role }));
}

/** The household the newest session for `email` opens in. */
export async function activeHouseholdOf(email: string): Promise<string | null> {
  const { rows } = await pool.query<{ active_organization_id: string | null }>(
    `select s.active_organization_id from "session" s
     join "user" u on u.id = s.user_id where u.email = $1
     order by s.created_at desc limit 1`,
    [email.toLowerCase()],
  );
  return rows[0]?.active_organization_id ?? null;
}

/**
 * The household every one of `email`'s live sessions opens in, oldest session first.
 *
 * The plural of `activeHouseholdOf`, and the difference is the whole point of it: a person can
 * be signed in on a phone and a laptop, and removing them has to reach both. A helper that read
 * only the newest row would pass with a fix that cleared one session and left the other.
 */
export async function activeHouseholdsOf(email: string): Promise<(string | null)[]> {
  const { rows } = await pool.query<{ active_organization_id: string | null }>(
    `select s.active_organization_id from "session" s
     join "user" u on u.id = s.user_id where u.email = $1
     order by s.created_at asc, s.id asc`,
    [email.toLowerCase()],
  );
  return rows.map((r) => r.active_organization_id);
}

export async function countRows(table: 'user' | 'organization' | 'member'): Promise<number> {
  const { rows } = await pool.query<{ n: string }>(`select count(*) as n from "${table}"`);
  return Number(rows[0]?.n ?? '0');
}

/** Every account's address, sorted, for asserting that one account was created and not two. */
export async function emailsOfUsers(): Promise<string[]> {
  const { rows } = await pool.query<{ email: string }>('select email from "user" order by email');
  return rows.map((r) => r.email);
}

/**
 * Run `fn` with every insert into `member` failing at the database.
 *
 * A trigger rather than a bad foreign key, because the code under test now checks the user
 * exists before it writes, so a made-up user id no longer reaches the insert at all - it would
 * make the atomicity test pass without ever exercising a rollback. This makes the SECOND write
 * of the pair fail for real, with the first already done inside the same transaction.
 */
export async function withFailingMemberInsert<T>(fn: () => Promise<T>): Promise<T> {
  await pool.query(`
    create or replace function hearth_test_block_member() returns trigger as $$
    begin raise exception 'member insert blocked by test'; end;
    $$ language plpgsql;
  `);
  await pool.query(
    `create trigger hearth_test_block_member before insert on "member"
     for each row execute function hearth_test_block_member();`,
  );
  try {
    return await fn();
  } finally {
    await pool.query('drop trigger if exists hearth_test_block_member on "member";');
    await pool.query('drop function if exists hearth_test_block_member();');
  }
}

/** How many invitations sit in each status, for asserting that a no-op consumed nothing. */
export async function invitationStatusCounts(): Promise<Record<string, number>> {
  const { rows } = await pool.query<{ status: string; n: string }>(
    'select status, count(*) as n from "invitation" group by status',
  );
  return Object.fromEntries(rows.map((r) => [r.status, Number(r.n)]));
}

/**
 * Remove the one-household-per-instance constraint for the rest of this test.
 *
 * The singleton index from migration 0004 makes a second household impossible, which is D36
 * working as intended. Tenant isolation is a different rule with a different job: it is the
 * defence that has to hold in the world where the cap is LIFTED, which is precisely why RLS is
 * defence in depth rather than something the application check could replace. So the tests for
 * it have to construct the state the cap forbids, and they do it the way a real deployment
 * would - by dropping that index, which is half of the documented procedure for lifting the cap
 * (the other half is SINGLE_HOUSEHOLD=false).
 *
 * `resetDb()` puts it back, so lifting it cannot leak into another file.
 */
export async function liftHouseholdCap(): Promise<void> {
  await pool.query('drop index if exists organization_singleton_uidx;');
}
