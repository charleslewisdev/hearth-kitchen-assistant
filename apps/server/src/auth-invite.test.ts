import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { auth } from './auth';
import { env } from './env';
import { resetDb } from '../test/db';
import {
  activeHouseholdOf,
  countRows,
  createHousehold,
  createInvitation,
  createUser,
  db,
  emailsOfUsers,
  householdWithOwner,
  invitationStatus,
  invitationStatusCounts,
  membershipsOf,
  withFailingMemberInsert,
} from '../test/factories';
import { bootstrapToken, invitedMember, ownerWithHousehold } from '../test/session';
import { buildServer } from './server';
import {
  acceptPendingInvitation,
  INVITE_ONLY_MESSAGE,
  INVITED_ROLE_ONLY_MESSAGE,
  NO_ROLE_CHANGES_MESSAGE,
  ONE_HOUSEHOLD_MESSAGE,
  SETUP_TOKEN_HEADER,
} from './auth-invite';
import { deleteSetupToken, readSetupToken } from './setup-token';
import { eq } from 'drizzle-orm';
import { member as memberTable } from './db/auth-schema';

const PASSWORD = 'password1234';

/**
 * Sign up through the real endpoint, which is what the invite-only middleware guards.
 *
 * `setupToken` is passed only when a test means to, because whether it is present is the whole
 * subject of the bootstrap cases: an invited sign-up must work without it, and an uninvited one
 * must fail without it.
 */
function signUp(email: string, setupToken?: string) {
  return auth.api.signUpEmail({
    body: { email, password: PASSWORD, name: 'Someone' },
    headers:
      setupToken === undefined ? undefined : new Headers({ [SETUP_TOKEN_HEADER]: setupToken }),
  });
}

const household = householdWithOwner;
const userCount = () => countRows('user');

