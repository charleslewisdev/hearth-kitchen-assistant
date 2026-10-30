import { z } from 'zod';
import { TRPCError } from '@trpc/server';
import { APIError } from 'better-auth/api';
import { auth } from '../../auth';
import { HOUSEHOLD_ROLES, householdRole, INVITED_ROLE } from '../../auth-invite';
import { NOT_A_MEMBER_MESSAGE } from '../../messages';
import { router, protectedProcedure } from '../trpc';

/**
 * The household's own membership and invitations, over Better Auth's organization plugin.
 *
 * Two things about this router are unlike the rest of the app and worth stating once.
 *
 * The tenant boundary is NOT `withHousehold`. These are Better Auth's tables: they carry
 * `organization_id`, not `household_id`, and no RLS policy applies to them, so the scoping is
 * this file's own. Every call below names `ctx.householdId`, which `createContext` reads off
 * the session's `activeOrganizationId` and which therefore never comes off the wire. The
 * plugin's endpoints then check the caller is a member of the household they were handed,
 * which is the second layer; `household.test.ts` proves the boundary from a second household's
 * side rather than assuming either layer.
 *
 * And the input here is an email address, which makes D38 easier to violate in this file than
 * anywhere else in the codebase. Nothing below logs, and every message it produces is a
 * constant. The addresses that legitimately cross this boundary go to the client (a household
 * may see its own membership) and to the invitee's mailbox, never to a log line.
 */

/** The role a member holds, narrowed to the two Hearth has (D36). */
type HouseholdRole = (typeof HOUSEHOLD_ROLES)[number];

/** The role that gates the three mutations below. */
const OWNER: HouseholdRole = 'owner';

/** Only the household owner may issue, revoke, or remove. */
export const OWNER_ONLY_MESSAGE = 'Only the household owner can do that.';

/**
 * The caller's session outlived their membership: see `rethrowLostMembership`. Defined in
 * `messages.ts`, which the web client also imports, and re-exported here so this router's
 * callers and its test are unchanged.
 */
export { NOT_A_MEMBER_MESSAGE };

/** A household with no owner can invite nobody and remove nobody, so it cannot be reached. */
export const LAST_OWNER_MESSAGE = 'A household has to keep at least one owner.';

/** Inviting someone who is already here. */
export const ALREADY_A_MEMBER_MESSAGE = 'That address is already in this household.';

/**
 * Covers all three ways a revoke misses: an id from another household, an id that never
 * existed, and an invitation already accepted or revoked (which is what a double click sends).
 * One sentence for all three, because naming which applies would answer questions about other
 * households, and because it is true of each.
 */
export const INVITATION_NOT_FOUND_MESSAGE = 'That invitation is not pending in this household.';

/** The same shape, for a member id: another household's, one that never was, one already gone. */
export const MEMBER_NOT_FOUND_MESSAGE = 'That person is not in this household.';

/** What the procedures need from the context: whose household, and whose session. */
type HouseholdContext = { householdId: string; headers: Headers };

type Member = Awaited<ReturnType<typeof auth.api.listMembers>>['members'][number];
type Invitation = Awaited<ReturnType<typeof auth.api.createInvitation>>;

/**
 * A Better Auth refusal that is not a bug, as the tRPC error it should be.
 *
 * Both list endpoints refuse a caller who is not a member of the household they name. That used
 * to be the ordinary state of a removed member and is now a race: migration 0006 clears the
 * household off their sessions inside the delete, so their next request is refused by
 * `protectedProcedure` before it reaches this file. What is left is the window between the two -
 * `createContext` resolves a session, the removal commits, and the call below then runs against
 * a membership that has just gone. Narrow, still reachable, and a raw `APIError` is not a
 * `TRPCError`: left alone tRPC would answer it with a 500 and log it at `error`, which is an
 * operator paged by a race nobody can act on.
 *
 * FORBIDDEN and UNAUTHORIZED both, because the plugin uses both for it: `orgSessionMiddleware`
 * answers a removed member with UNAUTHORIZED before either list endpoint reaches its own
 * FORBIDDEN. That status is also what a vanished session would produce, and this reports it as
 * a membership problem regardless - which is sound rather than lucky: `createContext` resolved
 * a session from these same headers moments earlier, and `protectedProcedure` refused the call
 * if it did not, so the only session that could be gone here is one revoked inside that window.
 * The imprecision is real and it is that: a revoked-mid-request session is told it is not a
 * member. Both answers ask the client to sign in again.
 *
 * Only those two statuses, and only at the two call sites below. Anything else is a state this
 * router did not anticipate, and a 500 carrying ids-only diagnostics is the honest answer.
 */
