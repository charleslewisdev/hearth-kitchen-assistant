import { describe, it, expect, afterAll, beforeAll, beforeEach } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { EventEmitter } from 'node:events';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Fastify from 'fastify';
import { buildServer, installProcessHandlers, MAX_IMPORT_BODY_BYTES } from './server';
import { createLogger } from './log';
import { resetDb, sessionIpFor, verifyEmail } from '../test/db';
import { capture } from '../test/logs';
import { bootstrapHeaders, signUpWithHousehold } from '../test/session';
import { publicConfig } from './config';
import { MAX_TRPC_BATCH } from '@hearth/shared';

let app: FastifyInstance;
beforeAll(async () => {
  app = await buildServer();
});
afterAll(async () => {
  await app.close();
});

/**
 * A server of its own with a capturable logger. The shared `app` logs through the singleton,
 * which is silent under test, so any test that reads log output builds one of these instead of
 * inferring the wiring from a response header.
 */
async function buildServerWithCapturedLogs(
  opts: { trustProxy?: number | string[] } = {},
): Promise<{ server: FastifyInstance; lines: () => Record<string, unknown>[] }> {
  const { sink, lines } = capture();
  const server = await buildServer({
    logger: createLogger({ level: 'info', pretty: false, destination: sink }),
    trustProxy: opts.trustProxy,
  });
  return { server, lines };
}

describe('health', () => {
  it('GET /health returns ok', async () => {
    const res = await app.inject({ method: 'GET', url: '/health' });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ status: 'ok' });
  });
});

describe('auth', () => {
  beforeAll(async () => {
    await resetDb();
  });
  /**
   * Sign-up deliberately does NOT hand back a session any more.
   *
   * `requireEmailVerification` makes Better Auth take its `shouldSkipAutoSignIn` branch, so the
   * account is created and the response carries `token: null` and no `Set-Cookie`. That is the
   * whole point of the setting - an unverified address cannot be signed in as - and asserting a
   * cookie here would be asserting that verification is off.
   */
  it('signs a user up without signing them in', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/auth/sign-up/email',
      payload: { email: 'a@test.dev', password: 'password1234', name: 'A' },
      headers: { 'content-type': 'application/json', ...bootstrapHeaders() },
    });
    expect(res.statusCode).toBeLessThan(400);
    expect(res.headers['set-cookie']).toBeUndefined();
    expect(res.json()).toMatchObject({ token: null });
  });

  it('issues a session cookie once the address is verified', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/auth/sign-in/email',
      payload: { email: 'a@test.dev', password: 'password1234' },
      headers: { 'content-type': 'application/json' },
    });
    // The account above is still unverified, so this is the refusal, not the cookie.
    expect(res.statusCode).toBeGreaterThanOrEqual(400);

    await verifyEmail('a@test.dev');
    const after = await app.inject({
      method: 'POST',
      url: '/api/auth/sign-in/email',
      payload: { email: 'a@test.dev', password: 'password1234' },
      headers: { 'content-type': 'application/json' },
    });
    expect(after.statusCode).toBeLessThan(400);
    expect(after.headers['set-cookie']).toBeDefined();
  });
});

describe('trpc recipe', () => {
  // A signed-in user with an active household, shared across the round-trip.
  let cookie: string;

  beforeAll(async () => {
    await resetDb();
    ({ cookie } = await signUpWithHousehold(app, 'b@test.dev'));
  });

  // tRPC over HTTP: mutations take the raw input as the POST body; queries take
  // it as a JSON-encoded `input` query param (the mutation `data`/`result` unwrap
  // to `{ result: { data: ... } }`).
  const mutate = (path: string, input: unknown) =>
    app.inject({
      method: 'POST',
      url: `/trpc/${path}`,
      payload: input as object,
      headers: { 'content-type': 'application/json', cookie },
    });
  const query = (path: string, input?: unknown) =>
    app.inject({
      method: 'GET',
      url:
        input === undefined
          ? `/trpc/${path}`
          : `/trpc/${path}?input=${encodeURIComponent(JSON.stringify(input))}`,
      headers: { cookie },
    });
  const dataOf = (res: { json: () => unknown }) =>
    (res.json() as { result: { data: unknown } }).result.data;

  it('refuses a batch larger than the web client ever sends', async () => {
    // Short unknown names keep the URL under Fastify's 100-character route-param limit, which
    // would otherwise answer 404 before tRPC sees the batch at all.
    const batch = (n: number) =>
      app.inject({ method: 'GET', url: `/trpc/${Array(n).fill('x').join(',')}?batch=1` });
    const over = await batch(MAX_TRPC_BATCH + 1);
    expect(over.statusCode).toBe(400);
    expect(over.body).toContain('Batch call exceeds maximum size');
    expect((await batch(MAX_TRPC_BATCH)).body).not.toContain('Batch call exceeds maximum size');
  });

  it('rejects recipe.list without a session', async () => {
    const res = await app.inject({ method: 'GET', url: '/trpc/recipe.list' });
    expect(res.statusCode).toBe(401);
  });

  it('creates, gets, lists, updates, and deletes a recipe', async () => {
    // Create with ingredients, a step, a meal type, and a tag.
    const create = await mutate('recipe.create', {
      title: 'White Bean Soup',
      servings: 4,
      mealTypes: ['dinner'],
      tags: ['Comfort'],
      ingredientLines: ['2 cups white beans', '1 onion'],
      steps: ['Simmer everything until tender.'],
    });
    expect(create.statusCode).toBe(200);
    const createdRecipe = dataOf(create) as { id: string; slug: string };
    expect(createdRecipe.id).toBeTruthy();

    // Get it back fully assembled and assert the round-trip.
    const got = await query('recipe.get', { idOrSlug: createdRecipe.id });
    expect(got.statusCode).toBe(200);
    const assembled = dataOf(got) as {
      title: string;
      mealTypes: string[];
      tags: string[];
      ingredients: { rawText: string; foodName: string | null }[];
      steps: { text: string }[];
    };
    expect(assembled.title).toBe('White Bean Soup');
    expect(assembled.mealTypes).toEqual(['dinner']);
    expect(assembled.tags).toEqual(['Comfort']);
    expect(assembled.ingredients).toHaveLength(2);
    expect(assembled.ingredients[0]!.rawText).toBe('2 cups white beans');
    expect(assembled.ingredients[0]!.foodName).toBeTruthy();
    expect(assembled.steps.map((s) => s.text)).toEqual(['Simmer everything until tender.']);

    // List shows the new recipe as a card.
    const list = await query('recipe.list');
    expect(list.statusCode).toBe(200);
    const cards = dataOf(list) as { id: string; title: string; servings: number }[];
    const listedCard = cards.find((c) => c.id === createdRecipe.id);
    expect(listedCard).toBeDefined();
    expect(listedCard!.title).toBe('White Bean Soup');
    expect(listedCard!.servings).toBe(4);

    // Update replaces its state (title + children).
    const updated = await mutate('recipe.update', {
      id: createdRecipe.id,
      title: 'Tuscan White Bean Soup',
      ingredientLines: ['3 cups white beans'],
      steps: ['Simmer longer.'],
    });
    expect(updated.statusCode).toBe(200);
    const afterUpdate = await query('recipe.get', { idOrSlug: createdRecipe.id });
    const reassembled = dataOf(afterUpdate) as {
      title: string;
      slug: string;
      ingredients: unknown[];
    };
    expect(reassembled.title).toBe('Tuscan White Bean Soup');
    expect(reassembled.slug).toBe(createdRecipe.slug); // slug stays stable
    expect(reassembled.ingredients).toHaveLength(1);

    // Delete removes it.
    const del = await mutate('recipe.delete', { id: createdRecipe.id });
    expect(del.statusCode).toBe(200);
    expect(dataOf(del)).toBe(true);
    const afterDelete = await query('recipe.get', { idOrSlug: createdRecipe.id });
    expect(dataOf(afterDelete)).toBeNull();
  });
});