describe('invite-only sign-up', () => {
  beforeEach(async () => {
    await resetDb();
  });

  it('rejects sign-up for an email with no pending invitation', async () => {
    await household();
    await expect(signUp('stranger@example.com')).rejects.toThrow(INVITE_ONLY_MESSAGE);
    expect(await userCount()).toBe(1);
  });

  it('allows sign-up for an email with a pending invitation', async () => {
    const { householdId, ownerId } = await household();
    await createInvitation({ householdId, inviterId: ownerId, email: 'grandma@example.com' });
    await expect(signUp('grandma@example.com')).resolves.toBeDefined();
    expect(await userCount()).toBe(2);
  });

  it('rejects sign-up when the invitation has expired', async () => {
    const { householdId, ownerId } = await household();
    await createInvitation({
      householdId,
      inviterId: ownerId,
      email: 'grandma@example.com',
      expiresAt: new Date(Date.now() - 60_000),
    });
    await expect(signUp('grandma@example.com')).rejects.toThrow(INVITE_ONLY_MESSAGE);
    expect(await userCount()).toBe(1);
  });

  it('rejects sign-up when the invitation was already accepted', async () => {
    const { householdId, ownerId } = await household();
    await createInvitation({
      householdId,
      inviterId: ownerId,
      email: 'grandma@example.com',
      status: 'accepted',
    });
    await expect(signUp('grandma@example.com')).rejects.toThrow(INVITE_ONLY_MESSAGE);
    expect(await userCount()).toBe(1);
  });

  it('rejects sign-up when the invitation is for a different email', async () => {
    const { householdId, ownerId } = await household();
    await createInvitation({ householdId, inviterId: ownerId, email: 'grandma@example.com' });
    await expect(signUp('grandpa@example.com')).rejects.toThrow(INVITE_ONLY_MESSAGE);
    expect(await userCount()).toBe(1);
  });

  /**
   * Both directions of the case question, because getting one right and the other wrong is
   * indistinguishable from the outside: a legitimate invitee is simply told the instance is
   * invite-only, with nothing anywhere naming the cause.
   *
   * Better Auth settles it, and this pins that it keeps doing so: `createInvitation` writes
   * `email.toLowerCase()`, and `signUpEmail` stores `email.toLowerCase()` too. So the stored
   * invitation is always lowercase, and lowercasing the sign-up address is the whole of the
   * matching rule.
   */
  it('matches an invitation created in mixed case against a lowercase sign-up', async () => {
    const { householdId, ownerId } = await household();
    // Written the way the API writes it, which is where the mixed case is lost.
    await createInvitation({
      householdId,
      inviterId: ownerId,
      email: 'Grandma@Example.COM'.toLowerCase(),
    });
    await expect(signUp('grandma@example.com')).resolves.toBeDefined();
  });

  it('matches a lowercase invitation against a mixed-case sign-up', async () => {
    const { householdId, ownerId } = await household();
    await createInvitation({ householdId, inviterId: ownerId, email: 'grandma@example.com' });
    await expect(signUp('Grandma@Example.COM')).resolves.toBeDefined();
    // The account Better Auth created is keyed on the lowercase address, so a second sign-up in
    // yet another case cannot produce a second account.
    expect(await emailsOfUsers()).toEqual(['grandma@example.com', 'owner@example.com']);
  });

  /**
   * The bootstrap carve-out. Without it an invitation is the only route to an account and no
   * invitation can exist, because issuing one needs an owner: a fresh install could never be
   * set up at all.
   */
  it('allows the very first account on an empty instance, with the setup token', async () => {
    await expect(signUp('owner@example.com', bootstrapToken())).resolves.toBeDefined();
  });

  /**
   * The brick, and why the token exists.
   *
   * Without it the carve-out was "no accounts exist yet", which any unauthenticated POST can
   * falsify - permanently, in one request. The squatter then cannot sign in either (unverified,
   * and on the shipped console mailer they cannot read their own link), so nobody can: an
   * instance with no owner, no invitations possible, and no in-app way back.
   */
  it('refuses an uninvited first account that has no setup token', async () => {
    await expect(signUp('squatter@attacker.invalid')).rejects.toThrow(INVITE_ONLY_MESSAGE);
    expect(await userCount()).toBe(0);
  });

  it('refuses an uninvited first account that has the wrong setup token', async () => {
    bootstrapToken();
    await expect(signUp('squatter@attacker.invalid', 'f'.repeat(64))).rejects.toThrow(
      INVITE_ONLY_MESSAGE,
    );
    expect(await userCount()).toBe(0);
  });

  /** The reproduction, run forwards: a failed squat must leave the instance claimable. */
  it('leaves the instance claimable after a squatter has been turned away', async () => {
    await expect(signUp('squatter@attacker.invalid')).rejects.toThrow(INVITE_ONLY_MESSAGE);
    await expect(signUp('realowner@example.com', bootstrapToken())).resolves.toBeDefined();
    expect(await userCount()).toBe(1);
  });

  it('closes the bootstrap carve-out as soon as one account exists', async () => {
    await createUser('owner@example.com');
    await expect(signUp('second@example.com', bootstrapToken())).rejects.toThrow(
      INVITE_ONLY_MESSAGE,
    );
    expect(await userCount()).toBe(1);
  });

  it('needs no setup token when there is an invitation', async () => {
    const { householdId, ownerId } = await household();
    await createInvitation({ householdId, inviterId: ownerId, email: 'grandma@example.com' });
    deleteSetupToken(env.DATA_DIR);

    await expect(signUp('grandma@example.com')).resolves.toBeDefined();
  });
});

/**
 * The half of D36 that the invite-only check on its own does not deliver.
 *
 * Requiring an invitation to sign up says who may have an account. It says nothing about which
 * household they land in - and an account with no membership has no active organization, which
 * is exactly the state `App.tsx` renders `<Onboarding />` for. Onboarding creates a household.
 * So without this, a relative invited to share the owner's recipe library could instead
 * provision themselves a separate tenant on his server, which is the opposite of the decision.
 *
 * Two mechanisms, and they are not redundant. Accepting the invitation at sign-up is what makes
 * the flow WORK; refusing to create a second household is what makes the bad outcome
 * IMPOSSIBLE, including on the day the first one fails halfway.
 */