function rethrowLostMembership(err: unknown): never {
  if (err instanceof APIError && (err.status === 'FORBIDDEN' || err.status === 'UNAUTHORIZED')) {
    throw new TRPCError({ code: 'FORBIDDEN', message: NOT_A_MEMBER_MESSAGE, cause: err });
  }
  throw err;
}

/**
 * Every member of the caller's household, oldest membership first.
 *
 * Sorted because the alternative is not sorted: an unordered `select` returns rows in whatever
 * order Postgres finds them, which is stable until it is not, and a settings screen whose list
 * reshuffles between refetches is the visible half of that. Oldest first also puts the owner at
 * the top of the list on its own, since D36 makes them the household's first member.
 *
 * Unpaginated on purpose. Better Auth caps a page at its `membershipLimit`, which defaults to
 * 100 and is the same number `acceptInvitation` refuses beyond, so an instance cannot hold a
 * household this would truncate. Should that limit ever be raised, the owner check below reads
 * the caller's own row out of this list and would start depending on which page they landed on.
 */
async function householdMembers(ctx: HouseholdContext): Promise<Member[]> {
  const { members } = await auth.api
    .listMembers({
      query: { organizationId: ctx.householdId, sortBy: 'createdAt', sortDirection: 'asc' },
      headers: ctx.headers,
    })
    .catch(rethrowLostMembership);
  return members;
}

/**
 * Every invitation of the caller's household, in every status, oldest first.
 *
 * Sorted here rather than in the query because `listInvitations` takes no ordering. The same
 * reasoning as above, with one extra reason: re-inviting UPDATES a pending row, which is
 * exactly the kind of write that moves a row in an unordered result.
 */
async function householdInvitations(ctx: HouseholdContext): Promise<Invitation[]> {
  const invitations = await auth.api
    .listInvitations({ query: { organizationId: ctx.householdId }, headers: ctx.headers })
    .catch(rethrowLostMembership);
  return invitations.sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime());
}

/**
 * The SQLSTATE `member_keeps_an_owner` raises (migration 0005), and the whole of what this
 * router knows about it.
 *
 * A user-defined code rather than a generic check violation, so this cannot mistake some other
 * constraint for the last-owner rule. It is spelled in two places, the migration and here,
 * which is drift a comment cannot prevent - so the race test drives the real database rather
 * than asserting against this constant, and would fail if either side changed.
 */
const LAST_OWNER_SQLSTATE = 'HH001';

/**
 * Better Auth's name for the same refusal, one layer down.
 *
 * The plugin counts the household's owners itself before it deletes, which is the same
 * check-then-act this router has, so WHICH of the two refuses a losing removal depends only on
 * where the winner's commit landed: before the plugin's re-read, and the plugin answers; after
 * it, and the delete reaches the trigger and the SQLSTATE above answers. Measured over 8
 * whole-file runs of household.test.ts, the trigger answered 7 and the plugin 1, and only the
 * trigger's half was translated - which is the whole of the intermittent 500 this fixes.
 *
 * One more place the rule is spelled, counting the migration. This one is a string in Better
 * Auth's `ORGANIZATION_ERROR_CODES`, so it drifts on an upgrade rather than on an edit, and the
 * race tests drive the real plugin, so they are what would fail if it did.
 */
const LAST_OWNER_PLUGIN_CODE = 'YOU_CANNOT_LEAVE_THE_ORGANIZATION_AS_THE_ONLY_OWNER';

/** Better Auth's name for a member row it looked up and did not find. Which row is not said. */
const MEMBER_NOT_FOUND_PLUGIN_CODE = 'MEMBER_NOT_FOUND';