describe('trpc shoppingList', () => {
  // A signed-in user with an active household, shared across the round-trip.
  let cookie: string;

  beforeAll(async () => {
    await resetDb();
    ({ cookie } = await signUpWithHousehold(app, 'c@test.dev'));
  });

  const mutate = (path: string, input: unknown) =>
    app.inject({
      method: 'POST',
      url: `/trpc/${path}`,
      payload: input as object,
      headers: { 'content-type': 'application/json', cookie },
    });
  const query = (path: string, input?: unknown) =>
    app.inject({
      method: 'GET',
      url:
        input === undefined
          ? `/trpc/${path}`
          : `/trpc/${path}?input=${encodeURIComponent(JSON.stringify(input))}`,
      headers: { cookie },
    });
  const dataOf = (res: { json: () => unknown }) =>
    (res.json() as { result: { data: unknown } }).result.data;

  type Item = { id: string; name: string; checked: boolean; source: string };
  const itemsOf = (res: { json: () => unknown }) => (dataOf(res) as { items: Item[] }).items;

  it('rejects shoppingList.get without a session', async () => {
    const res = await app.inject({ method: 'GET', url: '/trpc/shoppingList.get' });
    expect(res.statusCode).toBe(401);
  });

  it('returns NOT_FOUND (404) when adding a nonexistent recipe', async () => {
    const res = await mutate('shoppingList.addRecipe', {
      recipeId: '00000000-0000-0000-0000-000000000000',
      servings: 2,
    });
    expect(res.statusCode).toBe(404);
    const body = res.json() as { error: { data: { code: string } } };
    expect(body.error.data.code).toBe('NOT_FOUND');
  });

  it('adds a recipe and a manual item, checks and clears them', async () => {
    // A recipe whose ingredients will land on the list.
    const create = await mutate('recipe.create', {
      title: 'Garlic Bread',
      servings: 2,
      ingredientLines: ['1 loaf bread', '3 cloves garlic'],
    });
    expect(create.statusCode).toBe(200);
    const recipeId = (dataOf(create) as { id: string }).id;
    expect(recipeId).toBeTruthy();

    // Add the recipe to the active list, scaled to 4 servings.
    const added = await mutate('shoppingList.addRecipe', { recipeId, servings: 4 });
    expect(added.statusCode).toBe(200);

    // The list now carries the recipe's items.
    const afterRecipe = await query('shoppingList.get');
    expect(afterRecipe.statusCode).toBe(200);
    const recipeItems = itemsOf(afterRecipe);
    expect(recipeItems.length).toBeGreaterThanOrEqual(2);
    expect(recipeItems.every((i) => i.source === 'recipe')).toBe(true);
    const breadItem = recipeItems.find((i) => i.name.toLowerCase().includes('bread'));
    expect(breadItem).toBeTruthy();

    // Add a hand-typed manual item.
    const manual = await mutate('shoppingList.addItem', { text: 'paper towels' });
    expect(manual.statusCode).toBe(200);
    const manualItem = dataOf(manual) as Item;
    expect(manualItem.source).toBe('manual');

    const afterManual = itemsOf(await query('shoppingList.get'));
    expect(afterManual.some((i) => i.id === manualItem.id)).toBe(true);

    // Check the manual item, then confirm `get` reports it checked.
    const toggled = await mutate('shoppingList.toggleChecked', {
      itemId: manualItem.id,
      checked: true,
    });
    expect(toggled.statusCode).toBe(200);
    const afterToggle = itemsOf(await query('shoppingList.get'));
    expect(afterToggle.find((i) => i.id === manualItem.id)?.checked).toBe(true);

    // Clearing checked items removes it from the list.
    const cleared = await mutate('shoppingList.clearChecked', {});
    expect(cleared.statusCode).toBe(200);
    expect(dataOf(cleared)).toBe(1);
    const afterClear = itemsOf(await query('shoppingList.get'));
    expect(afterClear.some((i) => i.id === manualItem.id)).toBe(false);
  });
});

