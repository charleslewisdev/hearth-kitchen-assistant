# P0.5 — Self-Host Readiness & Observability: Implementation Plan

> ## ✅ COMPLETE — 2026-09-09
>
> **640 unit tests + 2 Playwright specs green** (190 at branch point). Typecheck, lint and build
> clean. Branch `feat/p05-selfhost-readiness`, 70 commits. Identity audit clean across every
> reachable commit.
>
> **Verified locally, not on the box.** The exit criterion is met in code and every security
> property was verified against real servers, real containers and a real database. Nothing was
> deployed: no image was pushed, no unraid container was touched. Those steps are the owner's, and
> [`deploy/unraid/README.md`](../../deploy/unraid/README.md) is the sequence.
>
> **Four errors in this plan were caught by review or by measurement**, and are corrected in place
> below rather than left to mislead: `pino-pretty` was specified as a devDependency on the default
> runtime path; `trustProxy: true` would have resolved a client-writable address; pointing Better
> Auth at `x-forwarded-for` would have made the sign-in limiter bypassable by rotating a header; and
> both "traps" recorded for Task 15 were wrong, one over-broad and one under-broad. Two more were
> found while writing the deploy docs: `trusted_proxies static private_ranges` does not parse inside
> a `reverse_proxy` block, and `X-Forwarded-Proto` is not what makes secure cookies work here.
>
> **Still open, deliberately:** GHCR package visibility is the owner's call (private packages need a
> persisted `docker login` on unraid); `docker-compose.yml` still publishes Postgres on `0.0.0.0`
> for local dev; and no unraid template has been through the unraid UI.


**Goal:** Take Hearth from "runs on my laptop" to "runs on the author's unraid server behind nginx, reachable by family, with invite-only accounts, verified email, rate limiting, and structured logs."

**Architecture:** Six additive layers on the existing Fastify/tRPC/Better-Auth server, then a delivery layer. Logging lands first because everything after it uses it. No new domain tables, so the RLS guard needs nothing new. All web work is additive routes and one screen that replaces an existing stub.

**Tech Stack:** pino (already bundled with Fastify) · nodemailer · @fastify/rate-limit · Better Auth 1.6.19 built-in rate limiting + hooks · GitHub Actions + GHCR · unraid XML templates.

**Design:** [self-host/cook/import design](../specs/2026-09-08-selfhost-cook-import-design.md) · Decisions [D34–D38](../DECISION_LOG.md)

---

## Read this before Task 1

Three things were verified against the installed `better-auth@1.6.19` typings during planning. Do not re-derive them, and do not substitute what you remember from other versions.

1. **`emailAndPassword.disableSignUp: true` would break invitations.** Accepting an invitation requires an authenticated session, and an invitee has no account yet. So signup stays *enabled* at the Better Auth level and is gated by a `hooks.before` middleware that rejects any `/sign-up/email` whose email has no pending, unexpired invitation. That middleware **is** the invite-only mechanism. Getting this wrong produces either an open signup surface or an invite flow nobody can complete.

2. **Better Auth has its own rate limiter** (`rateLimit` option: `enabled`, `window`, `max`, `customRules` per path, `storage: "memory" | "database" | "secondary-storage"`, default memory). It is path-aware, needs no new dependency, and is the right tool for `/api/auth/*`. `@fastify/rate-limit` is added only as a coarse global cap over `/trpc` and everything else. Two limiters, two jobs - do not collapse them.

3. **Proxy-aware client IPs are configured in two places** and both matter. Fastify needs `trustProxy` so its own logs and the global limiter see the real IP; Better Auth needs `advanced.ipAddress.ipAddressHeaders` so *its* limiter does. Setting only one silently rate-limits every user as if they were nginx.

**Repo conventions to follow:** tests live beside the code as `*.test.ts`; server tests run against a real Postgres in a single fork and reset via `resetDb()`; `pnpm test:local` brings the DB up, migrates, and runs everything. Never widen `packages/shared` to import server code. Commit after every task.

---

## Phase A — Structured logging

### Task 1: Logger module with redaction

**Files:**
- Create: `apps/server/src/log.ts`
- Create: `apps/server/src/log.test.ts`
- Modify: `apps/server/src/env.ts`

**Step 1: Add `LOG_LEVEL` and `NODE_ENV` to the env schema.**

In `apps/server/src/env.ts`, extend the zod object:

```ts
const schema = z.object({
  DATABASE_URL: z.string().url(),
  BETTER_AUTH_SECRET: z.string().min(32),
  BETTER_AUTH_URL: z.string().url(),
  WEB_ORIGIN: z.string().url(),
  PORT: z.coerce.number().default(3000),
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent']).default('info'),
});
```

**Step 2: Write the failing test** in `apps/server/src/log.test.ts`.

```ts
import { describe, it, expect } from 'vitest';
import { Writable } from 'node:stream';
import { createLogger, REDACT_PATHS } from './log';

function capture(): { sink: Writable; lines: () => Record<string, unknown>[] } {
  const out: string[] = [];
  const sink = new Writable({
    write(chunk, _enc, cb) { out.push(chunk.toString()); cb(); },
  });
  return { sink, lines: () => out.flatMap((s) => s.trim().split('\n')).map((l) => JSON.parse(l)) };
}

describe('createLogger', () => {
  it('redacts cookie, authorization, and set-cookie headers', () => {
    const { sink, lines } = capture();
    const log = createLogger({ level: 'info', pretty: false, destination: sink });
    log.info(
      { req: { headers: { cookie: 'better-auth.session_token=SECRET', authorization: 'Bearer SECRET' } } },
      'request',
    );
    const [line] = lines();
    const headers = (line.req as any).headers;
    expect(headers.cookie).toBe('[Redacted]');
    expect(headers.authorization).toBe('[Redacted]');
    expect(JSON.stringify(line)).not.toContain('SECRET');
  });

  it('redacts password and token fields anywhere in the payload', () => {
    const { sink, lines } = capture();
    const log = createLogger({ level: 'info', pretty: false, destination: sink });
    log.info({ body: { email: 'a@b.c', password: 'hunter2' }, token: 'abc123' }, 'signup');
    const line = lines()[0];
    expect(JSON.stringify(line)).not.toContain('hunter2');
    expect(JSON.stringify(line)).not.toContain('abc123');
  });

  it('honors the configured level', () => {
    const { sink, lines } = capture();
    const log = createLogger({ level: 'warn', pretty: false, destination: sink });
    log.info('dropped');
    log.warn('kept');
    expect(lines()).toHaveLength(1);
    expect(lines()[0].msg).toBe('kept');
  });

  it('exposes redaction paths so callers cannot drift from them', () => {
    expect(REDACT_PATHS).toContain('req.headers.cookie');
  });
});
```

**Step 3: Run it and watch it fail.**

Run: `pnpm --filter @hearth/server exec vitest run src/log.test.ts`
Expected: FAIL, cannot resolve `./log`.

**Step 4: Implement `apps/server/src/log.ts`.**

```ts
import { pino, type Logger, type DestinationStream } from 'pino';
import { env } from './env';

/**
 * Anything that could carry a credential or a session. Pino's redact only walks the
 * paths it is given, so wildcards cover the "somewhere in the payload" cases.
 *
 * The ids-only rule (D38) is a convention the call sites keep: log recipe ids, never
 * recipe content. Redaction is the backstop for secrets, not a substitute for that.
 */
export const REDACT_PATHS = [
  'req.headers.cookie',
  'req.headers.authorization',
  'res.headers["set-cookie"]',
  'headers.cookie',
  'headers.authorization',
  '*.password',
  '*.token',
  '*.secret',
  'password',
  'token',
  'secret',
];

export function createLogger(opts: {
  level: string;
  pretty: boolean;
  destination?: DestinationStream;
}): Logger {
  const base = {
    level: opts.level,
    redact: { paths: REDACT_PATHS, censor: '[Redacted]' },
  };
  if (opts.destination) return pino(base, opts.destination);
  if (opts.pretty) {
    return pino({
      ...base,
      transport: { target: 'pino-pretty', options: { colorize: true, translateTime: 'HH:MM:ss' } },
    });
  }
  return pino(base);
}

export const logger = createLogger({
  level: env.LOG_LEVEL,
  pretty: env.NODE_ENV === 'development',
});
```