describe('joining the household', () => {
  beforeEach(async () => {
    await resetDb();
  });

  /** An invited account, signed in. Invited accounts start verified, so no link to click. */
  async function invitedAndSignedIn(email: string): Promise<Headers> {
    await signUp(email);
    const signIn = await auth.api.signInEmail({
      body: { email, password: PASSWORD },
      returnHeaders: true,
    });
    const setCookie = signIn.headers.get('set-cookie');
    if (setCookie === null) throw new Error('sign-in returned no session cookie');
    return new Headers({ cookie: setCookie.split(';')[0] ?? '' });
  }

  const householdCount = () => countRows('organization');

  it('puts an invited account into the inviting household and consumes the invitation', async () => {
    const { householdId, ownerId } = await household();
    const invitationId = await createInvitation({
      householdId,
      inviterId: ownerId,
      email: 'grandma@example.com',
    });

    await signUp('grandma@example.com');

    expect(await membershipsOf('grandma@example.com')).toEqual([{ householdId, role: 'member' }]);
    expect(await invitationStatus(invitationId)).toBe('accepted');
  });

  /**
   * What actually keeps Onboarding off the invitee's screen.
   *
   * `activeOrganizationId` lives on the SESSION row, not on the user, so a membership alone does
   * not survive into the next sign-in: `App.tsx` asks `useActiveOrganization()`, and a null
   * answer renders Onboarding no matter how many households the user belongs to.
   */
  it('activates the household on the session the invitee signs in with', async () => {
    const { householdId, ownerId } = await household();
    await createInvitation({ householdId, inviterId: ownerId, email: 'grandma@example.com' });

    await invitedAndSignedIn('grandma@example.com');

    expect(await activeHouseholdOf('grandma@example.com')).toBe(householdId);
  });

  /**
   * The same mechanism, on the account that has the most to lose from it being absent: an owner
   * whose next sign-in landed with no active household would be shown Onboarding and could
   * create a SECOND household, which their whole recipe library is not in.
   */
  it('activates the household on a returning owner session too', async () => {
    const owner = await ownerWithHousehold();
    await auth.api.signInEmail({ body: { email: 'owner@example.com', password: PASSWORD } });

    expect(await activeHouseholdOf('owner@example.com')).toBe(owner.householdId);
  });

  it('refuses to let an invited member create a household of their own', async () => {
    const { householdId, ownerId } = await household();
    await createInvitation({ householdId, inviterId: ownerId, email: 'grandma@example.com' });
    const headers = await invitedAndSignedIn('grandma@example.com');

    await expect(
      auth.api.createOrganization({ body: { name: 'Not Mine', slug: 'not-mine' }, headers }),
    ).rejects.toThrow(ONE_HOUSEHOLD_MESSAGE);
    expect(await householdCount()).toBe(1);
  });

  /**
   * The backstop, tested with the first mechanism deliberately undone.
   *
   * Accepting the invitation and creating the membership are two writes on a live database, and
   * "the accept worked" is not something the refusal above is allowed to depend on: if it did,
   * the one situation the rule exists for - a user sitting on Onboarding with no household -
   * would be exactly the situation in which it stopped applying.
   */
  it('still refuses when the membership never landed', async () => {
    const { householdId, ownerId } = await household();
    await createInvitation({ householdId, inviterId: ownerId, email: 'grandma@example.com' });
    const headers = await invitedAndSignedIn('grandma@example.com');
    await db.delete(memberTable).where(eq(memberTable.role, 'member'));
    expect(await membershipsOf('grandma@example.com')).toEqual([]);

    await expect(
      auth.api.createOrganization({ body: { name: 'Not Mine', slug: 'not-mine' }, headers }),
    ).rejects.toThrow(ONE_HOUSEHOLD_MESSAGE);
    expect(await householdCount()).toBe(1);
  });

  /** The path that must survive all of the above: setting the instance up in the first place. */
  it('lets the first account create the initial household', async () => {
    const owner = await ownerWithHousehold();

    expect(owner.householdId).toBeTruthy();
    expect(await householdCount()).toBe(1);
  });

  /**
   * Atomicity between the two writes.
   *
   * Consuming the invitation without creating the membership is the worst reachable state: the
   * account exists, the invitation can never be used again, and the only route into the
   * household is gone. One transaction is what rules it out, and a membership insert that
   * violates the user foreign key is the cheapest way to make the second write fail for real.
   */
  it('leaves the invitation pending if the membership cannot be written', async () => {
    const { householdId, ownerId } = await household();
    const invitationId = await createInvitation({
      householdId,
      inviterId: ownerId,
      email: 'grandma@example.com',
    });
    const inviteeId = await createUser('grandma@example.com');

    await withFailingMemberInsert(async () => {
      await expect(
        acceptPendingInvitation({ userId: inviteeId, email: 'grandma@example.com' }),
      ).rejects.toThrow();
    });

    expect(await invitationStatus(invitationId)).toBe('pending');
    expect(await membershipsOf('grandma@example.com')).toEqual([]);
  });
});

/**
 * The pins for what an earlier round could only disclose as untested, plus the guards added
 * after review. Each of these is a mutant that a 471-test suite did not notice.
 */
