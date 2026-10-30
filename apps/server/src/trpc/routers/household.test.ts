import { describe, it, expect, afterEach, beforeEach, beforeAll, afterAll, vi } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { TRPCError } from '@trpc/server';
import type { Context } from '../context';

/**
 * The mailer is a startup singleton (mail/index.ts), so substituting it is a module mock rather
 * than an injection - the same reasoning as auth-mail.test.ts, and `importActual` for the same
 * reason too: MemoryMailer is the interface the real transports implement, where a local stub
 * would drift from it and still pass.
 *
 * Here it earns its place twice. It is what proves `invite` actually mails the accept link
 * rather than only writing a row, and it is the other half of the D38 assertion: the invited
 * address has to reach the message and no log line.
 */
vi.mock('../../mail', async () => {
  const actual = await vi.importActual<typeof import('../../mail/mailer')>('../../mail/mailer');
  return { mailer: new actual.MemoryMailer() };
});

const { appRouter } = await import('./index');
const { auth } = await import('../../auth');
const { publicConfig } = await import('../../config');
const { mailer } = await import('../../mail');
const { MemoryMailer } = await import('../../mail/mailer');
const {
  ALREADY_A_MEMBER_MESSAGE,
  INVITATION_NOT_FOUND_MESSAGE,
  LAST_OWNER_MESSAGE,
  MEMBER_NOT_FOUND_MESSAGE,
  NOT_A_MEMBER_MESSAGE,
  OWNER_ONLY_MESSAGE,
} = await import('./household');
const { resetDb } = await import('../../../test/db');
const {
  activeHouseholdsOf,
  createHousehold,
  createInvitation,
  createMember,
  createUser,
  invitationStatus,
  liftHouseholdCap,
  membershipsOf,
} = await import('../../../test/factories');
const { invitedMember, ownerWithHousehold, signInHeaders, signUpWithHousehold } =
  await import('../../../test/session');
const { NO_ACTIVE_HOUSEHOLD_MESSAGE } = await import('../trpc');
const { testContext } = await import('../../../test/trpc');
const { capture } = await import('../../../test/logs');
const { createLogger } = await import('../../log');
const { buildServer } = await import('../../server');

const memory = mailer as InstanceType<typeof MemoryMailer>;
const PASSWORD = 'password1234';

/**
 * A caller bound to a real session, assembled the way `createContext` assembles one.
 *
 * The session comes from `auth.api.getSession` rather than being hand-built, because the
 * household id under test is the one Better Auth put on the session, and a fixture that
 * asserted its own value would prove nothing about the tenancy the app actually runs on.
 */
async function callerFor(headers: Headers, over: Partial<Context> = {}) {
  const session = await auth.api.getSession({ headers });
  if (session === null) throw new Error('the fixture produced no session');
  return appRouter.createCaller(
    testContext({
      session,
      householdId: session.session.activeOrganizationId ?? null,
      headers,
      ...over,
    }),
  );
}

/**
 * The code and message a rejected call produced.
 *
 * Both, always, and that is the point: several of these boundaries are also guarded by Better
 * Auth further down, so a test that asserted only "rejects" would keep passing with this
 * router's own check deleted. The message says WHICH guard answered.
 */
async function failure(call: Promise<unknown>): Promise<{ code: string; message: string }> {
  try {
    await call;
  } catch (err) {
    if (err instanceof TRPCError) return { code: err.code, message: err.message };
    throw err;
  }
  throw new Error('expected the call to be rejected, and it resolved');
}

/**
 * A second household with a signed-in owner of its own.
 *
 * The cap has to come off first: `organization_singleton_uidx` makes a second household
 * impossible, which is D41 working. Tenant isolation is the rule that must hold in the world
 * where the cap is LIFTED - that is why it is defence in depth rather than something the
 * single-household check replaces - so this is the state its tests have to construct.
 * `resetDb()` puts the index back before the next test.
 *
 * `inviterId` is only a foreign key on the invitation row: nothing reads it here, and no
 * membership follows from it. What decides where the new account lands is the invitation's
 * household, which is the one built below.
 */
async function secondHousehold(
  inviterId: string,
): Promise<{ householdId: string; userId: string; headers: Headers }> {
  await liftHouseholdCap();
  const householdId = await createHousehold();
  const owner = await invitedMember({
    householdId,
    inviterId,
    email: 'owner-b@example.com',
    role: 'owner',
  });
  return { householdId, ...owner };
}

