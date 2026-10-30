import type { FastifyInstance } from 'fastify';
import { auth } from '../src/auth';
import { env } from '../src/env';
import { SETUP_TOKEN_HEADER } from '../src/auth-invite';
import { ensureSetupToken } from '../src/setup-token';
import { createInvitation } from './factories';
import { verifyEmail } from './db';

/**
 * The first-boot token that lets one uninvited account be created (D36's bootstrap carve-out).
 *
 * Read through the real module rather than stubbed, so a fixture cannot pass a check the
 * operator's copy-paste out of the boot log would fail. Regenerated on demand: creating a
 * household deletes the file, which is the behaviour under test elsewhere.
 */
export function bootstrapToken(): string {
  return ensureSetupToken(env.DATA_DIR);
}

/** The header an uninvited first sign-up has to carry. */
export function bootstrapHeaders(): Record<string, string> {
  return { [SETUP_TOKEN_HEADER]: bootstrapToken() };
}

/** Slugs are unique per organization, and a test file can build several in the same tick. */
let slugCounter = 0;

/**
 * A client address of this fixture's own, distinct from every other fixture's.
 *
 * Sign-up is rate limited per address (auth.ts), and `inject` defaults every request to
 * 127.0.0.1, so without this the fixtures in a file spend one shared budget: five HTTP sign-ups
 * used the whole allowance and the sixth failed as `sign-up failed: 429`, which says nothing
 * about the test that hit it. Distinct addresses are also what these fixtures actually are -
 * different people on different devices.
 *
 * TEST-NET-1 (192.0.2.0/24, RFC 5737) because it is reserved for documentation and unused
 * elsewhere in this suite, where a hand-written client is 203.0.113.x. A request with no
 * X-Forwarded-For resolves to its socket address under any TRUST_PROXY, so this becomes `req.ip`
 * and therefore the rate-limit key.
 *
 * The counter resets with this module, which vitest re-evaluates per test file, so two files
 * hand out the same addresses. That is only safe because vitest.config.ts inlines Better Auth
 * and gives each file its own limiter store; the two facts have to move together.
 */
let clientCounter = 0;
function nextClientAddress(): string {
  clientCounter += 1;
  return `192.0.2.${clientCounter}`;
}

/**
 * Sign a user up on `server` and give them an active household, the state every protected
 * procedure needs. Returns the ids as well as the cookie because they are what the tenancy
 * fields on a log line have to match.
 *
 * Three requests where there used to be two, and the extra one is not incidental:
 * `requireEmailVerification` makes sign-up return `token: null` and no cookie at all, so the
 * session has to come from a separate sign-in, and that sign-in is refused until the address is
 * verified. `verifyEmail` stands in for clicking the link in the message.
 *
 * The account is uninvited, so it only succeeds as the instance's first (D36): callers reset the
 * database first, and the guards below are what turn a forgotten reset into a named failure
 * rather than a confusing FORBIDDEN three assertions later.
 */
export async function signUpWithHousehold(
  server: FastifyInstance,
  email: string,
): Promise<{ cookie: string; userId: string; householdId: string }> {
  const remoteAddress = nextClientAddress();
  const signup = await server.inject({
    method: 'POST',
    url: '/api/auth/sign-up/email',
    payload: { email, password: 'password1234', name: email },
    headers: { 'content-type': 'application/json', ...bootstrapHeaders() },
    remoteAddress,
  });
  if (signup.statusCode >= 400) throw new Error(`sign-up failed: ${signup.statusCode}`);
  const userId = (signup.json() as { user: { id: string } }).user.id;

  await verifyEmail(email);
  const signin = await server.inject({
    method: 'POST',
    url: '/api/auth/sign-in/email',
    payload: { email, password: 'password1234' },
    headers: { 'content-type': 'application/json' },
    remoteAddress,
  });
  if (signin.statusCode >= 400) throw new Error(`sign-in failed: ${signin.statusCode}`);
  const cookie = signin.headers['set-cookie'] as string;

  const created = await server.inject({
    method: 'POST',
    url: '/api/auth/organization/create',
    payload: { name: 'Home', slug: `home-${Date.now()}-${Math.random().toString(36).slice(2)}` },
    headers: { 'content-type': 'application/json', cookie },
  });
  if (created.statusCode >= 400) throw new Error(`org create failed: ${created.statusCode}`);
  const org = created.json() as { id?: string; organization?: { id: string } };
  const householdId = org.id ?? org.organization?.id;
  if (!householdId) throw new Error('org create returned no id');

  // Guarded like the two above: a silent failure here leaves a session with no active
  // household, which surfaces much later as a confusing FORBIDDEN from protectedProcedure.
  const active = await server.inject({
    method: 'POST',
    url: '/api/auth/organization/set-active',
    payload: { organizationId: householdId },
    headers: { 'content-type': 'application/json', cookie },
  });
  if (active.statusCode >= 400) throw new Error(`org set-active failed: ${active.statusCode}`);

  return { cookie, userId, householdId };
}