describe('accepting an invitation, in detail', () => {
  beforeEach(async () => {
    await resetDb();
  });

  /**
   * Two sign-ups racing on ONE invitation must produce one membership.
   *
   * Deterministic despite being about concurrency: the second UPDATE blocks on the row lock the
   * first holds, and when it is released re-evaluates its own `status = 'pending'` against the
   * committed row. Delete that clause and both transactions claim it and both insert.
   *
   * Today `user_email_unique` would stop two sign-ups for one address from getting this far, so
   * the clause is not load-bearing on the sign-up path. It becomes load-bearing the moment
   * Phase F's `/accept-invite/:id` calls this from a path where no such constraint applies,
   * which is why it is pinned now rather than then.
   */
  it('serializes two racing accepts into a single membership', async () => {
    const { householdId, ownerId } = await householdWithOwner();
    const invitationId = await createInvitation({
      householdId,
      inviterId: ownerId,
      email: 'grandma@example.com',
    });
    const first = await createUser('grandma@example.com');
    const second = await createUser('grandma-second@example.com');

    const results = await Promise.all([
      acceptPendingInvitation({ userId: first, email: 'grandma@example.com' }),
      acceptPendingInvitation({ userId: second, email: 'grandma@example.com' }),
    ]);

    expect(results.filter((r) => r !== null)).toHaveLength(1);
    expect(await countRows('member')).toBe(2); // the owner, plus exactly one invitee
    expect(await invitationStatus(invitationId)).toBe('accepted');
  });

  /**
   * The subject of the earlier refactor that had no test: the invitation is read on the same
   * handle that claims it. Structural, because the behavioural difference only shows under
   * concurrency - and `db.select` being untouched is precisely the claim, since every read in
   * here goes through the transaction.
   */
  it('reads the invitation on the transaction, never on the pooled client', async () => {
    const { householdId, ownerId } = await householdWithOwner();
    await createInvitation({ householdId, inviterId: ownerId, email: 'grandma@example.com' });
    const inviteeId = await createUser('grandma@example.com');
    const pooled = vi.spyOn(db, 'select');

    try {
      await acceptPendingInvitation({ userId: inviteeId, email: 'grandma@example.com' });
      expect(pooled).not.toHaveBeenCalled();
    } finally {
      pooled.mockRestore();
    }
  });

  /**
   * A duplicate-address sign-up is answered with a SYNTHETIC user carrying a well-formed id for
   * a row that does not exist, so `typeof id === 'string'` does not filter it. Without the
   * existence check this reached the `member.user_id` foreign key: an unauthenticated caller
   * could make the server attempt a failing write and log an error, on demand, for any invited
   * address.
   */
  it('does nothing for a user id that has no row', async () => {
    const { householdId, ownerId } = await householdWithOwner();
    const invitationId = await createInvitation({
      householdId,
      inviterId: ownerId,
      email: 'grandma@example.com',
    });

    await expect(
      acceptPendingInvitation({ userId: 'looks-real-but-is-not', email: 'grandma@example.com' }),
    ).resolves.toBeNull();
    expect(await invitationStatus(invitationId)).toBe('pending');
  });

  /**
   * Two pending invitations to one household is a supported state - re-inviting is a thing an
   * owner does - so an invitee can auto-join at sign-up and then click the older emailed link.
   * The second accept must be a no-op, not a second membership row.
   */
  it('does not add a second membership in a household the user is already in', async () => {
    const { householdId, ownerId } = await householdWithOwner();
    await createInvitation({ householdId, inviterId: ownerId, email: 'grandma@example.com' });
    await createInvitation({ householdId, inviterId: ownerId, email: 'grandma@example.com' });
    const inviteeId = await createUser('grandma@example.com');

    await acceptPendingInvitation({ userId: inviteeId, email: 'grandma@example.com' });
    await expect(
      acceptPendingInvitation({ userId: inviteeId, email: 'grandma@example.com' }),
    ).resolves.toBe(householdId);

    expect(await membershipsOf('grandma@example.com')).toEqual([{ householdId, role: 'member' }]);
    // The second accept consumed nothing: one invitation used, the other still outstanding.
    expect(await invitationStatusCounts()).toEqual({ accepted: 1, pending: 1 });
  });

  /**
   * The plugin stores roles COMMA-JOINED (`parseRoles`), so an invitation created with two roles
   * is the literal string 'owner,member'. Copied verbatim it would be a role that every later
   * comparison silently fails to match, which is how a member ends up neither owner nor member.
   */
  it.each([
    ['owner', 'owner'],
    ['member', 'member'],
    ['owner,member', 'member'],
    ['admin', 'member'],
    [null, 'member'],
  ])('reduces an invitation role of %s to %s', async (invited, expected) => {
    const { householdId, ownerId } = await householdWithOwner();
    await createInvitation({
      householdId,
      inviterId: ownerId,
      email: 'grandma@example.com',
      role: invited ?? undefined,
    });
    const inviteeId = await createUser('grandma@example.com');

    await acceptPendingInvitation({ userId: inviteeId, email: 'grandma@example.com' });

    expect(await membershipsOf('grandma@example.com')).toEqual([{ householdId, role: expected }]);
  });
});