describe('request id and request logging', () => {
  const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

  const incomingRequest = (lines: Record<string, unknown>[]) =>
    lines.find((l) => l.msg === 'incoming request');

  it('echoes a generated request id on the response', async () => {
    const res = await app.inject({ method: 'GET', url: '/health' });
    expect(res.statusCode).toBe(200);
    expect(res.headers['x-request-id']).toMatch(UUID);
  });

  it('logs the request and the response under one request id', async () => {
    const { server, lines } = await buildServerWithCapturedLogs();
    const res = await server.inject({
      method: 'GET',
      url: '/health',
      headers: { cookie: 'better-auth.session_token=SESSIONSECRET' },
    });
    await server.close();

    const parsed = lines();
    const reqId = res.headers['x-request-id'];
    expect(reqId).toBeTruthy();
    expect(incomingRequest(parsed)?.reqId).toBe(reqId);
    expect(parsed.find((l) => l.msg === 'request completed')?.reqId).toBe(reqId);
    // The req serializer emits no `headers` key at all, so a cookie cannot reach the log by
    // this route. That is a stronger claim than redaction, whose coverage lives in log.test.ts.
    expect(Object.keys(incomingRequest(parsed)?.req as object)).not.toContain('headers');
    expect(JSON.stringify(parsed)).not.toContain('SESSIONSECRET');
  });

  // D38, and the reason it bites here: httpBatchLink sends tRPC queries as GET with the
  // procedure input in `?input=`, and a recipe slug is slugify(title). Logging the raw url
  // therefore logs recipe titles on the hot path, at info level.
  it('logs the path only, never the query string that carries recipe titles', async () => {
    const { server, lines } = await buildServerWithCapturedLogs();
    const input = encodeURIComponent(
      JSON.stringify({ 0: { json: { idOrSlug: 'grandmas-secret-chili' } } }),
    );
    await server.inject({ method: 'GET', url: `/trpc/recipe.get?batch=1&input=${input}` });
    await server.close();

    const parsed = lines();
    const logged = incomingRequest(parsed)?.req as { url?: string } | undefined;
    expect(logged?.url).toBe('/trpc/recipe.get');
    expect(JSON.stringify(parsed)).not.toContain('grandmas-secret-chili');
  });

  // An inbound `x-request-id` is attacker-controlled. A newline forges whole log lines, and
  // an unbounded value bloats every line the request writes, so anything that is not a short,
  // safe token is dropped in favour of a generated id.
  it.each([
    ['a newline', 'good\nfake log line'],
    ['a space', 'two words'],
    ['a quote', 'id","msg":"forged'],
    ['65 characters, one over the bound', 'a'.repeat(65)],
    ['over-long input', 'a'.repeat(200)],
    ['an empty value', ''],
  ])('generates its own request id when the client sends %s', async (_name, sent) => {
    const res = await app.inject({
      method: 'GET',
      url: '/health',
      headers: { 'x-request-id': sent },
    });
    expect(res.statusCode).toBe(200);
    expect(res.headers['x-request-id']).toMatch(UUID);
  });

  it.each([
    ['the shape of nginx $request_id', '3f2c1a9b8d7e6f5a4b3c2d1e0f9a8b7c'],
    ['64 characters, exactly the bound', 'a'.repeat(64)],
  ])(
    'keeps a well-formed client request id (%s) so the access log correlates',
    async (_n, sent) => {
      const res = await app.inject({
        method: 'GET',
        url: '/health',
        headers: { 'x-request-id': sent },
      });
      expect(res.headers['x-request-id']).toBe(sent);
    },
  );

  /**
   * The shipped chain, exactly as D39 describes it: client -> nginx -> Caddy -> Fastify.
   *
   * The client forges `9.9.9.9`; nginx appends the address it actually saw (203.0.113.7); Caddy,
   * having been told to trust nginx, appends nginx (10.0.0.2); Fastify's socket peer is Caddy.
   * With two trusted hops the resolved address is the first entry neither proxy vouched for,
   * which is the real client. Task 15 and Task 16 both key rate limits on this value, so a
   * client that could choose it could give itself a fresh bucket per request.
   */
  const CADDY = '172.18.0.1';
  const FORGED_CHAIN = '9.9.9.9, 203.0.113.7, 10.0.0.2';

  it('resolves the client IP across the two-hop chain, ignoring a forged entry', async () => {
    const { server, lines } = await buildServerWithCapturedLogs();
    await server.inject({
      method: 'GET',
      url: '/health',
      remoteAddress: CADDY,
      headers: { 'x-forwarded-for': FORGED_CHAIN },
    });
    await server.close();

    const logged = incomingRequest(lines())?.req as { remoteAddress?: string } | undefined;
    expect(logged?.remoteAddress).toBe('203.0.113.7');
  });

  // The hop count has to match the chain in both directions, which is why it is configuration
  // and not a constant. One hop too few stops at the inner proxy, and every user in the house
  // then shares one rate-limit bucket.
  it('attributes the request to the inner proxy when TRUST_PROXY is one too low', async () => {
    const { server, lines } = await buildServerWithCapturedLogs({ trustProxy: 1 });
    await server.inject({
      method: 'GET',
      url: '/health',
      remoteAddress: CADDY,
      headers: { 'x-forwarded-for': FORGED_CHAIN },
    });
    await server.close();

    const logged = incomingRequest(lines())?.req as { remoteAddress?: string } | undefined;
    expect(logged?.remoteAddress).toBe('10.0.0.2');
  });

  // ...and one hop too many reaches the entry the client wrote, which is the failure that
  // matters, so TRUST_PROXY is documented as "the number of proxies actually in front of you".
  it('reaches the forged entry when TRUST_PROXY is one too high', async () => {
    const { server, lines } = await buildServerWithCapturedLogs({ trustProxy: 3 });
    await server.inject({
      method: 'GET',
      url: '/health',
      remoteAddress: CADDY,
      headers: { 'x-forwarded-for': FORGED_CHAIN },
    });
    await server.close();

    const logged = incomingRequest(lines())?.req as { remoteAddress?: string } | undefined;
    expect(logged?.remoteAddress).toBe('9.9.9.9');
  });

  // The list form (D46): trust one named proxy, such as the firewall's HAProxy, rather than
  // whoever connects. A peer on the list vouches for the client; any other peer does not.
  it('trusts X-Forwarded-For only from a proxy named in the list', async () => {
    const { server, lines } = await buildServerWithCapturedLogs({ trustProxy: ['192.168.1.1'] });
    await server.inject({
      method: 'GET',
      url: '/health',
      remoteAddress: '192.168.1.1',
      headers: { 'x-forwarded-for': '9.9.9.9, 198.51.100.7' },
    });
    await server.inject({
      method: 'GET',
      url: '/health',
      remoteAddress: '192.168.1.50',
      headers: { 'x-forwarded-for': '9.9.9.9' },
    });
    await server.close();

    const seen = lines()
      .filter((l) => l['msg'] === 'incoming request')
      .map((l) => (l['req'] as { remoteAddress?: string }).remoteAddress);
    expect(seen).toEqual(['198.51.100.7', '192.168.1.50']);
  });

  // TRUST_PROXY=0 is the directly-exposed instance: there is no proxy to vouch for anything,
  // so X-Forwarded-For is client-written in full and must be ignored outright.
  it('ignores X-Forwarded-For entirely when TRUST_PROXY is 0', async () => {
    const { server, lines } = await buildServerWithCapturedLogs({ trustProxy: 0 });
    await server.inject({
      method: 'GET',
      url: '/health',
      remoteAddress: '203.0.113.9',
      headers: { 'x-forwarded-for': '9.9.9.9' },
    });
    await server.close();

    const logged = incomingRequest(lines())?.req as { remoteAddress?: string } | undefined;
    expect(logged?.remoteAddress).toBe('203.0.113.9');
  });
});

