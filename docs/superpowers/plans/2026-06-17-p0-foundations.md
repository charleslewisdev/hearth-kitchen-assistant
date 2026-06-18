# Hearth P0 — Foundations Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Stand up the Hearth monorepo so a logged-in user, scoped to a household, can sign in through a React PWA that renders the Fresh Market app shell and reads/writes household-scoped data through a typed tRPC API backed by Postgres — all reproducible via `docker compose up` and gated by green CI.

**Architecture:** A pnpm-workspace monorepo. Pure domain logic lives in `packages/shared` (Vitest, TDD). `apps/server` is Fastify + tRPC + Better Auth (email/password + Organizations = households) + Drizzle/Postgres, with **every domain query forced through a household-scoped repository layer** so tenant isolation is structural, not per-caller discipline. `apps/web` is React + Vite as an installable PWA carrying the semantic design tokens and the responsive shell (bottom tabs on phone, left rail on desktop) from the UI spec. This plan resolves the previously-open "Better Auth ↔ Drizzle" integration question: Better Auth owns the auth/org tables via its Drizzle adapter; domain tables carry `household_id` referencing the Better Auth `organization.id`.

**Tech Stack:** pnpm workspaces · TypeScript 5 (strict) · Vitest · Fastify 5 · tRPC 11 · Better Auth (+ organization plugin, Drizzle adapter) · Drizzle ORM + drizzle-kit · node-postgres (`pg`) · Postgres 16 · React 18 + Vite 5 + `vite-plugin-pwa` · Docker Compose · GitHub Actions.

## Global Constraints

- **Node:** `>=20` (set `engines.node` and CI matrix to 20).
- **Package manager:** **pnpm only** (workspaces). Never `npm install`/`yarn`.
- **TypeScript:** `strict: true` everywhere; avoid `any` without an inline justification comment (per CLAUDE.md).
- **Tenancy (non-negotiable):** every domain table has a `household_id text not null`; **no domain query may run without a household id** — all domain reads/writes go through the repository layer in Task 8, never raw Drizzle from routers.
- **Lookups return null, don't throw** (per CLAUDE.md) for not-found.
- **Conventional commits**, no emojis, no Claude attribution (per CLAUDE.md `code/CLAUDE.md`).
- **AI-optional:** nothing in P0 may call an external AI/LLM/OCR service.
- **Design tokens:** web components reference semantic CSS custom properties only — never raw hex (UI spec §0, Decision 24).
- **CI gates on green:** lint + typecheck + tests must pass before merge (Decision 11).

---

## Risks & decisions to confirm before executing (read first)

A stress test of this plan (2026-06-18) surfaced the following. Each is also flagged inline at the task where it bites — this list is the index.

**Validate before you trust the plan:**

- **🔴 Spike the Better Auth ↔ Fastify integration first (Task 6).** Highest-uncertainty, highest-dependency piece: every task after 6 assumes a working sign-up → cookie → session round-trip *in a real browser*. Prove it in isolation before building on it. Prefer Better Auth's documented Node/Fastify handler over the hand-rolled `Request` adapter, and forward `Set-Cookie` via `res.headers.getSetCookie()` (a Web `Headers` object comma-joins multiple Set-Cookie values and corrupts the session cookie).
- **🔴 Cross-origin cookies between `:5173` and `:3000` will not work in the browser (Tasks 9, 10).** Default `SameSite=Lax` cookies are not sent on cross-site fetch, so the in-process `app.inject` tests pass while the real browser session silently fails. Serve the API through a **Vite dev proxy** so the browser sees same-origin relative URLs.
- **🔴 P0 has no onboarding path (Task 10).** A fresh user can sign in but there is no sign-up, no create-household, no set-active-organization in the UI — so they hit `FORBIDDEN` with no way out. The "land in a household" exit criterion is otherwise met only by the test harness. Task 10 now includes the onboarding slice.

**Decisions to make consciously (cheap now, expensive later):**

- **🟠 Tenant isolation is enforced by repo-layer convention, not structurally (Task 7).** One forgotten `where(householdId)` leaks across households. Decide *now*: add the `no-restricted-imports` lint guard (Task 7 Step 6), and either adopt Postgres **Row-Level Security** as defense-in-depth or consciously defer it with reasons. Retrofitting RLS after ~15 tables exist is the expensive path.
- **🟠 The P0 `recipes` table is disposable scaffolding, not the Decision 9 structured-core model.** It proves the stack end-to-end; P1 replaces it. Treat it as throwaway to avoid sunk-cost attachment.
- **🟠 "Deployed via `docker compose up`" is not delivered by P0 as written.** Compose contains Postgres only; server + web run via `pnpm dev`, with no app container, migrate-on-boot, or TLS. Either pull app containerization into P0 or amend the ROADMAP P0 exit criterion to match. For a non-technical-first product whose #1 principle is one-command install, this is a scope decision, not a footnote. See Exit Criterion.

**Strategic questions (bigger than P0)** are logged in [DECISION_LOG.md](../../DECISION_LOG.md) (pending section) + the [ROADMAP.md](../../ROADMAP.md) backlog — they don't block P0 but should be answered before the phases that depend on them: the non-technical-audience-vs-self-host tension, solo-build scope / "dogfood line", sale-ad T1 input availability, and pulling data export earlier.

---

## File Structure

```
hearth/
  package.json                      # root: workspace scripts, devDeps (pnpm, vitest, eslint, prettier, typescript)
  pnpm-workspace.yaml               # packages: 'packages/*', 'apps/*'
  tsconfig.base.json                # shared strict compiler options
  vitest.workspace.ts               # runs all package/app test projects
  .eslintrc.cjs / .prettierrc       # lint + format
  docker-compose.yml                # Postgres 16 service (+ app later)
  .env.example                      # DATABASE_URL, BETTER_AUTH_SECRET, etc.
  .github/workflows/ci.yml          # install → lint → typecheck → test (Postgres service)

  packages/shared/
    package.json
    tsconfig.json
    src/index.ts                    # public exports
    src/slug.ts                     # slugify() — first pure-domain unit
    src/slug.test.ts

  apps/server/
    package.json
    tsconfig.json
    drizzle.config.ts               # drizzle-kit config
    src/env.ts                      # zod-validated env loader
    src/db/client.ts                # pg Pool + drizzle() instance
    src/db/auth-schema.ts           # Better Auth tables (generated)
    src/db/schema.ts                # domain tables (recipes) + re-export auth-schema
    src/auth.ts                     # Better Auth instance (org plugin + drizzle adapter)
    src/repo/recipes.ts             # household-scoped recipe repository
    src/repo/recipes.test.ts        # tenant-isolation tests
    src/trpc/context.ts             # tRPC context (db, session, householdId)
    src/trpc/trpc.ts                # initTRPC, publicProcedure, protectedProcedure
    src/trpc/routers/recipe.ts      # recipe.list / recipe.create
    src/trpc/routers/index.ts       # appRouter (+ AppRouter type export)
    src/server.ts                   # Fastify boot: auth handler, tRPC plugin, health
    src/server.test.ts              # health + protected-route integration tests
    test/db.ts                      # test DB helper (migrate, truncate)

  apps/web/
    package.json
    tsconfig.json
    vite.config.ts                  # React + PWA plugin
    index.html
    src/main.tsx                    # providers (theme, trpc, query)
    src/styles/tokens.css           # Fresh Market semantic tokens (light + dark)
    src/theme/ThemeProvider.tsx     # light/dark/system, data-theme on root
    src/lib/trpc.ts                 # tRPC react client (typeof AppRouter)
    src/lib/auth.ts                 # Better Auth react client
    src/app/AppShell.tsx            # bottom tabs (mobile) / left rail (desktop)
    src/app/AppShell.module.css
    src/routes/Recipes.tsx          # minimal: lists recipes, add form (proves vertical slice)
    src/routes/SignIn.tsx           # email/password sign-in
    src/App.tsx                     # auth gate → SignIn or AppShell
```

Tasks are ordered so each builds on the prior and ends with an independently testable deliverable.

---

### Task 1: Monorepo scaffolding

**Files:**
- Create: `package.json`, `pnpm-workspace.yaml`, `tsconfig.base.json`, `vitest.workspace.ts`, `.eslintrc.cjs`, `.prettierrc`
- Modify: `.gitignore` (add `node_modules`, `dist`, `.env`)