describe('household router', () => {
  let owner: Awaited<ReturnType<typeof ownerWithHousehold>>;
  let ownerCaller: Awaited<ReturnType<typeof callerFor>>;

  beforeEach(async () => {
    await resetDb();
    owner = await ownerWithHousehold();
    ownerCaller = await callerFor(owner.headers);
    // After the owner, not before: that account is uninvited, so building it sends a real
    // verification message of its own. Clearing here is what lets "exactly one message" below
    // mean "exactly one message caused by the procedure under test".
    memory.sent.length = 0;
  });

  /** The `member` row id of an account in the owner's household, which is what removal takes. */
  const memberIdOf = async (userId: string): Promise<string> => {
    const found = (await ownerCaller.household.members()).find((m) => m.userId === userId);
    if (found === undefined) throw new Error('the fixture is not in the household');
    return found.id;
  };

  /**
   * Every procedure is a `protectedProcedure`, asserted rather than assumed.
   *
   * Without this the whole file would pass with `publicProcedure` throughout, because every
   * other test here holds a real session. The rejection comes from the middleware, so the
   * codes it produces (UNAUTHORIZED with no session, FORBIDDEN with no active household) are
   * trpc.ts's to define; this only pins that these procedures are behind it.
   */
  describe('access', () => {
    const anonymous = () => appRouter.createCaller(testContext());

    it.each([
      ['members', (c: ReturnType<typeof anonymous>) => c.household.members()],
      ['invitations', (c: ReturnType<typeof anonymous>) => c.household.invitations()],
      ['invite', (c: ReturnType<typeof anonymous>) => c.household.invite({ email: 'a@b.com' })],
      [
        'revokeInvitation',
        (c: ReturnType<typeof anonymous>) => c.household.revokeInvitation({ invitationId: 'x' }),
      ],
      [
        'removeMember',
        (c: ReturnType<typeof anonymous>) => c.household.removeMember({ memberId: 'x' }),
      ],
      ['name', (c: ReturnType<typeof anonymous>) => c.household.name()],
      ['rename', (c: ReturnType<typeof anonymous>) => c.household.rename({ name: 'Ours' })],
    ])('%s refuses a caller with no session', async (_name, call) => {
      expect((await failure(call(anonymous()))).code).toBe('UNAUTHORIZED');
    });
  });

  describe('members', () => {
    it('lists the household with each role and joined date', async () => {
      const grandma = await invitedMember({
        householdId: owner.householdId,
        inviterId: owner.userId,
        email: 'grandma@example.com',
      });

      const members = await ownerCaller.household.members();

      // Ordered, not merely present: an unordered list reshuffles between refetches, and oldest
      // first is what puts the owner at the top without the screen having to sort it.
      expect(members).toMatchObject([
        { userId: owner.userId, email: 'owner@example.com', name: owner.name, role: 'owner' },
        { userId: grandma.userId, email: 'grandma@example.com', role: 'member' },
      ]);
      // An ISO string and not a Date: this router has no superjson transformer, so a Date would
      // arrive at the client as a string while the inferred type promised a Date. Pinned here
      // because Phase F is what would find it, at runtime, on a screen.
      const joinedAt = members[0]?.joinedAt;
      expect(typeof joinedAt).toBe('string');
      expect(Number.isNaN(new Date(String(joinedAt)).getTime())).toBe(false);
    });

    /**
     * The order is sorted, not merely the order the rows come back in.
     *
     * The fixture is what makes the difference observable: both rows are written AFTER the
     * owner, and the one that claims to have joined first is written last. An unordered
     * `select` returns them in the order Postgres holds them, which for a freshly truncated
     * table is the order they were inserted - so a list that is only incidentally sorted
     * passes every other assertion in this file and fails this one.
     */
    it('orders by when people joined, not by however the rows come back', async () => {
      const hourAgo = new Date(Date.now() - 60 * 60 * 1000);
      const later = await createUser('later@example.com');
      await createMember({ householdId: owner.householdId, userId: later });
      const earlier = await createUser('earlier@example.com');
      await createMember({ householdId: owner.householdId, userId: earlier, createdAt: hourAgo });

      const members = await ownerCaller.household.members();

      expect(members.map((m) => m.email)).toEqual([
        'earlier@example.com',
        'owner@example.com',
        'later@example.com',
      ]);
    });

    /**
     * The window migration 0006 leaves open, which is a request that was already in flight.
     *
     * The caller is built BEFORE the removal deliberately: a context resolved moments before the
     * delete committed is the only way this refusal is still reachable, now that a removed
     * member's sessions lose the household inside that delete. A caller built afterwards is
     * stopped by `protectedProcedure` instead, which is what the removeMember tests below
     * assert. Better Auth answers this one with an `APIError`, which is not a `TRPCError`: left
     * raw it would be a 500 logged at `error` for a race nobody can act on. It is the one Better
     * Auth refusal the router translates.
     */
    it('tells a removed member their session outlived their membership', async () => {
      const grandma = await invitedMember({
        householdId: owner.householdId,
        inviterId: owner.userId,
        email: 'grandma@example.com',
      });
      const memberCaller = await callerFor(grandma.headers);
      await ownerCaller.household.removeMember({ memberId: await memberIdOf(grandma.userId) });

      expect(await failure(memberCaller.household.members())).toEqual({
        code: 'FORBIDDEN',
        message: NOT_A_MEMBER_MESSAGE,
      });
      expect(await failure(memberCaller.household.invitations())).toEqual({
        code: 'FORBIDDEN',
        message: NOT_A_MEMBER_MESSAGE,
      });
    });

    // Reading the household is not an owner's privilege: the settings screen shows every member
    // who they live with. Only the three mutations are gated.
    it('is readable by a member, not only by the owner', async () => {
      const grandma = await invitedMember({
        householdId: owner.householdId,
        inviterId: owner.userId,
        email: 'grandma@example.com',
      });
      const memberCaller = await callerFor(grandma.headers);

      await expect(memberCaller.household.members()).resolves.toHaveLength(2);
      await expect(memberCaller.household.invitations()).resolves.toEqual([]);
    });
  });

  describe('invitations', () => {
    it('lists the pending ones, expired included, and nothing else', async () => {
      const base = { householdId: owner.householdId, inviterId: owner.userId };
      const live = await createInvitation({ ...base, email: 'live@example.com' });
      // Still pending, and still the owner's business: this is the row that explains why the
      // invitee was told the instance is invite-only, and the one they will want re-sent. The
      // client has `expiresAt` and can say so.
      const expired = await createInvitation({
        ...base,
        email: 'expired@example.com',
        expiresAt: new Date(Date.now() - 60_000),
      });
      await createInvitation({ ...base, email: 'in@example.com', status: 'accepted' });
      await createInvitation({ ...base, email: 'no@example.com', status: 'rejected' });
      await createInvitation({ ...base, email: 'gone@example.com', status: 'canceled' });

      const pending = await ownerCaller.household.invitations();

      expect(pending.map((i) => i.id).sort()).toEqual([live, expired].sort());
      expect(pending).toContainEqual(
        expect.objectContaining({ email: 'live@example.com', role: 'member' }),
      );
    });

    // In the order they were issued, and the older row is written last for the same reason the
    // member ordering test writes one out of sequence: otherwise "sorted" and "however the rows
    // came back" are the same list.
    it('orders by when the invitation was issued', async () => {
      const base = { householdId: owner.householdId, inviterId: owner.userId };
      const second = await createInvitation({ ...base, email: 'second@example.com' });
      const first = await createInvitation({
        ...base,
        email: 'first@example.com',
        createdAt: new Date(Date.now() - 60 * 60 * 1000),
      });

      expect((await ownerCaller.household.invitations()).map((i) => i.id)).toEqual([first, second]);
    });
  });

  describe('invite', () => {
    it('creates a pending invitation and mails the accept link to it', async () => {
      // Mixed case on purpose: Better Auth lowercases before it stores or sends, and the stored
      // address is what the sign-up gate later matches (auth-invite.ts).
      const invitation = await ownerCaller.household.invite({ email: 'Grandma@Example.COM' });

      expect(invitation.email).toBe('grandma@example.com');
      expect(await ownerCaller.household.invitations()).toEqual([invitation]);
      expect(memory.sent).toHaveLength(1);
      expect(memory.sent[0]?.to).toBe('grandma@example.com');
      expect(memory.sent[0]?.actionUrl).toBe(
        `${publicConfig.webOrigin}/accept-invite/${invitation.id}`,
      );
    });

    /**
     * The role pin, and the reason it is not cosmetic.
     *
     * The cast is the test. `invite` takes an email and nothing else, so this is what a client
     * posting an extra field sends; without the pin the invitation is created as an OWNER one,
     * and D36's auto-accept then writes a second owner into the household at sign-up - from an
     * unprivileged field on an unprivileged request.
     *
     * Asserted at both ends: the role the invitation carries, and the role the account that
     * consumes it actually lands with.
     */
    it('issues a member invitation even when a role is posted alongside the address', async () => {
      const invitation = await ownerCaller.household.invite({
        email: 'grandma@example.com',
        role: 'owner',
      } as { email: string });

      expect(invitation.role).toBe('member');

      await auth.api.signUpEmail({
        body: { email: 'grandma@example.com', password: PASSWORD, name: 'Grandma' },
      });
      expect(await membershipsOf('grandma@example.com')).toEqual([
        { householdId: owner.householdId, role: 'member' },
      ]);
    });

    /**
     * Re-inviting is the ordinary case, not an error: the first message went to spam, or was
     * deleted, and the owner presses Invite again. Better Auth refuses a second invitation for
     * a pending address unless asked to resend, so `resend: true` is what keeps that press from
     * being a 500. One row, extended, and a second message.
     */
    it('re-sends rather than failing when the address already has an invitation', async () => {
      const first = await ownerCaller.household.invite({ email: 'grandma@example.com' });
      const second = await ownerCaller.household.invite({ email: 'grandma@example.com' });

      expect(second.id).toBe(first.id);
      expect(await ownerCaller.household.invitations()).toHaveLength(1);
      expect(memory.sent).toHaveLength(2);
    });

    it('refuses an address that is already in the household, whatever its case', async () => {
      await invitedMember({
        householdId: owner.householdId,
        inviterId: owner.userId,
        email: 'grandma@example.com',
      });

      expect(await failure(ownerCaller.household.invite({ email: 'grandma@example.com' }))).toEqual(
        { code: 'CONFLICT', message: ALREADY_A_MEMBER_MESSAGE },
      );
      expect(await failure(ownerCaller.household.invite({ email: 'GRANDMA@Example.com' }))).toEqual(
        { code: 'CONFLICT', message: ALREADY_A_MEMBER_MESSAGE },
      );
      expect(memory.sent).toHaveLength(0);
    });

    // Padded, not malformed. `normalizeEmail` deliberately does not trim (auth-invite.ts), so an
    // invitation stored with the spaces intact is one no sign-up could ever match: the address
    // has to be refused here rather than mailed to.
    it('rejects an address the sign-up gate could never match', async () => {
      expect(
        (await failure(ownerCaller.household.invite({ email: ' grandma@example.com ' }))).code,
      ).toBe('BAD_REQUEST');
      expect(memory.sent).toHaveLength(0);
    });

    it('refuses a member who is not the owner', async () => {
      const grandma = await invitedMember({
        householdId: owner.householdId,
        inviterId: owner.userId,
        email: 'grandma@example.com',
      });
      const memberCaller = await callerFor(grandma.headers);

      expect(await failure(memberCaller.household.invite({ email: 'friend@example.com' }))).toEqual(
        {
          code: 'FORBIDDEN',
          message: OWNER_ONLY_MESSAGE,
        },
      );
      expect(await ownerCaller.household.invitations()).toEqual([]);
      expect(memory.sent).toHaveLength(0);
    });
  });

  describe('revokeInvitation', () => {
    it('cancels a pending invitation', async () => {
      const invitation = await ownerCaller.household.invite({ email: 'grandma@example.com' });

      await ownerCaller.household.revokeInvitation({ invitationId: invitation.id });

      // The status spelling is Better Auth's: `canceled`, one L.
      expect(await invitationStatus(invitation.id)).toBe('canceled');
      expect(await ownerCaller.household.invitations()).toEqual([]);
    });

    it('refuses an id that is not a pending invitation of this household', async () => {
      const invitation = await ownerCaller.household.invite({ email: 'grandma@example.com' });
      await ownerCaller.household.revokeInvitation({ invitationId: invitation.id });

      const unknown = await failure(
        ownerCaller.household.revokeInvitation({ invitationId: 'inv_nope' }),
      );
      expect(unknown).toEqual({ code: 'NOT_FOUND', message: INVITATION_NOT_FOUND_MESSAGE });
      // A second revoke of the same row, which is what a double click sends.
      const again = await failure(
        ownerCaller.household.revokeInvitation({ invitationId: invitation.id }),
      );
      expect(again).toEqual({ code: 'NOT_FOUND', message: INVITATION_NOT_FOUND_MESSAGE });
    });

    it('refuses a member who is not the owner, without touching the invitation', async () => {
      const invitation = await ownerCaller.household.invite({ email: 'friend@example.com' });
      const grandma = await invitedMember({
        householdId: owner.householdId,
        inviterId: owner.userId,
        email: 'grandma@example.com',
      });
      const memberCaller = await callerFor(grandma.headers);

      expect(
        await failure(memberCaller.household.revokeInvitation({ invitationId: invitation.id })),
      ).toEqual({ code: 'FORBIDDEN', message: OWNER_ONLY_MESSAGE });
      expect(await invitationStatus(invitation.id)).toBe('pending');
    });
  });

  describe('rename', () => {
    it('lets the owner rename the household, and every member reads the new name', async () => {
      const grandma = await invitedMember({
        householdId: owner.householdId,
        inviterId: owner.userId,
        email: 'grandma@example.com',
      });
      const memberCaller = await callerFor(grandma.headers);

      expect(await ownerCaller.household.rename({ name: '  The Lewis Kitchen ' })).toEqual({
        name: 'The Lewis Kitchen',
      });
      expect(await memberCaller.household.name()).toEqual({ name: 'The Lewis Kitchen' });
    });

    it('refuses a member who is not the owner, and a blank name', async () => {
      const before = await ownerCaller.household.name();
      const grandma = await invitedMember({
        householdId: owner.householdId,
        inviterId: owner.userId,
        email: 'grandma@example.com',
      });
      const memberCaller = await callerFor(grandma.headers);

      expect(await failure(memberCaller.household.rename({ name: 'Mine now' }))).toEqual({
        code: 'FORBIDDEN',
        message: OWNER_ONLY_MESSAGE,
      });
      expect((await failure(ownerCaller.household.rename({ name: '   ' }))).code).toBe(
        'BAD_REQUEST',
      );
      expect(await ownerCaller.household.name()).toEqual(before);
    });
  });

  describe('removeMember', () => {
    // `serializeRemovals` below installs a spy on `auth.api.removeMember`; every other test in
    // this block calls the real one.
    afterEach(() => {
      vi.restoreAllMocks();
    });

    /** A promise and the function that settles it, for holding one call while another runs. */
    function gate(): { open: () => void; opened: Promise<void> } {
      let open = (): void => {};
      const opened = new Promise<void>((resolve) => {
        open = resolve;
      });
      return { open, opened };
    }

    /**
     * Two concurrent removals serialized, with the loser chosen rather than drawn.
     *
     * The window this router cannot win is between its own read of the membership and Better
     * Auth's write: both calls read two owners, and by the time the second one writes the first
     * has committed. Left to the scheduler, WHERE the second one is then refused varies - the
     * database trigger if it got as far as the delete, Better Auth's own re-read if it did not -
     * and the second of those turned up in about one whole-file run in six. This holds the
     * window open on purpose instead: both calls are already past this router's own check when
     * the spy is entered, since the spy IS the call that follows it, and then one plugin call
     * runs to completion before the other starts.
     *
     * `auth.api.removeMember` is the seam because it is the call this router makes. Nothing
     * below it is substituted, so the plugin's checks, the delete and migration 0005's trigger
     * are all the real ones; what is arranged is only the order.
     *
     * `loserMemberId` names the removal that runs second. Omitted, whichever call ARRIVES
     * second runs second, which is what two removals of the same member need - there the two
     * calls carry the same target and nothing else tells them apart.
     */
    function serializeRemovals(loserMemberId?: string): void {
      const removeMember = auth.api.removeMember;
      const bothArrived = gate();
      const winnerSettled = gate();
      let arrived = 0;

      const ordered = async (
        ...args: Parameters<typeof removeMember>
      ): Promise<Awaited<ReturnType<typeof removeMember>>> => {
        const index = arrived;
        arrived += 1;
        if (arrived === 2) bothArrived.open();
        await bothArrived.opened;

        const target = args[0]?.body?.memberIdOrEmail;
        if (loserMemberId === undefined ? index === 1 : target === loserMemberId) {
          await winnerSettled.opened;
          return removeMember(...args);
        }
        try {
          return await removeMember(...args);
        } finally {
          winnerSettled.open();
        }
      };

      vi.spyOn(auth.api, 'removeMember').mockImplementation(ordered as typeof removeMember);
    }

    /** The household under test for the three race tests: the owner, plus a second owner. */
    async function twoOwners(): Promise<{ ownerMemberId: string; coOwnerMemberId: string }> {
      const coOwnerId = await createUser('co-owner@example.com');
      await createMember({ householdId: owner.householdId, userId: coOwnerId, role: 'owner' });
      return {
        ownerMemberId: await memberIdOf(owner.userId),
        coOwnerMemberId: await memberIdOf(coOwnerId),
      };
    }

    it('removes a member from the household', async () => {
      const grandma = await invitedMember({
        householdId: owner.householdId,
        inviterId: owner.userId,
        email: 'grandma@example.com',
      });

      await ownerCaller.household.removeMember({ memberId: await memberIdOf(grandma.userId) });

      expect(await ownerCaller.household.members()).toHaveLength(1);
      expect(await membershipsOf('grandma@example.com')).toEqual([]);
    });

    /**
     * The rule is about the household keeping an owner, not about self-removal: leaving is a
     * reasonable thing to want, and the case that must not happen is the household ending up
     * with nobody who can invite or remove anyone. With the role pinned to `member`, the
     * instance's only owner is its first account, so in practice this is what they get.
     */
    it('refuses to remove the last owner, including when that is the caller', async () => {
      const ownerMemberId = await memberIdOf(owner.userId);

      expect(
        await failure(ownerCaller.household.removeMember({ memberId: ownerMemberId })),
      ).toEqual({ code: 'CONFLICT', message: LAST_OWNER_MESSAGE });
      expect(await membershipsOf('owner@example.com')).toEqual([
        { householdId: owner.householdId, role: 'owner' },
      ]);
    });

    /**
     * The race the router's own check cannot win, run without arranging anything.
     *
     * Both calls read the membership before either writes, so both see two owners and both
     * decide the removal is fine - which is how two parallel requests emptied a household of
     * owners before migration 0005. Something below this router refuses the second one; this is
     * what turns that refusal into the same sentence the sequential case gets, rather than a
     * 500 and an error-level line for a person who pressed a button.
     *
     * This is the only one of the four race tests that leaves the ordering to the scheduler,
     * and it is kept for the one thing the three below cannot do: reach the point where both
     * calls are inside the delete, which is where migration 0005's trigger - rather than any
     * check - is what refuses the second commit. Measured over 8 whole-file runs, the loser was
     * the self-removal every time, refused by the trigger 7 times (SQLSTATE HH001) and by
     * Better Auth's own owner count once. Both of those are the last-owner refusal and both are
     * answered with the sentence below; the test that pins the second of them by construction
     * is the next one.
     */
    it('gives the loser of two concurrent owner removals the ordinary answer', async () => {
      const { ownerMemberId, coOwnerMemberId } = await twoOwners();

      const outcomes = await Promise.allSettled([
        ownerCaller.household.removeMember({ memberId: ownerMemberId }),
        ownerCaller.household.removeMember({ memberId: coOwnerMemberId }),
      ]);

      const rejected = outcomes.filter((o) => o.status === 'rejected');
      expect(rejected).toHaveLength(1);
      // The loser's answer depends on which removal committed first, and both are designed:
      // the two tests below pin each order. If the self-removal won, the co-owner's removal
      // was made by someone no longer in the household and is told so; otherwise the loser
      // would have left no owner. Asserting only the second failed CI whenever the scheduler
      // chose the first.
      //
      // When the self-removal won, the loser's answer ALSO depends on when it checked: after the
      // commit it is no longer a member (FORBIDDEN); before it, it gets as far as the delete and
      // the last-owner trigger refuses it (CONFLICT), since removing the co-owner would now leave
      // no owner. Both are true of the state the loser saw. CI hit the second on 2026-09-23.
      const selfRemovalWon = outcomes[0]?.status === 'fulfilled';
      const answer = await failure(Promise.reject(rejected[0]?.reason));
      const lastOwner = { code: 'CONFLICT', message: LAST_OWNER_MESSAGE };
      const notAMember = { code: 'FORBIDDEN', message: NOT_A_MEMBER_MESSAGE };
      expect(selfRemovalWon ? [notAMember, lastOwner] : [lastOwner]).toContainEqual(answer);
      // WHICH of the two commits is up to the scheduler, so the assertion is about the
      // household rather than about a person: one membership left, and it is an owner. That is
      // the whole point - someone can still invite and remove.
      expect([
        ...(await membershipsOf('owner@example.com')),
        ...(await membershipsOf('co-owner@example.com')),
      ]).toEqual([{ householdId: owner.householdId, role: 'owner' }]);
    });

    /**
     * The half of that race where Better Auth is what refuses the loser, held open on purpose.
     *
     * The co-owner's removal commits first, so the self-removal reaches the plugin after the
     * household is down to one owner and is refused by the plugin's own owner count, before it
     * ever reaches the delete. What it is refused WITH is the whole reason this test exists,
     * and it was measured rather than reasoned about: a Better Auth `APIError`, `status`
     * BAD_REQUEST, `body.code` of `YOU_CANNOT_LEAVE_THE_ORGANIZATION_AS_THE_ONLY_OWNER`, no
     * `code` of its own at the top level and no `cause`. A check that reads `err.code` sees
     * nothing there, which is how this reached the client as a 500 for as long as it did.
     */
    it('answers the loser the same way when Better Auth is what refused it', async () => {
      const { ownerMemberId, coOwnerMemberId } = await twoOwners();
      serializeRemovals(ownerMemberId);

      const outcomes = await Promise.allSettled([
        ownerCaller.household.removeMember({ memberId: ownerMemberId }),
        ownerCaller.household.removeMember({ memberId: coOwnerMemberId }),
      ]);

      expect(outcomes.map((o) => o.status)).toEqual(['rejected', 'fulfilled']);
      const rejected = outcomes.filter((o) => o.status === 'rejected');
      expect(await failure(Promise.reject(rejected[0]?.reason))).toEqual({
        code: 'CONFLICT',
        message: LAST_OWNER_MESSAGE,
      });
      expect([
        ...(await membershipsOf('owner@example.com')),
        ...(await membershipsOf('co-owner@example.com')),
      ]).toEqual([{ householdId: owner.householdId, role: 'owner' }]);
    });

    /**
     * The other half, which loses for a different reason and so gets a different sentence.
     *
     * Here the self-removal commits first, so when the co-owner's removal reaches the plugin
     * the CALLER is the one with no membership left. Better Auth refuses it on that - measured:
     * an `APIError`, BAD_REQUEST, `body.code` of `MEMBER_NOT_FOUND`, raised for the caller's own
     * missing row before it ever looks the target up. The target is still there.
     *
     * So the answer is NOT the last-owner sentence, even though the co-owner is by then the
     * last owner and removing them would be refused too. What actually stopped this call is
     * that the person making it has left, which is the state `rethrowLostMembership` already
     * names and which asks the client for the same thing: sign in again.
     */
    it('tells a caller whose own membership went first that they are not a member', async () => {
      const { ownerMemberId, coOwnerMemberId } = await twoOwners();
      serializeRemovals(coOwnerMemberId);

      const outcomes = await Promise.allSettled([
        ownerCaller.household.removeMember({ memberId: ownerMemberId }),
        ownerCaller.household.removeMember({ memberId: coOwnerMemberId }),
      ]);

      expect(outcomes.map((o) => o.status)).toEqual(['fulfilled', 'rejected']);
      const rejected = outcomes.filter((o) => o.status === 'rejected');
      expect(await failure(Promise.reject(rejected[0]?.reason))).toEqual({
        code: 'FORBIDDEN',
        message: NOT_A_MEMBER_MESSAGE,
      });
      expect([
        ...(await membershipsOf('owner@example.com')),
        ...(await membershipsOf('co-owner@example.com')),
      ]).toEqual([{ householdId: owner.householdId, role: 'owner' }]);
    });

    /**
     * The third way a removal loses, and the one with no owner in it: the same person removed
     * twice at once, which is what a double click on a slow link sends.
     *
     * The loser's target row is gone by the time the plugin looks it up, so it is refused with
     * the SAME `body.code` of `MEMBER_NOT_FOUND` as the test above, for the other missing row.
     * Which row it was is what the router's re-read tells apart, and this is the side of it that
     * has to stay a 404 about the target rather than a 403 about the caller.
     */
    it('tells the loser of two removals of the same person that they are already gone', async () => {
      const grandma = await invitedMember({
        householdId: owner.householdId,
        inviterId: owner.userId,
        email: 'grandma@example.com',
      });
      const grandmaMemberId = await memberIdOf(grandma.userId);
      serializeRemovals();

      const outcomes = await Promise.allSettled([
        ownerCaller.household.removeMember({ memberId: grandmaMemberId }),
        ownerCaller.household.removeMember({ memberId: grandmaMemberId }),
      ]);

      const rejected = outcomes.filter((o) => o.status === 'rejected');
      expect(rejected).toHaveLength(1);
      expect(await failure(Promise.reject(rejected[0]?.reason))).toEqual({
        code: 'NOT_FOUND',
        message: MEMBER_NOT_FOUND_MESSAGE,
      });
      expect(await membershipsOf('grandma@example.com')).toEqual([]);
    });

    // The other side of the same rule, and what proves it counts owners rather than refusing to
    // touch an owner at all.
    it('lets an owner leave once a second owner is there to hold the household', async () => {
      const coOwnerId = await createUser('co-owner@example.com');
      await createMember({ householdId: owner.householdId, userId: coOwnerId, role: 'owner' });
      const ownerMemberId = await memberIdOf(owner.userId);

      await ownerCaller.household.removeMember({ memberId: ownerMemberId });

      expect(await membershipsOf('owner@example.com')).toEqual([]);
      expect(await membershipsOf('co-owner@example.com')).toEqual([
        { householdId: owner.householdId, role: 'owner' },
      ]);
    });

    it('refuses an id that is not a member of this household', async () => {
      expect(await failure(ownerCaller.household.removeMember({ memberId: 'mbr_nope' }))).toEqual({
        code: 'NOT_FOUND',
        message: MEMBER_NOT_FOUND_MESSAGE,
      });
    });

    it('refuses a member who is not the owner, without removing anyone', async () => {
      const grandma = await invitedMember({
        householdId: owner.householdId,
        inviterId: owner.userId,
        email: 'grandma@example.com',
      });
      const memberCaller = await callerFor(grandma.headers);
      const ownerMemberId = await memberIdOf(owner.userId);

      expect(
        await failure(memberCaller.household.removeMember({ memberId: ownerMemberId })),
      ).toEqual({ code: 'FORBIDDEN', message: OWNER_ONLY_MESSAGE });
      expect(await ownerCaller.household.members()).toHaveLength(2);
    });

    /**
     * The hole this whole rule exists to close, stated where it was actually found.
     *
     * The household router refuses a removed member on its own, because it re-derives
     * membership through Better Auth on every call - which is exactly why this looked shut.
     * Every OTHER router trusts `ctx.householdId`, which `createContext` reads off the
     * session's `activeOrganizationId`, and Better Auth clears that field only when a user
     * removes THEMSELVES. So the recipes are the assertion, not the membership list: measured
     * before migration 0006, `recipe.list` returned the household's recipes to someone who had
     * been removed from it, and went on doing so until the session expired seven days later.
     *
     * The caller is rebuilt from the same cookie afterwards rather than reused, because that is
     * what a second request is: `createContext` resolves the session again from the headers.
     */
    it('leaves a removed member no way back into the household recipes', async () => {
      const grandma = await invitedMember({
        householdId: owner.householdId,
        inviterId: owner.userId,
        email: 'grandma@example.com',
      });
      await ownerCaller.recipe.create({ title: 'Pot roast' });
      // The access is real before it is taken away, which is what makes its absence meaningful.
      expect((await (await callerFor(grandma.headers)).recipe.list()).map((r) => r.title)).toEqual([
        'Pot roast',
      ]);

      await ownerCaller.household.removeMember({ memberId: await memberIdOf(grandma.userId) });

      expect(await failure((await callerFor(grandma.headers)).recipe.list())).toEqual({
        code: 'FORBIDDEN',
        message: NO_ACTIVE_HOUSEHOLD_MESSAGE,
      });
      expect(await failure((await callerFor(grandma.headers)).shoppingList.get())).toEqual({
        code: 'FORBIDDEN',
        message: NO_ACTIVE_HOUSEHOLD_MESSAGE,
      });
    });

    /**
     * The session SURVIVES; what it loses is the household.
     *
     * Deliberate, and the reason is on the migration: removing someone from the household is
     * not the same as ending their account, and the web app already has a screen for an
     * account with no household (`<Onboarding />`) and a route outside the gate for one that
     * has been invited back (`/accept-invite/:id`). Deleting the row would sign them out of a
     * device instead, and would leave Better Auth's own `setActiveOrganization` writing to a
     * row that no longer exists on the self-removal path.
     */
    it('clears the household from the removed member session without ending it', async () => {
      const grandma = await invitedMember({
        householdId: owner.householdId,
        inviterId: owner.userId,
        email: 'grandma@example.com',
      });

      await ownerCaller.household.removeMember({ memberId: await memberIdOf(grandma.userId) });

      expect(await activeHouseholdsOf('grandma@example.com')).toEqual([null]);
      const session = await auth.api.getSession({ headers: grandma.headers });
      expect(session?.user.email).toBe('grandma@example.com');
    });

    /**
     * Every device, not the one that happens to be newest.
     *
     * A phone and a laptop are two `session` rows for one account, and only the household they
     * name makes either of them a way into the recipes. A fix that cleared "the" session would
     * pass the test above and leave the other road open.
     */
    it('reaches every device the removed member is signed in on', async () => {
      const grandma = await invitedMember({
        householdId: owner.householdId,
        inviterId: owner.userId,
        email: 'grandma@example.com',
      });
      const laptop = await signInHeaders('grandma@example.com');
      expect(await activeHouseholdsOf('grandma@example.com')).toEqual([
        owner.householdId,
        owner.householdId,
      ]);

      await ownerCaller.household.removeMember({ memberId: await memberIdOf(grandma.userId) });

      expect(await activeHouseholdsOf('grandma@example.com')).toEqual([null, null]);
      expect(await failure((await callerFor(laptop)).recipe.list())).toEqual({
        code: 'FORBIDDEN',
        message: NO_ACTIVE_HOUSEHOLD_MESSAGE,
      });
    });

    /**
     * Self-removal is the path Better Auth already handles, and it handles exactly one session:
     * the one holding the request. The owner who leaves on their phone keeps a laptop pointed
     * at the household they just left.
     */
    it('reaches the other devices of an owner who removes themselves', async () => {
      const coOwnerId = await createUser('co-owner@example.com');
      await createMember({ householdId: owner.householdId, userId: coOwnerId, role: 'owner' });
      const laptop = await signInHeaders('owner@example.com');

      await ownerCaller.household.removeMember({ memberId: await memberIdOf(owner.userId) });

      expect(await activeHouseholdsOf('owner@example.com')).toEqual([null, null]);
      expect(await failure((await callerFor(laptop)).recipe.list())).toEqual({
        code: 'FORBIDDEN',
        message: NO_ACTIVE_HOUSEHOLD_MESSAGE,
      });
    });

    /** Nobody else's session is touched: the household goes on working for the people in it. */
    it('leaves the sessions of everyone still in the household alone', async () => {
      const grandma = await invitedMember({
        householdId: owner.householdId,
        inviterId: owner.userId,
        email: 'grandma@example.com',
      });
      await ownerCaller.recipe.create({ title: 'Pot roast' });

      await ownerCaller.household.removeMember({ memberId: await memberIdOf(grandma.userId) });

      expect(await activeHouseholdsOf('owner@example.com')).toEqual([owner.householdId]);
      expect((await (await callerFor(owner.headers)).recipe.list()).map((r) => r.title)).toEqual([
        'Pot roast',
      ]);
    });
  });

  /**
   * The tenant boundary, tested from the other household's side.
   *
   * Not `withHousehold` here: these are Better Auth's tables, which carry `organization_id` and
   * have no RLS policy, so the scoping is the router's own - every call names
   * `ctx.householdId`, which comes off the session and never off the wire. That claim is only
   * worth what a second household can prove about it.
   */
  describe('across households', () => {
    it('lists only its own household', async () => {
      const b = await secondHousehold(owner.userId);
      await createInvitation({
        householdId: owner.householdId,
        inviterId: owner.userId,
        email: 'grandma@example.com',
      });
      const bCaller = await callerFor(b.headers);

      const members = await bCaller.household.members();
      expect(members.map((m) => m.email)).toEqual(['owner-b@example.com']);
      expect(await bCaller.household.invitations()).toEqual([]);
    });

    it('cannot revoke another household invitation', async () => {
      const invitation = await ownerCaller.household.invite({ email: 'grandma@example.com' });
      const b = await secondHousehold(owner.userId);
      const bCaller = await callerFor(b.headers);

      expect(
        await failure(bCaller.household.revokeInvitation({ invitationId: invitation.id })),
      ).toEqual({ code: 'NOT_FOUND', message: INVITATION_NOT_FOUND_MESSAGE });
      expect(await invitationStatus(invitation.id)).toBe('pending');
    });

    it('cannot remove another household member', async () => {
      const ownerMemberId = await memberIdOf(owner.userId);
      const b = await secondHousehold(owner.userId);
      const bCaller = await callerFor(b.headers);

      expect(await failure(bCaller.household.removeMember({ memberId: ownerMemberId }))).toEqual({
        code: 'NOT_FOUND',
        message: MEMBER_NOT_FOUND_MESSAGE,
      });
      expect(await membershipsOf('owner@example.com')).toEqual([
        { householdId: owner.householdId, role: 'owner' },
      ]);
    });
  });
});