/**
 * Better Auth resolves a client IP by taking `headers[ipAddressHeaders[0]].split(',')[0]` - the
 * LEFTMOST X-Forwarded-For entry, verbatim, with no notion of a trusted proxy or a hop count
 * (`better-auth/dist/utils/get-request-ip.mjs`). Pointed at `x-forwarded-for` it would therefore
 * read the one entry the client writes, and Task 15's auth rate limiting would be defeated by
 * rotating a header. So it is handed `x-hearth-client-ip`, which the route sets from `req.ip`
 * after copying the inbound headers, i.e. from the value Fastify resolved under TRUST_PROXY.
 *
 * Both tests use non-loopback addresses on purpose. `getIp` falls back to 127.0.0.1 under
 * NODE_ENV=test, so an assertion against a loopback address would pass with the whole mechanism
 * removed - a trap worth remembering when Task 15 tests per-IP limits.
 */
describe('auth client ip attribution', () => {
  const CADDY = '172.18.0.1';

  // Per test, not once: sign-up is invite-only (D36) and the only uninvited account an instance
  // will ever accept is its first, so each of these has to start from an empty instance. With a
  // single `beforeAll` the second sign-up here is a stranger and gets a 403.
  beforeEach(async () => {
    await resetDb();
  });

  /**
   * Sign in rather than sign up, because a session row is what records the address and sign-up
   * no longer creates one: `requireEmailVerification` makes Better Auth skip the auto sign-in.
   * The account is created and verified first so the interesting request is the one under test.
   */
  const signInFrom = async (email: string, from: string, headers: Record<string, string>) => {
    const signup = await app.inject({
      method: 'POST',
      url: '/api/auth/sign-up/email',
      payload: { email, password: 'password1234', name: 'Ip' },
      headers: { 'content-type': 'application/json', ...bootstrapHeaders() },
    });
    expect(signup.statusCode).toBeLessThan(400);
    await verifyEmail(email);
    return app.inject({
      method: 'POST',
      url: '/api/auth/sign-in/email',
      payload: { email, password: 'password1234' },
      headers: { 'content-type': 'application/json', ...headers },
      remoteAddress: from,
    });
  };

  it('records the address the proxy chain vouched for, not the forged X-Forwarded-For entry', async () => {
    const email = 'xff@test.dev';
    const res = await signInFrom(email, CADDY, {
      'x-forwarded-for': '9.9.9.9, 203.0.113.7, 10.0.0.2',
    });
    expect(res.statusCode).toBeLessThan(400);
    expect(await sessionIpFor(email)).toBe('203.0.113.7');
  });

  it('ignores an x-hearth-client-ip the client supplied itself', async () => {
    const email = 'forged@test.dev';
    const res = await signInFrom(email, '198.51.100.4', { 'x-hearth-client-ip': '9.9.9.9' });
    expect(res.statusCode).toBeLessThan(400);
    expect(await sessionIpFor(email)).toBe('198.51.100.4');
  });
});

/**
 * D38's last hole, and the one nothing in log.ts could close: Fastify's default error handler
 * logs `reply.log.error({ req, res, err }, error?.message)`, putting the raw message in `msg`,
 * which no pino serializer can reach because serializers apply to fields. tRPC errors never
 * reach it (the adapter answers them), so the exposed surface is `/api/auth/*` - precisely
 * where email addresses are, and precisely what Phase D is about to exercise.
 */
describe('error handler', () => {
  const ADDRESS = 'relative@example.com';
  const THROWN = `could not send invitation to ${ADDRESS}`;

  /**
   * A route that throws under the auth prefix.
   *
   * Deliberately synthetic, and the test is worthless without it: no Fastify error reachable
   * from a real request today quotes request content in its message, so asserting on one of
   * those would pass whether the handler exists or not. What Phase D adds - a mailer, an
   * invitation lookup - throws exactly this shape.
   */
  async function serverThatThrows(): Promise<{
    server: FastifyInstance;
    lines: () => Record<string, unknown>[];
  }> {
    const { server, lines } = await buildServerWithCapturedLogs();
    server.get('/api/auth/explode', async () => {
      throw new Error(THROWN);
    });
    return { server, lines };
  }

  it('keeps the error message out of the log entirely, `msg` included', async () => {
    const { server, lines } = await serverThatThrows();
    const res = await server.inject({ method: 'GET', url: '/api/auth/explode' });
    await server.close();

    expect(res.statusCode).toBe(500);
    const parsed = lines();
    expect(JSON.stringify(parsed)).not.toContain(ADDRESS);
    // Named explicitly as well: `msg` is the field that leaked, and a whole-output assertion
    // would still pass if the message moved there from somewhere else.
    expect(parsed.map((l) => l.msg)).not.toContain(THROWN);
  });

  // The fix must not be "log less": a 500 with no line at all is worse than a leaky one.
  it('still logs where the failure happened', async () => {
    const { server, lines } = await serverThatThrows();
    const res = await server.inject({ method: 'GET', url: '/api/auth/explode' });
    await server.close();

    const failure = lines().find((l) => l.msg === 'request failed');
    expect(failure).toBeDefined();
    expect(failure!.status).toBe(500);
    expect(failure!.reqId).toBe(res.headers['x-request-id']);
    const err = failure!.err as { type: string; frames?: string[] };
    expect(err.type).toBe('Error');
    // The stack survives with its header (`Error: <message>`) removed, so the line still says
    // which code threw. That is the whole D40 bargain.
    expect(err.frames?.length).toBeGreaterThan(0);
  });

  // Only the log is the problem. The caller still needs the real message, and Fastify's error
  // body shape is what the web client already handles.
  it('leaves the response body unchanged', async () => {
    const { server } = await serverThatThrows();
    const res = await server.inject({ method: 'GET', url: '/api/auth/explode' });
    await server.close();

    expect(res.json()).toEqual({
      statusCode: 500,
      error: 'Internal Server Error',
      message: THROWN,
    });
  });

  /**
   * The line names the ROUTE, never `req.url`. They differ exactly where it matters: a tRPC GET
   * carries its input in `?input=`, and a recipe slug is slugify(title), so logging the url
   * would put recipe titles in the log of every failed request. The rationale for that one word
   * is what this pins.
   */
  it('logs the route pattern, not the url that carries the query string', async () => {
    const { server, lines } = await buildServerWithCapturedLogs();
    server.get('/api/auth/explode/:id', async () => {
      throw new Error(THROWN);
    });
    await server.inject({
      method: 'GET',
      url: '/api/auth/explode/42?input=grandmas-secret-chili',
    });
    await server.close();

    const failure = lines().find((l) => l.msg === 'request failed')!;
    expect(failure.route).toBe('/api/auth/explode/:id');
    expect(JSON.stringify(lines())).not.toContain('grandmas-secret-chili');
  });

  // A 4xx is not a bug in the server, so it keeps Fastify's quieter level - but it goes through
  // the same handler, so it is subject to the same rule about messages.
  it('reports a client error at info, with its status', async () => {
    const { server, lines } = await buildServerWithCapturedLogs();
    server.get('/api/auth/bad-request', async () => {
      throw Object.assign(new Error(THROWN), { statusCode: 400 });
    });
    const res = await server.inject({ method: 'GET', url: '/api/auth/bad-request' });
    await server.close();

    expect(res.statusCode).toBe(400);
    const failure = lines().find((l) => l.msg === 'request failed')!;
    expect(failure.level).toBe(30);
    expect(failure.status).toBe(400);
    expect(JSON.stringify(lines())).not.toContain(ADDRESS);
  });
});

