# Hearth

A self-hosted, invite-only household app for recipes, shopping lists and meal planning. Decisions are numbered in `docs/DECISION_LOG.md`; cite them as D<n>.

## Commands

- Dev: `set -a; . ./.env; set +a; pnpm --filter @hearth/server dev` (tsx does not load `.env`; bare, it dies with a ZodError from `env.ts`), and `pnpm --filter @hearth/web dev` (Vite on :5173, proxies /api and /trpc to :3000)
- Typecheck: `pnpm typecheck` · Lint: `pnpm lint`
- Test: `pnpm test:local` (starts the DB, migrates, runs the whole suite in a few minutes). Plain `pnpm test` fails without Postgres at `DATABASE_URL`.
- One test: `pnpm vitest run apps/server/src/repo/foods.test.ts`; shared: `pnpm --filter @hearth/shared exec vitest run src/slug.test.ts`
- E2E: `pnpm test:e2e` (needs the DB up and migrated, `.env` with no `SMTP_HOST`, and Chromium; it starts both dev servers itself, plus a production build on `vite preview` :4173 for the offline specs, since only a build has the service worker). CI does not run it, so run it after touching auth, invites or the shopping flow.
- Screenshots: `pnpm screenshots` rebuilds the invented demo kitchen (`hearth_demo`, data in `e2e/screenshots/demo-data.ts`) and rewrites `docs/screenshots/`. Stop dev servers first: it refuses a busy :3000 or :5173. `pnpm demo` opens that kitchen to click around in. Read the PNGs after a run; a pass only means the pages loaded.
- DB: `pnpm db:up`, `pnpm db:migrate`. Local Postgres is on 5433 via the gitignored `docker-compose.override.yml`; the committed compose and `.env.example` say 5432.

## Conventions that differ from defaults

- Every domain table carries `household_id` and is reached only through `withHousehold()` in `apps/server/src/repo/tenant.ts`, with RLS behind it. Details load from `.claude/rules/` when you open server files.
- Zod schemas live in the server (routers and `env.ts`). `packages/shared` has no zod; it is pure logic consumed from source (`main: ./src/index.ts`). `docs/ARCHITECTURE.md` and D23 say otherwise and are stale.
- Keep every regex over untrusted text linear: bound repetitions (`{0,200}`) or put a lookbehind such as `(?<!\d)` before a leading `\d+` or `\s+`, and add a timed hostile-input test. Unbounded patterns have frozen the server twice and cook mode once.
- Nothing AI-backed exists, and core flows must work without it. Import is deterministic; OCR runs in the box.
- Design specs are in `docs/specs/`. Implementation plans in `docs/plans/` are local and git-ignored. Open work is in `docs/ROADMAP.md` and `docs/DECISION_LOG.md`.

## Pitfalls

- **Tests truncate whatever `DATABASE_URL` in `.env` points at, which is the dev database.** Don't run them against data you want to keep.
- `pnpm install` warns that build scripts need `pnpm approve-builds`; that is expected.