describe('the setup token as an instance-state signal', () => {
  beforeEach(async () => {
    await resetDb();
  });

  /**
   * The cap enforced where it cannot be raced.
   *
   * `createHousehold` inserts directly, bypassing the endpoint and therefore the application
   * check entirely - which is the point. The application check is check-then-act and 20 truly
   * concurrent creates got past it against a real server; what kept households at one was this
   * index. Nothing else in the suite would notice migration 0004 being reverted.
   */
  it('refuses a second household at the database, not only in the application', async () => {
    await createHousehold();
    await expect(createHousehold()).rejects.toThrow(/organization_singleton_uidx/);
  });

  it('is deleted once the household exists, so it cannot linger as a live credential', async () => {
    bootstrapToken();
    await ownerWithHousehold();

    expect(readSetupToken(env.DATA_DIR)).toBeNull();
  });

  /**
   * An anonymous caller must not be able to tell a claimed instance from an unclaimed one.
   *
   * The household check runs ahead of the endpoint's own session middleware, so answering it
   * first would have made `/organization/create` a scanner-friendly oracle for exactly the
   * window in which a live setup token is sitting on disk. Both states must answer the same way
   * to someone with no session.
   */
  it('answers an anonymous household-creation attempt the same way either way', async () => {
    const unclaimed = await auth.api
      .createOrganization({ body: { name: 'A', slug: 'a' }, headers: new Headers() })
      .then(() => 'resolved')
      .catch((err: { status?: unknown; statusCode?: unknown }) => String(err.status));

    await ownerWithHousehold();

    const claimed = await auth.api
      .createOrganization({ body: { name: 'B', slug: 'b' }, headers: new Headers() })
      .then(() => 'resolved')
      .catch((err: { status?: unknown; statusCode?: unknown }) => String(err.status));

    expect(claimed).toBe(unclaimed);
    expect(claimed).not.toBe('resolved');
  });
});

/**
 * The two Better Auth endpoints that can put a second owner in a household, at the surface the
 * household router does not own.
 *
 * `server.ts` mounts the whole Better Auth handler at `/api/auth/*`, so pinning the invitation
 * role inside the tRPC procedure pinned it for callers who go through the procedure. The
 * plugin's own rule only stops a NON-owner from inviting an owner, so the household owner - the
 * one account every instance has - could do this from their signed-in browser. Reproduced
 * against a real listening server before the gate existed: one POST, and the invited account
 * signed up as a second `owner`.
 *
 * Driven over HTTP rather than through `auth.api.*` because the mount is the point. The
 * middleware covers both, which the sign-up tests above already show.
 */
