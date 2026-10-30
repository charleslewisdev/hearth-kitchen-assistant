import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type { FastifyInstance } from 'fastify';

/**
 * `NODE_ENV=production`, set before any import below is evaluated, and put back afterwards.
 *
 * This is the only place it can be set. `@better-auth/core/env` reads `NODE_ENV` once, at
 * module evaluation (`export const nodeENV = env.NODE_ENV ?? ''`), so assigning it inside a
 * `beforeAll` would be too late: the module is already loaded and its answer already fixed.
 * `vi.hoisted` runs before the imports, which is what makes it early enough.
 *
 * `TEST` is deleted for the same reason, and it is the half that is easy to miss. Better Auth
 * asks `isTest()`, which is `nodeENV === 'test' || toBoolean(env.TEST)`, and vitest sets
 * `TEST=true` in every worker - so NODE_ENV alone leaves Better Auth in test mode with
 * `skipOriginCheck: true` and `getIp` still falling back to 127.0.0.1. Measured, not assumed:
 * with NODE_ENV=production and TEST set, the context reports `skipOriginCheck=true`; deleting
 * TEST as well reports `false`.
 *
 * What production buys, once both are set, stated no higher than it is:
 *
 *  - The file exercises the configuration that ships rather than a neighbouring one - the
 *    origin check on, and no `127.0.0.1` fallback in `getIp` for a request whose address it
 *    cannot resolve (`utils/get-request-ip.mjs`).
 *  - `rateLimit.enabled` defaults to `isProduction` (`context/create-context.mjs`). auth.ts
 *    turns it on explicitly, and under production the option and the default agree, so passing
 *    here says the limiter is on as it ships.
 *
 * What it does NOT buy is the per-IP assertions below. The plan expected the `127.0.0.1`
 * fallback to make them vacuous, and it does not: the `/api/auth/*` route always hands Better
 * Auth an address it CAN resolve, so the fallback is unreachable from here. Measured by
 * mutation instead - pointing `ipAddressHeaders` at `x-forwarded-for` fails them under either
 * NODE_ENV, which is the regression they exist to catch.
 *
 * The other two variables are consequences, not preferences. The published dev default secret
 * is REFUSED in production (secret.ts), so importing `./auth` under this NODE_ENV would throw
 * without a replacement; and the shared logger is silent only under `NODE_ENV=test` (log.ts),
 * so without `LOG_LEVEL=silent` this one file would print every server line the rest of the
 * suite suppresses.
 *
 * Setting it here only works because vitest.config.ts inlines Better Auth: node_modules is
 * otherwise externalized to Node's own ESM cache, one instance for the whole fork, and then
 * whichever test file imported it first would have decided NODE_ENV for this one. The first
 * test below fails if that ever stops being true, rather than letting this file quietly run
 * under test semantics.
 *
 * Restoring in `afterAll` is what keeps this file from leaking into the next one: `process.env`
 * is process-wide and the suite runs in a single fork, so the restore has to land before the
 * next file's modules are evaluated.
 */