**Interfaces:**
- Produces: root scripts `pnpm -r build`, `pnpm -r typecheck`, `pnpm test`, `pnpm lint` usable by every later task and CI.

- [ ] **Step 1: Create `pnpm-workspace.yaml`**

```yaml
packages:
  - 'packages/*'
  - 'apps/*'
```

- [ ] **Step 2: Create root `package.json`**

```json
{
  "name": "hearth",
  "private": true,
  "type": "module",
  "engines": { "node": ">=20" },
  "scripts": {
    "build": "pnpm -r build",
    "typecheck": "pnpm -r typecheck",
    "test": "vitest run",
    "test:watch": "vitest",
    "lint": "eslint . --ext .ts,.tsx",
    "format": "prettier --write ."
  },
  "devDependencies": {
    "typescript": "^5.5.0",
    "vitest": "^2.0.0",
    "eslint": "^8.57.0",
    "@typescript-eslint/eslint-plugin": "^7.0.0",
    "@typescript-eslint/parser": "^7.0.0",
    "prettier": "^3.3.0"
  }
}
```

- [ ] **Step 3: Create `tsconfig.base.json`**

```json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "ESNext",
    "moduleResolution": "Bundler",
    "strict": true,
    "noUncheckedIndexedAccess": true,
    "esModuleInterop": true,
    "skipLibCheck": true,
    "declaration": true,
    "forceConsistentCasingInFileNames": true
  }
}
```

- [ ] **Step 4: Create `vitest.workspace.ts`**

```ts
export default ['packages/*', 'apps/*'];
```

- [ ] **Step 5: Create `.eslintrc.cjs` and `.prettierrc`**

```js
// .eslintrc.cjs
module.exports = {
  root: true,
  parser: '@typescript-eslint/parser',
  parserOptions: { ecmaVersion: 2022, sourceType: 'module', ecmaFeatures: { jsx: true } },
  plugins: ['@typescript-eslint'],
  extends: ['eslint:recommended', 'plugin:@typescript-eslint/recommended'],
  env: { node: true, browser: true, es2022: true },
  ignorePatterns: ['dist', 'node_modules', '*.config.*'],
};
```

```json
// .prettierrc
{ "singleQuote": true, "semi": true, "printWidth": 100 }
```

> ⚠️ `ecmaFeatures.jsx` is required or ESLint throws when parsing the `.tsx` files added in Tasks 9–10 (a CI lint gate). Add `eslint-plugin-react-hooks` later if you want hook-rule coverage.

- [ ] **Step 6: Append to `.gitignore`**

```
node_modules/
dist/
.env
```

- [ ] **Step 7: Install and verify the workspace resolves**

Run: `pnpm install`
Expected: completes without error; creates `pnpm-lock.yaml`.

- [ ] **Step 8: Commit**

```bash
git add -A
git commit -m "chore: scaffold pnpm monorepo with typescript, vitest, eslint"
```

---

### Task 2: `packages/shared` + first TDD unit (`slugify`)

Proves the pure-domain TDD harness (Decision 11) with a genuinely useful function (recipe slugs, reused by web routes and future sharing).

**Files:**
- Create: `packages/shared/package.json`, `packages/shared/tsconfig.json`, `packages/shared/src/index.ts`, `packages/shared/src/slug.ts`
- Test: `packages/shared/src/slug.test.ts`

**Interfaces:**
- Produces: `slugify(input: string): string` — lowercases, trims, replaces non-alphanumerics with single hyphens, strips leading/trailing hyphens. Exported from `@hearth/shared`.

- [ ] **Step 1: Create `packages/shared/package.json`**

```json
{
  "name": "@hearth/shared",
  "version": "0.0.0",
  "type": "module",
  "main": "./src/index.ts",
  "types": "./src/index.ts",
  "exports": { ".": "./src/index.ts" },
  "scripts": {
    "build": "tsc -p tsconfig.json",
    "typecheck": "tsc -p tsconfig.json --noEmit"
  }
}
```

- [ ] **Step 2: Create `packages/shared/tsconfig.json`**

```json
{
  "extends": "../../tsconfig.base.json",
  "compilerOptions": { "outDir": "dist", "rootDir": "src" },
  "include": ["src"]
}
```

- [ ] **Step 3: Write the failing test — `packages/shared/src/slug.test.ts`**

```ts
import { describe, it, expect } from 'vitest';
import { slugify } from './slug';

describe('slugify', () => {
  it('lowercases and hyphenates words', () => {
    expect(slugify('Tuscan White Bean Soup')).toBe('tuscan-white-bean-soup');
  });
  it('collapses runs of non-alphanumerics to one hyphen', () => {
    expect(slugify('Mac  &  Cheese!!')).toBe('mac-cheese');
  });
  it('trims leading and trailing separators', () => {
    expect(slugify('  --Hello--  ')).toBe('hello');
  });
  it('returns empty string for input with no alphanumerics', () => {
    expect(slugify('!!!')).toBe('');
  });
});
```

- [ ] **Step 4: Run the test to verify it fails**

Run: `pnpm vitest run packages/shared/src/slug.test.ts`
Expected: FAIL — cannot find module `./slug` / `slugify is not defined`.

- [ ] **Step 5: Implement `packages/shared/src/slug.ts`**

```ts
export function slugify(input: string): string {
  return input
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}
```

- [ ] **Step 6: Export from `packages/shared/src/index.ts`**

```ts
export { slugify } from './slug';
```

- [ ] **Step 7: Run the test to verify it passes**

Run: `pnpm vitest run packages/shared/src/slug.test.ts`
Expected: PASS (4 tests).

- [ ] **Step 8: Commit**

```bash
git add packages/shared
git commit -m "feat(shared): add slugify with test suite"
```

---

### Task 3: Docker Compose Postgres + env loader

**Files:**
- Create: `docker-compose.yml`, `.env.example`, `apps/server/package.json`, `apps/server/tsconfig.json`, `apps/server/src/env.ts`
- Test: covered by Task 4's server test (env is consumed there); this task's deliverable is a reachable Postgres + a validated env module.

**Interfaces:**
- Produces: `env` object with `DATABASE_URL: string`, `BETTER_AUTH_SECRET: string`, `BETTER_AUTH_URL: string`, `WEB_ORIGIN: string`, `PORT: number`. Throws at startup if any required var is missing/invalid.

- [ ] **Step 1: Create `docker-compose.yml`**

```yaml
services:
  db:
    image: postgres:16
    environment:
      POSTGRES_USER: hearth
      POSTGRES_PASSWORD: hearth
      POSTGRES_DB: hearth
    ports:
      - '5432:5432'
    volumes:
      - hearth_pg:/var/lib/postgresql/data
    healthcheck:
      test: ['CMD-SHELL', 'pg_isready -U hearth']
      interval: 5s
      timeout: 5s
      retries: 10
volumes:
  hearth_pg:
```

- [ ] **Step 2: Create `.env.example`**

```
DATABASE_URL=postgres://hearth:hearth@localhost:5432/hearth
BETTER_AUTH_SECRET=dev-secret-change-me-min-32-chars-long
BETTER_AUTH_URL=http://localhost:3000
WEB_ORIGIN=http://localhost:5173
PORT=3000
```

- [ ] **Step 3: Create `apps/server/package.json`**

```json
{
  "name": "@hearth/server",
  "version": "0.0.0",
  "type": "module",
  "scripts": {
    "dev": "tsx watch src/server.ts",
    "build": "tsc -p tsconfig.json",
    "typecheck": "tsc -p tsconfig.json --noEmit",
    "db:generate": "drizzle-kit generate",
    "db:migrate": "drizzle-kit migrate"
  },
  "dependencies": {
    "@hearth/shared": "workspace:*",
    "fastify": "^5.0.0",
    "@fastify/cors": "^10.0.0",
    "@trpc/server": "^11.0.0",
    "better-auth": "^1.2.0",
    "drizzle-orm": "^0.36.0",
    "pg": "^8.13.0",
    "zod": "^3.23.0"
  },
  "devDependencies": {
    "tsx": "^4.19.0",
    "drizzle-kit": "^0.28.0",
    "@types/pg": "^8.11.0"
  }
}
```

