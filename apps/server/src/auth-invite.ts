import { randomUUID } from 'node:crypto';
import { and, asc, desc, eq, gt, sql } from 'drizzle-orm';
import { APIError, createAuthMiddleware, getSessionFromCtx } from 'better-auth/api';
import { publicConfig } from './config';
import { db } from './db/client';
import { env } from './env';
import { deleteSetupToken, setupTokenMatches } from './setup-token';
import { INVITE_ONLY_MESSAGE, ONE_HOUSEHOLD_MESSAGE, SETUP_TOKEN_HEADER } from './messages';
import { invitation, member, organization, user } from './db/auth-schema';
import { logger } from './log';

/** The one Better Auth path that creates an account. */
export const SIGN_UP_PATH = '/sign-up/email';

/** The one Better Auth path that creates a household. */
export const ORGANIZATION_CREATE_PATH = '/organization/create';

/** The one Better Auth path that issues an invitation. */
export const INVITE_MEMBER_PATH = '/organization/invite-member';

/** The one Better Auth path that changes an existing member's role. */
export const UPDATE_MEMBER_ROLE_PATH = '/organization/update-member-role';

/**
 * The two sentences this middleware refuses with, and the header it reads the setup token from.
 * They are defined in `messages.ts`, which the web client also imports, and re-exported here so
 * this file's callers and its test are unchanged. See that module for why they cannot live in
 * this one.
 */
export { INVITE_ONLY_MESSAGE, ONE_HOUSEHOLD_MESSAGE, SETUP_TOKEN_HEADER };

/** What an invitation for any role but `member` is told. See `INVITED_ROLE`. */
export const INVITED_ROLE_ONLY_MESSAGE = 'A Hearth invitation is always for a member.';

/** What an attempt to change someone's role is told. See `UPDATE_MEMBER_ROLE_PATH`. */
export const NO_ROLE_CHANGES_MESSAGE = 'Hearth cannot change what someone is in a household.';

/**
 * The address as it will be stored, which is also how it is matched.
 *
 * Lowercase and nothing else, because that is exactly what Better Auth does at BOTH ends and
 * the two have to agree or a legitimate invitee is turned away with a message that says the
 * instance is invite-only:
 *   - `createInvitation` writes `ctx.body.email.toLowerCase()` into `invitation.email`;
 *   - `signUpEmail` writes `email.toLowerCase()` into `user.email`, and
 *     `internalAdapter.createUser` lowercases it a second time.
 *
 * Note what is NOT done: no trimming. `z.email()` rejects a padded address at the sign-up
 * endpoint anyway, and trimming here would mean this check matched an invitation that the
 * account about to be created could then never match again.
 *
 * `unknown` in, because a `hooks.before` middleware runs before the endpoint's body schema: at
 * that point `email` is whatever was posted, including an array or an object.
 */
export function normalizeEmail(value: unknown): string {
  return String(value ?? '').toLowerCase();
}

/**
 * Anything that can run a SELECT: the client, or a transaction handle. Structural rather than
 * a union of Drizzle's own types, which are generic in the schema and awkward to name.
 */
type Queryable = Pick<typeof db, 'select'>;

/** A pending invitation, reduced to what accepting it needs. */
export type PendingInvitation = {
  id: string;
  householdId: string;
  /** Better Auth allows this to be null; the plugin then falls back to its default role. */
  role: string | null;
};

/**
 * The unexpired, unconsumed invitation for `email`, if there is one.
 *
 * `status = 'pending'` is the consumed check: accepting sets `accepted`, declining sets
 * `rejected`, and the owner revoking sets `canceled` (one L - the plugin spells it that way,
 * and `cancelled` would match nothing). Comparing against the three of them instead would be a
 * list to keep in step with a library; comparing against the one live value is not.
 *
 * `now()` is the database's clock rather than this process's, so the row is compared against
 * the same clock that wrote its `expires_at`.
 *
 * Newest first, because re-inviting an address that already has a live invitation is a
 * supported thing to do and the most recent one is the one the invitee was sent.
 */