const restoreEnv = vi.hoisted(() => {
  const before: Record<string, string | undefined> = {
    NODE_ENV: process.env.NODE_ENV,
    TEST: process.env.TEST,
    BETTER_AUTH_SECRET: process.env.BETTER_AUTH_SECRET,
    LOG_LEVEL: process.env.LOG_LEVEL,
  };
  process.env.NODE_ENV = 'production';
  delete process.env.TEST;
  process.env.BETTER_AUTH_SECRET = 'auth-ratelimit-test-secret-not-the-dev-one';
  process.env.LOG_LEVEL = 'silent';
  return () => {
    for (const [key, value] of Object.entries(before)) {
      // Assigning `undefined` would set the STRING "undefined", which for NODE_ENV is a value
      // every `isTest()` check in the process would then read as neither test nor production.
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  };
});

import { publicConfig } from './config';
import { INVITE_ONLY_MESSAGE, SETUP_TOKEN_HEADER } from './auth-invite';
import { buildServer } from './server';
import { createLogger } from './log';
import { capture } from '../test/logs';
import { resetDb, verifyEmail } from '../test/db';
import { bootstrapHeaders } from '../test/session';
import { auth } from './auth';

/**
 * The proxy chain D39 describes, written out as addresses so a request can be posted through
 * it: the client's own machine, then nginx, then Caddy, which is the peer Fastify's socket
 * sees. `TRUST_PROXY` is 2 (env.ts), so Fastify skips the two proxies and resolves the entry
 * they vouched for, which is the client.
 */
const CADDY = '172.18.0.1';
const NGINX = '10.0.0.2';

/**
 * What the client wrote into `X-Forwarded-For` before nginx appended anything, i.e. the part of
 * the header an attacker controls. Every request here carries one, so no test can pass by
 * reading the leftmost entry.
 */
const FORGED = '9.9.9.9';

const PASSWORD = 'password1234';

/**
 * The limits, written out rather than imported from `auth.ts`.
 *
 * Importing them would make this file agree with the configuration by construction: raise
 * `max` to 10000 and the loop would simply run 10000 times and still find its 429 at the end.
 * Hardcoded, the mutation fails the test, which is the only reason to write it.
 */
const SIGN_IN_MAX = 25;
const SIGN_UP_MAX = 15;

/**
 * The paths Better Auth's built-in special rules would otherwise decide for us: 3 per 10
 * seconds for anything under `/sign-in`, `/sign-up`, `/change-password` or `/change-email`, and
 * 3 per 60 seconds for `/send-verification-email` (`api/rate-limiter/index.mjs`). This is the
 * complete list of paths this instance mounts that those rules catch and `auth.ts` did not
 * originally name, so the fourth request to each is the assertion.
 */
const ONCE_DEFAULTED = [
  '/change-password',
  '/change-email',
  '/send-verification-email',
  '/sign-in/social',
];

let app: FastifyInstance;

/**
 * Top level rather than inside the `describe`, so the restore is registered as early as this
 * file can register anything: `process.env` is process-wide and the suite runs in a single
 * fork, so a leak here is `NODE_ENV=production` and a silent logger for every file that runs
 * after this one.
 *
 * What it does NOT cover, stated rather than implied: if one of the imports above throws, the
 * body of this file never runs, so no hook of any kind gets registered and the environment
 * stays as the hoisted block left it. Placement cannot fix that - imports are evaluated before
 * the first statement here. What keeps it from happening is the values themselves: the secret
 * is 32-plus characters and is not the published dev default, which are the two things `./auth`
 * refuses to start on.
 */
afterAll(restoreEnv);

/**
 * Headers for one request from `client`, arriving through the chain above.
 *
 * `origin` is here because a browser always sends one, and because without it these requests
 * would be refused in the shape a browser actually sends. Better Auth answers 403
 * MISSING_OR_NULL_ORIGIN when all four of these hold, measured against 1.6.19 rather than read:
 *
 *   1. the method is not GET, HEAD or OPTIONS; and
 *   2. `skipOriginCheck` is false, which is what NODE_ENV=production plus a deleted `TEST` buys
 *      (see the block at the top of this file); and
 *   3. the request carries neither `Origin` nor `Referer`; and
 *   4. EITHER a `Cookie` header is present - `originCheckMiddleware` is router-wide, so this
 *      arm covers every auth path (verified on `/change-email` and `/get-session`) - OR any
 *      `Sec-Fetch-*` header is present with no cookie, which `formCsrfMiddleware` adds as an
 *      endpoint `use:` on `/sign-in/email` and `/sign-up/email` and nowhere else (verified:
 *      Sec-Fetch alone on `/change-email` is not refused).
 *
 * The fourth condition is why a comment here previously saying "only for a request that carries
 * a cookie" was wrong in the direction that matters: **a browser sends `Sec-Fetch-*` on every
 * request**, so the case it excluded is the browser-shaped one. These tests pass without
 * `Origin` only because `inject` sends neither a cookie nor Sec-Fetch, which is luck rather
 * than coverage.
 *
 * On `/sign-up/email` the invite-only gate answers first when it applies, because `hooks.before`
 * runs ahead of an endpoint's own `use:` middlewares - measured, that request is the
 * invite-only 403 rather than the origin one.
 *
 * The plan's warning is still worth its place for the reason behind it: a 403 a test never
 * looks at is indistinguishable from a limit that works, which is why the assertions below name
 * every status in a sequence rather than only the last.
 */
function clientHeaders(client: string, forged: string = FORGED): Record<string, string> {
  return {
    'content-type': 'application/json',
    origin: publicConfig.webOrigin,
    'x-forwarded-for': `${forged}, ${client}, ${NGINX}`,
  };
}

function signIn(client: string, email: string, forged: string = FORGED) {
  return app.inject({
    method: 'POST',
    url: '/api/auth/sign-in/email',
    payload: { email, password: PASSWORD },
    headers: clientHeaders(client, forged),
    remoteAddress: CADDY,
  });
}

function signUp(client: string, email: string, setupToken: string) {
  return app.inject({
    method: 'POST',
    url: '/api/auth/sign-up/email',
    payload: { email, password: PASSWORD, name: 'Someone' },
    headers: { ...clientHeaders(client), [SETUP_TOKEN_HEADER]: setupToken },
    remoteAddress: CADDY,
  });
}

/**
 * Every status a client got, in order, so an assertion can name the whole sequence. Statuses
 * rather than the responses themselves because the sequence IS the subject: a test that only
 * looked at the last one would pass just as happily if all of them had been 403s.
 */
async function statuses(count: number, send: (n: number) => Promise<{ statusCode: number }>) {
  const seen: number[] = [];
  for (let n = 0; n < count; n += 1) seen.push((await send(n)).statusCode);
  return seen;
}

describe('auth rate limiting', () => {
  beforeAll(async () => {
    await resetDb();
    app = await buildServer();
  });

  afterAll(async () => {
    await app.close();
  });

  /**
   * The guard on everything below, and the reason it is first: every other test here is written
   * for a server running under NODE_ENV=production, and none of them would fail if it were not.
   *
   * Better Auth sets `skipOriginCheck` from `isTest()` when the instance is constructed, so
   * refusing a cookie-bearing POST that carries no `Origin` is behaviour only a production
   * instance has. If the hoisted block above ever stops taking effect - Better Auth externalized
   * again and another file importing it first, or `TEST` creeping back - this fails here,
   * naming the reason, instead of leaving the rest of the file measuring something else.
   */
  it('is running under production semantics, which the rest of this file assumes', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/auth/sign-in/email',
      payload: { email: 'nobody@example.com', password: PASSWORD },
      headers: {
        'content-type': 'application/json',
        cookie: 'better-auth.session_token=irrelevant',
        'x-forwarded-for': `${FORGED}, 203.0.113.19, ${NGINX}`,
      },
      remoteAddress: CADDY,
    });

    expect(res.statusCode).toBe(403);
    expect(res.body).toContain('MISSING_OR_NULL_ORIGIN');
  });

  it('refuses one client the sign-in attempt after the limit, and answers 401 up to it', async () => {
    const client = '203.0.113.20';
    const seen = await statuses(SIGN_IN_MAX + 1, () => signIn(client, 'nobody@example.com'));

    expect(seen.slice(0, SIGN_IN_MAX)).toEqual(Array<number>(SIGN_IN_MAX).fill(401));
    expect(seen[SIGN_IN_MAX]).toBe(429);
  });

  it('leaves a different client alone, so the key is the address and not a global counter', async () => {
    const hammering = '203.0.113.21';
    const bystander = '203.0.113.22';
    const seen = await statuses(SIGN_IN_MAX + 1, () => signIn(hammering, 'nobody@example.com'));
    expect(seen[SIGN_IN_MAX]).toBe(429);

    const other = await signIn(bystander, 'nobody@example.com');
    expect(other.statusCode).toBe(401);
  });

  it('keys on the address the proxy vouched for, not the X-Forwarded-For entry the client wrote', async () => {
    const client = '203.0.113.23';
    // A fresh forged leftmost entry on every request. This is the bypass the whole
    // `x-hearth-client-ip` arrangement exists to prevent: Better Auth reads `split(',')[0]`
    // verbatim, so pointed at `x-forwarded-for` it would open a new bucket every time.
    const seen = await statuses(SIGN_IN_MAX + 1, (n) =>
      signIn(client, 'nobody@example.com', `9.9.9.${n}`),
    );

    expect(seen.slice(0, SIGN_IN_MAX)).toEqual(Array<number>(SIGN_IN_MAX).fill(401));
    expect(seen[SIGN_IN_MAX]).toBe(429);
  });

  /**
   * The setup token is a 64-character hex string, so this is not the attack that finds it. It
   * is the check that the attack is bounded at all: without the limiter running ahead of
   * `inviteOnly`, a stranger gets unlimited guesses at a 403 and the only thing standing
   * between them and ownership of the instance is the length of the token.
   */
  it('counts sign-ups the invite-only gate refused, so setup-token guessing is limited too', async () => {
    const client = '203.0.113.24';
    const seen = await statuses(SIGN_UP_MAX + 1, (n) =>
      signUp(client, `guess${n}@example.com`, 'not-the-real-setup-token'),
    );

    expect(seen.slice(0, SIGN_UP_MAX)).toEqual(Array<number>(SIGN_UP_MAX).fill(403));
    expect(seen[SIGN_UP_MAX]).toBe(429);
  });

  it('refuses a guessed setup token with the invite-only message, not a hint that it was wrong', async () => {
    const res = await signUp('203.0.113.25', 'guesser@example.com', 'not-the-real-setup-token');
    expect(res.statusCode).toBe(403);
    expect(res.body).toContain(INVITE_ONLY_MESSAGE);
  });

  /**
   * Better Auth's special rules are not "what applies to paths we did not name" in the sense
   * that would be harmless: they are stricter than this file's rules over a short window, and
   * `/send-verification-email` at 3 per 60 seconds was the tightest limit on the box - on a
   * path a household hits while onboarding, sharing one budget behind one NAT address. Every
   * mounted path they catch now has a rule of its own, and this is what says so.
   */
  it.each(ONCE_DEFAULTED)(
    'gives %s a budget of its own, not the 3-per-10-seconds default',
    async (path) => {
      const client = `203.0.113.${40 + ONCE_DEFAULTED.indexOf(path)}`;
      const send = () =>
        app.inject({
          method: 'POST',
          url: `/api/auth${path}`,
          payload: {
            email: 'nobody@example.com',
            newEmail: 'nobody2@example.com',
            provider: 'none',
          },
          headers: clientHeaders(client),
          remoteAddress: CADDY,
        });

      // Four, because three is what the default allows: the fourth is the one that would be 429.
      const seen = await statuses(4, send);
      expect(seen).not.toContain(429);
    },
  );

  /**
   * The invite-only refusal is deliberately one sentence for never-invited, expired and
   * already-accepted alike, so that sign-up is not an oracle for "is this address known here".
   * A 429 that answered differently for an address that exists would give that back.
   */
  it('answers a limited client the same way whether or not the address exists', async () => {
    const known = 'owner@example.com';
    await auth.api.signUpEmail({
      body: { email: known, password: PASSWORD, name: 'Owner' },
      headers: new Headers(bootstrapHeaders()),
    });
    await verifyEmail(known);

    const onKnown = await statuses(SIGN_IN_MAX + 1, () => signIn('203.0.113.26', known));
    const onUnknown = await statuses(SIGN_IN_MAX + 1, () =>
      signIn('203.0.113.27', 'stranger@example.com'),
    );
    expect(onKnown[SIGN_IN_MAX]).toBe(429);
    expect(onUnknown[SIGN_IN_MAX]).toBe(429);

    const limitedOnKnown = await signIn('203.0.113.26', known);
    const limitedOnUnknown = await signIn('203.0.113.27', 'stranger@example.com');
    expect(limitedOnKnown.body).toBe(limitedOnUnknown.body);
    expect(limitedOnKnown.body).not.toContain(known);
    // Over twenty real password hashes, which outlast the default timeout on a busy machine.
  }, 20_000);

  /**
   * The auth limiter answers its own 429 without throwing, so neither the error handler's line
   * nor the global cap's `onExceeded` covers it: server.ts logs this one itself. `warn` is the
   * level an operator watching an internet-facing box filters on, and the assertion that the
   * ten attempts BEFORE the refusal write nothing there is the other half of the bargain - a
   * household member who has forgotten which password they used does not fill the log.
   */
  it('logs the refusal at warn, and writes nothing there for the attempts it allowed', async () => {
    const client = '203.0.113.29';
    const { sink, lines } = capture();
    const server = await buildServer({
      logger: createLogger({ level: 'info', pretty: false, destination: sink }),
    });
    const send = () =>
      server.inject({
        method: 'POST',
        url: '/api/auth/sign-in/email',
        payload: { email: 'nobody@example.com', password: PASSWORD },
        headers: clientHeaders(client),
        remoteAddress: CADDY,
      });

    for (let n = 0; n < SIGN_IN_MAX; n += 1) await send();
    const warnsWhileAllowed = lines().filter((l) => l.level === 40);

    const refused = await send();
    await server.close();

    expect(refused.statusCode).toBe(429);
    expect(warnsWhileAllowed).toEqual([]);
    const warned = lines().filter((l) => l.level === 40);
    expect(warned).toHaveLength(1);
    expect(warned[0]!.limiter).toBe('auth');
    expect(warned[0]!.remoteAddress).toBe(client);
  });

  /**
   * Better Auth spells it `X-Retry-After`, not the standard `Retry-After` that Task 16's global
   * limiter sends. Pinned because it is the only thing telling a client how long to wait, and
   * because it reaches the client only through the header-copy loop in `/api/auth/*`.
   *
   * The content type is pinned with it, and it is a wart rather than a choice: Better Auth
   * builds its 429 as a `Response` with a JSON string and no content type, so the platform
   * default applies and the body arrives as `text/plain` that happens to be JSON. Phase F has
   * to parse it without trusting the header - `fetch`'s `.json()` does. If this assertion ever
   * fails because the type became `application/json`, that is Better Auth fixing it: drop the
   * assertion and tell Phase F it can trust the header after all.
   */
  it('tells a limited client how long to wait', async () => {
    const client = '203.0.113.28';
    const seen = await statuses(SIGN_IN_MAX + 1, () => signIn(client, 'nobody@example.com'));
    expect(seen[SIGN_IN_MAX]).toBe(429);

    const limited = await signIn(client, 'nobody@example.com');
    const retryAfter = Number(limited.headers['x-retry-after']);
    expect(retryAfter).toBeGreaterThan(0);
    expect(retryAfter).toBeLessThanOrEqual(900);
    expect(limited.headers['content-type']).toBe('text/plain;charset=UTF-8');
    expect(JSON.parse(limited.body)).toEqual({
      message: 'Too many requests. Please try again later.',
    });
  });
});