describe('the role an invitation may carry', () => {
  let server: FastifyInstance;
  let owner: Awaited<ReturnType<typeof ownerWithHousehold>>;
  let member: Awaited<ReturnType<typeof invitedMember>>;

  beforeAll(async () => {
    server = await buildServer();
  });

  afterAll(async () => {
    await server.close();
  });

  beforeEach(async () => {
    await resetDb();
    owner = await ownerWithHousehold();
    member = await invitedMember({
      householdId: owner.householdId,
      inviterId: owner.userId,
      email: 'grandma@example.com',
    });
  });

  const post = (path: string, payload: object, cookie: string) =>
    server.inject({
      method: 'POST',
      url: `/api/auth/${path}`,
      payload,
      headers: { 'content-type': 'application/json', cookie },
    });

  const ownerCookie = () => {
    const cookie = owner.headers.get('cookie');
    if (cookie === null) throw new Error('the owner fixture carries no cookie');
    return cookie;
  };

  const inviteAs = (cookie: string, role: unknown) =>
    post(
      'organization/invite-member',
      { email: 'second-owner@example.com', role, organizationId: owner.householdId },
      cookie,
    );

  // Every spelling that reaches an owner-shaped invitation, and one that does not but has no
  // business being accepted either. The array form matters because the plugin joins it into the
  // literal `owner,member`, and the padded form because Better Auth trims one end of a string
  // and not the other - so the gate compares rather than interprets.
  it.each([
    { name: 'owner', role: 'owner' },
    { name: 'an array containing owner', role: ['owner', 'member'] },
    { name: 'a padded member', role: ' member' },
    { name: 'an array containing member', role: ['member'] },
    { name: 'a role the app does not have', role: 'admin' },
    { name: 'no role at all', role: undefined },
  ])('refuses an invitation for $name', async ({ role }) => {
    const res = await inviteAs(ownerCookie(), role);

    expect(res.statusCode).toBe(403);
    expect(res.json()).toMatchObject({ message: INVITED_ROLE_ONLY_MESSAGE });
    // No pending row, so nothing for the sign-up hook to honour later. (The accepted one is
    // the member fixture's own invitation, already consumed.)
    expect((await invitationStatusCounts()).pending).toBeUndefined();
  });

  // The positive control. Without it the gate could refuse everything and this file would not
  // notice, and inviting is the feature.
  it('allows the member invitation the household router sends', async () => {
    const res = await post(
      'organization/invite-member',
      { email: 'grandpa@example.com', role: 'member', organizationId: owner.householdId },
      ownerCookie(),
    );

    expect(res.statusCode).toBe(200);
    expect((await invitationStatusCounts()).pending).toBe(1);
  });

  /**
   * The whole point of the gate, end to end: no owner invitation means no second owner, which
   * is what makes the household's own rules enforceable from inside it.
   */
  it('leaves no way for an invited account to arrive as an owner', async () => {
    await inviteAs(ownerCookie(), 'owner');

    await expect(
      auth.api.signUpEmail({
        body: { email: 'second-owner@example.com', password: 'password1234', name: 'Second' },
      }),
    ).rejects.toThrow(INVITE_ONLY_MESSAGE);
    expect(await membershipsOf('second-owner@example.com')).toEqual([]);
  });

  /**
   * Promotion and demotion do not exist, so the endpoint that performs them is closed to
   * everyone rather than left mounted and guarded only by the library's default role table.
   * Demotion is also how the last owner disappears without a member row being deleted.
   */
  it('refuses to change anyone role, the owner included', async () => {
    const memberRow = await db
      .select({ id: memberTable.id })
      .from(memberTable)
      .where(eq(memberTable.userId, member.userId));

    const res = await post(
      'organization/update-member-role',
      { memberId: memberRow[0]?.id, role: 'owner', organizationId: owner.householdId },
      ownerCookie(),
    );

    expect(res.statusCode).toBe(403);
    expect(res.json()).toMatchObject({ message: NO_ROLE_CHANGES_MESSAGE });
    expect(await membershipsOf('grandma@example.com')).toEqual([
      { householdId: owner.householdId, role: 'member' },
    ]);
  });

  /**
   * What a `member` may not do at the raw surface.
   *
   * All of these are refused today by Better Auth's DEFAULT ROLE TABLE, which is a dependency
   * and not a decision this repo has recorded anywhere. The household router's owner gate is no
   * defence here, because a request to `/api/auth/*` never enters it. If an upgrade grants
   * `member` any of these, this fails and the household does not.
   */
  it.each([
    ['organization/invite-member', () => ({ email: 'x@example.com', role: 'member' })],
    ['organization/remove-member', () => ({ memberIdOrEmail: 'owner@example.com' })],
    ['organization/update-member-role', () => ({ memberId: 'any', role: 'member' })],
    ['organization/cancel-invitation', () => ({ invitationId: 'any' })],
    ['organization/delete', () => ({})],
    ['organization/update', () => ({ data: { name: 'Renamed' } })],
  ])('refuses a member at /%s', async (path, payload) => {
    const before = await householdShape();

    const res = await post(
      path,
      { ...payload(), organizationId: owner.householdId },
      member.cookie,
    );

    expect(res.statusCode).toBeGreaterThanOrEqual(400);
    expect(await householdShape()).toEqual(before);
  });
});

/** Enough of the household to notice any of the raw endpoints having worked. */
async function householdShape() {
  return {
    households: await countRows('organization'),
    members: await membershipsOf('owner@example.com'),
    membersTotal: await countRows('member'),
    invitations: await invitationStatusCounts(),
  };
}