/**
 * Without these a `docker restart` drops in-flight requests and leaks Postgres connections,
 * and a failure after startup exits with no line explaining it at all.
 *
 * The handlers are installed on an injected emitter rather than on `process` so the test can
 * fire the signal for real. Emitting SIGTERM on the actual process would run vitest's own
 * listeners and take the run down with it.
 */
describe('process lifecycle', () => {
  async function installedOn(proc: EventEmitter): Promise<{
    closed: () => boolean;
    exited: Promise<number>;
    lines: () => Record<string, unknown>[];
  }> {
    const { server, lines } = await buildServerWithCapturedLogs();
    let closed = false;
    server.addHook('onClose', async () => {
      closed = true;
    });
    let resolveExit: (code: number) => void;
    const exited = new Promise<number>((resolve) => {
      resolveExit = resolve;
    });
    installProcessHandlers({
      app: server,
      log: server.log,
      proc: {
        on: (event, listener) => void proc.on(event, listener),
        exit: (code) => resolveExit(code),
      },
    });
    return { closed: () => closed, exited, lines };
  }

  it.each(['SIGTERM', 'SIGINT'])('closes the server on %s and exits 0', async (signal) => {
    const proc = new EventEmitter();
    const { closed, exited, lines } = await installedOn(proc);

    proc.emit(signal);

    expect(await exited).toBe(0);
    expect(closed()).toBe(true);
    expect(lines().some((l) => l.msg === 'shutting down')).toBe(true);
  });

  it.each([
    ['unhandledRejection', 'unhandled rejection'],
    ['uncaughtException', 'uncaught exception'],
  ])('logs %s as fatal and exits 1', async (event, msg) => {
    const proc = new EventEmitter();
    const { exited, lines } = await installedOn(proc);

    proc.emit(event, new Error('relative@example.com'));

    expect(await exited).toBe(1);
    const fatal = lines().find((l) => l.msg === msg);
    expect(fatal).toBeDefined();
    expect(fatal!.level).toBe(60);
    expect((fatal!.err as { type: string }).type).toBe('Error');
    // Same rule as everywhere else: the reason is reduced, never quoted.
    expect(JSON.stringify(lines())).not.toContain('relative@example.com');
  });
});

/**
 * The error handler rebuilds the response instead of delegating (see server.ts), which means
 * every detail of Fastify's own error shape is now OUR responsibility. Asserting that against a
 * hand-written expectation would only pin what the author believed; this runs each case through
 * a bare Fastify instance in the same process and compares. When Fastify next majors and its
 * shape moves, these fail rather than drifting.
 */
