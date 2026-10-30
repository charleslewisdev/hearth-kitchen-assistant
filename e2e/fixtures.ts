/*
  FIRST, and deliberately: importing this module is what loads the repo-root .env into
  process.env, and every server module below parses process.env at ITS OWN import (env.ts),
  where a missing DATABASE_URL throws rather than defaults. Playwright loads the config - which
  imports the same module - in every worker before it requires a spec, so that load has already
  happened by the time this file is evaluated; ES modules evaluate imports in source order, so
  keeping this line first is what makes that a redundancy rather than something to depend on.
*/
import { API_URL, SERVER_DATA_DIR, SERVER_LOG, WEB_ORIGIN } from './env';
import { readFile } from 'node:fs/promises';
import { request } from '@playwright/test';
// The pool is never closed here: the Playwright worker owns this process and exits with the run.
import { pool } from '../apps/server/src/db/client';
import { SETUP_TOKEN_HEADER } from '../apps/server/src/messages';
import { ensureSetupToken } from '../apps/server/src/setup-token';
import { resetDb, verifyEmail } from '../apps/server/test/db';
import { createHousehold, createMember } from '../apps/server/test/factories';

/**
 * The household these specs start from, and why it is built rather than driven.
 *
 * D36 leaves an instance exactly two ways to produce an account, and neither is a screen a spec
 * can simply walk through twice:
 *
 *   - The FIRST-BOOT path: the setup token, the sign-in screen's disclosure, and then the
 *     verification link, which with no SMTP configured is a line in the server's log. It works
 *     once per database and no more - creating the household deletes the token file
 *     (`joinInvitedHousehold`) and the first committed account closes the exemption
 *     (`hasAnyUser`) - so a spec built on it still needs a reset before it can run twice.
 *   - An INVITATION, which needs an owner, which is the thing being built.
 *
 * So the reset is not avoidable, and once a reset is in hand the first-boot screens buy the
 * grocery spec nothing except two more ways for it to fail for reasons that are not about
 * groceries. This builds the same end state directly, and `invite.spec.ts` is where the mail
 * path is exercised for real, because there it IS the flow under test.
 *
 * What is still driven through the real server, rather than written: the account itself. A
 * password only exists as a credential Better Auth wrote, so the sign-up below goes over HTTP
 * carrying the real setup token - which keeps the bootstrap carve-out on the exercised path and
 * means these specs cannot pass against a server that has stopped honouring it.
 *
 * The household and the membership are written directly, exactly as `test/factories.ts` does for
 * the server suite: they are rows in Better Auth's own tables with no RLS on them, the endpoint
 * that would create them can only be called once per instance anyway, and every HTTP sign-in
 * spends from a rate-limit budget (25 per 900 seconds, per client address) that a developer
 * running this suite repeatedly shares with the browser.
 */

/** The one account these specs sign in as, and the household owner every one of them needs. */
export const OWNER = {
  email: 'e2e-owner@example.com',
  password: 'hearth-e2e-password',
  name: 'E2E Owner',
} as const;

export type SeededHousehold = { householdId: string; ownerId: string };

/**
 * Empty the database, then put one verified owner and their household in it.
 *
 * The reset is what makes a spec rerunnable, and after Phase D it is what makes it runnable at
 * all a second time: `organization_singleton_uidx` allows one household per database, so a spec
 * that creates its own succeeds exactly once. It is the same `resetDb()` the server suite runs
 * before every test, against the same development database, so nothing is being treated as
 * disposable here that was not already.
 *
 * Every spec file calls this, and there is one database for all of them, so they cannot run at
 * the same time: one file's reset would empty another's household mid-test. `workers: 1` in
 * playwright.config.ts is what keeps that from happening, and is why it is set.
 */