**Step 5: Add pino and pino-pretty as server dependencies.**

Run: `pnpm --filter @hearth/server add pino pino-pretty`

Both go in `dependencies`, **not** `devDependencies`. `NODE_ENV` defaults to `development`, so an
unconfigured process takes the `pino-pretty` transport branch and resolves the module at import
time - as a dev-only dependency that is a boot crash, not a degraded log format. (`pino` comes in
transitively via Fastify, but declare it so the import is honest.)

**Step 6: Run the tests.**

Run: `pnpm --filter @hearth/server exec vitest run src/log.test.ts`
Expected: PASS, 4 tests.

**Step 7: Commit.**

```bash
git add apps/server/src/log.ts apps/server/src/log.test.ts apps/server/src/env.ts apps/server/package.json ../../pnpm-lock.yaml
git commit -m "feat(server): structured logger with secret redaction"
```

---

### Task 2: Wire the logger into Fastify with request ids

**Files:**
- Modify: `apps/server/src/server.ts`
- Modify: `apps/server/src/server.test.ts`

**Step 1: Write the failing test.** Append to `apps/server/src/server.test.ts`:

```ts
it('attaches a request-scoped logger and a request id', async () => {
  const app = await buildServer();
  const res = await app.inject({ method: 'GET', url: '/health' });
  expect(res.statusCode).toBe(200);
  expect(res.headers['x-request-id']).toBeTruthy();
  await app.close();
});
```

**Step 2: Run it.**

Run: `pnpm --filter @hearth/server exec vitest run src/server.test.ts`
Expected: FAIL, `x-request-id` undefined.

**Step 3: Implement.** In `apps/server/src/server.ts`, replace `Fastify({ logger: false })`:

```ts
import { randomUUID } from 'node:crypto';
import { logger } from './log';

const app = Fastify({
  loggerInstance: logger,
  trustProxy: true, // nginx terminates TLS (D35); without this every client IP is nginx's
  genReqId: (req) => (req.headers['x-request-id'] as string) ?? randomUUID(),
  disableRequestLogging: env.NODE_ENV === 'test',
});

app.addHook('onRequest', async (req, reply) => {
  reply.header('x-request-id', req.id);
});
```

> `loggerInstance` (not `logger`) is the Fastify 5 option for passing a constructed pino
> instance. Passing it as `logger` is silently treated as config and drops the redaction.

**Step 4: Run the server tests.**

Run: `pnpm --filter @hearth/server exec vitest run src/server.test.ts`
Expected: PASS.

**Step 5: Commit.**

```bash
git add apps/server/src/server.ts apps/server/src/server.test.ts
git commit -m "feat(server): request-scoped logging, request ids, trustProxy"
```

---

### Task 3: tRPC logging middleware

**Files:**
- Modify: `apps/server/src/trpc/context.ts`
- Modify: `apps/server/src/trpc/trpc.ts`
- Create: `apps/server/src/trpc/logging.test.ts`

**Step 1: Put the request logger on the context.** In `context.ts`:

```ts
export async function createContext({ req }: { req: FastifyRequest }) {
  const headers = new Headers();
  for (const [k, v] of Object.entries(req.headers)) {
    if (typeof v === 'string') headers.set(k, v);
  }
  const session = await auth.api.getSession({ headers });
  const householdId = session?.session.activeOrganizationId ?? null;
  // Child logger carries tenancy on every line the request produces (D38).
  const log = req.log.child({
    userId: session?.user.id ?? null,
    householdId,
  });
  return { session, householdId, log };
}
```

**Step 2: Write the failing test** in `apps/server/src/trpc/logging.test.ts`. Assert that a
successful call logs `{ path, durationMs, ok: true }` and a throwing call logs at `error`
with `ok: false`, using a fake logger object rather than a real pino instance.

```ts
import { describe, it, expect, vi } from 'vitest';
import { router, publicProcedure } from './trpc';

function fakeLog() {
  const calls: { level: string; obj: Record<string, unknown> }[] = [];
  const rec = (level: string) => (obj: Record<string, unknown>) => calls.push({ level, obj });
  return { calls, info: rec('info'), error: rec('error'), warn: rec('warn'), debug: rec('debug') };
}

describe('tRPC logging middleware', () => {
  it('logs path, duration and ok=true on success', async () => {
    const log = fakeLog();
    const r = router({ ping: publicProcedure.query(() => 'pong') });
    const caller = r.createCaller({ session: null, householdId: null, log } as never);
    await caller.ping();
    const line = log.calls.find((c) => c.obj.path === 'ping');
    expect(line?.obj.ok).toBe(true);
    expect(typeof line?.obj.durationMs).toBe('number');
  });

  it('logs ok=false at error level when the procedure throws', async () => {
    const log = fakeLog();
    const r = router({
      boom: publicProcedure.query(() => {
        throw new Error('nope');
      }),
    });
    const caller = r.createCaller({ session: null, householdId: null, log } as never);
    await expect(caller.boom()).rejects.toThrow();
    const line = log.calls.find((c) => c.level === 'error');
    expect(line?.obj.ok).toBe(false);
  });
});
```

**Step 3: Run it.** Expected: FAIL (no middleware yet, nothing logged).

**Step 4: Implement in `trpc.ts`.**

```ts
const loggingMiddleware = t.middleware(async ({ ctx, path, type, next }) => {
  const started = Date.now();
  const result = await next();
  const durationMs = Date.now() - started;
  // Ids and shape only, never inputs — inputs carry recipe and account content (D38).
  const line = { path, type, durationMs, ok: result.ok };
  if (result.ok) ctx.log.info(line, 'trpc');
  else ctx.log.error({ ...line, err: result.error }, 'trpc');
  return result;
});

export const publicProcedure = t.procedure.use(loggingMiddleware);
export const protectedProcedure = publicProcedure.use(({ ctx, next }) => { /* unchanged body */ });
```

> `protectedProcedure` must build on `publicProcedure` so protected calls are logged too.

**Step 5: Run the full server suite** to catch context-shape breakage in existing tests.

Run: `pnpm --filter @hearth/server exec vitest run`
Expected: PASS. Existing router tests that construct a context by hand will need `log` added -
give them a shared `test/log.ts` helper returning a silent logger rather than repeating a stub.

**Step 6: Commit.**

```bash
git add apps/server/src/trpc apps/server/test
git commit -m "feat(server): log every tRPC call with tenancy, duration and outcome"
```

---

## Phase B — Config, secrets, and public identity

### Task 4: `PUBLIC_URL` drives origins and cookie security

**Files:**
- Create: `apps/server/src/config.ts`
- Create: `apps/server/src/config.test.ts`

**Step 1: Write the failing test.**

```ts
import { describe, it, expect } from 'vitest';
import { derivePublicConfig } from './config';

describe('derivePublicConfig', () => {
  it('derives auth url and web origin from one PUBLIC_URL', () => {
    const c = derivePublicConfig({ publicUrl: 'https://hearth.example.com' });
    expect(c.authUrl).toBe('https://hearth.example.com');
    expect(c.webOrigin).toBe('https://hearth.example.com');
  });

  it('enables secure cookies for https', () => {
    expect(derivePublicConfig({ publicUrl: 'https://hearth.example.com' }).useSecureCookies).toBe(true);
  });

  it('disables secure cookies for plain http so local dev still logs in', () => {
    expect(derivePublicConfig({ publicUrl: 'http://localhost:8080' }).useSecureCookies).toBe(false);
  });

  it('strips a trailing slash so origin comparisons match', () => {
    expect(derivePublicConfig({ publicUrl: 'https://hearth.example.com/' }).webOrigin)
      .toBe('https://hearth.example.com');
  });

  it('rejects a PUBLIC_URL with a path, which would silently break auth callbacks', () => {
    expect(() => derivePublicConfig({ publicUrl: 'https://example.com/hearth' })).toThrow(/path/i);
  });
});
```

**Step 2: Run it.** Expected: FAIL, module not found.

**Step 3: Implement `apps/server/src/config.ts`** with `derivePublicConfig` returning
`{ authUrl, webOrigin, useSecureCookies }`, throwing on a non-empty pathname.

**Step 4: Run the tests.** Expected: PASS, 5 tests.

**Step 5: Commit.**