/**
 * The same router over a real request, which is the only place two things are observable: that
 * `createContext` hands the session headers to the procedures (nothing else could authenticate
 * the Better Auth calls underneath), and what the request actually wrote to the log.
 *
 * D38 is easier to violate here than anywhere else in this codebase, because an email address
 * is this router's primary input. The assertion is over every line the file produced, not only
 * the tRPC ones, and it includes `msg` - the one field no serializer can reach (log.ts).
 *
 * What it does not cover, stated rather than implied: the console mailer's own line, which
 * carries the recipient by design because in that mode the log IS the delivery (mailer.ts).
 * That line goes to the module logger, which is silent under test, and the mailer here is a
 * MemoryMailer anyway.
 */
describe('household router over a real request', () => {
  let server: FastifyInstance;
  let lines: () => Record<string, unknown>[];
  let cookie: string;

  beforeAll(async () => {
    await resetDb();
    const captured = capture();
    lines = captured.lines;
    server = await buildServer({
      logger: createLogger({ level: 'info', pretty: false, destination: captured.sink }),
    });
    ({ cookie } = await signUpWithHousehold(server, 'owner@test.dev'));
    memory.sent.length = 0;
  });

  afterAll(async () => {
    await server.close();
  });

  const query = (path: string) =>
    server.inject({ method: 'GET', url: `/trpc/${path}`, headers: { cookie } });
  const mutate = (path: string, payload: unknown) =>
    server.inject({
      method: 'POST',
      url: `/trpc/${path}`,
      payload: payload as object,
      headers: { 'content-type': 'application/json', cookie },
    });
  const data = <T>(res: { json: () => unknown }): T =>
    (res.json() as { result: { data: T } }).result.data;

  it('drives every procedure over HTTP and writes no address to the log', async () => {
    const invited = await mutate('household.invite', { email: 'grandma@example.com' });
    expect(invited.statusCode).toBe(200);
    const invitation = data<{ id: string; email: string }>(invited);
    expect(invitation.email).toBe('grandma@example.com');

    const pending = await query('household.invitations');
    expect(data<{ id: string }[]>(pending).map((i) => i.id)).toEqual([invitation.id]);

    const members = await query('household.members');
    const [me] = data<{ id: string; email: string }[]>(members);
    expect(me?.email).toBe('owner@test.dev');

    // Two failures as well as the successes: a rejected call is where an address would reach a
    // log line, through an error message or a validation issue.
    const lastOwner = await mutate('household.removeMember', { memberId: me?.id });
    expect(lastOwner.statusCode).toBe(409);
    const malformed = await mutate('household.invite', { email: 'grandma at example.com' });
    expect(malformed.statusCode).toBe(400);

    const revoked = await mutate('household.revokeInvitation', { invitationId: invitation.id });
    expect(revoked.statusCode).toBe(200);

    // The lines have to exist first: "the address is absent" is trivially true of a log nobody
    // wrote, and would pass with the whole middleware deleted.
    const trpcLines = lines().filter((l) => l.msg === 'trpc');
    expect(trpcLines.map((l) => l.path)).toEqual([
      'household.invite',
      'household.invitations',
      'household.members',
      'household.removeMember',
      'household.invite',
      'household.revokeInvitation',
    ]);

    // The address reached the invitee, which is what makes its absence from the log meaningful.
    expect(memory.sent.map((m) => m.to)).toEqual(['grandma@example.com']);
    const written = JSON.stringify(lines());
    expect(written).not.toContain('grandma@example.com');
    expect(written).not.toContain('grandma at example.com');
    expect(written).not.toContain('owner@test.dev');
  });
});