export async function seedOwnerAndHousehold(): Promise<SeededHousehold> {
  await resetDb();

  // Written by this process rather than read: the server deletes the token at boot once a
  // household exists (`announceSetupToken`), and `tsx watch` reboots on every edit, so the file
  // is missing about as often as it is present. `ensureSetupToken` is the server's own function,
  // so what it writes is what the middleware will accept.
  const token = ensureSetupToken(SERVER_DATA_DIR);

  const api = await request.newContext({ baseURL: API_URL });
  let ownerId: string;
  try {
    const signUp = await api.post('/api/auth/sign-up/email', {
      data: { email: OWNER.email, password: OWNER.password, name: OWNER.name },
      headers: { [SETUP_TOKEN_HEADER]: token },
    });
    if (!signUp.ok()) {
      throw new Error(`owner sign-up failed: ${signUp.status()} ${await signUp.text()}`);
    }
    const body = (await signUp.json()) as { user?: { id?: unknown } };
    if (typeof body.user?.id !== 'string') throw new Error('owner sign-up returned no user id');
    ownerId = body.user.id;
  } finally {
    await api.dispose();
  }

  // What clicking the verification link does. The owner was not invited, so nothing has proved
  // the address and `requireEmailVerification` refuses to sign them in until something does;
  // the link itself is only in the server's log, and fishing it out would make every spec that
  // needs a signed-in owner depend on the mail path instead of the one that tests it.
  await verifyEmail(OWNER.email);

  const householdId = await createHousehold();
  await createMember({ householdId, userId: ownerId, role: 'owner' });
  return { householdId, ownerId };
}

/**
 * A URL as the console mailer writes it, bounded by the quote both pino formats put after it.
 *
 * The invitation id is Better Auth's, out of an alphanumeric alphabet, and `acceptInviteUrl`
 * percent-encodes it - hence `%` in the tail.
 */
const ACCEPT_INVITE_URL = /https?:\/\/[^\s"']+\/accept-invite\/[A-Za-z0-9_%-]+/;

/**
 * The invitation link that was sent to `email`, read out of the API server's log.
 *
 * With no SMTP configured this is not a shortcut around delivery: it IS delivery. ConsoleMailer
 * logs `{ to, actionUrl }` and nothing else - no subject, no body - so the address and the link
 * are two fields of one line, which pino-pretty (development) splits across lines and pino's
 * JSON output does not. Matching the address and then taking the next link after it works in
 * both, and depends only on the order the mailer builds that object in.
 *
 * The LAST occurrence of the address, because a reused server's log carries earlier runs too.
 * Specs pass an address unique to the run, so the newest line for it is this run's.
 */
export async function inviteLinkFor(email: string, timeoutMs = 15_000): Promise<string> {
  return linkFor(email, ACCEPT_INVITE_URL, 'invitation', timeoutMs);
}

const RESET_PASSWORD_URL = /https?:\/\/[^\s"']+\/reset-password\/[A-Za-z0-9_%-]+\?callbackURL=[^\s"']+/;

/** The password-reset link sent to `email`, read the same way as an invitation link. */
export async function resetLinkFor(email: string, timeoutMs = 15_000): Promise<string> {
  return linkFor(email, RESET_PASSWORD_URL, 'password reset', timeoutMs);
}

async function linkFor(
  email: string,
  pattern: RegExp,
  what: string,
  timeoutMs: number,
): Promise<string> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    // Missing until the server writes its first line, which on a reused server it may already
    // have done long ago. Either way an unreadable log is "not there yet" until the deadline.
    const log = await readFile(SERVER_LOG, 'utf8').catch(() => '');
    const at = log.lastIndexOf(email);
    const link = at === -1 ? null : pattern.exec(log.slice(at))?.[0];
    if (link) return link;
    if (Date.now() >= deadline) {
      throw new Error(
        `no ${what} link for ${email} appeared in ${SERVER_LOG} within ${timeoutMs}ms. ` +
          'That file is written by the webServer command in playwright.config.ts, so it stays ' +
          'empty when Playwright reuses an API server it did not start (reuseExistingServer).',
      );
    }
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
}

/** Where an invitation link has to point for the person who follows it to reach this app. */
export const INVITE_LINK_PREFIX = `${WEB_ORIGIN}/accept-invite/`;

/**
 * The id of the invitation waiting for `email`, straight from the database.
 *
 * This is the independent oracle for what the mailed link should say, and without it the link
 * is barely tested. Nothing on the signed-out accept path reads the id out of the URL:
 * `joinInvitedHousehold` finds the pending invitation BY ADDRESS at sign-up, so an invitation
 * link carrying a stale id, a truncated one, or somebody else's would carry the invitee through
 * exactly the same happy path. The id only becomes load-bearing on the signed-in accept branch.
 *
 * Raw SQL rather than Drizzle because `drizzle-orm` resolves from the server package and not
 * from this one; the table is Better Auth's own, with no RLS on it, so the query needs nothing
 * the repository layer provides.
 */
export async function pendingInvitationId(email: string): Promise<string | null> {
  const { rows } = await pool.query<{ id: string }>(
    `select id from "invitation" where email = $1 and status = 'pending'`,
    [email.toLowerCase()],
  );
  return rows[0]?.id ?? null;
}
