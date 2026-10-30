import { describe, it, expect, beforeEach } from 'vitest';
import { pool } from './client';
import { resetDb } from '../../test/db';
import { createHousehold, createMember, createUser } from '../../test/factories';

/**
 * A household keeps at least one owner (migration 0005), enforced where concurrent writers
 * meet rather than where the request is handled.
 *
 * The application check in the household router is the message; this is the guarantee. It is
 * the same split migration 0004 made for the household cap, for the same reason: the router
 * reads the owner count and then writes, so two concurrent removals of two different owners
 * both see two owners and both commit. Measured against a real server before this existed -
 * two parallel requests, both 200, zero owners left, and every route back into the household
 * refused. Recovery was manual SQL.
 *
 * Driven in SQL rather than through the router, deliberately: `/organization/leave` and
 * `/organization/remove-member` are mounted at `/api/auth/*` and delete member rows without
 * passing through any of this app's code, so the invariant has to hold against the row, not
 * against a caller.
 */
describe('a household keeps at least one owner', () => {
  let householdId: string;
  let ownerMemberId: string;

  beforeEach(async () => {
    await resetDb();
    householdId = await createHousehold();
    ownerMemberId = await createMember({
      householdId,
      userId: await createUser('owner@example.com'),
      role: 'owner',
    });
  });

  const deleteMember = (id: string) => pool.query('delete from "member" where id = $1', [id]);
  const owners = async () =>
    (
      await pool.query(`select 1 from "member" where organization_id = $1 and role = 'owner'`, [
        householdId,
      ])
    ).rowCount;

  it('refuses to remove the only owner', async () => {
    await expect(deleteMember(ownerMemberId)).rejects.toMatchObject({ code: 'HH001' });
    expect(await owners()).toBe(1);
  });

  it('refuses to demote the only owner, which empties a household of owners without a delete', async () => {
    await expect(
      pool.query(`update "member" set role = 'member' where id = $1`, [ownerMemberId]),
    ).rejects.toMatchObject({ code: 'HH001' });
    expect(await owners()).toBe(1);
  });

  it('allows removing someone who is not the owner', async () => {
    const memberId = await createMember({
      householdId,
      userId: await createUser('grandma@example.com'),
    });

    await expect(deleteMember(memberId)).resolves.toBeDefined();
    expect(await owners()).toBe(1);
  });

  it('allows removing an owner while another owner remains', async () => {
    await createMember({
      householdId,
      userId: await createUser('co-owner@example.com'),
      role: 'owner',
    });

    await expect(deleteMember(ownerMemberId)).resolves.toBeDefined();
    expect(await owners()).toBe(1);
  });

  /**
   * Deleting the household takes its members with it, and that must not trip the trigger.
   *
   * This is what the deferral buys: the check runs at commit, by which time the household row
   * is gone and there is no invariant left to hold. An immediate trigger would fire in the
   * middle of the cascade and refuse to let anyone delete a household at all.
   */
  it('allows deleting the household itself, members and all', async () => {
    await expect(
      pool.query('delete from "organization" where id = $1', [householdId]),
    ).resolves.toBeDefined();
    expect(await owners()).toBe(0);
  });

  /**
   * The race the router cannot win: two connections, each removing a DIFFERENT owner, both
   * having decided before either commits.
   *
   * BOTH COMMITS GO AT ONCE, and that is the whole design of this test. Committing one and then
   * the other passes with or without the `FOR UPDATE` inside the trigger, because the second
   * transaction's commit-time check would see the first one's committed delete either way. It
   * is simultaneous commits that put two backends inside their triggers together, each reading
   * a snapshot from before the other wrote - the window the lock closes by making the second
   * wait. Measured: with the lock, 60 of 60 trials refused one of the two; with the lock
   * removed, 60 of 60 let both through and left the household with no owner at all.
   */
  it('lets only one of two simultaneous owner removals commit', async () => {
    const coOwnerMemberId = await createMember({
      householdId,
      userId: await createUser('co-owner@example.com'),
      role: 'owner',
    });

    const first = await pool.connect();
    const second = await pool.connect();
    try {
      await Promise.all([first.query('begin'), second.query('begin')]);
      // Both decide here, before either commits: this is the interleaving the application check
      // sees as "two owners, so removing one is fine" on both connections.
      await Promise.all([
        first.query('delete from "member" where id = $1', [ownerMemberId]),
        second.query('delete from "member" where id = $1', [coOwnerMemberId]),
      ]);

      const commits = await Promise.allSettled([first.query('commit'), second.query('commit')]);
      const refused = commits.filter((c) => c.status === 'rejected');
      expect(refused).toHaveLength(1);
      expect(refused[0]).toMatchObject({ reason: { code: 'HH001' } });
    } finally {
      await first.query('rollback').catch(() => undefined);
      await second.query('rollback').catch(() => undefined);
      first.release();
      second.release();
    }

    expect(await owners()).toBe(1);
  });
});