/**
 * The two roads out of a household that never pass through this router.
 *
 * `/api/auth/organization/remove-member` and `/api/auth/organization/leave` are mounted at
 * `/api/auth/*` and delete a `member` row without any of this app's code running. That is the
 * same shape migration 0005 was written for, and it is why the session rule cannot live in
 * `household.removeMember`: a rule enforced in the router is a rule with a road around it.
 *
 * Driven over real HTTP with real cookies, so what is being tested is the deployed surface
 * rather than a helper. `leave` also covers the case Better Auth half-handles - it clears the
 * active household on the session that made the request, and leaves every other device of the
 * same account pointed at the household its owner just walked out of.
 */
describe('a membership that ends over the raw auth endpoints', () => {
  let server: FastifyInstance;

  beforeAll(async () => {
    server = await buildServer({ logger: createLogger({ level: 'silent', pretty: false }) });
  });

  afterAll(async () => {
    await server.close();
  });

  beforeEach(async () => {
    await resetDb();
  });

  const post = (url: string, payload: object, cookie: string) =>
    server.inject({
      method: 'POST',
      url,
      payload,
      headers: { 'content-type': 'application/json', cookie },
    });
  const listRecipes = (cookie: string) =>
    server.inject({ method: 'GET', url: '/trpc/recipe.list', headers: { cookie } });
  const cookieOf = (headers: Headers): string => headers.get('cookie') ?? '';

  /** The `member` row id of an account, read the way the owner's own client would read it. */
  const memberIdOf = async (headers: Headers, householdId: string, email: string) => {
    const { members } = await auth.api.listMembers({
      query: { organizationId: householdId },
      headers,
    });
    const found = members.find((m) => m.user.email === email);
    if (found === undefined) throw new Error('the fixture is not in the household');
    return found.id;
  };

  it('shuts the recipes to a member removed through the mounted endpoint', async () => {
    const owner = await ownerWithHousehold();
    const grandma = await invitedMember({
      householdId: owner.householdId,
      inviterId: owner.userId,
      email: 'grandma@example.com',
    });
    const laptop = await signInHeaders('grandma@example.com');
    await post('/trpc/recipe.create', { title: 'Pot roast' }, cookieOf(owner.headers));

    // The access is real first, over the same route and the same cookie.
    const before = await listRecipes(grandma.cookie);
    expect(before.statusCode).toBe(200);
    expect(before.body).toContain('Pot roast');

    const removed = await post(
      '/api/auth/organization/remove-member',
      {
        memberIdOrEmail: await memberIdOf(owner.headers, owner.householdId, 'grandma@example.com'),
        organizationId: owner.householdId,
      },
      cookieOf(owner.headers),
    );
    expect(removed.statusCode).toBe(200);

    // The symptom first, so that a broken revocation fails on the access it leaves open rather
    // than on the column that is the mechanism of shutting it.
    expect((await listRecipes(grandma.cookie)).statusCode).toBe(403);
    expect((await listRecipes(cookieOf(laptop))).statusCode).toBe(403);
    expect(await activeHouseholdsOf('grandma@example.com')).toEqual([null, null]);
    // The household goes on working for the person still in it.
    expect((await listRecipes(cookieOf(owner.headers))).statusCode).toBe(200);
  });

  it('shuts the recipes on every device of someone who leaves on one of them', async () => {
    const owner = await ownerWithHousehold();
    const grandma = await invitedMember({
      householdId: owner.householdId,
      inviterId: owner.userId,
      email: 'grandma@example.com',
    });
    const laptop = await signInHeaders('grandma@example.com');

    const left = await post(
      '/api/auth/organization/leave',
      { organizationId: owner.householdId },
      grandma.cookie,
    );
    expect(left.statusCode).toBe(200);

    // Better Auth clears the session that made the request. The laptop is the one it misses.
    expect((await listRecipes(cookieOf(laptop))).statusCode).toBe(403);
    expect(await activeHouseholdsOf('grandma@example.com')).toEqual([null, null]);
  });
});
