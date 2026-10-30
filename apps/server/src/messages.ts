/**
 * The strings the web client has to spell exactly as the server does, in a module a browser
 * bundle can import.
 *
 * They were defined next to the code that throws them - `auth-invite.ts` and the household
 * router - and that is where they belong, except for one thing: Phase F needs the strings
 * themselves on the client, and neither of those modules can cross into a browser bundle. Both
 * reach `node:fs` and `pg` through their imports, and `vite build` fails on it rather than
 * warning ("join" is not exported by "__vite-browser-external", from `setup-token.ts`).
 *
 * So the wording moved here, to a module with no imports at all, and both original homes
 * re-export it. There is still exactly one home for each sentence and every existing import
 * site is unchanged; what changed is that the client can now import the same constant instead
 * of restating it and drifting.
 *
 * What belongs here: a string the CLIENT states on its own, matches on, or sends. A message the
 * server only ever throws stays beside the code that throws it, where its reasoning is.
 */

/**
 * The header the first-boot setup token is presented in.
 *
 * A header rather than a sign-up body field, for two reasons. Better Auth types the sign-up body
 * as a closed shape - the runtime schema accepts extras but the TypeScript one does not - so a
 * body field would have every caller, the web client included, working around its own types to
 * send it. And it is a deployment credential rather than user data: it belongs beside the
 * client-IP header, not next to the password, and this keeps it out of `parseUserInput` and out
 * of anything that echoes the submitted body back.
 *
 * Three readers now spell it: the middleware that checks it, the startup line that tells the
 * operator to send it, and the sign-in screen's first-boot form. This is the one place it is
 * written down.
 */
export const SETUP_TOKEN_HEADER = 'x-hearth-setup-token';

/**
 * What a rejected sign-up is told.
 *
 * Deliberately the same sentence whether the address was never invited, was invited and the
 * invitation expired, or was invited to a household someone already accepted for. Naming which
 * one applies would turn the sign-up form into an oracle for "is this address known to this
 * instance", which is the one question a public endpoint should not answer. The household owner
 * can see the real state on the settings screen, and that is the right place for it.
 *
 * The sign-in screen states it up front (Task 20), so a stranger who lands on the URL learns why
 * there is no way to register before they look for one.
 */
export const INVITE_ONLY_MESSAGE =
  'Hearth is invite-only. Ask the household owner for an invitation.';

/**
 * What an attempt to create a second household is told.
 *
 * Phrased as a route forward rather than as a refusal, because the person most likely to see it
 * is not an attacker: it is an invitee whose membership did not land, sitting on the onboarding
 * screen, for whom the answer really is "ask the owner to invite you again".
 *
 * The onboarding screen states it without waiting for the refusal, because the form it used to
 * show could never succeed on a claimed instance.
 */
export const ONE_HOUSEHOLD_MESSAGE =
  'This Hearth already has a household. Ask its owner for an invitation to join it.';

/**
 * The caller's membership ended while their request was in flight: see `rethrowLostMembership`
 * in the household router, the one Better Auth refusal it translates.
 *
 * It was the steady answer to a removed member until migration 0006, which clears the household
 * off that person's sessions inside the delete - so their next request is now refused by
 * `protectedProcedure` before any household query runs. What still reaches this message is a
 * request whose session was resolved a moment before the removal committed.
 *
 * The client matches on it rather than on the FORBIDDEN code, because `protectedProcedure`
 * answers "No active household" with that same code and the two need different handling: one is
 * a session to end, the other is a household to join.
 */
export const NOT_A_MEMBER_MESSAGE = 'You are not a member of this household.';

/**
 * Renaming a food to a name another food already has. The Foods screen matches on the code and
 * shows this sentence, then offers to merge the two instead.
 */
export const FOOD_NAME_TAKEN_MESSAGE =
  'Another food already has that name. Merge the two instead, so recipes and lists share one.';

/**
 * Renaming a tag to a name another tag already has. The Tags screen matches on the code and
 * offers to merge the two instead.
 */
export const TAG_NAME_TAKEN_MESSAGE =
  'Another tag already has that name. Merge the two instead, so the recipes share one tag.';