describe('error handler equivalence with Fastify', () => {
  type Case = { name: string; register: (app: FastifyInstance) => void; url: string };

  const throwing =
    (url: string, make: () => unknown): Case['register'] =>
    /* eslint-disable-next-line @typescript-eslint/no-misused-promises */
    (app: FastifyInstance) => {
      app.get(url, async () => {
        throw make();
      });
    };

  const CASES: Case[] = [
    {
      name: 'a plain Error',
      url: '/e/plain',
      register: throwing('/e/plain', () => new Error('boom')),
    },
    {
      name: 'an error carrying statusCode',
      url: '/e/status-code',
      register: throwing('/e/status-code', () =>
        Object.assign(new Error('bad input'), { statusCode: 400 }),
      ),
    },
    {
      name: 'an error carrying status only',
      url: '/e/status',
      register: throwing('/e/status', () => Object.assign(new Error('teapot'), { status: 418 })),
    },
    {
      // The case that caught a real bug: `setErrorHeaders` prefers `status`, but
      // `setErrorStatusCode` runs after it and reads `err.statusCode || err.status`, so
      // Fastify's effective precedence is the opposite of the one the comment used to claim.
      name: 'an error carrying BOTH status and statusCode',
      url: '/e/both',
      register: throwing('/e/both', () =>
        Object.assign(new Error('conflict'), { status: 418, statusCode: 409 }),
      ),
    },
    {
      name: 'an error whose statusCode is not an error status',
      url: '/e/status-200',
      register: throwing('/e/status-200', () =>
        Object.assign(new Error('nonsense'), { statusCode: 200 }),
      ),
    },
    {
      name: 'an error carrying a string code',
      url: '/e/code',
      register: throwing('/e/code', () =>
        Object.assign(new Error('unprocessable'), { statusCode: 422, code: 'HEARTH_NOPE' }),
      ),
    },
    {
      name: 'an error carrying response headers',
      url: '/e/headers',
      register: throwing('/e/headers', () =>
        Object.assign(new Error('unauthorized'), {
          statusCode: 401,
          headers: { 'www-authenticate': 'Bearer realm="hearth"' },
        }),
      ),
    },
    {
      // Synthetic, and worth saying so: @fastify/rate-limit does not produce this shape. It
      // sets `retry-after` on the reply and throws an error with no headers (see the global
      // rate limit tests, which pin the real one). This covers the other half - an error that
      // carries headers of its own, which Fastify's handler forwards and so does ours.
      name: 'a 429 carrying retry-after on the error, which is not how the plugin sends it',
      url: '/e/retry',
      register: throwing('/e/retry', () =>
        Object.assign(new Error('too many requests'), {
          statusCode: 429,
          headers: { 'retry-after': '60' },
        }),
      ),
    },
    {
      name: 'an error with no message at all',
      url: '/e/empty',
      register: throwing('/e/empty', () => new Error()),
    },
    {
      name: 'a route that set a status before throwing',
      url: '/e/preset',
      register: (app) => {
        app.get('/e/preset', async (_req, reply) => {
          reply.code(503);
          throw new Error('unavailable');
        });
      },
    },
    {
      name: 'a route that set a non-error status before throwing',
      url: '/e/preset-201',
      register: (app) => {
        app.get('/e/preset-201', async (_req, reply) => {
          reply.code(201);
          throw new Error('created, then not');
        });
      },
    },
    {
      name: 'a route missing entirely (the 404 handler, not the error handler)',
      url: '/e/absent',
      register: () => {},
    },
  ];

  it.each(CASES.map((c) => [c.name, c] as const))(
    'answers %s exactly as Fastify does',
    async (_name, testCase) => {
      const bare = Fastify({ logger: false });
      testCase.register(bare);
      await bare.ready();
      const { server } = await buildServerWithCapturedLogs();
      testCase.register(server);

      const expected = await bare.inject({ method: 'GET', url: testCase.url });
      const actual = await server.inject({ method: 'GET', url: testCase.url });
      await bare.close();
      await server.close();

      // The raw body, not the parsed one: field order is part of the shape a client sees.
      expect({
        status: actual.statusCode,
        body: actual.body,
        contentType: actual.headers['content-type'],
        wwwAuthenticate: actual.headers['www-authenticate'],
        retryAfter: actual.headers['retry-after'],
      }).toEqual({
        status: expected.statusCode,
        body: expected.body,
        contentType: expected.headers['content-type'],
        wwwAuthenticate: expected.headers['www-authenticate'],
        retryAfter: expected.headers['retry-after'],
      });
    },
  );

  /**
   * Two deliberate divergences, stated rather than claimed away.
   *
   * A thrown non-object has no safe rendering: Fastify answers 500 text/plain with the thrown
   * VALUE as the body, which echoes attacker-controlled text straight back. This answers the
   * same status with the ordinary JSON error shape and no echo. A non-string `code` is coerced
   * by Fastify's serializer and left as-is here, which is a JSON type difference in a field
   * nothing in this app sets to a number.
   */
  it.each([
    ['a bare string', '/e/string', () => 'a bare string', 'a bare string'],
    [
      'a plain object',
      '/e/object',
      () => ({ statusCode: 400, secretField: 'internal detail' }),
      'internal detail',
    ],
  ])('answers %s with the JSON error shape rather than echoing it', async (_n, url, make, echo) => {
    const { server } = await buildServerWithCapturedLogs();
    server.get(url, async () => {
      throw make();
    });
    const res = await server.inject({ method: 'GET', url });
    await server.close();

    expect(res.headers['content-type']).toContain('application/json');
    // Fastify would have put the thrown value in the body verbatim: the string as text/plain,
    // the object serialized field for field. Neither is something to hand back to a caller.
    expect(res.body).not.toContain(echo);
  });

  it('keeps a thrown string at the status Fastify would have used', async () => {
    const { server } = await buildServerWithCapturedLogs();
    server.get('/e/string', async () => {
      throw 'a bare string';
    });
    const res = await server.inject({ method: 'GET', url: '/e/string' });
    await server.close();

    expect(res.statusCode).toBe(500);
    expect(res.headers['content-type']).toContain('application/json');
    expect(res.body).not.toContain('a bare string');
  });
});

/**
 * D38's remaining hole after the error handler: Fastify's 404 handler logs
 * `Route ${method}:${url} not found` as a bare string message (lib/four-oh-four.js), raw url and
 * query string included, which neither a serializer nor requireMessage can reach. Only unrouted
 * paths get there - `/trpc/*` and `/api/auth/*` are wildcards - but it is unbounded
 * client-controlled text at info level, which is the thing this phase is about.
 */
describe('not-found handler', () => {
  const SLUG = 'grandmas-secret-chili';

  it('keeps the requested url out of the log', async () => {
    const { server, lines } = await buildServerWithCapturedLogs();
    const res = await server.inject({
      method: 'GET',
      url: `/nope?input=${encodeURIComponent(JSON.stringify({ idOrSlug: SLUG }))}`,
    });
    await server.close();

    expect(res.statusCode).toBe(404);
    expect(JSON.stringify(lines())).not.toContain(SLUG);
    // The path still reaches the log, once, through the serializer that strips the query
    // string - so a 404 is still diagnosable under the request id.
    const notFound = lines().find((l) => l.msg === 'route not found');
    expect(notFound).toBeDefined();
    expect(notFound!.reqId).toBe(res.headers['x-request-id']);
    const incoming = lines().find((l) => l.msg === 'incoming request');
    expect((incoming!.req as { url: string }).url).toBe('/nope');
  });

  it('answers with the body Fastify would have sent', async () => {
    const bare = Fastify({ logger: false });
    await bare.ready();
    const { server } = await buildServerWithCapturedLogs();

    const expected = await bare.inject({ method: 'GET', url: '/nope?a=1' });
    const actual = await server.inject({ method: 'GET', url: '/nope?a=1' });
    await bare.close();
    await server.close();

    expect(actual.statusCode).toBe(expected.statusCode);
    expect(actual.body).toBe(expected.body);
  });
});