```bash
git add apps/server/src/config.ts apps/server/src/config.test.ts
git commit -m "feat(server): derive auth origin and cookie security from PUBLIC_URL"
```

---

### Task 5: First-boot secret generation and production refusal

**Files:**
- Create: `apps/server/src/secret.ts`
- Create: `apps/server/src/secret.test.ts`
- Modify: `apps/server/src/env.ts`

**Behavior to build:**
- `resolveAuthSecret({ envSecret, dataDir, nodeEnv })`.
- Env secret set and not the dev default → use it.
- Env secret is the literal `dev-secret-change-me-min-32-chars-long` and `nodeEnv === 'production'` → **throw** with a message naming `BETTER_AUTH_SECRET`.
- Same default outside production → allow, log a warning.
- No env secret → read `${dataDir}/auth-secret`; if absent, generate 32 random bytes hex, write with mode `0600`, return it. Second call returns the same value.

**Step 1: Write the failing tests** using a `mkdtemp` temp dir per test, covering all five
branches plus "the file is reused across calls" and "the file is created with mode 0600".

**Step 2: Run.** Expected: FAIL.

**Step 3: Implement** with `node:crypto` `randomBytes(32).toString('hex')` and
`writeFileSync(path, secret, { mode: 0o600 })`, creating `dataDir` recursively first.

**Step 4: Make `BETTER_AUTH_SECRET` optional in `env.ts`** (`z.string().min(32).optional()`)
and add `DATA_DIR: z.string().default('./.data')` and `PUBLIC_URL: z.string().url().optional()`.

**Also add `TRUST_PROXY`** (`z.coerce.number().int().min(0).default(2)`), carried forward from
Task 2 and **corrected by the Task 2 quality review**. Task 2 hardcoded `trustProxy: 1`, not
`true`, because `true` resolves the **leftmost** `X-Forwarded-For` entry, which any client can
write, while a hop count resolves the entry a trusted proxy appended. That reasoning is right and
the original hop count was wrong. See D39: the real chain is client → nginx → **Caddy** → Fastify,
so the correct default is **2**, and it only works once the Caddyfile trusts its peer (Task 24).
Make it configurable here, have `server.ts` read it, and document it in `.env.example` including
the fact that the value must match the number of proxies actually in front of the app.

**Step 5: Run the whole server suite.** Expected: PASS.

**Step 6: Commit.**

```bash
git add apps/server/src/secret.ts apps/server/src/secret.test.ts apps/server/src/env.ts
git commit -m "feat(server): first-boot auth secret generation, refuse dev default in production"
```

---

### Task 6: Apply config and secret in `auth.ts`

**Files:**
- Modify: `apps/server/src/auth.ts`

Wire `derivePublicConfig` and `resolveAuthSecret` in, and keep
`trustedOrigins: [publicConfig.webOrigin]`.

**Do NOT write `ipAddressHeaders: ['x-forwarded-for']`, which is what an earlier draft of this
plan said.** Verified in `better-auth/dist/utils/get-request-ip.mjs:12`, Better Auth resolves the
client IP as:

```js
const ip = value.split(",")[0].trim();
```

That is the **leftmost** entry, which is the one any client can write, and Better Auth has no
concept of trusted proxies or hop counting. Pointing it at `x-forwarded-for` would make Task 15's
auth rate limiting trivially bypassable: an attacker brute-forcing sign-in rotates the header and
every request lands in a fresh bucket. That defeats the entire purpose of the limit.

**Instead, hand Better Auth the address Fastify already resolved correctly.** `server.ts`'s
`/api/auth/*` handler builds a fresh `Headers` from `req.headers`; after that loop, overwrite a
private header with Fastify's resolved value:

```ts
// Fastify has already applied TRUST_PROXY to pick the right X-Forwarded-For entry (D39).
// set() after the copy loop, so a client-supplied value of this header is overwritten, never
// merged. Better Auth takes headers[0] verbatim, so it must never see one the client controls.
headers.set('x-hearth-client-ip', req.ip);
```

then configure `advanced: { useSecureCookies: publicConfig.useSecureCookies, ipAddress: {
ipAddressHeaders: ['x-hearth-client-ip'] } }`.

**Test the bypass explicitly**, not just the happy path: a request carrying a forged
`X-Forwarded-For` must still be attributed to its real address, and a forged `x-hearth-client-ip`
must be ignored. Both are one-line regressions if someone later moves the `set()` above the copy
loop.

Note `getIp` falls back to `127.0.0.1` in test and development, so all local requests share one
bucket. That is fine, but it means a rate-limit test asserting per-IP isolation has to run with
`NODE_ENV=production` or it will pass vacuously - relevant to Task 15.

**Verify:** `pnpm test:local` still green, then commit.

---

### Task 6b: Close the Fastify error-handler leak (D38)

**Files:**
- Modify: `apps/server/src/server.ts`
- Modify: `apps/server/src/server.test.ts`

Surfaced by Task 3, which could not fix it from its own scope. Fastify's default error handler
logs `reply.log.error({ req, res, err }, error?.message)` - the raw error message as the log
**`msg`**, which **no pino serializer can reach**, because serializers apply to fields and this is
the message itself.

tRPC errors do not reach that path (the adapter handles them), so the exposure is the
`/api/auth/*` route - which is exactly where email addresses live, and which Phase D is about to
exercise hard with invitations and verification. Left alone, an auth error can write a relative's
email address into the logs of an internet-reachable box.