export async function findPendingInvitation(
  email: string,
  /**
   * Which connection to read on. `acceptPendingInvitation` passes its transaction handle: read
   * on `db` from inside a transaction and the SELECT runs on a different pooled connection,
   * outside it, which is a lie the code would tell quietly and only under load.
   */
  on: Queryable = db,
): Promise<PendingInvitation | null> {
  const rows = await on
    .select({
      id: invitation.id,
      householdId: invitation.organizationId,
      role: invitation.role,
    })
    .from(invitation)
    .where(
      and(
        eq(invitation.email, email),
        eq(invitation.status, 'pending'),
        gt(invitation.expiresAt, sql`now()`),
      ),
    )
    .orderBy(desc(invitation.createdAt))
    .limit(1);
  return rows[0] ?? null;
}

export async function hasPendingInvitation(email: string): Promise<boolean> {
  return (await findPendingInvitation(email)) !== null;
}

/**
 * Whether this instance has any account at all.
 *
 * Half of the bootstrap carve-out; the setup token is the other half and the important one.
 * D36 makes an invitation the only route to an account and issuing one requires an owner, so on
 * a fresh install the rule is unsatisfiable and the first account has to be exempt. Exempting
 * it on this condition ALONE was a way to brick a box permanently with one unauthenticated
 * POST: a stranger creates the user row, this returns true from then on, and the real owner is
 * told to ask a household owner who does not exist. Worse on the shipped zero-config console
 * mailer, where the stranger cannot read their own verification link either, so the outcome is
 * not even a takeover - it is an instance nobody can use, with no in-app way back.
 *
 * So the exemption now needs the setup token as well, and this narrows the window rather than
 * being the gate: from the first committed account onwards the invitation rule is absolute.
 * ("First committed", not "second request" - two concurrent first requests both read false.)
 */
export async function hasAnyUser(): Promise<boolean> {
  const rows = await db.select({ id: user.id }).from(user).limit(1);
  return rows.length > 0;
}

/**
 * Whether an uninvited sign-up may proceed: the operator, claiming a fresh instance.
 *
 * Under `singleHousehold` the token stops working once an account exists. Measured, not assumed:
 * 25 simultaneous token-bearing sign-ups against a real server produced 23 accounts, because
 * `hasAnyUser` is a read and the insert is a write and nothing serializes them. That is a real
 * limit of this check and it is written down rather than papered over - but it is not the same
 * kind of hole as the one the token closed, because every one of those requests had to hold the
 * token, which means they were all the operator. The rule the token enforces is "not a
 * stranger", and that one has no race in it; "exactly one account" is a convenience on top.
 *
 * With the cap lifted the token stays usable, since a second household also needs a first
 * account and there is no invitation that could produce one.
 */
async function mayBootstrap(headers: Headers | undefined): Promise<boolean> {
  if (!setupTokenMatches(headers?.get(SETUP_TOKEN_HEADER), env.DATA_DIR)) return false;
  return publicConfig.singleHousehold ? !(await hasAnyUser()) : true;
}

/**
 * Whether this instance has a household yet.
 *
 * D36 puts every invitee into the OWNER'S household - that is the whole point of it, and what
 * lets `withHousehold` and the RLS policies stay exactly as they are - so an instance has one
 * household and the only legitimate moment to create it is when there is none.
 */
export async function householdExists(): Promise<boolean> {
  const rows = await db.select({ id: organization.id }).from(organization).limit(1);
  return rows.length > 0;
}

/**
 * The household a session should open in: the oldest one this user belongs to.
 *
 * "Oldest" rather than "any", because an arbitrary answer is one that can change between two
 * sign-ins for no reason the user can see. Under the one-household rule above there is at most
 * one anyway; the ordering is what keeps that from becoming an assumption.
 */