/**
 * The coarse cap over everything the Better Auth limiter does not cover (Task 16). Two limiters
 * with two jobs: that one bounds guessing at a password, this one bounds what a single client
 * can make this box do at all.
 *
 * Its own server, because the store lives in the plugin registration: these tests deliberately
 * spend whole minutes of budget, and doing that on the shared `app` would take the rest of the
 * file's requests with them.
 */
describe('global rate limit', () => {
  /**
   * Written out rather than imported from server.ts, for the same reason the auth limits are:
   * a test that reads the configured number agrees with it by construction, and raising the
   * limit to 10000 would leave it passing.
   */
  const GLOBAL_MAX = 300;

  let limited: FastifyInstance;

  beforeAll(async () => {
    limited = await buildServer();
    // Registered before anything injects, which is the last moment Fastify accepts a route.
    limited.get('/counted', async () => ({ ok: true }));
  });

  afterAll(async () => {
    await limited.close();
  });

  const get = (url: string, from: string) =>
    limited.inject({ method: 'GET', url, remoteAddress: from });

  /** Every distinct status a client saw over `count` requests, so a stray one cannot hide. */
  const statusesOf = async (count: number, send: () => Promise<{ statusCode: number }>) => {
    const seen = new Set<number>();
    for (let n = 0; n < count; n += 1) seen.add((await send()).statusCode);
    return [...seen];
  };

  it('never throttles /health, so a container health check cannot be starved', async () => {
    const client = '203.0.113.30';
    // Well past the limit, not just up to it: the point is that this route has no budget to
    // spend, and a test that stopped at the limit could not tell that from a generous one.
    expect(await statusesOf(GLOBAL_MAX + 50, () => get('/health', client))).toEqual([200]);
  });

  it('caps a path with no route, which reaches no per-route hook to be capped by', async () => {
    const client = '203.0.113.31';
    expect(await statusesOf(GLOBAL_MAX, () => get('/nope', client))).toEqual([404]);

    const refused = await get('/nope', client);
    expect(refused.statusCode).toBe(429);
  });

  it('spends one budget across routes, and tells a refused client how long to wait', async () => {
    const client = '203.0.113.32';
    expect(await statusesOf(GLOBAL_MAX, () => get('/nope', client))).toEqual([404]);

    // A different route, and the budget is already gone: the cap is per client, not per route.
    const refused = await limited.inject({
      method: 'GET',
      url: '/trpc/recipes.list',
      remoteAddress: client,
    });
    expect(refused.statusCode).toBe(429);
    // The header the Phase B error handler was written to preserve. It has to survive to the
    // client or a caller has nothing to back off by.
    expect(Number(refused.headers['retry-after'])).toBeGreaterThan(0);
    expect(Number(refused.headers['retry-after'])).toBeLessThanOrEqual(60);
  });

  /**
   * The hole this test exists for, and the one the 404 test above does not cover.
   *
   * @fastify/cors answers a preflight from an INSTANCE-level `onRequest` hook - its source says
   * so, in as many words, so that it can reply before authentication plugins - while
   * @fastify/rate-limit attaches per ROUTE, through `onRoute`. Fastify runs instance hooks
   * first, so cors replied 204 and the cap never ran, at any registration order. Measured
   * against a real server before the fix: 5000 preflights on one keep-alive connection in 1.02s,
   * zero 429s, and 2.2MB of log, on a path `apps/web/Caddyfile` proxies by any method.
   */
  it('caps a CORS preflight, which cors answers from an instance hook ahead of every route', async () => {
    const client = '203.0.113.36';
    const preflight = () =>
      limited.inject({
        method: 'OPTIONS',
        url: '/api/auth/sign-in/email',
        remoteAddress: client,
        headers: {
          origin: publicConfig.webOrigin,
          'access-control-request-method': 'POST',
        },
      });

    expect(await statusesOf(GLOBAL_MAX, preflight)).toEqual([204]);
    expect((await preflight()).statusCode).toBe(429);
  });

  /**
   * The other half of the preflight fix: an ordinary routed request must still spend exactly
   * one unit. Two hooks that both counted would halve every budget on the box, and the symptom
   * would be a household throttled at 150 requests a minute for no visible reason.
   *
   * A route of its own rather than the 404 path above, so this measures the per-route hook
   * rather than the not-found one, and not an `/api/auth/*` path, which Better Auth's own
   * 100-per-60s ceiling would refuse long before 300.
   */
  it('counts an ordinary routed request exactly once, not once per hook', async () => {
    const client = '203.0.113.37';
    const counted = () => limited.inject({ method: 'GET', url: '/counted', remoteAddress: client });

    expect(await statusesOf(GLOBAL_MAX, counted)).toEqual([200]);
    expect((await counted()).statusCode).toBe(429);
  });

  /**
   * A refusal costs the log one warn line and one info line, and neither carries a stack.
   *
   * The stack is what made a flood expensive: `serializeError` renders `err.stack`, and the
   * plugin's default error is thrown from inside node_modules, so every refused request wrote
   * the same three frames. The body is asserted byte for byte because the error handler builds
   * it from `err.message`, so replacing the plugin's error is a change a client could see.
   */
  it('refuses without writing a stack trace, and answers exactly what the plugin would', async () => {
    const client = '203.0.113.38';
    const { server, lines } = await buildServerWithCapturedLogs();
    for (let n = 0; n < GLOBAL_MAX; n += 1) {
      await server.inject({ method: 'GET', url: '/nope', remoteAddress: client });
    }
    const refused = await server.inject({ method: 'GET', url: '/nope', remoteAddress: client });
    await server.close();

    expect(refused.body).toBe(
      '{"statusCode":429,"error":"Too Many Requests","message":"Rate limit exceeded, retry in 1 minute"}',
    );
    const failure = lines().find((l) => l.msg === 'request failed')!;
    expect(failure.status).toBe(429);
    expect((failure.err as { frames?: string[] }).frames).toBeUndefined();
  });

  it('keys on the client address, so one hammering client cannot lock the household out', async () => {
    const hammering = '203.0.113.33';
    const bystander = '203.0.113.34';
    expect(await statusesOf(GLOBAL_MAX, () => get('/nope', hammering))).toEqual([404]);
    expect((await get('/nope', hammering)).statusCode).toBe(429);

    expect((await get('/nope', bystander)).statusCode).toBe(404);
  });

  /**
   * A refusal has to be visible at the level an operator watches. `warn` rather than `info`
   * because a 429 is never a single mistake - it takes 301 requests in a minute, or eleven
   * sign-ins in a quarter hour - and because the two lines Fastify already writes for the same
   * request are at `info`, where a self-hoster running LOG_LEVEL=warn would never see them.
   */
  it('logs a refusal at warn, naming the address, and nothing while under the limit', async () => {
    const client = '203.0.113.35';
    const { server, lines } = await buildServerWithCapturedLogs();
    for (let n = 0; n < GLOBAL_MAX; n += 1) {
      await server.inject({ method: 'GET', url: '/nope', remoteAddress: client });
    }
    const warnsWhileAllowed = lines().filter((l) => l.level === 40);

    await server.inject({ method: 'GET', url: '/nope', remoteAddress: client });
    await server.close();

    expect(warnsWhileAllowed).toEqual([]);
    const warned = lines().filter((l) => l.level === 40);
    expect(warned).toHaveLength(1);
    expect(warned[0]!.remoteAddress).toBe(client);
  });
});