/**
 * An owner with a household, signed in, built through the real Better Auth API.
 *
 * Direct `auth.api` calls rather than `server.inject`, because the tests that need this are
 * about what Better Auth does (invitations, verification) rather than about the HTTP edge, and
 * a Fastify instance would be a second thing that could be the reason a test fails.
 *
 * The email is marked verified by hand between sign-up and sign-in. That step is not
 * decoration: `requireEmailVerification` makes sign-up return no session at all
 * (`shouldSkipAutoSignIn`), so the only way to a signed-in owner is to do what clicking the
 * verification link does. Doing it in SQL rather than through `/verify-email` keeps the fixture
 * from depending on a token round-trip that is not what any of these tests are about.
 *
 * The caller is responsible for `resetDb()` first: this account is uninvited, so it only
 * succeeds as the instance's first (D36).
 */
export async function ownerWithHousehold(
  email = 'owner@example.com',
): Promise<{ headers: Headers; userId: string; householdId: string; name: string }> {
  const password = 'password1234';
  const name = 'Household Owner';
  const signUp = await auth.api.signUpEmail({
    body: { email, password, name },
    headers: new Headers(bootstrapHeaders()),
  });
  const userId = signUp.user.id;

  await verifyEmail(email);

  const signIn = await auth.api.signInEmail({ body: { email, password }, returnHeaders: true });
  const setCookie = signIn.headers.get('set-cookie');
  if (setCookie === null) throw new Error('sign-in returned no session cookie');
  const headers = new Headers({ cookie: setCookie.split(';')[0] ?? '' });

  const org = await auth.api.createOrganization({
    body: { name: 'The Test Kitchen', slug: `kitchen-${Date.now()}-${++slugCounter}` },
    headers,
  });
  const householdId = org?.id;
  if (householdId === undefined) throw new Error('createOrganization returned no id');

  await auth.api.setActiveOrganization({ body: { organizationId: householdId }, headers });
  return { headers, userId, householdId, name };
}

/**
 * A second device for an account that already exists: sign in again, on its own session.
 *
 * `session` is one row per sign-in and `activeOrganizationId` is a column on each of them, so
 * one account signed in twice is two independent ways into the household. Every other fixture
 * here hands back exactly one session, which is not the state a rule about "this person's
 * sessions" can be tested against - a fix that cleared the newest row would pass against it and
 * leave the phone in the other pocket still reading the recipes.
 *
 * The address has to be verified already, which every fixture in this file leaves it.
 */
export async function signInHeaders(email: string, password = 'password1234'): Promise<Headers> {
  const signIn = await auth.api.signInEmail({ body: { email, password }, returnHeaders: true });
  const setCookie = signIn.headers.get('set-cookie');
  if (setCookie === null) throw new Error('sign-in returned no session cookie');
  return new Headers({ cookie: setCookie.split(';')[0] ?? '' });
}

/**
 * A second person in an existing household, signed in: invited, signed up, signed in.
 *
 * The route D36 actually gives people, rather than two factory inserts, because a member needs
 * a SESSION and a session needs a password, which only sign-up writes. Sign-up marks an invited
 * account verified on creation (auth.ts), so nothing stands between it and sign-in.
 *
 * `inviterId` is a foreign key on the invitation row and nothing more: no membership follows
 * from it, and what decides where the account lands is `householdId`. `role` is here for the
 * tests that need a second OWNER or a household of their own, states the API is now closed to -
 * writing them through the invitation row is how a test builds what a request may not.
 *
 * Returns both header shapes: `headers` for `auth.api.*` calls, `cookie` for `server.inject`.
 */
export async function invitedMember(opts: {
  householdId: string;
  inviterId: string;
  email: string;
  role?: string;
}): Promise<{ userId: string; headers: Headers; cookie: string }> {
  await createInvitation({
    householdId: opts.householdId,
    inviterId: opts.inviterId,
    email: opts.email,
    role: opts.role,
  });
  const password = 'password1234';
  const signUp = await auth.api.signUpEmail({
    body: { email: opts.email, password, name: 'Housemate' },
  });
  const signIn = await auth.api.signInEmail({
    body: { email: opts.email, password },
    returnHeaders: true,
  });
  const setCookie = signIn.headers.get('set-cookie');
  if (setCookie === null) throw new Error('sign-in returned no session cookie');
  const cookie = setCookie.split(';')[0] ?? '';
  return { userId: signUp.user.id, headers: new Headers({ cookie }), cookie };
}