- [ ] **Step 4: Create `apps/server/tsconfig.json`**

```json
{
  "extends": "../../tsconfig.base.json",
  "compilerOptions": { "outDir": "dist", "rootDir": "src" },
  "include": ["src"]
}
```

- [ ] **Step 5: Create `apps/server/src/env.ts`**

```ts
import { z } from 'zod';

const schema = z.object({
  DATABASE_URL: z.string().url(),
  BETTER_AUTH_SECRET: z.string().min(32),
  BETTER_AUTH_URL: z.string().url(),
  WEB_ORIGIN: z.string().url(),
  PORT: z.coerce.number().default(3000),
});

export const env = schema.parse(process.env);
export type Env = z.infer<typeof schema>;
```

- [ ] **Step 6: Install deps and start Postgres**

Run: `pnpm install && cp .env.example .env && docker compose up -d db`
Expected: `db` container reports healthy (`docker compose ps` shows healthy).

- [ ] **Step 7: Commit**

```bash
git add docker-compose.yml .env.example apps/server/package.json apps/server/tsconfig.json apps/server/src/env.ts
git commit -m "chore(server): add postgres compose service and validated env loader"
```

---

### Task 4: Fastify server skeleton + health route

**Files:**
- Create: `apps/server/src/server.ts`
- Test: `apps/server/src/server.test.ts`

**Interfaces:**
- Produces: `buildServer(): Promise<FastifyInstance>` — constructs the app (CORS for `WEB_ORIGIN`, a `GET /health` route returning `{ status: 'ok' }`). Later tasks register the auth handler and tRPC plugin inside this function.

- [ ] **Step 1: Write the failing test — `apps/server/src/server.test.ts`**

```ts
import { describe, it, expect, afterAll, beforeAll } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildServer } from './server';

let app: FastifyInstance;
beforeAll(async () => { app = await buildServer(); });
afterAll(async () => { await app.close(); });

describe('health', () => {
  it('GET /health returns ok', async () => {
    const res = await app.inject({ method: 'GET', url: '/health' });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ status: 'ok' });
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `pnpm vitest run apps/server/src/server.test.ts`
Expected: FAIL — cannot find module `./server`.

- [ ] **Step 3: Implement `apps/server/src/server.ts`**

```ts
import Fastify, { type FastifyInstance } from 'fastify';
import cors from '@fastify/cors';
import { env } from './env';

export async function buildServer(): Promise<FastifyInstance> {
  const app = Fastify({ logger: false });
  await app.register(cors, { origin: env.WEB_ORIGIN, credentials: true });
  app.get('/health', async () => ({ status: 'ok' }));
  return app;
}