Register an `app.setErrorHandler` that logs an ids-only line (status, path, and `{ err }` so Task
3's `serializeError` does apply) and never passes the raw message as `msg`. Keep the response body
unchanged: the client should still receive the real message, since only the *log* is the problem.

**Close the same hole in pino's own no-message form, which is the other half of this bug.** The
Task 3 review verified that `log.error(new Error('SECRET'))` and `log.error({ err })` with no
message string both write `err.message` straight into `msg`, while `err` itself is correctly
reduced. The resulting line **looks** redacted and is not. No call site does this today, so it is
latent, but `log.ts` currently claims the serializer "governs every `{ err }` in the app", which is
false and which the next person to write `log.error({ err })` will believe.

Rewrite that contract to state the real one - a message string is mandatory at every `err` call
site - and enforce it rather than documenting it. A thin `logError(log, ids, err)` wrapper or an
ESLint rule are both acceptable; documentation alone is not, since that is what already failed.

**Test:** drive an error through `/api/auth/*` whose message contains an email address, capture the
log output, and assert the address appears nowhere in it - `msg` included, which is the field that
fails today. Also cover the bare `log.error(new Error(...))` form. Mutation-check by removing the
handler **and** by asserting on a thrown error whose message contains an address: the Fastify error
messages reachable today do not quote request content, so a weaker case would pass vacuously.

**Also fold in the lifecycle gap** flagged by the Task 2 review, since this task has `server.ts`
open: add a `SIGTERM` handler calling `app.close()` (a container restart currently drops in-flight
requests and Postgres connections), and `unhandledRejection` / `uncaughtException` handlers, since
today a failure after startup exits with no fatal line at all.

---

## Phase C — Mail ✅ DONE 2026-09-08

> **Shipped with three deliberate deviations from the text below.** Recorded here because Phase D
> is planned from this document and the original wording is now wrong:
>
> 1. **The console line carries `to` and `actionUrl` only, at `warn`** - not "recipient and subject
>    at `info`". The subject was dropped because it is built from the inviter's and household's
>    names, so logging it put user content on every send while buying nothing (the URL already
>    distinguishes an invitation from a verification). `warn` because `LOG_LEVEL=warn` is a
>    supported setting and the line *is* the delivery mechanism.
> 2. **`SMTP_SECURE` parses a word table and refuses unknown words**, not `z.coerce.boolean()`.
>    That coercion is `Boolean(v)`, so `'false'`, `'0'` and `'no'` are all **true** - and guessing
>    wrong is silent in the dangerous direction, downgrading a connection meant to be encrypted.
> 3. **`MailMessage` gained a required `actionUrl`.** This is what makes the D38 console exception
>    possible: the console line can be actionable without being a body.

### Task 7: `Mailer` interface with SMTP, console, and memory implementations

**Files:**
- Create: `apps/server/src/mail/mailer.ts`
- Create: `apps/server/src/mail/mailer.test.ts`

**Step 1: Add nodemailer.**

Run: `pnpm --filter @hearth/server add nodemailer && pnpm --filter @hearth/server add -D @types/nodemailer`

**Step 2: Write the failing tests.**

```ts
describe('createMailer', () => {
  it('returns a console mailer when SMTP_HOST is unset', () => {
    expect(createMailer({ env: {}, logger: silent }).kind).toBe('console');
  });

  it('returns an SMTP mailer when SMTP_HOST is set', () => {
    expect(createMailer({ env: { SMTP_HOST: 'smtp.example.com' }, logger: silent }).kind).toBe('smtp');
  });
});

describe('MemoryMailer', () => {
  it('captures messages for assertions', async () => {
    const m = new MemoryMailer();
    await m.send({ to: 'a@b.c', subject: 'Hi', text: 'link https://x/y' });
    expect(m.sent).toHaveLength(1);
    expect(m.sent[0].to).toBe('a@b.c');
  });
});

describe('ConsoleMailer', () => {
  it('logs the recipient and subject but never the full body at info', async () => {
    // Deterministic-first: no SMTP configured must still complete the flow (design A3).
  });
});
```

**Step 3–5:** Run (fail), implement `Mailer` as
`{ kind: 'smtp' | 'console' | 'memory'; send(msg: MailMessage): Promise<void> }`, run (pass), commit.

---

### Task 8: Email templates

**Files:**
- Create: `apps/server/src/mail/templates.ts`
- Create: `apps/server/src/mail/templates.test.ts`

Two pure functions returning `{ subject, text, html }`:
`householdInvitation({ inviterName, householdName, acceptUrl })` and
`emailVerification({ verifyUrl })`.

**Tests:** the accept URL appears in both text and html; html escapes a household name
containing `<script>`; the subject names the household. Pure functions, no I/O.

Commit as `feat(server): invitation and verification email templates`.

---

### Task 9: Env schema for SMTP + startup mailer selection

**Files:**
- Modify: `apps/server/src/env.ts`
- Create: `apps/server/src/mail/index.ts`

Add `SMTP_HOST`, `SMTP_PORT` (coerce number, default 587), `SMTP_USER`, `SMTP_PASS`,
`SMTP_SECURE` (coerce boolean, default false), `SMTP_FROM` (default `hearth@localhost`),
all optional except the default-carrying ones. Export a singleton `mailer`.

Log the selected mailer kind once at startup at `info` so a self-hoster can tell from the
logs whether mail will actually leave the box.

Commit.

---

## Phase D — Invite-only accounts ✅ DONE 2026-09-09

> **Spike done.** The Better Auth archaeology in this plan held in full against 1.6.19. Four
> things the plan did not say, all verified live and all load-bearing for Task 13 and Phase F:
>
> 1. **`requireEmailVerification: true` makes sign-up return no session** (`shouldSkipAutoSignIn`),
>    so `token: null` and no `Set-Cookie`. Anything that needs a signed-in user must verify and
>    sign in as a separate step - `test/session.ts` does. It also means auto-accept **cannot** call
>    `auth.api.acceptInvitation`, which requires a session.
> 2. **`sendVerificationEmail` fires even for an already-verified user** - the send is gated on
>    `sendOnSignUp ?? requireEmailVerification`, never on `emailVerified` - so skipping it for
>    invited accounts has to be an explicit guard in the callback.
> 3. **Both mail callbacks run inside `runInBackgroundOrAwait`**, which swallows what escapes and
>    prints it with `console.error`, outside pino. Rethrowing from them is therefore a D38/D40
>    violation, not diligence. Better Auth's own logger is now pointed at ours for the same reason.
> 4. **`createInvitation` and `signUpEmail` both lowercase the address**, so matching on the
>    lowercased value is the whole rule, and trimming would break it.
>
> **Three mechanisms deliver D36, not one**, and Task 13 and Phase F depend on all three:
>
> - **Signing up requires a pending invitation** (`inviteOnly`, Task 10), *except* for the first
>   account, which needs the **first-boot setup token** from `DATA_DIR/setup-token` sent as the
>   `x-hearth-setup-token` header. Without that token any stranger could create the one user row
>   that closes the carve-out and **brick the instance permanently** - reproduced.
> - **Sign-up accepts the matching invitation** (`joinInvitedHousehold`), consuming it and writing
>   the membership in one transaction, so the invitee lands in the owner's household.
> - **The instance holds exactly one household**, enforced by the
>   `organization_singleton_uidx` unique index (migration 0004), because the application check is
>   check-then-act and 20 concurrent creates got past it. `member` also gained
>   `unique (organization_id, user_id)`.
>
> **Consequences for the tasks below:**
>
> - **Task 13's cross-tenant tests cannot build a second household through the API, or through
>   `createHousehold()` either** - the index refuses it. Call `liftHouseholdCap()` from
>   `test/factories.ts` first, as the repo tests do; `resetDb()` restores it.
> - **Roles are normalised on accept** (`householdRole`): the plugin stores roles comma-joined, so
>   an invitation for two roles is the literal `'owner,member'`. Task 13 should compare against
>   `HOUSEHOLD_ROLES`, not against raw strings.
> - **`SINGLE_HOUSEHOLD`** is on `publicConfig` and read by all three single-tenant sites. Lifting
>   the cap is that flag plus dropping the index; do not re-hardcode the assumption anywhere new.
> - **Phase F** must send the setup token header on the first sign-up, must handle
>   `ONE_HOUSEHOLD_MESSAGE` on the onboarding screen (that is what an invitee whose auto-accept
>   failed will hit), and owns `e2e/grocery-mvp.spec.ts`, which is **currently broken**: it signs
>   up and expects a session, which verification no longer grants. CI does not run e2e.
>
> **Original spike note, kept for the record.** Before Task 10, prove the Better Auth invitation round-trip works in this
> codebase: a script or scratch test that creates a household, calls
> `auth.api.createInvitation`, and reads the row back. The plugin is bound but has never
> issued an invitation here (design "Risks"). If the API shape differs from this plan, stop
> and reconcile the plan rather than improvising around it.

### Task 10: Signup requires a pending invitation

**Files:**
- Modify: `apps/server/src/auth.ts`
- Create: `apps/server/src/auth-invite.ts`
- Create: `apps/server/src/auth-invite.test.ts`

**Step 1: Write the failing integration test** (real Postgres, `resetDb()` first):

```ts
it('rejects sign-up for an email with no pending invitation', async () => {
  await expect(
    auth.api.signUpEmail({ body: { email: 'stranger@example.com', password: 'pw-at-least-8', name: 'S' } }),
  ).rejects.toThrow(/invitation/i);
});

it('allows sign-up for an email with a pending invitation', async () => { /* ... */ });
it('rejects sign-up when the invitation is expired', async () => { /* ... */ });
it('rejects sign-up when the invitation was already accepted', async () => { /* ... */ });
it('rejects sign-up when the invitation is for a different email', async () => { /* ... */ });
```

**Step 2: Run.** Expected: FAIL - signup currently succeeds for anyone.

**Step 3: Implement** in `auth-invite.ts` a `requirePendingInvitation` helper and use it from
`auth.ts`:

```ts
import { createAuthMiddleware, APIError } from 'better-auth/api';

hooks: {
  before: createAuthMiddleware(async (ctx) => {
    if (ctx.path !== '/sign-up/email') return;
    const email = String(ctx.body?.email ?? '').toLowerCase();
    const ok = await hasPendingInvitation(email);
    if (!ok) {
      throw new APIError('FORBIDDEN', {
        message: 'Hearth is invite-only. Ask the household owner for an invitation.',
      });
    }
  }),
},
```

`hasPendingInvitation` queries the `invitation` table for
`email = $1 AND status = 'pending' AND expires_at > now()`.

> This middleware **is** the invite-only control (see "Read this before Task 1" #1).
> `disableSignUp` is deliberately left off; setting it would block invitees too.

**Step 4: Run.** Expected: PASS, 5 tests.

**Step 5: Commit.**

---

### Task 11: Invitation email delivery

**Files:**
- Modify: `apps/server/src/auth.ts`

Wire the organization plugin:

```ts
organization({
  async sendInvitationEmail(data) {
    const acceptUrl = `${publicConfig.webOrigin}/accept-invite/${data.id}`;
    const msg = householdInvitation({
      inviterName: data.inviter.user.name,
      householdName: data.organization.name,
      acceptUrl,
    });
    await mailer.send({ to: data.email, ...msg });
  },
})
```

**Test** (integration, `MemoryMailer` injected): creating an invitation sends exactly one
message, to the invited address, whose body contains `/accept-invite/<id>`.

Commit.

---

### Task 12: Email verification wiring

**Files:**
- Modify: `apps/server/src/auth.ts`

```ts
emailAndPassword: { enabled: true, requireEmailVerification: true },
emailVerification: {
  sendOnSignUp: true,
  async sendVerificationEmail({ url }) { /* mailer.send(emailVerification({ verifyUrl: url })) */ },
},
```

**Decision to implement:** a user who signed up through an invitation link has already proven
control of that address, so mark them verified on creation and skip the second email. Do this in
`databaseHooks.user.create.before` when a pending invitation matches, setting `emailVerified: true`.

**Test:** an invited signup lands with `emailVerified = true` and `MemoryMailer` captures **no**
verification message; assert both, since the second half is what proves the skip.

Commit.

---

### Task 13: Household tRPC router ✅ DONE 2026-09-09

Shipped as `8f83513`. Beyond the text below: the invitation **role is pinned** to `member` and the
input carries no role field, because the plugin will happily issue an owner-role invitation which
auto-accept then copies into a second owner. `removeMember`'s rule is **"never the last owner"**,
not "never yourself" - leaving is legitimate, an ownerless household is not. `invite` passes
`resend: true`, since re-inviting after a message goes to spam is the ordinary case and would
otherwise throw a 500. Every refusal is this router's own `TRPCError`, because an `APIError` from
the library surfaces as a 500; only "not a member" is translated, which a removed person's live
session produces on every poll. The tRPC **context now carries `headers`**, because the plugin's
endpoints authenticate from headers and cannot be handed a session object.

<!-- original task text follows -->

### Task 13: Household tRPC router

**Files:**
- Create: `apps/server/src/trpc/routers/household.ts`
- Create: `apps/server/src/trpc/routers/household.test.ts`
- Modify: `apps/server/src/trpc/routers/index.ts`

Procedures, all `protectedProcedure`, all scoped to `ctx.householdId`:
- `members` - list members with role and joined date
- `invitations` - list pending invitations
- `invite({ email })` - owner only
- `revokeInvitation({ invitationId })` - owner only
- `removeMember({ memberId })` - owner only, **cannot remove the last owner**

**Verified during planning against better-auth 1.6.19 - do not re-derive.** The organization
plugin exposes `createInvitation`, `getInvitation`, `listInvitations`, `acceptInvitation`,
`rejectInvitation`, **`cancelInvitation`**, `listMembers`, `addMember`, `removeMember`, and
`updateMemberRole`. Note the plugin calls it **cancel**, not revoke: the tRPC procedure above
keeps the name `revokeInvitation` because that is the word the UI uses, but it calls
`cancelInvitation` underneath. Invitation `status` is one of `pending` / `accepted` /
`rejected` / **`canceled`** (one L - spelling it `cancelled` silently matches nothing).

The `invitation` table columns are `id`, `organization_id`, `email`, `role`, `status`
(default `pending`), `expires_at`, `created_at`, `inviter_id`. The `member` table is `id`,
`organization_id`, `user_id`, `role` (default `member`), `created_at`. Task 10's pending-check
query (`status = 'pending' AND expires_at > now()`) is correct against this schema.

**Tests must cover the tenant and privilege boundaries, not just the happy path:**
a member (not owner) calling `invite` gets `FORBIDDEN`; a user in household B cannot list
household A's members or revoke its invitations; removing the last owner is rejected.

Commit.

---

### Task 14: Verify RLS guard still passes ✅ DONE 2026-09-08

Run: `pnpm --filter @hearth/server exec vitest run src/db/rls.test.ts`

**Ran after Phase C: 1 test passed.** Phases A through C added no `household_id` table, so tenant
isolation is untouched. Re-run after Phase D, which is the phase that could plausibly add one.

---

## Phase E — Rate limiting ✅ DONE 2026-09-09

> **Done, and four things the plan did not say.** All measured against `better-auth@1.6.19` and
> `@fastify/rate-limit@11.2.0`, all load-bearing.
>
> 1. **`NODE_ENV=production` is not enough to take Better Auth out of test mode.** Its `isTest()`
>    is `nodeENV === 'test' || toBoolean(env.TEST)`, and vitest sets `TEST=true` in every worker.
>    With NODE_ENV set and TEST left alone the context still reports `skipOriginCheck: true` and
>    `getIp` still falls back to `127.0.0.1`. `auth-ratelimit.test.ts` deletes `TEST` as well, and
>    its first test asserts the mode it is running in so this cannot regress quietly.
> 2. **Better Auth's module state is shared by every test file**, because vitest externalizes
>    node_modules to Node's ESM cache while re-evaluating source modules per file. The rate
>    limiter's `memory` Map is module-level, so the suite's HTTP sign-ups shared one 5-per-900s
>    bucket for `127.0.0.1` and two files failed with `sign-up failed: 429`. `vitest.config.ts`
>    now inlines Better Auth, which restores per-file isolation for about 3% of the suite runtime
>    (104.3s without, 107.8s with). `@better-auth/core`'s one-time NODE_ENV capture depended on
>    the same thing. Removing the inline today fails exactly one test - the production-semantics
>    guard - because the fixtures also got addresses of their own; the bucket sharing it insures
>    against no longer shows as a failure, and that is the point of insurance.
> 3. **The 403 the plan warned about is narrower than the plan said and wider than the first
>    correction said.** Measured, it fires when the method is not GET/HEAD/OPTIONS, and
>    `skipOriginCheck` is false, and there is neither `Origin` nor `Referer`, and EITHER a
>    `Cookie` is present - `originCheckMiddleware` is router-wide, so every auth path - OR any
>    `Sec-Fetch-*` is present with no cookie, which `formCsrfMiddleware` adds as an endpoint
>    `use:` on `/sign-in/email` and `/sign-up/email` only. Since **a browser sends `Sec-Fetch-*`
>    on every request**, "only with a cookie" was wrong in the direction that matters: the case
>    it excluded is the browser-shaped one. `inject` and curl send neither, which is why the
>    tests pass without `Origin`; they send it anyway, because a browser does. The lesson that
>    survives is the other one: assert every status in a sequence, never only the last.
> 4. **`@fastify/rate-limit` does not put `retry-after` on its error.** It sets the header on the
>    reply and throws an error with no `headers` at all, so the error handler's `err.headers`
>    forwarding (Phase B) is not what carries it. Removing that line fails only the two synthetic
>    equivalence cases; the real 429 keeps its header either way. The comment in `server.ts` and
>    the case name in `server.test.ts` have been corrected, and the real path now has a test.
>
> **Shape of what shipped.** Auth paths, keyed on `x-hearth-client-ip` (Fastify's resolved
> `req.ip`) and grouped by what the path does: guessing a credential (`/sign-in/email`,
> `/sign-in/social`, `/change-password`) 25 per 900s; sending a message to an address
> (`/sign-up/email`, `/send-verification-email`, `/change-email`, `/request-password-reset`) 15
> per 900s; every other auth path 100 per 60s. Global: 300 per minute per address, `/health`
> exempt via `config: { rateLimit: false }`.
>
> **The numbers are per household, not per person.** Five people behind one NAT address share
> one bucket, and the window is not a rolling quota - `decideConsume` pushes the expiry to
> `now + window` on every ALLOWED request, so the rule is "N requests, then 900 seconds of
> quiet". The plan's original 10/5 put an onboarding afternoon for a family of five exactly on
> the boundary, which is why these are higher; 25 per 900s is still about a tenth of what Better
> Auth's own default for those paths allows per hour.
>
> **Better Auth's built-in rules are not a safe fallback, and the custom list is exhaustive for
> that reason.** `getDefaultSpecialRules()` applies 3 per 10 seconds under `/sign-in`,
> `/sign-up`, `/change-password` and `/change-email`, and 3 per 60 seconds to
> `/request-password-reset` and `/send-verification-email` - which made the tightest limit on
> the box an endpoint a family hits while verifying addresses. Measured, four POSTs to
> `/send-verification-email` from one address: `200 200 200 429`. Every mounted path those rules
> catch now has a rule of its own, and a test per path says so. A path added later falls back to
> them silently, so a new auth surface means a new rule.
>
> **Refusals log one `warn` line each**, `{ limiter, remoteAddress }`, from `onExceeded` for the
> global cap and from the `/api/auth/*` route for Better Auth's, which answers its own 429
> without throwing. A wrong password is a 401 and logs nothing at `warn`.
>
> **The global cap attaches per ROUTE, and two things never reach a route.** @fastify/rate-limit
> hooks `onRoute`, so both of these were uncapped and both are closed:
>
> - **A path with no route**, closed with `setNotFoundHandler({ preHandler: app.rateLimit() })`.
> - **A CORS preflight**, which is the worse of the two and was found in review after this phase
>   first reported done. @fastify/cors answers OPTIONS from an INSTANCE-level `onRequest` hook,
>   and its source says why: so it can reply before authentication plugins. Fastify runs instance
>   hooks before route hooks, so cors replied 204 and the cap never ran, at any registration
>   order. Measured before the fix: 5000 preflights on one keep-alive connection in 1.02s, every
>   one a 204, zero 429s, 2.2MB of log. `apps/web/Caddyfile` proxies `/api/*` and `/trpc/*` by
>   any method, so it is reachable from the internet. Closed with an instance-level `onRequest`
>   hook registered before cors and gated to OPTIONS. The gate matters: ungated it would also
>   count `/health`, which an instance hook cannot see the route-level exemption for.
>
> **A refusal is thrown without a stack.** The plugin's default error is `new Error(...)` thrown
> inside node_modules, and `serializeError` renders its frames, so every refused request wrote
> the same three frames: 852 bytes of the 1418 one refusal cost. `errorResponseBuilder` returns
> the same message with `stack: ''`, which took a 5000-preflight flood from 1418 to 813 bytes a
> request. That halves a flood rather than solving one - the two `info` lines Fastify writes per
> request are inherent to request logging, so the bound on an unrotated json-file driver is a
> `logging:` block in the compose file. **Task 24 must add one.**
>
> **The limiter runs before the invite gate.** Better Auth's router calls `onRequestRateLimit` in
> `onRequest`, ahead of `processRequest` and therefore ahead of `hooks.before`, so a sign-up that
> `inviteOnly` refuses still spends budget. That is what bounds guessing at the first-boot setup
> token: five 403s and the sixth attempt is a 429.

### Task 15: Better Auth rate limiting on auth paths

**Files:**
- Modify: `apps/server/src/auth.ts`
- Create: `apps/server/src/auth-ratelimit.test.ts`

```ts
rateLimit: {
  enabled: true, // default is production-only; on always so tests and staging behave alike
  window: 60,
  max: 100,
  storage: 'memory',
  customRules: {
    '/sign-in/email': { window: 900, max: 10 },
    '/sign-up/email': { window: 900, max: 5 },
    '/request-password-reset': { window: 900, max: 5 },
  },
},
```

**Test:** the 11th sign-in attempt inside the window returns 429, and a different client IP is
unaffected (proving the key is the IP, not a global counter).

**Two traps. BOTH were recorded wrong in an earlier draft of this plan; these are the measured
rules, established by a 60-cell live matrix during the Phase E review. A per-IP test that misses
either passes while measuring nothing.**

1. **`getIp` returns `127.0.0.1` whenever Better Auth thinks it is under test**, so every request
   shares one bucket and a per-IP assertion proves nothing. `NODE_ENV=production` **is not
   sufficient**: `isTest()` is `nodeENV === 'test' || toBoolean(env.TEST)`, and **vitest sets
   `TEST=true`**. Delete `TEST` as well. (`nodeENV` is captured at import, so set both before the
   module graph loads.)

2. **`403 MISSING_OR_NULL_ORIGIN` fires under four conditions together**, not "any POST without an
   Origin" (over-broad, the original error) and not "only with a cookie" (under-broad, and wrong in
   the direction that bites):

   - the method is not GET / HEAD / OPTIONS; **and**
   - `skipOriginCheck` is false (so `NODE_ENV=production` *and* `TEST` unset) and
     `advanced.disableCSRFCheck` is unset; **and**
   - the request carries **neither** `Origin` **nor** `Referer`; **and**
   - **either** a `Cookie` header is present - any cookie, not just a session, via the router-wide
     `originCheckMiddleware`, which applies to **every** auth path - **or** no cookie but any
     `Sec-Fetch-*` header, via `formCsrfMiddleware`, which applies only to **`/sign-in/email` and
     `/sign-up/email`**.

   **A browser sends `Sec-Fetch-*` on every request**, so the no-cookie case is the browser-shaped
   one. A `curl` or `fetch` call that sends neither passes without a 403, which is why
   `auth-ratelimit.test.ts` is green - by luck, not design. Send `origin: <PUBLIC_URL>` on every
   injected request, and assert the whole status sequence rather than one status, so a request that
   starts 403ing for a different reason cannot masquerade as the behaviour under test.

   Three neighbours that look identical and are not: a `Referer` with no `Origin` gives
   `INVALID_ORIGIN`; `Sec-Fetch-Site: cross-site` with `Sec-Fetch-Mode: navigate` gives
   `CROSS_SITE_NAVIGATION_LOGIN_BLOCKED` **even with a valid Origin**; and on `/sign-up/email` the
   `inviteOnly` hook answers 403 *before* the CSRF middleware runs, so its 403 masks this one. That
   last case is exactly how an earlier verification script appeared to prove a guard worked while
   actually measuring a CSRF rejection.

Better Auth is already pointed at `x-hearth-client-ip` (Task 6). **Do not add `x-forwarded-for` to
that list**, and remember its default memory storage is per-process, so limits reset on restart.

Commit.

---

### Task 16: Global cap over everything else

**Files:**
- Modify: `apps/server/src/server.ts`

Run: `pnpm --filter @hearth/server add @fastify/rate-limit`

Register with a generous global limit (e.g. 300/minute) so a runaway or hostile client cannot
exhaust the box, and skip `/health` so container health checks are never throttled.

**Test:** `/health` survives well past the limit; an over-limit `/trpc` request returns 429.

Commit.

---

### Task 17: Manual verification behind a simulated proxy ✅

Run against a real server (`tsx src/server.ts`, `NODE_ENV=production`, `PUBLIC_URL`
`http://localhost:3111`, JSON logs), with `curl` playing the client and the header standing in
for the chain: `X-Forwarded-For: <forged>, <client>, 10.0.0.2` arriving on a socket from
127.0.0.1, which is the same shape D39's client -> nginx -> Caddy -> Fastify produces.

**At the shipped `TRUST_PROXY=2`.**

```
### attribution, from the server's own log
{"url":"/health","remoteAddress":"203.0.113.50"}
{"url":"/health","remoteAddress":"203.0.113.51"}
{"url":"/health","remoteAddress":"127.0.0.1"}      <- the probe that sent no header

### auth limiter: 12 sign-in attempts as client 203.0.113.50
401 401 401 401 401 401 401 401 401 401 429 429
### the same window, client 203.0.113.51
401
### client 203.0.113.50 rotating the forged leftmost entry, 3 attempts
429 429 429

### the 429 a client sees
HTTP/1.1 429 Too Many Requests
x-retry-after: 900
body: {"message":"Too many requests. Please try again later."}

### global cap: 305 requests to an unrouted path as 203.0.113.60
counts: 300 404, 5 429
### the same client, /health
200 200 200
### a different client, same window
404
### the 429 a client sees
HTTP/1.1 429 Too Many Requests
x-ratelimit-limit: 300  x-ratelimit-remaining: 0  x-ratelimit-reset: 60  retry-after: 60
body: {"statusCode":429,"error":"Too Many Requests","message":"Rate limit exceeded, retry in 1 minute"}

### setup-token guessing, wrong token, fresh client
403 403 403 403 403 429      (accounts created: 0)

### every warn line the run produced
6 auth   203.0.113.50
1 auth   203.0.113.70
6 global 203.0.113.60
5 global 127.0.0.1           <- the no-header case below
```

Both limiters key on the forwarded client. Neither ever attributed a request to 10.0.0.2 or to
127.0.0.1 while the header was present.

**The two ways the hop count can be wrong, both reproduced.**

- `TRUST_PROXY=3` against a two-proxy chain: 14 sign-in attempts with the forged leftmost entry
  rotated returned `401` fourteen times and never a 429, because the server attributed each one
  to a different attacker-chosen address (`9.9.9.1` ... `9.9.9.14` in the log). One hop too many
  hands the rate-limit key to the client.
- `TRUST_PROXY=1` against the same chain: ten attempts from one household member and the
  eleventh request, from a **different** member, got `429`. All eleven were logged as
  `10.0.0.2`. One hop too few is the lockout this milestone has warned about three times.
- No `X-Forwarded-For` at all, which is what Caddy sends today for an untrusted peer: 300
  requests exhausted the shared `127.0.0.1` bucket and three notionally different clients all
  got `429`.

**One consequence worth stating plainly.** On the box as it ships today, the limiter is right
and the Caddyfile is wrong, and the combination is remotely triggerable: because Caddy sends no
`X-Forwarded-For`, every client collapses into one bucket, so a stranger can spend the
household's sign-in budget and lock everyone out for fifteen minutes. Measured: ten failed
sign-ins from a stranger, then a household member with the CORRECT password gets 429. Task 24 is
therefore a prerequisite for exposing the box, not a tidy-up.

**Phase F, two shapes to expect.** The two limiters answer differently: the global cap sends
standard `retry-after` (seconds) with a Fastify error body, and Better Auth sends only
`X-Retry-After` with `{"message":"Too many requests. Please try again later."}` as
`content-type: text/plain;charset=UTF-8` - JSON in a text/plain envelope, because it builds a
`Response` from a string and sets no type. Parse without trusting the header, and read both
retry headers.

**What this cannot verify, and Task 24 must.** Everything above proves the Fastify layer resolves
and keys on the address it is *given*. It cannot prove the deployment gives it the right one:
per D39 the real Caddy **replaces** `X-Forwarded-For` for peers absent from `trusted_proxies`,
which is unset. Until `trusted_proxies static private_ranges` is in `apps/web/Caddyfile`, the
deployed chain is the third case above - every household member in one bucket - and no
`TRUST_PROXY` value can recover an address Caddy discarded. Task 24 must set that, keep
`TRUST_PROXY=2` matching the real hop count, bind the web container's published port off
`0.0.0.0` (trusting private ranges means any host that can reach Caddy directly can forge the
header), and re-run this check end to end from a third machine.

---

## Phase F — Web surfaces

### Task 18: Household settings screen

**Files:**
- Create: `apps/web/src/routes/Household.tsx`, `Household.module.css`, `Household.test.tsx`
- Modify: `apps/web/src/App.tsx` (replace the `More` stub with `Household` at `/more`)

Member list with roles, pending invitations with revoke, and an invite-by-email form.
Owner-only controls hidden for members. Follow the existing screens' patterns for tRPC
queries/mutations and the design tokens in `apps/web/src/styles/tokens.css`.

**Tests** (React Testing Library, matching `ShoppingList.test.tsx`'s style): the form submits
the typed email; a member does not see the invite form; a failed invite surfaces its error
rather than failing silently.

Commit.

---

### Task 19: Accept-invitation route

**Files:**
- Create: `apps/web/src/routes/AcceptInvite.tsx`, `AcceptInvite.test.tsx`
- Modify: `apps/web/src/App.tsx`

Route `/accept-invite/:invitationId`, rendered **outside** `AppShell` and reachable while
signed out. States to handle explicitly, each with its own test:
- not signed in → name + password form → sign up → accept → land in the household
- already signed in as the invited address → single Accept button
- signed in as a **different** address → explain, offer sign out
- invitation expired, revoked, or unknown → plain explanation, no stack trace

Commit.

---

### Task 20: Sign-in copy reflects invite-only

**Files:**
- Modify: `apps/web/src/routes/SignIn.tsx`

Remove or disable any self-service "create account" affordance and say plainly that Hearth is
invite-only. A stranger hitting the URL should understand why they cannot register.

Commit.

---

### Task 21: E2E - invitation happy path

**Files:**
- Create: `e2e/invite.spec.ts`

**First, `e2e/grocery-mvp.spec.ts` is broken and must be fixed here.** Phase D made signup return
no session (`requireEmailVerification` suppresses it) and put invited users straight into the
household, so the existing spec's "sign up, land on Onboarding" flow no longer happens. CI does not
run e2e (`ci.yml` is lint/typecheck/test only), which is exactly why it went unnoticed - do not
treat a green CI as evidence this passes.

Then the new path: owner signs in → invites an address → the invitation link is read from the
`MemoryMailer`/console transport → a second browser context opens it, sets a password, and lands in
the household → that new member sees the household's recipes.

Follow `e2e/grocery-mvp.spec.ts` for setup. E2E remains out of CI (a known deferral); note in
the completion banner that it was run locally.

Commit.

---

### Task 13c: A removed member must lose their session ✅ DONE 2026-09-09

Found during Phase F, verified against the real database and the real routers.

Better Auth clears `session.activeOrganizationId` **only when a user removes themselves**
(`crud-members.mjs` ~line 85). When the owner removes someone else, that person's session row keeps
its `activeOrganizationId`, `protectedProcedure` derives `ctx.householdId` from it, and RLS keys off
the same value. So **a removed member keeps recipe and shopping-list access until their session
expires, seven days by default.** Confirmed: after removal, `recipe.list` returned the household's
recipes for the removed member.

The `household` router itself refuses them, because it re-derives membership through Better Auth on
every call. That is exactly why this looked closed. Everything that trusts `ctx.householdId` does
not. Phase F's client-side sign-out is a courtesy, not a control - it only fires if the removed
person opens the settings screen.

**This is the third instance of one pattern, and the pattern is now the finding:**

| Where | The rule | The road around it |
|---|---|---|
| Household cap (D41) | checked in the app | two concurrent writers |
| Invitation role (Task 13 C1) | enforced in the tRPC router | `/api/auth/organization/invite-member` |
| Membership (here) | re-derived in one router | every other router, via `ctx.householdId` |

Each time the rule was real, tested, and enforced in one place while a second path reached the same
state. **An invariant belongs where every writer must pass**: the database for the first, Better
Auth's own middleware for the second, and for this one, wherever a membership actually ends - which
includes `/organization/leave` and the raw `remove-member` endpoint, not just the tRPC router.

> **Done, and the layer is the database.** Migration 0006 adds `member_loses_the_household`, an
> immediate `AFTER DELETE` trigger on `member` that nulls `session.active_organization_id` for that
> user and that household. Four things decided it, all checked against `better-auth@1.6.19`:
>
> 1. **`databaseHooks` cannot reach `member`.** The option only has `user`, `session`, `account`
>    and `verification` (`@better-auth/core/dist/types/init-options.d.mts`). The plugin's own
>    `organizationHooks.afterRemoveMember` does exist, but `/organization/leave` calls
>    `adapter.deleteMember` and never invokes it, so a hook there covers three of the four roads a
>    `member` row goes and runs outside the delete's transaction besides.
> 2. **It is not two writes.** A trigger runs inside the statement that fired it, so there is no
>    second statement to fail and leave the membership gone with the session still naming the
>    household. Proved both ways: roll the delete back and the session's household comes back with
>    it, and a removal the deferred `member_keeps_an_owner` refuses at COMMIT takes the session
>    update down with it.
> 3. **Which sessions:** the removed person's, and only those naming the household they left.
>    `/organization/leave` and the self-removal branch of `remove-member` clear only the session
>    that made the request, so the second device was the case Better Auth misses; a session naming
>    another household is not stale, and one naming nothing is already refused by
>    `protectedProcedure`.
> 4. **The row survives; the household comes off it.** Removal from a household is not a sign-out,
>    the web app already renders `<Onboarding />` for an account with no household and keeps
>    `/accept-invite/:id` outside the session gate, and deleting the row would leave Better Auth's
>    own `setActiveOrganization(token, null)` updating a row that no longer exists.
>
> The migration also backfills: it nulls every session naming a household its user is not a member
> of, so an instance where someone was already removed does not carry the hole forward. Verified by
> hand against a stale row, since migrations run before the suite does.
>
> Reproduced before the fix through the real routers and real cookies: `recipe.list` resolved for a
> removed member, and `GET /trpc/recipe.list` answered **200** to their cookie after removal
> through both `/api/auth/organization/remove-member` and `/api/auth/organization/leave`. With the
> trigger dropped, 9 tests fail; the two raw-path ones fail on `expected 200 to be 403`.

---

## Phase G — Ship it

### Task 22: Identity-separation audit (before anything is published)

Run the identity-separation audit defined in the author's global operating rules, over the
**full history** rather than the working tree, and paste the output into the completion notes.
Screen two things: commit authorship (`git log --all --format='%an %ae %cn %ce' | sort -u`) and
file contents across every reachable commit.

The patterns to screen for live in that global rule and are deliberately **not** restated here.
Writing them into this repo would plant the exact strings the audit exists to keep out - an
earlier draft of this plan made that mistake and had to be rebuilt.

**If either check finds a hit, STOP.** Report it and do not rewrite shared history unannounced.
Publishing images makes this namespace externally visible, so this gate comes before Task 23.

---

### Task 23: GHCR publishing workflow

**Files:**
- Create: `.github/workflows/publish.yml`

Build and push `ghcr.io/charleslewisdev/hearth-server` and `ghcr.io/charleslewisdev/hearth-web`
on pushes to `main` and on `v*` tags, `linux/amd64`, using `GITHUB_TOKEN` with `packages: write`.
Tag both `latest` and the short SHA.

**Not** Docker Hub, and **not** the author's other registry namespace (D34).

Commit.

---

### Task 24: unraid templates and deployment docs

**Files:**
- Create: `deploy/unraid/hearth-db.xml`, `hearth-server.xml`, `hearth-web.xml`
- Create: `deploy/unraid/README.md`
- Modify: `docker-compose.yml` (named `hearth` network, `PUBLIC_URL`, `DATA_DIR` volume, SMTP passthrough)
- Modify: `apps/web/Caddyfile` (correct the now-wrong automatic-TLS comment per D35)

**Set `NODE_ENV=production` on the server container.** Found during Task 1: nothing in the
Dockerfile or the compose files sets it, so it defaults to `development` and the deployed
container would emit pretty, colorized logs instead of the JSON a log collector can parse.
The same variable arms the dev-secret refusal from Task 5, so leaving it unset silently
disables that guard too. (Task 1 also moved `pino-pretty` into `dependencies`, so an unset
`NODE_ENV` no longer crashes at boot - but it still produces the wrong output.)

All three templates join a dedicated `hearth` bridge network; **Postgres publishes no host port**
(D37). The README covers, in order: `docker network create hearth`, start the DB, set `PUBLIC_URL`
and SMTP, start the server, start the web container, then point nginx at it - including the
`proxy_set_header X-Forwarded-Proto $scheme` line that makes secure cookies work, and a note that
the appdata path `/mnt/user/appdata/hearth/` holds the generated auth secret and must persist.

**Pass the SMTP variables through, flagged by Phase C.** `docker-compose.yml` forwards no
`SMTP_*` at all, so every setting documented in `.env.example` is unreachable from inside the
container and the mailer silently stays in console mode no matter what the operator configures.
The unraid template needs the same fields. Until this lands, SMTP is undeliverable through the
documented install path, which makes console mode not a fallback but the only mode.

**Migrate the env surface, flagged by Phase B.** Three concrete items, all of which make the
Phase B work unreachable through the shipped deployment if left alone:

1. **`docker-compose.yml` still pins `BETTER_AUTH_SECRET: ${BETTER_AUTH_SECRET:-dev-secret-change-me-min-32-chars-long}`.** First-boot generation is therefore unreachable through compose, and there is no volume for `DATA_DIR`, so a generated secret would die with the container and log every household member out on restart. Compose also sets no `NODE_ENV`, so the production refusal built in Task 5 never fires. Fix all three together: drop the secret default, mount `DATA_DIR`, set `NODE_ENV=production`.
2. **`BETTER_AUTH_URL` is now read by nothing but is still `required` in the env schema**, and `WEB_ORIGIN` survives only as a `PUBLIC_URL` fallback. An operator following `PUBLIC_URL`-only docs hits `BETTER_AUTH_URL: Required` for a value nothing uses. Make both optional (or drop them), and keep the fallback documented.
3. **An empty env value is not an absent one.** Phase B found `z.coerce.number()` reads `''` as `0`, so a blank `TRUST_PROXY` from `${VAR:-}` or an untouched unraid template field would have silently disabled proxy trust. `env.ts` now preprocesses empty to absent - when writing the unraid templates, still prefer omitting a variable over shipping it blank, and check any new numeric or boolean field for the same trap.

> ### ⚠ Task 24 is a PREREQUISITE FOR EXPOSING THE BOX, not a tidy-up
>
> Measured during the Phase E review, against the stack exactly as it ships today:
>
> ```
> stranger, 10 failed sign-ins (no XFF, which is what Caddy sends today):  401 x10
> household member, CORRECT credentials, next request:                     429
> ```
>
> Because Caddy replaces `X-Forwarded-For` for untrusted peers, every client collapses into one
> rate-limit bucket. **Any internet client can lock the entire household out of sign-in for 15
> minutes with 11 requests.** That is a remotely-triggerable denial of service, and no
> `TRUST_PROXY` value fixes it - the address is gone before Fastify sees it.
>
> The limiter is right and the Caddyfile is wrong. Phase E is safe on a LAN and unsafe on the
> open internet until the `trusted_proxies` change below lands and is verified from a third
> machine.

**Fix the proxy chain (D39). This is the load-bearing part of this task.** The Task 2 quality
review ran the real `caddy:2-alpine` image against this repo's Caddyfile and found Caddy
**replaces** `X-Forwarded-For` and `X-Forwarded-Proto` for peers absent from `trusted_proxies`,
which is unset by default:

```
sent:          X-Forwarded-For: 203.0.113.9   X-Forwarded-Proto: https
upstream saw:  xff=127.0.0.1  xfp=http
```

Untreated, that means every rate-limit key in Task 16 resolves to nginx and throttles all users as
one, and `X-Forwarded-Proto` arrives as `http`, which defeats the secure-cookie derivation from
Task 4. **No `trustProxy` hop count can recover an address Caddy discarded.** Add
`trusted_proxies static private_ranges` to the reverse-proxy blocks in `apps/web/Caddyfile` so
Caddy appends instead of replacing, and set `TRUST_PROXY=2`. Then **bind the web container's
published port to the host loopback or the docker network rather than `0.0.0.0`**, since trusting
private ranges means any host that can reach Caddy directly can forge the header. Verify end to
end with a forged `X-Forwarded-For` from a third machine before calling this done.

**Add lifecycle handlers to `server.ts`** while deploying, flagged by the same review: there is no
`SIGTERM` handler calling `app.close()`, so a container restart drops in-flight requests and
Postgres connections, and no `unhandledRejection` / `uncaughtException` handler, so a failure after
startup exits with no fatal line at all. On a headless box that is the difference between a
diagnosable crash and a mystery.

Include `proxy_set_header X-Request-ID $request_id;` too. Task 2 accepts a client-supplied
`x-request-id` when it matches `^[A-Za-z0-9_-]{1,64}$`, precisely so nginx's `$request_id` flows
through and one id correlates the nginx access log with Hearth's own lines. Without that header
the correlation silently does not happen, and nothing in the test suite can catch it because there
is no nginx in this repo.

Commit.

---

### Task 25: Close out

- Update `docs/plans/2026-06-19-p0-deferred-and-hardening.md`: mark 🔴 items 1–4 done.
- Update `docs/ROADMAP.md`: P0.5 ✅ with a completion banner and a session-log entry.
- Run the full gate: `pnpm test:local && pnpm typecheck && pnpm lint && pnpm build`.
- Paste real output into the completion banner. **Do not claim green without it.**

---

## Definition of done

- [ ] `pnpm test:local`, `pnpm typecheck`, `pnpm lint`, `pnpm build` all green, output pasted
- [ ] Invitation round-trip verified end to end, locally, in a browser
- [ ] Rate limits verified to key on the forwarded IP, not nginx's
- [ ] Booting with `NODE_ENV=production` and the dev secret exits non-zero
- [ ] Console mailer path verified with no SMTP configured
- [ ] Identity audit clean, output pasted
- [ ] Images build and push to GHCR under `charleslewisdev`