export async function householdForUser(userId: string): Promise<string | null> {
  const rows = await db
    .select({ householdId: member.organizationId })
    .from(member)
    .where(eq(member.userId, userId))
    .orderBy(asc(member.createdAt))
    .limit(1);
  return rows[0]?.householdId ?? null;
}

/**
 * Consume this address's pending invitation and put the user in the household, or do nothing.
 *
 * Both writes or neither, in one transaction, because the half-done state is the damaging one:
 * an invitation marked accepted with no membership behind it is an account that can never join
 * anything and an invitation that can never be used again. A rollback undoes the accept, where a
 * compensating update afterwards would be a second write that could itself fail.
 *
 * `status = 'pending'` is repeated in the UPDATE's own WHERE and is not redundant with the SELECT
 * above it. Two sign-ups racing on one invitation both read it as pending; the UPDATE is what
 * serializes them, and the loser matches no row, returns null, and writes no second membership.
 *
 * Returns the household joined, or null when there was nothing to accept - which is the ordinary
 * case for the instance's first account.
 */
export async function acceptPendingInvitation(opts: {
  userId: string;
  email: string;
}): Promise<string | null> {
  return db.transaction(async (tx) => {
    // The user is read, not assumed, and this is not defensive padding. Sign-up answers a
    // duplicate address with a SYNTHETIC user - deliberately indistinguishable from a real
    // one, so the endpoint is not an account-existence oracle - and `buildSyntheticUserOutput`
    // copies an id onto it. So a caller who posts an invited address that already has an
    // account hands this hook a well-formed id for a user that does not exist. Without this the
    // insert below reaches the `member.user_id` foreign key, which rejects it correctly but
    // turns an unauthenticated request into a failing write and an error log on demand.
    const exists = await tx.select({ id: user.id }).from(user).where(eq(user.id, opts.userId));
    if (exists.length === 0) return null;

    const pending = await findPendingInvitation(opts.email, tx);
    if (pending === null) return null;

    // Already in that household: nothing to grant, and nothing to consume. Reachable from
    // Phase F's accept-invite route, where an invitee auto-joined at sign-up can still click an
    // older emailed link for the same household. The unique index on (organization_id, user_id)
    // is what makes this impossible rather than merely unlikely; this is what makes it quiet.
    const already = await tx
      .select({ id: member.id })
      .from(member)
      .where(and(eq(member.userId, opts.userId), eq(member.organizationId, pending.householdId)));
    if (already.length > 0) return pending.householdId;

    const claimed = await tx
      .update(invitation)
      .set({ status: 'accepted' })
      .where(and(eq(invitation.id, pending.id), eq(invitation.status, 'pending')))
      .returning({ householdId: invitation.organizationId, role: invitation.role });
    const row = claimed[0];
    if (row === undefined) return null;

    await tx.insert(member).values({
      // Better Auth generates its own ids for rows it writes; this row is written here, so it
      // needs one of its own. A UUID rather than an imitation of the library's alphabet, because
      // a value that merely LOOKS like one of theirs would be the more confusing of the two.
      id: randomUUID(),
      organizationId: row.householdId,
      userId: opts.userId,
      role: householdRole(row.role),
      createdAt: new Date(),
    });
    return row.householdId;
  });
}

/** The only two roles Hearth has (D36). `admin` is left unused rather than designed early. */
export const HOUSEHOLD_ROLES = ['owner', 'member'] as const;

/**
 * An invitation's role reduced to one this app understands.
 *
 * Not a formality. The plugin stores roles as a COMMA-JOINED string (`parseRoles`), so an
 * invitation created with `role: ['owner', 'member']` is the literal `'owner,member'`, and
 * copying that verbatim into `member.role` would produce a row that every later role comparison
 * - Task 13's owner-only procedures included - silently fails to match, in the permissive
 * direction for some comparisons and the restrictive one for others.
 *
 * Anything unrecognised becomes `member`, which is the direction that cannot grant more than
 * the invitation asked for. `owner` is preserved, because inviting a co-owner is a legitimate
 * thing a household owner does and only an owner can issue such an invitation
 * (`createInvitation` refuses otherwise).
 */
