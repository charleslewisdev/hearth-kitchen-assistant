import type { FastifyRequest } from 'fastify';
import { betterAuth } from 'better-auth';
import { drizzleAdapter } from 'better-auth/adapters/drizzle';
import { organization } from 'better-auth/plugins';
import { db } from './db/client';
import { env } from './env';
import { publicConfig } from './config';
import { resolveAuthSecret } from './secret';
import {
  hasPendingInvitation,
  householdForUser,
  inviteOnly,
  joinInvitedHousehold,
  normalizeEmail,
} from './auth-invite';
import { acceptInviteUrl, deliver } from './auth-mail';
import { mailer } from './mail';
import { emailVerification, householdInvitation, passwordReset } from './mail/templates';
import { logger } from './log';
import {
  user,
  session,
  account,
  verification,
  organization as organizationTable,
  member,
  invitation,
} from './db/auth-schema';

/**
 * The header the `/api/auth/*` route puts Fastify's resolved client address in, and the only
 * one Better Auth is allowed to read an IP from.
 *
 * Better Auth resolves an IP as `value.split(',')[0].trim()` - the LEFTMOST X-Forwarded-For
 * entry - and has no concept of a trusted proxy or a hop count
 * (`better-auth/dist/utils/get-request-ip.mjs`). That entry is the one any client can write, so
 * configuring `ipAddressHeaders: ['x-forwarded-for']` would let anyone brute-forcing sign-in
 * rotate the header and land in a fresh rate-limit bucket on every request. Fastify has already
 * done this correctly under TRUST_PROXY, so the answer is to hand Better Auth that result rather
 * than to let it parse the raw header a second time, with worse rules.
 *
 * Exported so the writer (server.ts) and the reader (below) cannot drift apart.
 */
export const CLIENT_IP_HEADER = 'x-hearth-client-ip';

/**
 * The headers every Better Auth call gets, built from a Fastify request.
 *
 * One helper rather than a loop at each call site, because the interesting line is the last
 * one and it is the easy one to leave out: `/api/auth/*` had it, the tRPC context did not. That
 * was harmless only because `getSession` neither creates a session nor consults `getIp`, and it
 * would have become a live rate-limit bypass the first time any `auth.api.*` call there did.
 *
 * `set()` after the copy, never before: a Headers object APPENDS to an existing value, so a
 * client-supplied `x-hearth-client-ip` would otherwise survive as the first entry of
 * "9.9.9.9, 203.0.113.7" - and the first entry is exactly what Better Auth reads.
 */
export function authHeaders(req: FastifyRequest): Headers {
  const headers = new Headers();
  for (const [k, v] of Object.entries(req.headers)) {
    if (typeof v === 'string') headers.set(k, v);
  }
  // Fastify has already applied TRUST_PROXY to pick the right X-Forwarded-For entry (D39).
  headers.set(CLIENT_IP_HEADER, req.ip);
  return headers;
}

