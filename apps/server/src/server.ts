import { backfillAltMeasures } from './repo/alt-measures';
import { randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { join, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { STATUS_CODES, type IncomingMessage } from 'node:http';
import Fastify, { type FastifyBaseLogger, type FastifyError, type FastifyInstance } from 'fastify';
import cors from '@fastify/cors';
import rateLimit from '@fastify/rate-limit';
import fastifyStatic from '@fastify/static';
import { fastifyTRPCPlugin } from '@trpc/server/adapters/fastify';
import {
  base64Length,
  MAX_IMAGE_IMPORT_BYTES,
  MAX_PDF_BYTES,
  MAX_TRPC_BATCH,
} from '@hearth/shared';
import { env } from './env';
import { logger } from './log';
// Imported for the singleton's construction, which is what writes the one startup line saying
// whether mail will actually leave this box (`warn` when it will not: see mail/mailer.ts).
// Nothing here uses the mailer yet - Phase D imports the binding itself when it wires
// invitations and verification - but without this import that line would not exist until then,
// and the promise it makes to a self-hoster would be false in the meantime. Constructing it
// opens no socket.
import './mail';
import { publicConfig } from './config';
import { auth, authHeaders } from './auth';
import { householdExists, SETUP_TOKEN_HEADER } from './auth-invite';
import { deleteSetupToken, ensureSetupToken, setupTokenPath } from './setup-token';
import { appRouter } from './trpc/routers';
import { createContext } from './trpc/context';
import { findRecipeFile } from './repo/recipe-files';
import { readFileVariant } from './files';

/**
 * The shape an inbound request id has to have to be reused: a short token of characters that
 * cannot break a log line. nginx's `$request_id` (32 hex chars) and a UUID both fit, which is
 * the point - reusing the proxy's id is what makes its access log line and ours the same
 * request. Anything else is replaced by a generated id.
 *
 * Unlike `X-Forwarded-*`, `X-Request-ID` is not rewritten by the Caddy hop, so it arrives as
 * whoever set it last sent it. That correlation therefore only means anything if nginx sets
 * `proxy_set_header X-Request-ID $request_id`; without it nginx forwards whatever the client
 * sent. The caveat below is what keeps that safe either way.
 */
const SAFE_REQUEST_ID = /^[A-Za-z0-9_-]{1,64}$/;

/**
 * An `x-request-id` off the network is attacker-controlled: a newline forges whole log lines,
 * and an unbounded value bloats every line the request writes. Hence the validation.
 *
 * Even a well-formed id stays untrusted data. A client can repeat one, or send an id that
 * collides with another request's, so request ids correlate logs and nothing more - never
 * authorize, rate-limit, or dedupe on them.
 */
function generateRequestId(req: IncomingMessage): string {
  const supplied = req.headers['x-request-id'];
  return typeof supplied === 'string' && SAFE_REQUEST_ID.test(supplied) ? supplied : randomUUID();
}

/**
 * The status Fastify itself would have answered with. Reimplemented rather than delegated to,
 * because the only way to reach Fastify's version is `reply.send(err)`, and that runs the
 * default handler this one replaces.
 *
 * It answers in two stages, and the second overrides the first, which is easy to get backwards:
 * `setErrorHeaders` prefers `err.status` over `err.statusCode`, and then `setErrorStatusCode`
 * (`lib/error-status.js`) runs AFTER it reading `err.statusCode || err.status` - the opposite
 * order. The second stage only applies when the route did not set a status of its own, a
 * condition Fastify checks with an internal symbol but which `reply.statusCode === 200` decides
 * exactly: the symbol is set by `reply.code()`, so any other value means the route called it.
 *
 * The equivalence test in server.test.ts pins all of this against a real Fastify instance
 * rather than against this description, because a comment is what got it wrong the first time.
 * The one deliberate narrowing: a `status` that is not a number is treated as absent, where
 * Fastify would compare it to 400 and pass a string to `reply.code()`. better-call's APIError,
 * which every Better Auth failure is, sets exactly that alongside a numeric `statusCode`.
 */
function errorStatus(err: FastifyError, replyStatus: number): number {
  const e = err as unknown as { status?: unknown; statusCode?: unknown };
  if (replyStatus === 200) {
    const chosen = e.statusCode ? e.statusCode : e.status;
    return typeof chosen === 'number' && chosen >= 400 ? chosen : 500;
  }
  for (const candidate of [e.status, e.statusCode, replyStatus]) {
    if (typeof candidate === 'number' && candidate >= 400) return candidate;
  }
  return 500;
}

/** Prefixes the server answers itself; a miss under one is a 404, never the app page. */
const API_PREFIXES = ['/api/', '/trpc/', '/health'];

function isAppPage(method: string, url: string): boolean {
  if (method !== 'GET' && method !== 'HEAD') return false;
  const path = url.split('?')[0] ?? '';
  return !API_PREFIXES.some(
    (prefix) => path === prefix.replace(/\/$/, '') || path.startsWith(prefix),
  );
}

/**
 * Where the built web app is: `WEB_DIST_DIR`, else in production `apps/web/dist` beside this
 * package when a build is there (the image), else `null`. Outside production Vite serves the
 * app, and a stray local build must not change what the server answers under test.
 */
export function resolveWebDist(): string | null {
  if (env.WEB_DIST_DIR) return env.WEB_DIST_DIR;
  if (env.NODE_ENV !== 'production') return null;
  const beside = fileURLToPath(new URL('../../web/dist', import.meta.url));
  return existsSync(join(beside, 'index.html')) ? beside : null;
}

/**
 * Serve the web app from this process (D46), which used to be a Caddy container of its own.
 *
 * Vite names every asset by its content hash, so `/assets/*` may be cached for a year. Nothing
 * else may: `index.html`, the service worker and the manifest are how a new release reaches a
 * phone, and a cached one pins the household to the old app until the cache expires.
 */
async function serveWebApp(app: FastifyInstance, root: string): Promise<void> {
  await app.register(fastifyStatic, {
    root,
    wildcard: true,
    index: 'index.html',
    // Off so the header below is the only one: the plugin's own writes `max-age=0` over it.
    cacheControl: false,
    setHeaders(res, path) {
      res.setHeader(
        'cache-control',
        path.includes(`${sep}assets${sep}`) ? 'public, max-age=31536000, immutable' : 'no-cache',
      );
    },
  });
}

/**
 * The same D38 problem as the error handler, in Fastify's 404 path: `basic404`
 * (`lib/four-oh-four.js`) logs ``Route ${method}:${url} not found`` as a bare string message,
 * raw query string included, which no serializer and no requireMessage can reach because it is
 * the message itself. Only unrouted paths reach it, since `/trpc/*` and `/api/auth/*` are
 * wildcards, but it is unbounded client-controlled text at info level.
 *
 * The path is not repeated here: the `incoming request` line for the same request id already
 * carries it, cut at the `?` by the audited serializer. The body keeps Fastify's shape, url and
 * all, because that goes to the one client that sent it rather than into a file on the box.
 */
function installNotFoundHandler(app: FastifyInstance, spa: boolean): void {
  // The global cap is attached per ROUTE (the plugin's `onRoute` hook), and a path with no
  // route never reaches one, so a 404 flood would otherwise cost an attacker nothing.
  // `app.rateLimit()` builds a handler over the same store and the same key, so it spends the
  // same budget as everything else. This is one of two paths the per-route attachment misses;
  // the CORS preflight is the other, and buildServer closes that one.
  app.setNotFoundHandler({ preHandler: app.rateLimit() }, (req, reply) => {
    // A page of the app itself, such as /plan opened from a bookmark: the client router knows
    // it, the server does not. Anything under the API prefixes is a real 404.
    if (spa && isAppPage(req.method, req.url)) {
      reply.header('cache-control', 'no-cache');
      return reply.sendFile('index.html');
    }
    req.log.info({ status: 404, method: req.method }, 'route not found');
    reply.code(404).send({
      message: `Route ${req.method}:${req.url} not found`,
      error: 'Not Found',
      statusCode: 404,
    });
  });
}

/**
 * D38's last hole, and the reason this handler exists at all.
 *
 * Fastify's default handler logs `reply.log.error({ req, res, err }, error?.message)`: the raw
 * message as the log `msg`, where no pino serializer can reach it, because serializers apply to
 * fields and this is the message itself. tRPC errors never get here (the adapter answers them),
 * so the exposed surface is `/api/auth/*` - exactly where email addresses are, and exactly what
 * Phase D's invitations and verification are about to exercise on an internet-reachable box.
 *
 * The response is rebuilt rather than delegated: `reply.send(err)` from inside a custom handler
 * re-enters Fastify's error path with the DEFAULT handler as the next one, which logs the
 * message again. So the same body shape is written here - `statusCode`, `code`, `error`,
 * `message`, in Fastify's own field order - and the caller still receives the real message,
 * because only the log was ever the problem.
 */
function installErrorHandler(app: FastifyInstance): void {
  app.setErrorHandler<FastifyError>((err, req, reply) => {
    const status = errorStatus(err, reply.statusCode);
    // Preserved because they carry protocol meaning a client acts on, `www-authenticate` on a
    // 401 being the standing example, and because Fastify's own handler preserves them - the
    // equivalence cases in server.test.ts pin both.
    //
    // NOT what carries the rate limiter's `retry-after`, which the comment here used to claim:
    // @fastify/rate-limit sets that header on the REPLY before it throws, and its error carries
    // no `headers` at all. Verified by removing this line - the two synthetic equivalence cases
    // fail and the real 429 keeps its header. The global rate limit tests pin the real path.
    const { headers } = err as unknown as { headers?: Record<string, string | number | string[]> };
    if (headers !== undefined) reply.headers(headers);

    // Ids only: a status, the ROUTE (authored, unlike req.url, which carries the query string
    // a tRPC GET puts recipe slugs in), and `err`, which serializeError reduces to type, code,
    // issue paths and frames. The message is not here in any form, `msg` included.
    // A 4xx keeps Fastify's quieter level: it is a client mistake, not a fault in the server.
    const line = { err, status, method: req.method, route: req.routeOptions.url };
    if (status >= 500) req.log.error(line, 'request failed');
    else req.log.info(line, 'request failed');

    reply.status(status).send({
      statusCode: status,
      code: err.code,
      error: STATUS_CODES[status],
      message: err.message,
    });
  });
}

/**
 * Minimal view of `process`, so the handlers below can be installed on something a test can
 * emit signals into. Firing a real SIGTERM inside the suite would run vitest's own listeners
 * and take the run down with it.
 */
export type ProcessLike = {
  on(event: string, listener: (...args: unknown[]) => void): unknown;
  exit(code: number): void;
};

/**
 * Shutdown and last-words handlers.
 *
 * Without the signal handlers a `docker restart` kills the process mid-request: in-flight
 * replies are dropped and Postgres connections are left for the server to time out. `app.close()`
 * stops accepting, drains what is in flight, and runs the onClose hooks that end the pool.
 *
 * Without the last two, a failure after startup exits with no line at all, which on a headless
 * box is indistinguishable from a machine that rebooted. They deliberately do NOT try to close
 * gracefully: after an uncaught exception the process state is undefined, and an
 * `unhandledRejection` handler exists only to make the crash legible - Node would otherwise
 * terminate the process itself.
 */
export function installProcessHandlers(opts: {
  app: FastifyInstance;
  log: FastifyBaseLogger;
  proc?: ProcessLike;
}): void {
  const { app, log } = opts;
  const proc = opts.proc ?? process;

  for (const signal of ['SIGTERM', 'SIGINT']) {
    proc.on(signal, () => {
      void (async () => {
        log.info({ signal }, 'shutting down');
        try {
          await app.close();
          proc.exit(0);
        } catch (err) {
          log.fatal({ err }, 'shutdown failed');
          proc.exit(1);
        }
      })();
    });
  }

  // `{ err: reason }` because a rejection reason is usually an Error and serializeError handles
  // whatever it is not. The message string is mandatory here like everywhere else (see log.ts).
  const dieWith = (msg: string) => (reason: unknown) => {
    log.fatal({ err: reason }, msg);
    // Exit a turn late. pino's default destination issues an async write, and in a container
    // stdout is a pipe, so exiting in the same tick can truncate the one line this handler
    // exists to produce. A turn is not a guarantee, but it lets the queued write run first.
    setImmediate(() => proc.exit(1));
  };
  proc.on('unhandledRejection', dieWith('unhandled rejection'));
  proc.on('uncaughtException', dieWith('uncaught exception'));
}

export type BuildServerOptions = {
  /**
   * Injection seam. Defaults to the shared logger; tests pass one built over a capturable
   * destination so they can assert on the lines the server actually emitted. The suite stays
   * quiet because the shared logger is silent under test, not because of anything here.
   */
  logger?: FastifyBaseLogger;
  /**
   * Injection seam for the same reason: `env.TRUST_PROXY` is parsed once at import, so without
   * this the only hop count the suite could ever exercise is the configured one. What varies
   * with it is which X-Forwarded-For entry becomes `req.ip`, and that is the value the rate
   * limiters key on, so it is worth testing at more than one setting.
   */
  trustProxy?: number | string[];
  /** The built web app to serve (D46); `null` serves none. Defaults to `resolveWebDist()`. */
  webDist?: string | null;
};

/**
 * The largest body the tRPC routes accept.
 *
 * The biggest thing that travels through them is an import upload, base64 encoded, so this is
 * the larger of the two upload caps at its encoded length plus room for the JSON envelope and
 * the tRPC wrapper around it. It is derived rather than written down, so raising an upload cap
 * cannot leave a body limit that silently refuses the uploads it now allows.
 */
export const MAX_IMPORT_BODY_BYTES =
  base64Length(Math.max(MAX_PDF_BYTES, MAX_IMAGE_IMPORT_BYTES)) + 64 * 1024;

export async function buildServer(opts: BuildServerOptions = {}): Promise<FastifyInstance> {
  // Widened deliberately: a pino `Logger` here would specialize Fastify's logger generic, and
  // the resulting instance no longer matches the plain `FastifyInstance` this returns.
  const log: FastifyBaseLogger = opts.logger ?? logger;
  const app = Fastify({
    // `loggerInstance`, not `logger`: passing a constructed pino under `logger` is read as
    // config instead, which silently drops the redaction rules built into it.
    loggerInstance: log,
    // A reverse proxy terminates TLS (D35), so the client address has to come from
    // X-Forwarded-For. A hop count or a list of the proxies' addresses, never `true`: `true`
    // trusts the whole chain and resolves the LEFTMOST entry, which any client can write. The
    // default trusts nobody (D46); the deployment names its proxy (see env.ts).
    trustProxy: opts.trustProxy ?? env.TRUST_PROXY,
    genReqId: generateRequestId,
  });

  // Hand the id back so a failing response can be quoted and found in the logs.
  app.addHook('onRequest', async (req, reply) => {
    reply.header('x-request-id', req.id);
  });

  /**
   * The coarse cap over everything, so one client cannot exhaust the box.
   *
   * Deliberately generous, and deliberately not the auth limiter's job: 300 a minute is far
   * more than a household member browsing recipes produces and far less than a runaway client
   * or a scraper. Guessing a password is bounded much harder, per path, by Better Auth's own
   * limiter (auth.ts). Two limiters, two jobs.
   *
   * `keyGenerator` is left at its default of `req.ip`, which is the same value the auth
   * limiter's `x-hearth-client-ip` carries, so both agree on who the client is and TRUST_PROXY
   * decides it once. They also group IPv6 the same way: both collapse an address to its /64
   * (this plugin's `ipv6Subnet` option, and the same default inside Better Auth's
   * `normalizeIP`), so a household on IPv6 is one client to both limiters rather than a fresh
   * bucket per device. Neither default is overridden here, and overriding one would not move
   * the other.
   *
   * The store is in memory, per process and per registration, so the counts reset on restart -
   * the same trade the auth limiter makes, for the same reason.
   */
  await app.register(rateLimit, {
    max: 300,
    timeWindow: '1 minute',
    /**
     * One line per refused request, at `warn`.
     *
     * `warn` because a 429 is never a single mistake: it takes 301 requests inside a minute to
     * reach one, and an operator watching an internet-facing box filters on this level, where
     * the two lines Fastify already writes for the same request (at `info`) are invisible. It
     * is a third line on a request that already writes two, so a flood loud enough to matter
     * was already loud in the request log.
     *
     * The address is repeated here rather than left to the `incoming request` line, because the
     * point of the level is that this line can be read on its own. `onExceeded` fires on every
     * refused request, and there is no once-per-window hook to prefer: `onExceeding` runs on
     * every request the limiter allows, the one that reaches the limit included.
     */
    onExceeded: (req, key) => {
      req.log.warn({ limiter: 'global', remoteAddress: key }, 'rate limited');
    },
    /**
     * The plugin's own error, minus the stack, because a refusal is not a fault.
     *
     * The default builder is `new Error(...)` with a `statusCode` on it, and the error handler
     * logs `{ err }`, which `serializeError` turns into the stack frames of the throw. Those
     * frames are the same three lines inside node_modules on every refusal, they say nothing an
     * operator can act on, and under a flood they are most of the log: measured at 852 bytes of
     * the 1418 one refused request wrote, against 190 for the warn line above.
     *
     * The message is the default's, verbatim, because the error handler rebuilds the response
     * body from it and a client should see exactly what the plugin would have sent. There is a
     * test on the exact body for that reason.
     *
     * This trims a flood by roughly half. It does not solve one: the two `info` lines Fastify
     * writes per request are inherent to request logging, so the real bound on an unrotated
     * json-file driver is a `logging:` block in the compose file, which is Task 24's.
     */
    errorResponseBuilder: (_req, context) => {
      const err = new Error(`Rate limit exceeded, retry in ${context.after}`);
      return Object.assign(err, { statusCode: context.statusCode, stack: '' });
    },
  });

  /**
   * The cap over CORS preflights, which is the one request the registration above cannot reach.
   *
   * @fastify/cors answers a preflight from an INSTANCE-level `onRequest` hook, and says why in
   * its own source: so that it can reply before authentication plugins. @fastify/rate-limit
   * attaches per ROUTE, through `onRoute`. Fastify runs instance hooks before route hooks, so
   * cors replied 204 and the cap never ran - at any registration order, including this one,
   * where the limiter is registered first. Measured before this existed: 5000 preflights on one
   * keep-alive connection in 1.02s, every one a 204, no 429 and no warn line, and 2.2MB of log.
   * `apps/web/Caddyfile` proxies `/api/*` and `/trpc/*` by any method, so that is reachable from
   * the internet on the deployed box.
   *
   * Registered here, before cors, because instance hooks run in registration order and this one
   * has to get there first.
   *
   * Gated to OPTIONS, and the gate is load-bearing rather than tidy: ungated, this hook would
   * count `/health` too, and an instance hook cannot see the route-level `rateLimit: false`
   * that exempts it. Measured - removing the gate fails the health test. Double counting is not
   * the hazard, because `rateLimitRequestHandler` guards re-entry with its own `rateLimitRan`
   * symbol, but a routed request still has to spend exactly one unit and there is a test for
   * that beside the preflight one.
   */
  const limitPreflight = app.rateLimit();
  app.addHook('onRequest', async (req, reply) => {
    // `.call(app, ...)`, because the plugin types its handler as a Fastify hook, which is
    // declared with `this: FastifyInstance`. Calling it bare is a type error, and binding the
    // instance is what Fastify itself does when it runs a hook.
    if (req.method === 'OPTIONS') await limitPreflight.call(app, req, reply);
  });

  installErrorHandler(app);
  const webDist = opts.webDist === undefined ? resolveWebDist() : opts.webDist;
  installNotFoundHandler(app, webDist !== null);
  if (webDist !== null) await serveWebApp(app, webDist);

  await app.register(cors, { origin: publicConfig.webOrigin, credentials: true });
  // Exempt from the cap above: a container health check runs on a fixed schedule forever, and
  // throttling it would take the container down for the one reason that is not a fault.
  app.get('/health', { config: { rateLimit: false } }, async () => ({ status: 'ok' }));

  // Convert Fastify's raw req into a web Request and delegate to Better Auth.
  app.route({
    method: ['GET', 'POST'],
    url: '/api/auth/*',
    async handler(req, reply) {
      const url = new URL(req.url, publicConfig.authUrl);
      // Including the resolved client IP, which Better Auth must never read off a raw header.
      const headers = authHeaders(req);
      const request = new Request(url, {
        method: req.method,
        headers,
        body: ['GET', 'HEAD'].includes(req.method) ? undefined : JSON.stringify(req.body),
      });
      const res = await auth.handler(request);
      // Better Auth answers a limited client itself, without throwing, so neither the error
      // handler's line nor the global cap's `onExceeded` covers this one. Same level and same
      // message as those, for the same reason: eleven sign-ins in a quarter of an hour is not
      // something an ordinary user does, and at `info` it would be invisible to an operator
      // running LOG_LEVEL=warn. Which auth path it was is on the `incoming request` line under
      // this request id, where the serializer has already cut the query string off it.
      if (res.status === 429) {
        req.log.warn({ limiter: 'auth', remoteAddress: req.ip }, 'rate limited');
      }
      reply.status(res.status);
      // A Web `Headers` object merges multiple Set-Cookie values into one comma-joined
      // string, which corrupts the session cookie. Forward them explicitly.
      for (const cookie of res.headers.getSetCookie()) reply.header('set-cookie', cookie);
      res.headers.forEach((value, key) => {
        if (key.toLowerCase() !== 'set-cookie') reply.header(key, value);
      });
      reply.send(res.body ? await res.text() : null);
    },
  });

  /*
    A recipe's photo or source file, by id: `full` or `thumb`.

    Authorized exactly as a tRPC call is: the same `createContext`, so the same session and the
    same active household, and the row is looked up inside that household (RLS behind it), so an
    id from another household is a 404, not a leak. The id never becomes a path by itself: the
    bytes are found under the household the SESSION names.

    A file never changes once stored (a new photo is a new id), so the browser may keep it for a
    year; `private` keeps a shared proxy from doing the same. `nosniff` holds the browser to the
    stored type, and a PDF is sent as a download rather than rendered on this origin.
  */
  app.get<{ Params: { id: string; variant: string } }>(
    '/api/files/:id/:variant',
    async (req, reply) => {
      const { id, variant } = req.params;
      if (!/^[0-9a-f-]{36}$/i.test(id) || (variant !== 'full' && variant !== 'thumb')) {
        return reply.code(404).send({ message: 'Not found' });
      }
      const ctx = await createContext({ req });
      if (!ctx.session || !ctx.householdId) return reply.code(401).send({ message: 'Sign in' });
      const file = await findRecipeFile(ctx.householdId, id);
      const stream = file ? readFileVariant(ctx.householdId, file.id, variant) : null;
      if (!file || !stream) return reply.code(404).send({ message: 'Not found' });
      reply
        .header('content-type', file.contentType)
        .header('cache-control', 'private, max-age=31536000, immutable')
        .header('x-content-type-options', 'nosniff');
      if (file.contentType === 'application/pdf') {
        reply.header('content-disposition', 'attachment; filename="source.pdf"');
      }
      return reply.send(stream);
    },
  );

  /*
    tRPC, inside a scope whose routes accept an import upload.

    A photo or a PDF reaches `import.fromImage` / `import.fromPdf` as base64 inside the JSON
    body, and Fastify's default body limit is 1MiB - far under `MAX_IMAGE_BYTES` encoded. The
    limit is raised by an `onRoute` hook rather than on the Fastify instance, because
    `fastifyTRPCPlugin` registers its own route and exposes no way to pass route options: inside
    an encapsulated `register`, the hook sees only the routes that plugin adds. Better Auth's
    endpoints and /health keep the 1MiB default, which is what a scoped hook buys over a server
    option.

    The bound this leaves is 8MiB bodies at the coarse rate limiter's 300 a minute. Fastify reads
    the body before createContext checks the session, so that bound applies to anonymous clients
    too, not only to invited members (D36). It is accepted for now: the instance sits behind the
    reverse proxy, and the alternative - a separate upload route with its own
    auth - is a second way into the same procedure. Batches are capped at MAX_TRPC_BATCH so one
    request cannot fan out into many imports.
  */
  await app.register(async (trpcScope) => {
    trpcScope.addHook('onRoute', (route) => {
      route.bodyLimit = MAX_IMPORT_BODY_BYTES;
    });
    await trpcScope.register(fastifyTRPCPlugin, {
      prefix: '/trpc',
      trpcOptions: { router: appRouter, createContext, maxBatchSize: MAX_TRPC_BATCH },
    });
  });

  return app;
}

/**
 * Tell the operator how to claim an unclaimed instance, or clean up after a claimed one.
 *
 * D36 makes an invitation the only route to an account, and issuing one needs an owner, so the
 * first account is exempt - gated on a token that only someone with access to the box can read.
 * This is where they read it. Without a line like this the token would be a credential the
 * operator has to know to go looking for in DATA_DIR, and a self-hoster following a README does
 * not.
 *
 * The token is in the MESSAGE and not in a field, which is the opposite of the usual rule here
 * (D38). It has to be: `token` is one of log.ts's SECRET_KEYS, so as a field it would be printed
 * as `[Redacted]` - correctly, and uselessly. The same bargain ConsoleMailer strikes, for the
 * same reason and with the same warning attached: at `warn` so it survives `LOG_LEVEL=warn`, and
 * it stops being printed the moment a household exists.
 */
export async function announceSetupToken(log: Pick<FastifyBaseLogger, 'warn'>): Promise<void> {
  if (await householdExists()) {
    // Claimed. The credential has no further use, so it does not sit on disk unwatched.
    deleteSetupToken(env.DATA_DIR);
    return;
  }
  const token = ensureSetupToken(env.DATA_DIR);
  log.warn(
    { path: setupTokenPath(env.DATA_DIR) },
    'This Hearth has no household yet. Create the first account by sending the header ' +
      `"${SETUP_TOKEN_HEADER}: ${token}" with the sign-up request. Anyone who can read this ` +
      'line, or that file, can claim this instance; both stop mattering once the household ' +
      'exists, and this line stops being printed.',
  );
}

// Entry point (not run during tests). Fastify logs "Server listening at ..." itself once a
// logger is wired, so the only thing left to report here is a startup that never got that far.
if (env.NODE_ENV !== 'test' && process.argv[1]?.endsWith('server.ts')) {
  buildServer()
    .then(async (app) => {
      // Before listen, so a signal arriving during startup still closes what was opened.
      installProcessHandlers({ app, log: app.log });
      await announceSetupToken(app.log);
      const filled = await backfillAltMeasures();
      if (filled > 0) app.log.info({ count: filled }, 'ingredient second measures filled in');
      await app.listen({ port: env.PORT, host: '0.0.0.0' });
    })
    .catch((err: unknown) => {
      logger.fatal({ err }, 'server failed to start');
      process.exit(1);
    });
}