describe('the body an import upload needs', () => {
  beforeEach(resetDb);

  /** A JSON body of roughly `bytes` bytes, shaped like a tRPC mutation input. */
  const body = (bytes: number) => JSON.stringify({ fileBase64: 'A'.repeat(bytes) });

  it("lets a body past Fastify's 1MiB default reach the tRPC route", async () => {
    // 2MiB is over the default and well under the import cap. Reaching UNAUTHORIZED means the
    // body was parsed and the procedure was entered; a 413 would mean it never got there, which
    // is what a photograph would hit if this were left at the default.
    const res = await app.inject({
      method: 'POST',
      url: '/trpc/import.fromImage',
      headers: { 'content-type': 'application/json' },
      payload: body(2 * 1024 * 1024),
    });
    expect(res.statusCode).not.toBe(413);
    expect(res.statusCode).toBe(401);
  });

  it('still refuses a body over the import cap', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/trpc/import.fromImage',
      headers: { 'content-type': 'application/json' },
      payload: body(MAX_IMPORT_BODY_BYTES + 1024),
    });
    expect(res.statusCode).toBe(413);
  });

  it('leaves the auth endpoints on the 1MiB default', async () => {
    // True, and NOT evidence that the hook is encapsulated: /api/auth/* is registered before the
    // tRPC scope, and `onRoute` only fires for routes added after the hook, so this passes on
    // declaration order alone. Making the hook global leaves it green. The case below is the
    // one that can tell the difference.
    const res = await app.inject({
      method: 'POST',
      url: '/api/auth/sign-in/email',
      headers: { 'content-type': 'application/json' },
      payload: body(2 * 1024 * 1024),
    });
    expect(res.statusCode).toBe(413);
  });

  it('does not raise the limit for a route registered after the tRPC scope', async () => {
    /*
      What the encapsulation actually buys, tested where declaration order cannot supply the
      answer: this route is added AFTER `buildServer` has registered the tRPC scope, so a hook
      that had leaked out of that scope would reach it. Move the `addHook` up onto the Fastify
      instance and this is the test that goes red.

      Its own server, because a route cannot be added to one that is already listening or that
      other tests are injecting into.
    */
    const scoped = await buildServer();
    scoped.post('/late-route-for-this-test', async () => ({ ok: true }));

    const oversized = await scoped.inject({
      method: 'POST',
      url: '/late-route-for-this-test',
      headers: { 'content-type': 'application/json' },
      payload: body(2 * 1024 * 1024),
    });
    expect(oversized.statusCode).toBe(413);

    // And it is a working route at a normal size, so the 413 above is about the body and not
    // about the route being missing.
    const small = await scoped.inject({
      method: 'POST',
      url: '/late-route-for-this-test',
      headers: { 'content-type': 'application/json' },
      payload: body(16),
    });
    expect(small.statusCode).toBe(200);
    await scoped.close();
  });
});

/**
 * The web app, served by this process since D46 folded the Caddy container into it. A build
 * directory written here stands in for `apps/web/dist`, so the suite does not need a Vite build.
 */
describe('serving the web app', () => {
  let dist: string;
  let server: FastifyInstance;

  beforeAll(async () => {
    dist = mkdtempSync(join(tmpdir(), 'hearth-dist-'));
    mkdirSync(join(dist, 'assets'));
    writeFileSync(join(dist, 'index.html'), '<!doctype html><title>Hearth</title>');
    writeFileSync(join(dist, 'assets', 'index-abc123.js'), 'console.log(1)');
    writeFileSync(join(dist, 'sw.js'), 'self.addEventListener("fetch", () => {})');
    server = await buildServer({ webDist: dist });
  });

  afterAll(async () => {
    await server.close();
    rmSync(dist, { recursive: true, force: true });
  });

  it('serves the app at the root and at a deep link, never cached', async () => {
    for (const url of ['/', '/plan', '/recipes/some-soup/cook?servings=4']) {
      const res = await server.inject({ method: 'GET', url });
      expect(res.statusCode, url).toBe(200);
      expect(res.body).toContain('<title>Hearth</title>');
      expect(res.headers['cache-control']).toBe('no-cache');
    }
  });

  it('caches hashed assets for a year, and the service worker not at all', async () => {
    const asset = await server.inject({ method: 'GET', url: '/assets/index-abc123.js' });
    expect(asset.statusCode).toBe(200);
    expect(asset.headers['cache-control']).toBe('public, max-age=31536000, immutable');
    const sw = await server.inject({ method: 'GET', url: '/sw.js' });
    expect(sw.statusCode).toBe(200);
    expect(sw.headers['cache-control']).toBe('no-cache');
  });

  it('keeps a miss under the API prefixes a JSON 404, not the app page', async () => {
    for (const url of ['/api/nope', '/trpc/nope.nope']) {
      const res = await server.inject({ method: 'GET', url });
      expect(res.statusCode, url).toBe(404);
      expect(res.headers['content-type']).toContain('application/json');
    }
    const post = await server.inject({ method: 'POST', url: '/plan' });
    expect(post.statusCode).toBe(404);
  });

  it('serves no app at all when there is no build', async () => {
    const bare = await buildServer({ webDist: null });
    const res = await bare.inject({ method: 'GET', url: '/plan' });
    await bare.close();
    expect(res.statusCode).toBe(404);
  });
});