/**
 * The code Better Auth put on a refusal, which is NOT `err.code`.
 *
 * Measured on both of the refusals this file translates: an `APIError` carries `status`
 * ('BAD_REQUEST'), `statusCode` (400), `message`, and a `body` of `{ message, code }`. It has no
 * `code` of its own at the top level and no `cause`, so there is no chain to walk and nothing a
 * depth bound would bound. Reading `err.code` on one finds undefined, which is exactly how the
 * plugin's last-owner refusal used to leave this router as an INTERNAL_SERVER_ERROR while the
 * trigger's version of the same refusal was answered with a sentence.
 */
function pluginErrorCode(err: unknown): string | undefined {
  if (!(err instanceof APIError)) return undefined;
  const body: unknown = err.body;
  if (typeof body !== 'object' || body === null) return undefined;
  const code = (body as { code?: unknown }).code;
  return typeof code === 'string' ? code : undefined;
}

/**
 * Whether a failed write was a refusal to leave the household without an owner, from either of
 * the two places that refuse it.
 *
 * The pg error is flat: node-postgres puts the SQLSTATE on `err.code` of a `DatabaseError` and
 * Better Auth passes it through unwrapped, so this reads the top level and nothing else.
 */
function isLastOwnerViolation(err: unknown): boolean {
  if (pluginErrorCode(err) === LAST_OWNER_PLUGIN_CODE) return true;
  return (
    typeof err === 'object' &&
    err !== null &&
    (err as { code?: unknown }).code === LAST_OWNER_SQLSTATE
  );
}

/**
 * The owner gate. `protectedProcedure` establishes a session and an active household; the role
 * within it is this router's to check, and Better Auth's own permission checks sit behind this
 * one rather than in place of it (they answer with an `APIError`, which tRPC would surface as
 * a 500).
 *
 * A caller who is somehow absent from the list is treated as not an owner: that cannot happen
 * while `listMembers` refuses a non-member, and it is the direction that grants nothing.
 */
function requireOwner(members: Member[], userId: string): void {
  const caller = members.find((member) => member.userId === userId);
  if (caller === undefined || householdRole(caller.role) !== OWNER) {
    throw new TRPCError({ code: 'FORBIDDEN', message: OWNER_ONLY_MESSAGE });
  }
}

/**
 * Dates leave as ISO strings, not as `Date`s.
 *
 * This router has no superjson transformer, so a `Date` is JSON.stringify'd on the way out and
 * arrives at the client as a string while the inferred `AppRouter` type still claims a `Date`.
 * Converting here makes the type the client is given the truth about what it receives.
 */
function toMemberView(member: Member) {
  return {
    /** The member row's id, which is what `removeMember` takes. */
    id: member.id,
    /** The account's id, which is how a client recognises itself in this list. */
    userId: member.userId,
    name: member.user.name,
    email: member.user.email,
    role: householdRole(member.role),
    joinedAt: member.createdAt.toISOString(),
  };
}

function toInvitationView(invitation: Invitation) {
  return {
    id: invitation.id,
    email: invitation.email,
    role: householdRole(invitation.role),
    expiresAt: invitation.expiresAt.toISOString(),
  };
}