export const auth = betterAuth({
  // Unset by default, in which case a random one is generated into DATA_DIR on first boot and
  // reused from there. Throws rather than starts if the published dev default reaches production.
  secret: resolveAuthSecret({
    envSecret: env.BETTER_AUTH_SECRET,
    dataDir: env.DATA_DIR,
    nodeEnv: env.NODE_ENV,
  }),
  baseURL: publicConfig.authUrl,
  /**
   * Better Auth's own logger, pointed at ours.
   *
   * Left unset it builds its own, which writes to `console` directly. That is not a formatting
   * difference: those lines never pass through pino, so no redaction path and no
   * `serializeError` applies to them, and Better Auth logs error OBJECTS - `logger.error('Failed
   * to create user', e)` in `sign-up.mjs` prints a pg error whose `detail` is
   * `Key (email)=(someone@example.com) already exists`. Two concurrent sign-ups for one invited
   * address is enough to produce it. D38 and D40 cannot be kept at the call sites of a library,
   * so the fix is to own the sink rather than to chase the call sites.
   *
   * Extra arguments go under `args` rather than into the message, because `msg` is the one field
   * no serializer can reach (log.ts) and those arguments are exactly the errors carrying quoted
   * user input. Under `args` they meet `serializeError` and the redaction paths like anything
   * else. Better Auth's own `success` level never reaches here: it maps it to `info` before
   * calling this, which is why the union has four members and not five.
   *
   * The level is left to Better Auth's default of `warn` and NOT raised to debug, deliberately:
   * `sign-up.mjs` also does `logger.info(\`Sign-up attempt for existing email: ${email}\`)`, where
   * the address is interpolated into the message string itself and nothing downstream can
   * remove it.
   */
  logger: {
    log: (level, message, ...args) => {
      logger[level]({ args }, message);
    },
  },
  // Pass the Drizzle tables explicitly — the adapter cannot infer models otherwise.
  database: drizzleAdapter(db, {
    provider: 'pg',
    schema: {
      user,
      session,
      account,
      verification,
      organization: organizationTable,
      member,
      invitation,
    },
  }),
  emailAndPassword: {
    enabled: true,
    requireEmailVerification: true,
    // A forgotten password used to mean editing the database. The link goes out like every
    // other Hearth message: by mail, or into this server's log when there is no SMTP, where the
    // owner can pass it on. Resetting signs out every session, since a reset is what someone
    // does after losing a phone as often as after forgetting.
    sendResetPassword: ({ user: recipient, url }) =>
      deliver({
        mailer,
        log: logger,
        kind: 'password-reset',
        render: () => ({ to: recipient.email, ...passwordReset({ resetUrl: url }) }),
      }),
    revokeSessionsOnPasswordReset: true,
  },
  emailVerification: {
    sendOnSignUp: true,
    // An unverified account that signs in with the right password gets a fresh link. The first
    // account's link lasts an hour and this is the only way to ask for another; the password is
    // what keeps it from being a way to mail an arbitrary address.
    sendOnSignIn: true,
    /**
     * `url` is `${baseURL}/verify-email?token=...&callbackURL=<client value>`, and the tail is
     * the reason this callback is built the way it is. `linkHtml` refuses a non-http(s) action
     * URL, so a URL that could be steered would be a throw on the sign-up path; it cannot be,
     * because `PUBLIC_URL` is refused at boot unless its scheme is http or https (config.ts) and
     * Better Auth percent-encodes the callbackURL. Rendering happens inside `deliver` anyway, so
     * the day either of those stops holding it is a logged line rather than an escaped throw.
     */
    sendVerificationEmail: ({ user: recipient, url }) => {
      // Already verified means invited: the invitation was mailed to this address and is the
      // only thing that let the account exist (D36), so control of it is already proved and a
      // second email would ask for the same proof twice. See the user.create.before hook.
      if (recipient.emailVerified) return Promise.resolve();
      return deliver({
        mailer,
        log: logger,
        kind: 'verification',
        render: () => ({ to: recipient.email, ...emailVerification({ verifyUrl: url }) }),
      });
    },
  },
  trustedOrigins: [publicConfig.webOrigin],
  /**
   * Rate limiting on the auth paths, keyed by client address.
   *
   * `enabled` is set rather than left alone because the default is `isProduction`
   * (`context/create-context.mjs`), which would leave the limiter off in every environment a
   * change can be observed in. On always means the suite and a staging box exercise the code
   * path the deployment runs.
   *
   * **Every budget here is shared by the whole household.** The deployment is a family of about
   * five behind one NAT address, so one key covers all of them, and every request spends from
   * it - a mistyped email, a password one character short, a double-submitted form. That is why
   * these numbers are not as tight as they could be against a single attacker: the same number
   * has to cover an onboarding afternoon for five people.
   *
   * The window is not a rolling quota, which makes the numbers matter more than they look.
   * `decideConsume` advances `lastRequest` on every ALLOWED request and pushes the entry's
   * expiry to `now + window`, so the rule reads "N requests, then 900 seconds of quiet": ten
   * sign-ins spread over twenty minutes still refuse the eleventh. Refusals do not extend it.
   *
   * The rules are grouped by what the path does:
   *
   *  - **Guessing a credential** (`/sign-in/email`, `/sign-in/social`, `/change-password`): 25
   *    per 900s, about 100 guesses an hour from one address against an account whose address is
   *    verified.
   *  - **Sending a message to an address** (`/sign-up/email`, `/send-verification-email`,
   *    `/change-email`, `/request-password-reset`): 15 per 900s, so 60 an hour. These are the
   *    paths that can be pointed at somebody else's inbox.
   *
   * **These rules replace Better Auth's own, and the list is exhaustive on purpose.**
   * `getDefaultSpecialRules()` applies 3 per 10 seconds to anything under `/sign-in`,
   * `/sign-up`, `/change-password` or `/change-email`, and 3 per 60 seconds to
   * `/request-password-reset` and `/send-verification-email`. Those are tighter per second and
   * looser per hour - 3 per 10 seconds is 1080 password guesses an hour, against 100 here - and
   * the 3-per-60 one landed on an endpoint a family hits while verifying their addresses:
   * measured, four POSTs to `/send-verification-email` from one address gave `200 200 200 429`.
   * So every path this instance mounts that those rules catch is named above. A path added
   * later - a new sign-in method, an email-otp plugin - falls back to them silently, so a new
   * auth surface means a new rule here.
   *
   * The 100 per 60 seconds is what applies to the auth paths no rule catches, ours or Better
   * Auth's: `/get-session`, `/sign-out`, `/verify-email`, `/reset-password`, the organization
   * endpoints. The web client calls several of those on a normal navigation, hence the number.
   *
   * `memory` storage is per process and resets when the container restarts. That is the right
   * trade here and not merely the default: the alternative writes a row per client per path to
   * Postgres on the sign-in path, and the reset it costs is one an attacker cannot cause.
   *
   * What keys the buckets is `x-hearth-client-ip` (see CLIENT_IP_HEADER above), which the
   * `/api/auth/*` route sets from Fastify's resolved `req.ip`. Adding `x-forwarded-for` to that
   * list would defeat every number here, since Better Auth would then read an entry the client
   * writes and a rotating header would open a fresh bucket per request.
   *
   * These limits apply to requests through `auth.handler`, i.e. over HTTP. The limiter runs in
   * the router's `onRequest` (`api/index.mjs`), and `auth.api.*` calls do not go through the
   * router, so direct server-side calls are not counted. Both facts matter: the first is why a
   * sign-up the invite-only middleware refuses still consumes budget - `hooks.before` runs
   * later - which is what bounds guessing at the first-boot setup token; the second is why the
   * fixtures in `test/` that call `auth.api` directly are unaffected.
   */
  rateLimit: {
    enabled: true,
    window: 60,
    max: 100,
    storage: 'memory',
    customRules: {
      '/sign-in/email': { window: 900, max: 25 },
      '/sign-in/social': { window: 900, max: 25 },
      '/change-password': { window: 900, max: 25 },
      '/sign-up/email': { window: 900, max: 15 },
      '/send-verification-email': { window: 900, max: 15 },
      '/change-email': { window: 900, max: 15 },
      '/request-password-reset': { window: 900, max: 15 },
    },
  },
  // D36: an invitation is the only route to an account, after the first one, and into the one
  // household the instance has. Both checks live in auth-invite.ts; this is only the binding.
  hooks: { before: inviteOnly, after: joinInvitedHousehold },
  databaseHooks: {
    session: {
      create: {
        /**
         * Open every session in the household its user belongs to.
         *
         * `activeOrganizationId` is a column on the SESSION, so it does not survive a sign-out:
         * without this, the second sign-in of every account - invitee and owner alike - arrives
         * with no active household, and `App.tsx` renders `<Onboarding />` for exactly that
         * state. Setting it here rather than asking the client to call `set-active` afterwards
         * means there is no window in which the app believes the user has no household.
         *
         * Nothing is returned when the user has no membership. That is the first account on a
         * fresh install, which SHOULD land on Onboarding because creating the household is what
         * it is there to do - and also the invitee whose auto-accept failed, which is precisely
         * the case the `/organization/create` cap exists to keep from becoming a second tenant.
         *
         * Nothing is returned under `singleHousehold: false` either, and that is the third and
         * least obvious place the one-household assumption is load-bearing: "the user's
         * household" is only unambiguous while there is one of them. With the cap lifted,
         * picking the oldest membership would silently decide which tenant a session opens in.
         */
        before: async (created) => {
          if (!publicConfig.singleHousehold) return;
          const householdId = await householdForUser(created.userId);
          if (householdId === null) return;
          return { data: { ...created, activeOrganizationId: householdId } };
        },
      },
    },
    user: {
      create: {
        /**
         * An invited account starts verified.
         *
         * The invitation was delivered to this address and, after the first account, it is the
         * only way to have one at all - so the person signing up has already demonstrated the
         * one thing a verification email asks for. Sending a second challenge would add a step
         * that proves nothing, and on a zero-config install (console mail) it would mean fishing
         * a second link out of the container log.
         *
         * `before` rather than `after`, so the row is written verified in one statement: an
         * `after` hook would insert unverified and update, leaving a window in which sign-in is
         * refused, and `sendVerificationEmail` would see `emailVerified: false` and mail anyway.
         *
         * Returning nothing leaves the data untouched. Returning `false` would ABORT the create,
         * which is why the two branches here are a merge or nothing at all.
         */
        before: async (created) => {
          if (created.emailVerified) return;
          if (!(await hasPendingInvitation(normalizeEmail(created.email)))) return;
          return { data: { ...created, emailVerified: true } };
        },
      },
    },
  },
  advanced: {
    // Explicit rather than inferred. Better Auth would otherwise derive this from `baseURL`,
    // which lands on the same answer today, but its newer versions also consult request-supplied
    // protocol headers - and D39 established that ours arrive saying `http` even when the client
    // is on TLS. The public URL is the one place that fact is stated, so it is what decides.
    useSecureCookies: publicConfig.useSecureCookies,
    ipAddress: { ipAddressHeaders: [CLIENT_IP_HEADER] },
  },
  plugins: [
    organization({
      // The invitee has no account yet, so this link is the only route to one (D36). Spreading
      // the template gives the mailer its required `actionUrl`, which is what makes the link the
      // console transport prints provably the same one the body carries.
      sendInvitationEmail: (data) =>
        deliver({
          mailer,
          log: logger,
          kind: 'invitation',
          render: () => ({
            to: data.email,
            ...householdInvitation({
              inviterName: data.inviter.user.name,
              householdName: data.organization.name,
              acceptUrl: acceptInviteUrl(data.id),
            }),
          }),
        }),
    }),
  ],
});

export type Auth = typeof auth;
