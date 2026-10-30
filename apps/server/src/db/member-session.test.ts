import { describe, it, expect, beforeEach } from 'vitest';
import { randomUUID } from 'node:crypto';
import { pool } from './client';
import { resetDb } from '../../test/db';
import { createHousehold, createMember, createUser, liftHouseholdCap } from '../../test/factories';

/**
 * A membership that ends takes the household off that person's sessions (migration 0006).
 *
 * The rule the application wants is "a removed member cannot read the household's recipes", and
 * before this it was held nowhere. `protectedProcedure` derives `ctx.householdId` from
 * `session.active_organization_id` and the RLS policies key off the same value, while Better
 * Auth clears that column only for a user who removes THEMSELVES - so an owner removing someone
 * else left a live session still naming the household, for the seven days until it expired.
 *
 * Driven in SQL rather than through the router, for the same reason `household-owner.test.ts`
 * is: `/organization/leave` and `/organization/remove-member` are mounted at `/api/auth/*` and
 * delete member rows without passing through any of this app's code. The invariant has to hold
 * against the row, not against a caller, so this is the test that says where it lives. The
 * household router's own tests drive the same rule from a real session, which is what proves it
 * closes the hole that was actually found.
 */
describe('a membership that ends clears the household from its sessions', () => {
  let householdId: string;
  let ownerId: string;
  let grandmaId: string;
  let grandmaMemberId: string;

  beforeEach(async () => {
    await resetDb();
    householdId = await createHousehold();
    ownerId = await createUser('owner@example.com');
    await createMember({ householdId, userId: ownerId, role: 'owner' });
    grandmaId = await createUser('grandma@example.com');
    grandmaMemberId = await createMember({ householdId, userId: grandmaId });
  });

  /**
   * A `session` row written directly, because what is under test is what happens to the row.
   *
   * `token` is unique and nothing here reads it, so it is derived from the id. `expires_at` is
   * in the future so that a row this test finds cleared cannot be one that was merely stale.
   */
  const createSession = async (userId: string, activeHouseholdId: string | null) => {
    const id = randomUUID();
    await pool.query(
      `insert into "session"
         (id, expires_at, token, created_at, updated_at, user_id, active_organization_id)
       values ($1, now() + interval '7 days', $2, now(), now(), $3, $4)`,
      [id, `tok_${id}`, userId, activeHouseholdId],
    );
    return id;
  };

  const householdOf = async (sessionId: string) =>
    (
      await pool.query<{ active_organization_id: string | null }>(
        'select active_organization_id from "session" where id = $1',
        [sessionId],
      )
    ).rows[0]?.active_organization_id ?? null;

  const deleteMember = (id: string) => pool.query('delete from "member" where id = $1', [id]);

  it('clears every session the removed member had open on that household', async () => {
    const phone = await createSession(grandmaId, householdId);
    const laptop = await createSession(grandmaId, householdId);

    await deleteMember(grandmaMemberId);

    expect([await householdOf(phone), await householdOf(laptop)]).toEqual([null, null]);
  });

  it('leaves the sessions of everyone still in the household alone', async () => {
    const theirs = await createSession(ownerId, householdId);

    await deleteMember(grandmaMemberId);

    expect(await householdOf(theirs)).toBe(householdId);
  });

  /**
   * Scoped to the household the membership was in, not to the person.
   *
   * `SINGLE_HOUSEHOLD` is on by default and the cap makes a second household impossible, so this
   * is the state the instance is not in today - which is exactly why it is worth pinning. The
   * rule is about a stale pointer, and a session naming a household this person is still a
   * member of is not stale. Signing them out of it would be a second, different decision.
   */
  it('leaves a session that names a household they are still in alone', async () => {
    await liftHouseholdCap();
    const otherHouseholdId = await createHousehold();
    await createMember({ householdId: otherHouseholdId, userId: grandmaId, role: 'owner' });
    const elsewhere = await createSession(grandmaId, otherHouseholdId);
    const nowhere = await createSession(grandmaId, null);

    await deleteMember(grandmaMemberId);

    expect(await householdOf(elsewhere)).toBe(otherHouseholdId);
    expect(await householdOf(nowhere)).toBeNull();
  });

  /**
   * Deleting the household takes its members with it, and the sessions naming it go too.
   *
   * The cascade is the reason this trigger is immediate where `member_keeps_an_owner` is
   * deferred: that one has to wait for the household row to be gone before it can tell a
   * cascade from an emptying, and this one has nothing to wait for. It is a write that
   * accompanies the delete, not a check that has to see everyone else's commits.
   */
  it('clears the sessions of a household that is deleted out from under them', async () => {
    const mine = await createSession(grandmaId, householdId);

    await pool.query('delete from "organization" where id = $1', [householdId]);

    expect(await householdOf(mine)).toBeNull();
  });

  /**
   * THE TWO WRITES ARE ONE WRITE, which is the whole reason this is a trigger.
   *
   * A revocation the application performs after the delete is a second statement that can fail
   * on its own, and a failed second statement leaves the membership gone and the session still
   * naming the household - the hole, silently, with the removal reported as a success. Here
   * there is no second statement to fail: roll the delete back and the session comes back with
   * it, because the two never existed apart.
   */
  it('comes back with the membership when the removal is rolled back', async () => {
    const mine = await createSession(grandmaId, householdId);
    const client = await pool.connect();
    try {
      await client.query('begin');
      await client.query('delete from "member" where id = $1', [grandmaMemberId]);
      const inside = await client.query<{ active_organization_id: string | null }>(
        'select active_organization_id from "session" where id = $1',
        [mine],
      );
      expect(inside.rows[0]?.active_organization_id).toBeNull();
    } finally {
      // In the `finally`, not after the assertion: a failed expectation leaves the transaction
      // open on a pooled connection, and the deferred `member_keeps_an_owner` events pending on
      // it make the next test's TRUNCATE fail with an error about the wrong thing entirely.
      await client.query('rollback').catch(() => undefined);
      client.release();
    }

    expect(await householdOf(mine)).toBe(householdId);
  });

  /**
   * The same atomicity, driven by the constraint that actually refuses a removal in production.
   *
   * `member_keeps_an_owner` is DEFERRED, so it raises at COMMIT - long after this trigger has
   * already cleared the session. That ordering is only safe because both are in one
   * transaction: the refusal takes the session update down with the delete it belonged to.
   */
  it('keeps the household on the session when the last-owner rule refuses the removal', async () => {
    const theirs = await createSession(ownerId, householdId);
    const ownerMemberId = (
      await pool.query<{ id: string }>(
        'select id from "member" where organization_id = $1 and user_id = $2',
        [householdId, ownerId],
      )
    ).rows[0]?.id;

    await expect(deleteMember(ownerMemberId ?? '')).rejects.toMatchObject({ code: 'HH001' });

    expect(await householdOf(theirs)).toBe(householdId);
  });
});