export function householdRole(role: string | null): string {
  return HOUSEHOLD_ROLES.find((known) => known === role) ?? 'member';
}

/**
 * The role every invitation is issued at, and the only one an invitation may carry.
 *
 * It lives here, beside the middleware that enforces it, because the rule has to hold at BOTH
 * surfaces this app mounts and stating it twice is how they come apart. The household router
 * sends this value; `inviteOnly` refuses anything else arriving at `/api/auth/*`. Task 13
 * shipped the first half alone, and the gap was not theoretical: one POST from the owner's live
 * browser session created an `owner` invitation, and `joinInvitedHousehold` then wrote a second
 * owner at sign-up. Reproduced end to end before this existed.
 *
 * Why `member` and not "whatever the owner asked for": a second owner is the state that makes
 * the household's rules unenforceable from inside it, and Hearth has no screen for promotion,
 * no way to demote, and no reason yet for either. Inviting someone and granting them authority
 * over the household are different decisions, and only the first one exists.
 */
export const INVITED_ROLE: (typeof HOUSEHOLD_ROLES)[number] = 'member';

/**
 * The invite-only rule, applied at both doors it has (D36).
 *
 * Sign-up is the obvious one. Household creation is the one the rule needs and does not state:
 * an account with no membership has no active organization, which is precisely the state
 * `App.tsx` renders `<Onboarding />` for, and Onboarding creates a household. Without the second
 * check, a relative invited to share the owner's recipe library could instead provision
 * themselves a separate tenant on his server - self-service signup refused at the front door and
 * granted at the side one.
 *
 * The second check is deliberately NOT "has this user been invited". It is a count of
 * households, so it holds for every account however it was created, and it also removes a
 * hazard that predates invitations entirely: an owner whose session had no active household saw
 * Onboarding and could create a second one, which their whole recipe library is not in.
 *
 * This is a `hooks.before` middleware rather than `emailAndPassword.disableSignUp`, and the
 * difference is not stylistic: accepting an invitation requires an authenticated session, and
 * an invitee has no account until they sign up. `disableSignUp` would therefore leave an
 * invitation nobody can ever act on. Sign-up stays enabled at the Better Auth level and this
 * decides who may use it.
 */