export const householdRouter = router({
  /** The household's name, as invitations and the More screen show it. Any member may read. */
  name: protectedProcedure.query(async ({ ctx }) => {
    const household = await auth.api
      .getFullOrganization({ query: { organizationId: ctx.householdId }, headers: ctx.headers })
      .catch(rethrowLostMembership);
    return { name: household?.name ?? '' };
  }),

  /**
   * Rename the household. Owner only, like inviting: the name is what an invitation email
   * introduces the household by.
   */
  rename: protectedProcedure
    .input(z.object({ name: z.string().trim().min(1).max(60) }))
    .mutation(async ({ ctx, input }) => {
      requireOwner(await householdMembers(ctx), ctx.session.user.id);
      await auth.api.updateOrganization({
        body: { data: { name: input.name }, organizationId: ctx.householdId },
        headers: ctx.headers,
      });
      return { name: input.name };
    }),

  /** Who is in the household, with their role and the day they joined. Any member may look. */
  members: protectedProcedure.query(async ({ ctx }) =>
    (await householdMembers(ctx)).map(toMemberView),
  ),

  /**
   * Invitations still awaiting a sign-up.
   *
   * Readable by any member, like the membership list: only the three mutations are gated.
   *
   * `pending` is the status, so an EXPIRED one is included, deliberately. It is the row that
   * explains why someone was told the instance is invite-only (auth-invite.ts keeps that
   * message deliberately uninformative), and the owner is the one who can act on it - re-send
   * it, or revoke it. `expiresAt` goes with each row so the client can say which those are.
   */
  invitations: protectedProcedure.query(async ({ ctx }) =>
    (await householdInvitations(ctx))
      .filter((invitation) => invitation.status === 'pending')
      .map(toInvitationView),
  ),

  /**
   * Invite an address into the household. Owner only.
   *
   * `resend: true` because re-inviting is an ordinary thing to do - the first message went to
   * spam - and Better Auth otherwise refuses a second invitation for an address that already
   * has a pending one. With it, the press extends the existing invitation and sends it again
   * instead of failing, which also keeps one row per address for the auto-accept to find.
   *
   * The address is lowercased and NOT trimmed. Lowercasing here is what makes the
   * already-a-member comparison below meaningful, and it changes nothing downstream:
   * `createInvitation` lowercases again before it stores or mails. Trimming is refused rather
   * than performed - zod rejects a padded address, and that is the right answer, because
   * `normalizeEmail` does not trim at sign-up either, so a trimmed invitation would be one no
   * sign-up could ever match.
   */
  invite: protectedProcedure
    .input(z.object({ email: z.string().email() }))
    .mutation(async ({ ctx, input }) => {
      const members = await householdMembers(ctx);
      requireOwner(members, ctx.session.user.id);

      // Answered here rather than left to Better Auth, whose `APIError` for this would reach the
      // client as a 500. Compared against the stored address, which Better Auth lowercases at
      // both ends. It is a check-then-act, so the plugin's own check remains the guarantee; this
      // is what turns the common case into a sentence the owner can act on.
      const email = input.email.toLowerCase();
      if (members.some((member) => member.user.email.toLowerCase() === email)) {
        throw new TRPCError({ code: 'CONFLICT', message: ALREADY_A_MEMBER_MESSAGE });
      }

      const invitation = await auth.api.createInvitation({
        body: { email, role: INVITED_ROLE, organizationId: ctx.householdId, resend: true },
        headers: ctx.headers,
      });
      return toInvitationView(invitation);
    }),

  /**
   * Withdraw a pending invitation. Owner only.
   *
   * Named for what the UI calls it; underneath it is the plugin's `cancelInvitation`, which
   * sets the status to `canceled` (one L). The lookup is what scopes it: the invitation has to
   * be one of this household's pending ones, so an id from another household is a miss rather
   * than a cross-tenant write. `cancelInvitation` would also refuse it - it resolves the
   * caller's membership against the INVITATION's household, not the caller's - but it would do
   * so with an `APIError`, and the scoping this router promises should not be a side effect of
   * a library's error path.
   */
  revokeInvitation: protectedProcedure
    .input(z.object({ invitationId: z.string().min(1) }))
    .mutation(async ({ ctx, input }) => {
      requireOwner(await householdMembers(ctx), ctx.session.user.id);

      const invitations = await householdInvitations(ctx);
      const target = invitations.find(
        (invitation) => invitation.id === input.invitationId && invitation.status === 'pending',
      );
      if (target === undefined) {
        throw new TRPCError({ code: 'NOT_FOUND', message: INVITATION_NOT_FOUND_MESSAGE });
      }

      await auth.api.cancelInvitation({
        body: { invitationId: target.id },
        headers: ctx.headers,
      });
      return { id: target.id };
    }),

  /**
   * Remove someone from the household. Owner only, and never the last owner.
   *
   * The last-owner rule is about the household, not about self-removal: leaving is a reasonable
   * thing to want, and the state that must not be reachable is a household nobody can invite
   * into or remove from, whose recipes are stranded behind a membership no one can grant. So an
   * owner may remove themselves once a second owner is there, and may not otherwise.
   *
   * What leaving costs them is a known dependency of allowing it, not a discovery: the household
   * is cleared off their sessions, so they are left with an account, no membership, and no way
   * back in on their own - `/organization/create` is refused because the household exists, and
   * `acceptPendingInvitation` only runs on the sign-up hook, so an invitation cannot readmit an
   * account that already exists. Phase F's `/accept-invite/:id` has to call
   * `/organization/accept-invitation` for a signed-in account, and until it does, leaving is
   * one-way.
   *
   * NOTHING HERE REVOKES THE REMOVED PERSON'S SESSIONS, and that is the second rule this file
   * states rather than holds. `ctx.householdId` comes off `session.activeOrganizationId`, so
   * until that column is cleared every router that is not this one goes on serving someone who
   * has been removed - measured, `recipe.list` returned the household's recipes to them. Better
   * Auth clears it only for a user removing THEMSELVES, and only on the session that asked. The
   * enforcer is `member_loses_the_household` (migration 0006), for the same reason as the
   * last-owner rule below: `/organization/leave` and `/organization/remove-member` reach the
   * same delete without passing through this file, and a revocation performed after the delete
   * is a second write that can fail on its own and leave the hole open silently.
   *
   * THIS CHECK IS THE MESSAGE, NOT THE GUARANTEE, and the distinction is the same one the
   * household cap already turned out to need. It reads the owner count and then writes, so two
   * concurrent removals of two different owners both see two owners and both commit - measured,
   * not feared: two parallel requests emptied a household of owners while every route back was
   * refused. `member_keeps_an_owner` (migration 0005) is what actually holds it, at the only
   * place concurrent writers meet, and it also covers the doors this file is not on:
   * `/organization/leave` and `/organization/remove-member` are mounted at `/api/auth/*`.
   *
   * What is left here is the part a constraint cannot do: answer the ordinary case with a
   * sentence rather than a rolled-back transaction. The loser of a race gets that same sentence
   * by way of `isLastOwnerViolation`.
   *
   * Better Auth refuses both of these one layer down too, with an `APIError`, and its
   * last-owner check has the identical race. The catch below translates those refusals rather
   * than letting them reach the client as a 500; what tells them apart is `err.body.code`, not
   * `err.code`, which is what `pluginErrorCode` reads.
   *
   * The member id is resolved to a row of THIS household before anything is removed. That
   * `find` is the tenant boundary, and it is also what keeps a caller-supplied string out of
   * the plugin's `memberIdOrEmail` email branch: what is passed on is a row id read back from
   * the household.
   */
  removeMember: protectedProcedure
    .input(z.object({ memberId: z.string().min(1) }))
    .mutation(async ({ ctx, input }) => {
      const members = await householdMembers(ctx);
      requireOwner(members, ctx.session.user.id);

      const target = members.find((member) => member.id === input.memberId);
      if (target === undefined) {
        throw new TRPCError({ code: 'NOT_FOUND', message: MEMBER_NOT_FOUND_MESSAGE });
      }

      const owners = members.filter((member) => householdRole(member.role) === OWNER);
      if (householdRole(target.role) === OWNER && owners.length <= 1) {
        throw new TRPCError({ code: 'CONFLICT', message: LAST_OWNER_MESSAGE });
      }

      try {
        await auth.api.removeMember({
          body: { memberIdOrEmail: target.id, organizationId: ctx.householdId },
          headers: ctx.headers,
        });
      } catch (err) {
        if (isLastOwnerViolation(err)) {
          throw new TRPCError({ code: 'CONFLICT', message: LAST_OWNER_MESSAGE, cause: err });
        }
        if (pluginErrorCode(err) !== MEMBER_NOT_FOUND_PLUGIN_CODE) throw err;

        // MEMBER_NOT_FOUND names no row, and the two rows it can mean want different answers,
        // so the membership is read again to find out which one went. The caller's own is the
        // row Better Auth looks up first: when that is the one that vanished - the other half
        // of the owner race, where the caller's self-removal committed - `householdMembers` is
        // refused in turn and `rethrowLostMembership` answers NOT_A_MEMBER. Otherwise the
        // target is what went, which is two removals of the same person landing together, and
        // the sentence for that is the one a stale member id already gets. Neither, and this is
        // a state the router did not anticipate: the raw error, and a 500 with ids-only
        // diagnostics, is the honest answer.
        const remaining = await householdMembers(ctx);
        if (remaining.some((member) => member.id === target.id)) throw err;
        throw new TRPCError({ code: 'NOT_FOUND', message: MEMBER_NOT_FOUND_MESSAGE, cause: err });
      }
      return { id: target.id };
    }),
});