// Entry point (not run during tests)
if (process.env.NODE_ENV !== 'test' && process.argv[1]?.endsWith('server.ts')) {
  buildServer().then((app) =>
    app.listen({ port: env.PORT, host: '0.0.0.0' }).then(() => {
      // eslint-disable-next-line no-console -- startup log
      console.log(`server on :${env.PORT}`);
    }),
  );
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `pnpm vitest run apps/server/src/server.test.ts`
Expected: PASS. (Test sets `NODE_ENV=test` via Vitest default; the env loader needs `.env` values — Vitest loads `.env` is NOT automatic, so ensure the test process has env. Add `apps/server/vitest.config.ts` if needed — see next step.)

- [ ] **Step 5: Ensure env is present for tests — create `apps/server/vitest.config.ts`**

```ts
import { defineConfig } from 'vitest/config';
import { config } from 'dotenv';
import { fileURLToPath } from 'node:url';
// Resolve relative to THIS file, not process.cwd(): root `pnpm test` runs from the repo root,
// where '../../.env' would point above the repo. In CI there is no .env file and the vars come
// from the job env, so dotenv is a harmless no-op there.
config({ path: fileURLToPath(new URL('../../.env', import.meta.url)) });

export default defineConfig({ test: { environment: 'node' } });
```

Add `dotenv` to devDependencies: `pnpm --filter @hearth/server add -D dotenv`. Re-run Step 4; expect PASS.

- [ ] **Step 6: Commit**

```bash
git add apps/server/src/server.ts apps/server/src/server.test.ts apps/server/vitest.config.ts apps/server/package.json
git commit -m "feat(server): fastify skeleton with health route and test"
```

---

### Task 5: Drizzle client, Better Auth schema, domain schema, migration

> ℹ️ The `recipes` table here is **disposable scaffolding to prove the stack end-to-end — not** the Decision 9 structured-core recipe model (ingredients, steps, canonical Foods, scaling rules). P1 replaces it. Don't over-invest in or grow attached to this shape.
>
> Note also: drizzle-kit owns the Better Auth tables' migrations here (not the Better Auth CLI). Every Better Auth version bump means re-running `generate` and reconciling the schema diff by hand.

**Files:**
- Create: `apps/server/drizzle.config.ts`, `apps/server/src/db/client.ts`, `apps/server/src/db/auth-schema.ts` (generated), `apps/server/src/db/schema.ts`
- Test: migration applies cleanly (verified by running drizzle-kit + a smoke query in Task 7's test setup).

**Interfaces:**
- Produces:
  - `db` — a `drizzle()` instance over a `pg` Pool (from `./db/client`).
  - `recipes` Drizzle table: `{ id: uuid pk default random, householdId: text not null, title: text not null, slug: text not null, createdAt: timestamp default now }`.
  - `type Recipe = typeof recipes.$inferSelect`.
  - Better Auth tables (`user`, `session`, `account`, `verification`, `organization`, `member`, `invitation`) in `auth-schema.ts`.

- [ ] **Step 1: Create `apps/server/src/db/client.ts`**

```ts
import { drizzle } from 'drizzle-orm/node-postgres';
import pg from 'pg';
import { env } from '../env';

export const pool = new pg.Pool({ connectionString: env.DATABASE_URL });
export const db = drizzle(pool);
export type DB = typeof db;
```

- [ ] **Step 2: Create `apps/server/drizzle.config.ts`**

```ts
import { defineConfig } from 'drizzle-kit';

export default defineConfig({
  schema: './src/db/schema.ts',
  out: './drizzle',
  dialect: 'postgresql',
  dbCredentials: { url: process.env.DATABASE_URL! },
});
```

- [ ] **Step 3: Generate the Better Auth schema**

Run: `pnpm --filter @hearth/server exec npx @better-auth/cli generate --config src/auth.ts --output src/db/auth-schema.ts`

> Note: `src/auth.ts` is created in Task 6. To unblock this task, first create a minimal `src/auth.ts` stub (Task 6 Step 1), then run generate. If the CLI is not yet usable, hand-author `auth-schema.ts` with the Better Auth + organization plugin tables (`user`, `session`, `account`, `verification`, `organization`, `member`, `invitation`) per Better Auth's documented Drizzle schema. The `organization.id` column is `text` primary key — domain tables reference it.

Expected: `src/db/auth-schema.ts` exists exporting the auth tables.

- [ ] **Step 4: Create `apps/server/src/db/schema.ts` (domain tables + re-export auth)**

```ts
import { pgTable, uuid, text, timestamp } from 'drizzle-orm/pg-core';
import { organization } from './auth-schema';

export * from './auth-schema';

export const recipes = pgTable('recipes', {
  id: uuid('id').primaryKey().defaultRandom(),
  householdId: text('household_id')
    .notNull()
    .references(() => organization.id, { onDelete: 'cascade' }),
  title: text('title').notNull(),
  slug: text('slug').notNull(),
  createdAt: timestamp('created_at').notNull().defaultNow(),
});

export type Recipe = typeof recipes.$inferSelect;
export type NewRecipe = typeof recipes.$inferInsert;
```

- [ ] **Step 5: Generate and apply the migration**

Run: `pnpm --filter @hearth/server db:generate && pnpm --filter @hearth/server db:migrate`
Expected: a SQL file under `apps/server/drizzle/`; migrate applies it; `recipes` + auth tables exist in Postgres.

- [ ] **Step 6: Commit**

```bash
git add apps/server/drizzle.config.ts apps/server/src/db apps/server/drizzle
git commit -m "feat(server): drizzle client, better-auth schema, recipes table, initial migration"
```

---

### Task 6: Better Auth instance (email/password + organizations) on Fastify

> 🔴 **Spike this in isolation before building on it.** Every later task assumes a working sign-up → session-cookie → `getSession` round-trip *in a real browser* (not just `app.inject`). Prove that first. Strongly prefer Better Auth's documented Node/Fastify integration over the hand-rolled `Request` adapter below — the adapter is the single most failure-prone piece in this plan. If you keep the hand-rolled path, the `Set-Cookie` handling in Step 2 is mandatory, not optional.

**Files:**
- Create: `apps/server/src/auth.ts`
- Modify: `apps/server/src/server.ts` (mount the auth handler at `/api/auth/*`)
- Test: `apps/server/src/server.test.ts` (add a sign-up → session smoke test)

**Interfaces:**
- Produces: `auth` — the Better Auth instance. Exposes `auth.handler(request: Request): Promise<Response>` and `auth.api.getSession({ headers })`. Email/password enabled; organization plugin enabled (organizations = households).

- [ ] **Step 1: Create `apps/server/src/auth.ts`**

```ts
import { betterAuth } from 'better-auth';
import { drizzleAdapter } from 'better-auth/adapters/drizzle';
import { organization } from 'better-auth/plugins';
import { db } from './db/client';
import { env } from './env';

export const auth = betterAuth({
  secret: env.BETTER_AUTH_SECRET,
  baseURL: env.BETTER_AUTH_URL,
  database: drizzleAdapter(db, { provider: 'pg' }),
  emailAndPassword: { enabled: true },
  trustedOrigins: [env.WEB_ORIGIN],
  plugins: [organization()],
});

export type Auth = typeof auth;
```

- [ ] **Step 2: Mount the handler in `server.ts` — add inside `buildServer` before returning**

```ts
import { auth } from './auth';

// Convert Fastify's raw req into a web Request and delegate to Better Auth.
app.route({
  method: ['GET', 'POST'],
  url: '/api/auth/*',
  async handler(req, reply) {
    const url = new URL(req.url, env.BETTER_AUTH_URL);
    const headers = new Headers();
    for (const [k, v] of Object.entries(req.headers)) {
      if (typeof v === 'string') headers.set(k, v);
    }
    const request = new Request(url, {
      method: req.method,
      headers,
      body: ['GET', 'HEAD'].includes(req.method) ? undefined : JSON.stringify(req.body),
    });
    const res = await auth.handler(request);
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
```

> Add `app.addContentTypeParser` for JSON if Fastify's default body parsing interferes; Better Auth expects the raw JSON body re-serialized as above. Re-serializing only works for JSON bodies — if any auth route uses a non-JSON content type this breaks, which is the other reason to prefer the official Node/Fastify handler.

- [ ] **Step 3: Write the failing integration test — append to `apps/server/src/server.test.ts`**

```ts
import { resetDb } from '../test/db';

describe('auth', () => {
  beforeAll(async () => { await resetDb(); });
  it('signs up a user and returns a session cookie', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/auth/sign-up/email',
      payload: { email: 'a@test.dev', password: 'password1234', name: 'A' },
      headers: { 'content-type': 'application/json' },
    });
    expect(res.statusCode).toBeLessThan(400);
    expect(res.headers['set-cookie']).toBeDefined();
  });
});
```

- [ ] **Step 4: Create the test DB helper — `apps/server/test/db.ts`**

```ts
import { pool } from '../src/db/client';

// Truncate all app tables between test runs. Order respects FKs via CASCADE.
export async function resetDb(): Promise<void> {
  await pool.query(`
    truncate table recipes, "member", "invitation", "organization",
      "session", "account", "verification", "user" restart identity cascade;
  `);
}
```

- [ ] **Step 5: Run the test to verify it passes**

Run: `pnpm vitest run apps/server/src/server.test.ts`
Expected: PASS — sign-up returns < 400 and sets a cookie. (Ensure migrations are applied against the running Postgres first.)

- [ ] **Step 6: Commit**

```bash
git add apps/server/src/auth.ts apps/server/src/server.ts apps/server/src/server.test.ts apps/server/test/db.ts
git commit -m "feat(server): better-auth email/password + organizations mounted on fastify"
```

---

### Task 7: Household-scoped recipe repository (tenant isolation)

The structural guarantee from the Global Constraints: domain access only through this layer, always parameterized by `householdId`.

> 🟠 **This guarantee is convention, not structure, unless you enforce it.** Nothing stops a future router from importing `db` and forgetting `.where(householdId)` — one such slip leaks data across households. Step 6 adds a lint guard. Decide now whether to also adopt Postgres **Row-Level Security** as defense-in-depth (survives a coding mistake; cheapest to adopt while only one domain table exists) or to consciously defer it — record the call in the Decision Log either way. Consider a branded `type HouseholdId = string & { readonly __brand: 'HouseholdId' }` so the wrong string can't be passed positionally.

**Files:**
- Create: `apps/server/src/repo/recipes.ts`
- Test: `apps/server/src/repo/recipes.test.ts`

**Interfaces:**
- Consumes: `db` (`./db/client`), `recipes`, `Recipe`, `slugify` (`@hearth/shared`).
- Produces:
  - `listRecipes(householdId: string): Promise<Recipe[]>` — only rows for that household, newest first.
  - `createRecipe(householdId: string, input: { title: string }): Promise<Recipe>` — sets `slug = slugify(title)`.
  - `getRecipe(householdId: string, id: string): Promise<Recipe | null>` — null if missing or other household (never throws).

- [ ] **Step 1: Write the failing test — `apps/server/src/repo/recipes.test.ts`**

```ts
import { describe, it, expect, beforeEach } from 'vitest';
import { resetDb } from '../../test/db';
import { createHousehold } from '../../test/factories';
import { listRecipes, createRecipe, getRecipe } from './recipes';

describe('recipe repository (tenant isolation)', () => {
  beforeEach(async () => { await resetDb(); });

  it('createRecipe stores a slug and scopes to the household', async () => {
    const h = await createHousehold();
    const r = await createRecipe(h, { title: 'White Bean Soup' });
    expect(r.slug).toBe('white-bean-soup');
    expect(r.householdId).toBe(h);
  });

  it('listRecipes returns only the calling household rows', async () => {
    const a = await createHousehold();
    const b = await createHousehold();
    await createRecipe(a, { title: 'A Soup' });
    await createRecipe(b, { title: 'B Stew' });
    const listA = await listRecipes(a);
    expect(listA).toHaveLength(1);
    expect(listA[0]!.title).toBe('A Soup');
  });

  it('getRecipe returns null for a recipe owned by another household', async () => {
    const a = await createHousehold();
    const b = await createHousehold();
    const r = await createRecipe(a, { title: 'Secret' });
    expect(await getRecipe(b, r.id)).toBeNull();
    expect(await getRecipe(a, r.id)).not.toBeNull();
  });
});
```

- [ ] **Step 2: Create the test factory — `apps/server/test/factories.ts`**

```ts
import { pool } from '../src/db/client';

let n = 0;
// Insert a minimal organization row directly; returns its id (the household id).
export async function createHousehold(): Promise<string> {
  const id = `hh_${++n}_${Date.now()}`;
  await pool.query(
    `insert into "organization" (id, name, slug, "createdAt") values ($1, $2, $3, now())`,
    [id, `House ${n}`, `house-${n}-${Date.now()}`],
  );
  return id;
}
```

> If the generated `organization` table column names differ (e.g. `created_at`), adjust the insert to match `auth-schema.ts`. Verify columns with `\d organization` in psql.

- [ ] **Step 3: Run the test to verify it fails**

Run: `pnpm vitest run apps/server/src/repo/recipes.test.ts`
Expected: FAIL — cannot find module `./recipes`.

- [ ] **Step 4: Implement `apps/server/src/repo/recipes.ts`**

```ts
import { and, desc, eq } from 'drizzle-orm';
import { slugify } from '@hearth/shared';
import { db } from '../db/client';
import { recipes, type Recipe } from '../db/schema';

export async function listRecipes(householdId: string): Promise<Recipe[]> {
  return db
    .select()
    .from(recipes)
    .where(eq(recipes.householdId, householdId))
    .orderBy(desc(recipes.createdAt));
}

export async function createRecipe(
  householdId: string,
  input: { title: string },
): Promise<Recipe> {
  const [row] = await db
    .insert(recipes)
    .values({ householdId, title: input.title, slug: slugify(input.title) })
    .returning();
  return row!;
}

export async function getRecipe(householdId: string, id: string): Promise<Recipe | null> {
  const [row] = await db
    .select()
    .from(recipes)
    .where(and(eq(recipes.id, id), eq(recipes.householdId, householdId)));
  return row ?? null;
}
```

- [ ] **Step 5: Run the test to verify it passes**

Run: `pnpm vitest run apps/server/src/repo/recipes.test.ts`
Expected: PASS (3 tests) — isolation proven.

- [ ] **Step 6: Add the import guard that makes tenancy structural**

In `.eslintrc.cjs`, restrict importing the raw `db` client outside the repo/db layer so domain queries cannot bypass household scoping:

```js
// add to module.exports in .eslintrc.cjs
overrides: [
  {
    files: ['apps/server/src/**/*.ts'],
    excludedFiles: ['apps/server/src/repo/**', 'apps/server/src/db/**'],
    rules: {
      'no-restricted-imports': ['error', {
        patterns: [{ group: ['**/db/client'], message: 'Domain access must go through src/repo/* (household-scoped).' }],
      }],
    },
  },
],
```

Run `pnpm lint`; expect it to flag any non-repo import of `db` (there should be none yet).

- [ ] **Step 7: Commit**

```bash
git add apps/server/src/repo apps/server/test/factories.ts .eslintrc.cjs
git commit -m "feat(server): household-scoped recipe repository with isolation tests"
```

---

### Task 8: tRPC context, protected procedure, recipe router

**Files:**
- Create: `apps/server/src/trpc/trpc.ts`, `apps/server/src/trpc/context.ts`, `apps/server/src/trpc/routers/recipe.ts`, `apps/server/src/trpc/routers/index.ts`
- Modify: `apps/server/src/server.ts` (register the tRPC Fastify plugin at `/trpc`)
- Test: `apps/server/src/server.test.ts` (add an authed `recipe.create` → `recipe.list` round-trip; and an unauthed call returns UNAUTHORIZED)

**Interfaces:**
- Consumes: `auth` (session), repo functions (Task 7).
- Produces:
  - `createContext({ req })` → `{ session, householdId }` where `householdId` is the user's active organization id (or `null`).
  - `publicProcedure`, `protectedProcedure` (throws `UNAUTHORIZED` if no session, `FORBIDDEN` if no `householdId`).
  - `appRouter` with `recipe.list` (query) and `recipe.create` (mutation, input `{ title: string }`).
  - `export type AppRouter = typeof appRouter` — consumed by the web client.

- [ ] **Step 1: Create `apps/server/src/trpc/context.ts`**

```ts
import type { FastifyRequest } from 'fastify';
import { auth } from '../auth';

export async function createContext({ req }: { req: FastifyRequest }) {
  const headers = new Headers();
  for (const [k, v] of Object.entries(req.headers)) {
    if (typeof v === 'string') headers.set(k, v);
  }
  const session = await auth.api.getSession({ headers });
  const householdId = session?.session.activeOrganizationId ?? null;
  return { session, householdId };
}

export type Context = Awaited<ReturnType<typeof createContext>>;
```

> `activeOrganizationId` is set by the organization plugin once a user creates/selects a household. If your Better Auth version names it differently, read the active org from `auth.api.getFullOrganization` / session fields accordingly.

- [ ] **Step 2: Create `apps/server/src/trpc/trpc.ts`**

```ts
import { initTRPC, TRPCError } from '@trpc/server';
import type { Context } from './context';

const t = initTRPC.context<Context>().create();

export const router = t.router;
export const publicProcedure = t.procedure;

export const protectedProcedure = t.procedure.use(({ ctx, next }) => {
  if (!ctx.session) throw new TRPCError({ code: 'UNAUTHORIZED' });
  if (!ctx.householdId) throw new TRPCError({ code: 'FORBIDDEN', message: 'No active household' });
  return next({ ctx: { ...ctx, householdId: ctx.householdId, session: ctx.session } });
});
```

- [ ] **Step 3: Create `apps/server/src/trpc/routers/recipe.ts`**

```ts
import { z } from 'zod';
import { router, protectedProcedure } from '../trpc';
import { listRecipes, createRecipe } from '../../repo/recipes';

export const recipeRouter = router({
  list: protectedProcedure.query(({ ctx }) => listRecipes(ctx.householdId)),
  create: protectedProcedure
    .input(z.object({ title: z.string().min(1) }))
    .mutation(({ ctx, input }) => createRecipe(ctx.householdId, input)),
});
```

- [ ] **Step 4: Create `apps/server/src/trpc/routers/index.ts`**

```ts
import { router } from '../trpc';
import { recipeRouter } from './recipe';

export const appRouter = router({ recipe: recipeRouter });
export type AppRouter = typeof appRouter;
```

- [ ] **Step 5: Register the tRPC plugin — add to `server.ts` inside `buildServer`**

```ts
import { fastifyTRPCPlugin } from '@trpc/server/adapters/fastify';
import { appRouter } from './trpc/routers';
import { createContext } from './trpc/context';

await app.register(fastifyTRPCPlugin, {
  prefix: '/trpc',
  trpcOptions: { router: appRouter, createContext },
});
```

Add dep: `pnpm --filter @hearth/server add @trpc/server` (already present) — the fastify adapter ships with `@trpc/server`.

- [ ] **Step 6: Write the failing test — append to `apps/server/src/server.test.ts`**

```ts
describe('trpc recipe', () => {
  beforeAll(async () => { await resetDb(); });

  it('rejects recipe.list without a session', async () => {
    const res = await app.inject({ method: 'GET', url: '/trpc/recipe.list' });
    expect(res.statusCode).toBe(401);
  });

  it('authed user creates then lists a recipe', async () => {
    // sign up, capture cookie
    const signup = await app.inject({
      method: 'POST', url: '/api/auth/sign-up/email',
      payload: { email: 'b@test.dev', password: 'password1234', name: 'B' },
      headers: { 'content-type': 'application/json' },
    });
    const cookie = signup.headers['set-cookie'] as string;
    // create the household (active organization)
    await app.inject({
      method: 'POST', url: '/api/auth/organization/create',
      payload: { name: 'Home', slug: `home-${Date.now()}` },
      headers: { 'content-type': 'application/json', cookie },
    });
    // create a recipe via tRPC
    const create = await app.inject({
      method: 'POST', url: '/trpc/recipe.create',
      payload: { title: 'White Bean Soup' },
      headers: { 'content-type': 'application/json', cookie },
    });
    expect(create.statusCode).toBe(200);
    // list it back
    const list = await app.inject({ method: 'GET', url: '/trpc/recipe.list', headers: { cookie } });
    expect(list.statusCode).toBe(200);
    expect(JSON.stringify(list.json())).toContain('White Bean Soup');
  });
});
```

> If your Better Auth org-create endpoint requires the org to be set active explicitly, add a `POST /api/auth/organization/set-active` call with the returned org id before `recipe.create`.

- [ ] **Step 7: Run the test to verify it passes**

Run: `pnpm vitest run apps/server/src/server.test.ts`
Expected: PASS — unauthed → 401; authed create+list round-trips "White Bean Soup".

- [ ] **Step 8: Commit**

```bash
git add apps/server/src/trpc apps/server/src/server.ts apps/server/src/server.test.ts
git commit -m "feat(server): trpc context, protected procedure, recipe router"
```

---

### Task 9: Web PWA scaffold + Fresh Market design tokens + theme provider

Implements UI spec §0 (Decision 24): semantic tokens, light + dark token sets, `data-theme` switching.

**Files:**
- Create: `apps/web/package.json`, `apps/web/tsconfig.json`, `apps/web/vite.config.ts`, `apps/web/index.html`, `apps/web/src/main.tsx`, `apps/web/src/styles/tokens.css`, `apps/web/src/theme/ThemeProvider.tsx`
- Test: `apps/web/src/theme/ThemeProvider.test.tsx`

**Interfaces:**
- Produces:
  - `tokens.css` defining `:root` (light) and `[data-theme='dark']` semantic tokens (names per UI spec §0: `--color-bg`, `--color-surface`, `--color-surface-2`, `--color-border`, `--color-text`, `--color-text-muted`, `--color-accent`, `--color-accent-soft`, `--color-accent-soft-text`, `--color-leftover-*`, `--color-frozen-*`, `--radius`).
  - `ThemeProvider` + `useTheme(): { theme: 'light'|'dark'|'system', setTheme }` — applies `data-theme` to `document.documentElement`.

- [ ] **Step 1: Create `apps/web/package.json`**

```json
{
  "name": "@hearth/web",
  "version": "0.0.0",
  "type": "module",
  "scripts": {
    "dev": "vite",
    "build": "tsc -p tsconfig.json && vite build",
    "typecheck": "tsc -p tsconfig.json --noEmit",
    "preview": "vite preview"
  },
  "dependencies": {
    "@hearth/server": "workspace:*",
    "@tanstack/react-query": "^5.59.0",
    "@trpc/client": "^11.0.0",
    "@trpc/react-query": "^11.0.0",
    "better-auth": "^1.2.0",
    "react": "^18.3.0",
    "react-dom": "^18.3.0"
  },
  "devDependencies": {
    "@vitejs/plugin-react": "^4.3.0",
    "vite": "^5.4.0",
    "vite-plugin-pwa": "^0.20.0",
    "@testing-library/react": "^16.0.0",
    "@testing-library/jest-dom": "^6.5.0",
    "jsdom": "^25.0.0",
    "@types/react": "^18.3.0",
    "@types/react-dom": "^18.3.0"
  }
}
```

> `@hearth/server` is a dev type-only dependency for `AppRouter`. Importing only the type keeps server code out of the client bundle.

- [ ] **Step 2: Create `apps/web/tsconfig.json`, `apps/web/vite.config.ts`, `apps/web/index.html`**

```json
// tsconfig.json
{
  "extends": "../../tsconfig.base.json",
  "compilerOptions": { "jsx": "react-jsx", "lib": ["ES2022", "DOM", "DOM.Iterable"], "noEmit": true },
  "include": ["src"]
}
```

```ts
// vite.config.ts
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { VitePWA } from 'vite-plugin-pwa';

export default defineConfig({
  plugins: [react(), VitePWA({ registerType: 'autoUpdate', manifest: { name: 'Hearth', short_name: 'Hearth', theme_color: '#2E9E5B', display: 'standalone' } })],
  test: { environment: 'jsdom', setupFiles: ['./src/test-setup.ts'] },
  server: {
    port: 5173,
    // Proxy API + auth to the server so the browser sees ONE origin. Cross-origin
    // (:5173 -> :3000) breaks Better Auth's SameSite=Lax session cookie in the browser
    // even though in-process app.inject tests pass. Keep client URLs relative (Task 10).
    proxy: {
      '/api': { target: 'http://localhost:3000', changeOrigin: true },
      '/trpc': { target: 'http://localhost:3000', changeOrigin: true },
    },
  },
});
```

```html
<!-- index.html -->
<!doctype html>
<html lang="en">
  <head><meta charset="UTF-8" /><meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover" /><title>Hearth</title></head>
  <body><div id="root"></div><script type="module" src="/src/main.tsx"></script></body>
</html>
```

Also create `apps/web/src/test-setup.ts`:

```ts
import '@testing-library/jest-dom/vitest';
```

- [ ] **Step 3: Create `apps/web/src/styles/tokens.css`**

```css
:root {
  --color-bg: #f7f9f8;
  --color-surface: #ffffff;
  --color-surface-2: #f0f4f2;
  --color-border: #e3e8e5;
  --color-text: #1f2937;
  --color-text-muted: #6b7280;
  --color-accent: #2e9e5b;
  --color-accent-soft: #e6f4ec;
  --color-accent-soft-text: #1d7a45;
  --color-leftover-bg: #fbefd9;
  --color-leftover-text: #9a6212;
  --color-frozen-bg: #e3eef8;
  --color-frozen-text: #2c6ca8;
  --radius: 14px;
}
[data-theme='dark'] {
  --color-bg: #14181a;
  --color-surface: #1d2326;
  --color-surface-2: #242b2e;
  --color-border: #313a3e;
  --color-text: #e7edea;
  --color-text-muted: #9aa6a1;
  --color-accent: #3fb56e;
  --color-accent-soft: #1d3527;
  --color-accent-soft-text: #8fd8ab;
  --color-leftover-bg: #3a2f1c;
  --color-leftover-text: #e3b873;
  --color-frozen-bg: #1e2e3e;
  --color-frozen-text: #8fbbe6;
  --radius: 14px;
}
* { box-sizing: border-box; }
body { margin: 0; background: var(--color-bg); color: var(--color-text); font-family: system-ui, sans-serif; }
```

- [ ] **Step 4: Write the failing test — `apps/web/src/theme/ThemeProvider.test.tsx`**

```tsx
import { describe, it, expect } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { ThemeProvider, useTheme } from './ThemeProvider';

function Probe() {
  const { theme, setTheme } = useTheme();
  return <button onClick={() => setTheme('dark')}>theme:{theme}</button>;
}

describe('ThemeProvider', () => {
  it('defaults to system and applies data-theme=dark when set', () => {
    render(<ThemeProvider><Probe /></ThemeProvider>);
    fireEvent.click(screen.getByRole('button'));
    expect(document.documentElement.getAttribute('data-theme')).toBe('dark');
  });
});
```

- [ ] **Step 5: Run the test to verify it fails**

Run: `pnpm vitest run apps/web/src/theme/ThemeProvider.test.tsx`
Expected: FAIL — cannot find module `./ThemeProvider`.

- [ ] **Step 6: Implement `apps/web/src/theme/ThemeProvider.tsx`**

```tsx
import { createContext, useContext, useEffect, useState, type ReactNode } from 'react';

type Mode = 'light' | 'dark' | 'system';
const ThemeCtx = createContext<{ theme: Mode; setTheme: (m: Mode) => void } | null>(null);

function resolve(mode: Mode): 'light' | 'dark' {
  if (mode !== 'system') return mode;
  return window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
}

export function ThemeProvider({ children }: { children: ReactNode }) {
  const [theme, setTheme] = useState<Mode>('system');
  useEffect(() => {
    document.documentElement.setAttribute('data-theme', resolve(theme));
  }, [theme]);
  return <ThemeCtx.Provider value={{ theme, setTheme }}>{children}</ThemeCtx.Provider>;
}

export function useTheme() {
  const ctx = useContext(ThemeCtx);
  if (!ctx) throw new Error('useTheme must be used within ThemeProvider');
  return ctx;
}
```

- [ ] **Step 7: Create `apps/web/src/main.tsx` (mounts provider + tokens)**

```tsx
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import './styles/tokens.css';
import { ThemeProvider } from './theme/ThemeProvider';
import { App } from './App';

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <ThemeProvider><App /></ThemeProvider>
  </StrictMode>,
);
```

> `App` is created in Task 10. To keep this task's build green, create a one-line placeholder `apps/web/src/App.tsx` exporting `export function App() { return null; }`, replaced in Task 10.

- [ ] **Step 8: Run the test to verify it passes**

Run: `pnpm vitest run apps/web/src/theme/ThemeProvider.test.tsx`
Expected: PASS.

- [ ] **Step 9: Commit**

```bash
git add apps/web
git commit -m "feat(web): vite pwa scaffold, fresh-market tokens, light/dark theme provider"
```

---

### Task 10: Web vertical slice — auth client, tRPC client, app shell, onboarding, recipes screen

Implements UI spec §1 app shell (Decision 25) at minimal fidelity and proves the full stack end-to-end (**sign up → create household → set it active →** see/add household-scoped recipes). The onboarding slice is required: without it a fresh user signs in, has no active organization, and hits `FORBIDDEN` from `protectedProcedure` with no UI path forward.

**Files:**
- Create: `apps/web/src/lib/auth.ts`, `apps/web/src/lib/trpc.ts`, `apps/web/src/app/AppShell.tsx`, `apps/web/src/app/AppShell.module.css`, `apps/web/src/routes/SignIn.tsx`, `apps/web/src/routes/Onboarding.tsx`, `apps/web/src/routes/Recipes.tsx`
- Modify: `apps/web/src/App.tsx` (replace placeholder with the auth gate)
- Test: `apps/web/src/app/AppShell.test.tsx`

**Interfaces:**
- Consumes: `AppRouter` type (`@hearth/server`), `ThemeProvider` (Task 9).
- Produces:
  - `authClient` (`createAuthClient`) with `signIn`, `signUp`, `signOut`, `useSession`.
  - `trpc` (`createTRPCReact<AppRouter>()`) + a configured client pointing at `/trpc` with credentials.
  - `AppShell` — renders the four destinations (Recipes · Plan · Shop · More) + an Add action; a CSS media query swaps bottom-bar (mobile) for left-rail (desktop).

- [ ] **Step 1: Create `apps/web/src/lib/auth.ts`**

```ts
import { createAuthClient } from 'better-auth/react';
import { organizationClient } from 'better-auth/client/plugins';

// Same-origin: the Vite dev proxy (and the prod reverse proxy) forward /api/auth to the
// server. Absolute cross-origin URLs would break the session cookie in the browser.
export const authClient = createAuthClient({
  baseURL: window.location.origin,
  plugins: [organizationClient()],
});
```

- [ ] **Step 2: Create `apps/web/src/lib/trpc.ts`**

```ts
import { createTRPCReact } from '@trpc/react-query';
import { httpBatchLink } from '@trpc/client';
import type { AppRouter } from '@hearth/server/src/trpc/routers';

export const trpc = createTRPCReact<AppRouter>();

export const trpcClient = trpc.createClient({
  // Relative URL -> goes through the Vite proxy (dev) / reverse proxy (prod), same origin.
  links: [httpBatchLink({ url: '/trpc', fetch: (u, o) => fetch(u, { ...o, credentials: 'include' }) })],
});
```

> Ensure `@hearth/server` exposes the router type. If deep import paths are awkward, add an `exports` entry in `apps/server/package.json` mapping `./router-type` to `./src/trpc/routers/index.ts` and import from there.

- [ ] **Step 3: Create `apps/web/src/app/AppShell.tsx` and `AppShell.module.css`**

```tsx
import type { ReactNode } from 'react';
import styles from './AppShell.module.css';

const DESTINATIONS = [
  { key: 'recipes', label: 'Recipes', icon: '📖' },
  { key: 'plan', label: 'Plan', icon: '📅' },
  { key: 'shop', label: 'Shop', icon: '🛒' },
  { key: 'more', label: 'More', icon: '☰' },
] as const;

export function AppShell({ active, onNavigate, children }: {
  active: string; onNavigate: (k: string) => void; children: ReactNode;
}) {
  return (
    <div className={styles.shell}>
      <nav className={styles.rail} aria-label="Primary">
        <div className={styles.brand}>Hearth</div>
        <button className={styles.add}>＋ Add / Import</button>
        {DESTINATIONS.map((d) => (
          <button key={d.key} aria-current={active === d.key}
            className={styles.item} onClick={() => onNavigate(d.key)}>
            <span aria-hidden>{d.icon}</span>{d.label}
          </button>
        ))}
      </nav>
      <main className={styles.main}>{children}</main>
    </div>
  );
}
```

```css
/* AppShell.module.css — bottom bar on phone, left rail on desktop */
.shell { display: flex; flex-direction: column; min-height: 100vh; }
.main { flex: 1; padding: 16px; }
.rail { display: flex; order: 2; position: sticky; bottom: 0; background: var(--color-surface);
  border-top: 1px solid var(--color-border); }
.brand, .add { display: none; }
.item { flex: 1; padding: 10px; background: none; border: none; color: var(--color-text-muted);
  font-size: 11px; display: flex; flex-direction: column; align-items: center; gap: 2px; }
.item[aria-current='true'] { color: var(--color-accent-soft-text); font-weight: 700; }

@media (min-width: 768px) {
  .shell { flex-direction: row; }
  .rail { order: 0; flex-direction: column; width: 200px; border-top: none;
    border-right: 1px solid var(--color-border); padding: 16px 12px; position: sticky; top: 0; height: 100vh; }
  .brand { display: block; font-weight: 900; font-size: 19px; padding: 4px 8px 14px; }
  .add { display: block; background: var(--color-accent); color: #fff; border: none;
    border-radius: 10px; padding: 10px; font-weight: 700; margin-bottom: 14px; }
  .item { flex: none; flex-direction: row; justify-content: flex-start; gap: 11px;
    font-size: 14px; border-radius: 9px; }
  .item[aria-current='true'] { background: var(--color-accent-soft); }
}
```

- [ ] **Step 4: Write the failing test — `apps/web/src/app/AppShell.test.tsx`**

```tsx
import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { AppShell } from './AppShell';

describe('AppShell', () => {
  it('renders the four destinations and reports navigation', () => {
    const onNavigate = vi.fn();
    render(<AppShell active="recipes" onNavigate={onNavigate}>body</AppShell>);
    for (const label of ['Recipes', 'Plan', 'Shop', 'More']) {
      expect(screen.getByText(label)).toBeInTheDocument();
    }
    fireEvent.click(screen.getByText('Plan'));
    expect(onNavigate).toHaveBeenCalledWith('plan');
  });
});
```

- [ ] **Step 5: Run the test to verify it fails, then passes**

Run: `pnpm vitest run apps/web/src/app/AppShell.test.tsx`
Expected: FAIL (no module) → after Step 3 already exists, PASS. (If authored together, expect PASS; confirm all four labels render and click reports `'plan'`.)

- [ ] **Step 6: Create `apps/web/src/routes/SignIn.tsx`**

```tsx
import { useState } from 'react';
import { authClient } from '../lib/auth';

// Minimal combined sign-in / create-account. A fresh self-host install has no users,
// so create-account must be reachable from the first screen (non-technical-first).
export function SignIn() {
  const [mode, setMode] = useState<'signin' | 'signup'>('signin');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    const res =
      mode === 'signin'
        ? await authClient.signIn.email({ email, password })
        : await authClient.signUp.email({ email, password, name: email });
    if (res.error) setError(res.error.message ?? 'Failed');
  }
  return (
    <form onSubmit={submit} style={{ maxWidth: 320, margin: '60px auto', display: 'grid', gap: 10 }}>
      <h1>{mode === 'signin' ? 'Sign in to Hearth' : 'Create your Hearth account'}</h1>
      <input placeholder="Email" value={email} onChange={(e) => setEmail(e.target.value)} />
      <input placeholder="Password" type="password" value={password} onChange={(e) => setPassword(e.target.value)} />
      <button type="submit">{mode === 'signin' ? 'Sign in' : 'Create account'}</button>
      <button type="button" onClick={() => setMode(mode === 'signin' ? 'signup' : 'signin')}
        style={{ background: 'none', border: 'none', color: 'var(--color-accent-soft-text)' }}>
        {mode === 'signin' ? 'Create an account' : 'Have an account? Sign in'}
      </button>
      {error && <p role="alert">{error}</p>}
    </form>
  );
}
```

- [ ] **Step 7: Create `apps/web/src/routes/Recipes.tsx`**

```tsx
import { useState } from 'react';
import { trpc } from '../lib/trpc';

export function Recipes() {
  const list = trpc.recipe.list.useQuery();
  const utils = trpc.useUtils();
  const create = trpc.recipe.create.useMutation({ onSuccess: () => utils.recipe.list.invalidate() });
  const [title, setTitle] = useState('');
  return (
    <section>
      <h1>Recipes</h1>
      <form onSubmit={(e) => { e.preventDefault(); if (title) { create.mutate({ title }); setTitle(''); } }}>
        <input placeholder="New recipe title" value={title} onChange={(e) => setTitle(e.target.value)} />
        <button type="submit">Add</button>
      </form>
      <ul>{list.data?.map((r) => <li key={r.id}>{r.title}</li>)}</ul>
    </section>
  );
}
```

- [ ] **Step 7b: Create `apps/web/src/routes/Onboarding.tsx` (create + activate the first household)**

```tsx
import { useState } from 'react';
import { authClient } from '../lib/auth';
import { slugify } from '@hearth/shared';

// Shown when a user is signed in but has no active household. Creating the org and
// setting it active is what makes protectedProcedure stop returning FORBIDDEN.
export function Onboarding() {
  const [name, setName] = useState('');
  const [error, setError] = useState<string | null>(null);
  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    const created = await authClient.organization.create({ name, slug: slugify(name) || 'home' });
    if (created.error) return setError(created.error.message ?? 'Could not create household');
    const activated = await authClient.organization.setActive({ organizationId: created.data.id });
    if (activated.error) setError(activated.error.message ?? 'Could not activate household');
    // useActiveOrganization() in App re-renders into the app shell on success.
  }
  return (
    <form onSubmit={submit} style={{ maxWidth: 320, margin: '60px auto', display: 'grid', gap: 10 }}>
      <h1>Name your household</h1>
      <p style={{ color: 'var(--color-text-muted)' }}>Everything in Hearth — recipes, plans, lists — lives in a household.</p>
      <input placeholder="e.g. The Smith Kitchen" value={name} onChange={(e) => setName(e.target.value)} />
      <button type="submit" disabled={!name}>Create household</button>
      {error && <p role="alert">{error}</p>}
    </form>
  );
}
```

> Verify the exact org-client method names against your Better Auth version (`authClient.organization.create` / `.setActive`). Confirm whether `create` already sets the org active — if it does, the explicit `setActive` is a harmless no-op; if it doesn't, it's required (and the same question applies to the server-side test in Task 8).

- [ ] **Step 8: Replace `apps/web/src/App.tsx` with the auth + onboarding gate**

```tsx
import { useState } from 'react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { trpc, trpcClient } from './lib/trpc';
import { authClient } from './lib/auth';
import { AppShell } from './app/AppShell';
import { SignIn } from './routes/SignIn';
import { Onboarding } from './routes/Onboarding';
import { Recipes } from './routes/Recipes';

const queryClient = new QueryClient();

export function App() {
  const { data: session, isPending } = authClient.useSession();
  const { data: activeOrg, isPending: orgPending } = authClient.useActiveOrganization();
  const [active, setActive] = useState('recipes');
  if (isPending) return null;
  if (!session) return <SignIn />;
  if (orgPending) return null;
  if (!activeOrg) return <Onboarding />; // signed in but no household yet
  return (
    <trpc.Provider client={trpcClient} queryClient={queryClient}>
      <QueryClientProvider client={queryClient}>
        <AppShell active={active} onNavigate={setActive}>
          {active === 'recipes' ? <Recipes /> : <p>Coming soon</p>}
        </AppShell>
      </QueryClientProvider>
    </trpc.Provider>
  );
}
```

- [ ] **Step 9: Manual end-to-end verification**

Run (three terminals): `docker compose up -d db` · `pnpm --filter @hearth/server dev` · `pnpm --filter @hearth/web dev`
Then in the browser at `http://localhost:5173`: **create an account → name your household → add a recipe "White Bean Soup" → reload.** Do the whole flow through the UI (this is the real onboarding path, not a test shortcut). Then open a second account in a private window and confirm it does **not** see the first household's recipe (manual tenant-isolation check).
Expected: the session survives reload (proves the same-origin proxy + cookie work), the recipe persists, the second account sees an empty list, and the app shell shows a bottom bar at phone width and a left rail at ≥768px.

- [ ] **Step 10: Commit**

```bash
git add apps/web
git commit -m "feat(web): auth+trpc clients, responsive app shell, recipes vertical slice"
```

---

### Task 11: CI pipeline (lint + typecheck + tests, gated on green)

**Files:**
- Create: `.github/workflows/ci.yml`
- Modify: add `typecheck` script to any package missing it (verify all four: root, shared, server, web).

**Interfaces:**
- Produces: a CI workflow that runs on push/PR, spins up Postgres, applies migrations, and runs lint + typecheck + tests. Required to pass before merge.

- [ ] **Step 1: Create `.github/workflows/ci.yml`**

```yaml
name: CI
on:
  push: { branches: [main] }
  pull_request: { branches: [main] }
jobs:
  build:
    runs-on: ubuntu-latest
    services:
      postgres:
        image: postgres:16
        env: { POSTGRES_USER: hearth, POSTGRES_PASSWORD: hearth, POSTGRES_DB: hearth }
        ports: ['5432:5432']
        options: >-
          --health-cmd "pg_isready -U hearth" --health-interval 5s
          --health-timeout 5s --health-retries 10
    env:
      DATABASE_URL: postgres://hearth:hearth@localhost:5432/hearth
      BETTER_AUTH_SECRET: ci-secret-must-be-at-least-32-characters
      BETTER_AUTH_URL: http://localhost:3000
      WEB_ORIGIN: http://localhost:5173
    steps:
      - uses: actions/checkout@v4
      - uses: pnpm/action-setup@v4
        with: { version: 9 }
      - uses: actions/setup-node@v4
        with: { node-version: 20, cache: pnpm }
      - run: pnpm install --frozen-lockfile
      - run: pnpm --filter @hearth/server db:migrate
      - run: pnpm lint
      - run: pnpm typecheck
      - run: pnpm test
```

- [ ] **Step 2: Verify every workspace has a `typecheck` script**

Run: `pnpm -r typecheck`
Expected: passes for shared, server, web. Add the script to any package missing it (mirror the pattern in Tasks 2/3/9).

- [ ] **Step 3: Run the full suite locally to mirror CI**

Run: `pnpm install && pnpm --filter @hearth/server db:migrate && pnpm lint && pnpm typecheck && pnpm test`
Expected: all green.

- [ ] **Step 4: Commit and push to trigger CI**

```bash
git add .github/workflows/ci.yml
git commit -m "ci: lint, typecheck, and test on postgres service"
```

Expected after push: the CI job passes on GitHub (gates future merges).

---

## Exit Criterion (maps to ROADMAP P0)

When this plan is complete: a user can start Postgres via `docker compose up -d db`, run the server and web (`pnpm dev`), **create an account, name a household, and create/list recipes that are provably isolated to their household** (Task 7 tests + the Step 9 manual check), through a typed tRPC API — with the Fresh Market app shell rendering responsively and **CI gating on green** (Task 11).

> ⚠️ **Scope mismatch to resolve before calling P0 "done."** The ROADMAP P0 exit says "deployed via `docker compose up`" — *one* command, app included. This plan ships Postgres in compose but runs server + web via `pnpm dev`, with no app container, migrate-on-boot, or TLS/HTTPS. For a product whose #1 principle is one-command install for non-technical users, that gap is the headline, not a detail. Decide explicitly: (a) add `apps/server` + `apps/web` Dockerfiles, a migrate-on-boot step, and a reverse proxy (e.g. Caddy for automatic TLS) to compose as a final P0 task, or (b) amend the ROADMAP P0 exit criterion to "dev-runnable; full one-command deploy is P0.5." Don't let it pass silently.

## Self-Review notes (coverage vs. ROADMAP P0 + UI spec foundations)

- **Repo / monorepo layout (Decision 23):** Task 1 (workspace) + package boundaries shared/server/web. ✓
- **Postgres + Drizzle (Decision 23):** Tasks 3, 5. ✓
- **Better Auth + household model (Decisions 4, 5):** Tasks 6, 7 (organizations = households; `household_id` on `recipes`). ✓
- **Tenant-scoped data access from day one (Decision 5):** Task 7 repository + isolation tests; Task 8 protected procedure requires `householdId`. ✓
- **tRPC end-to-end types (Decision 3):** Task 8 (`AppRouter`) consumed by Task 10 web client. ✓
- **TDD core + CI green (Decision 11):** Task 2 (shared TDD), repository/server/web tests throughout, Task 11 CI gate. ✓
- **Docker one-command deploy (J3):** Task 3 compose (db); app containerization can extend the same compose file in a later phase (noted, not required for P0 exit). ✓
- **Design tokens + app shell (Decisions 24, 25):** Tasks 9, 10. ✓
- **Resolves open question** "Better Auth ↔ Drizzle integration": Better Auth Drizzle adapter owns auth/org tables; domain tables FK to `organization.id`. ✓
- **Deferred (revisit explicitly, not silently):** RLS-vs-app-layer defense-in-depth (app-layer + lint guard enforced here; decide RLS *now* per the Task 7 note, don't just punt to the data-model spec), full one-command `docker compose up` app deploy + TLS (see Exit Criterion), PWA offline-sync conflict resolution, email verification + auth rate-limiting + first-boot secret generation (needed before any public/multi-tenant instance), and the five feature screens (next plan, P1).