export const inviteOnly = createAuthMiddleware(async (ctx) => {
  if (ctx.path === SIGN_UP_PATH) {
    const email = normalizeEmail((ctx.body as { email?: unknown } | undefined)?.email);
    if (await hasPendingInvitation(email)) return;
    if (await mayBootstrap(ctx.headers)) return;
    throw new APIError('FORBIDDEN', { message: INVITE_ONLY_MESSAGE });
  }

  if (ctx.path === ORGANIZATION_CREATE_PATH) {
    // This check is the MESSAGE, not the guarantee. It is check-then-act - the read here and the
    // insert in the endpoint are separate statements with nothing between them - and 20 truly
    // simultaneous creates against a real server got past it. What holds the line is the
    // `organization_singleton_uidx` unique index from migration 0004, which turns the loser into
    // a failed insert instead of a second household. Verified: households stayed at 1, with the
    // losers split between this 403 and a 500 from the index.
    if (!publicConfig.singleHousehold) return;
    // AFTER the session check, not before. This runs ahead of the endpoint's own
    // `orgSessionMiddleware`, so answering here first would let an anonymous caller tell a
    // claimed instance (FORBIDDEN) from an unclaimed one (UNAUTHORIZED) - which is exactly the
    // signal someone hunting for a box whose setup token is still live wants, and it would make
    // that window findable by scanning. Unauthenticated callers now get the same answer either
    // way, from the endpoint.
    if ((await getSessionFromCtx(ctx)) === null) return;
    if (!(await householdExists())) return;
    throw new APIError('FORBIDDEN', { message: ONE_HOUSEHOLD_MESSAGE });
  }

  /**
   * The role an invitation may carry, at the surface the household router does not own.
   *
   * `/api/auth/*` mounts Better Auth's whole handler (server.ts), so the router's pinned role
   * is only the pin for calls that go through the router. The plugin's own check refuses a
   * NON-owner inviting an owner and nothing else, so the household owner - the one account
   * every instance has - could issue an owner invitation from their signed-in browser, and
   * `joinInvitedHousehold` would honour it at sign-up.
   *
   * Compared as a literal, not normalized. `role` may arrive as an array, which the plugin
   * joins into `'owner,member'`, and Better Auth trims one end of a string but not the other -
   * so anything but exactly `member` is refused rather than interpreted. Nothing legitimate
   * sends anything else: the router sends this same constant.
   */
  if (ctx.path === INVITE_MEMBER_PATH) {
    const role = (ctx.body as { role?: unknown } | undefined)?.role;
    if (role !== INVITED_ROLE) {
      throw new APIError('FORBIDDEN', { message: INVITED_ROLE_ONLY_MESSAGE });
    }
    return;
  }

  /**
   * Promotion and demotion do not exist in Hearth, so the endpoint that performs them is closed
   * rather than left mounted and unused. It is the other way an owner-role member appears, and
   * demotion is how the last owner would disappear without any member row being deleted.
   *
   * Refused outright, for every caller and every role, because there is no version of this
   * request the app has a use for. When promotion has a screen it will have its own procedure
   * and its own rules, and this is where the exception for it will be written down.
   */
  if (ctx.path === UPDATE_MEMBER_ROLE_PATH) {
    throw new APIError('FORBIDDEN', { message: NO_ROLE_CHANGES_MESSAGE });
  }
});

/**
 * Put a freshly created account into the household it was invited to.
 *
 * Sign-up checking that an invitation EXISTS is not the same as using it up, and the difference
 * is a real state: signed up, invitation still pending, no household, staring at the onboarding
 * screen. This closes it in the same request.
 *
 * An `after` middleware rather than `databaseHooks.user.create.after`, because that hook is
 * awaited by `internalAdapter.createUser` inside sign-up's try block: a throw there is caught
 * and reported as FAILED_TO_CREATE_USER even though the user row is already committed, and the
 * account would exist with a password not yet linked to it. By the time this runs, Better Auth
 * has finished, so the worst a failure can leave behind is an account with no membership - which
 * is exactly the case `inviteOnly` refuses to let turn into a household of its own.
 *
 * Hence the catch. The account is real and usable either way, so failing the response would be a
 * lie; the line names the user by id and nothing else (D38), and the invitation is still pending,
 * so the link in the invitee's inbox remains a working way in.
 */
export const joinInvitedHousehold = createAuthMiddleware(async (ctx) => {
  if (ctx.path === ORGANIZATION_CREATE_PATH) {
    // The instance is claimed, so the credential that claims it has no further use. Self-
    // cleaning rather than left on disk forever, because a live bootstrap token on a running
    // instance is a credential nobody is watching. Not under `singleHousehold: false`, where a
    // second household also needs a first account and no invitation can produce one.
    if (publicConfig.singleHousehold) deleteSetupToken(env.DATA_DIR);
    return;
  }
  if (ctx.path !== SIGN_UP_PATH) return;

  const created = (ctx.context.returned as { user?: { id?: unknown; email?: unknown } } | undefined)
    ?.user;
  // Absent when sign-up returned no user at all: a rejected request. It is NOT what filters out
  // the synthetic user of a duplicate-address sign-up, which carries a perfectly good-looking
  // id - `acceptPendingInvitation` checks the row exists, and that is where that case dies.
  if (typeof created?.id !== 'string') return;

  try {
    await acceptPendingInvitation({ userId: created.id, email: normalizeEmail(created.email) });
  } catch (err) {
    logger.error({ err, userId: created.id }, 'could not join the invited household at sign-up');
  }
});
