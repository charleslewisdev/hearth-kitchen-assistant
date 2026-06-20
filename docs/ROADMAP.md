# Hearth — Roadmap

> **Living doc — updated every working session.** Keep this current as the single source of truth for "where are we and what's next." Each phase becomes its own spec → plan → build cycle when we reach it.

_Last updated: 2026-06-20 (foundation hardening merged; P1 next)_

## How to read this

- Phases are **roughly ordered**, not rigid. Differentiators are deliberately staged after a usable core so we ship value early.
- Each phase has an **exit criterion** — the thing that's true when the phase is "done."
- Status keys: `⬜ not started` · `🟦 in progress` · `✅ done`.

## Current status

**Phase: P0 complete ✅ + foundation hardening merged ✅ → next is P1 (Recipe core).**
The monorepo is live and running: `docker compose up` brings up Postgres + Fastify/tRPC/Better-Auth API + an installable React PWA behind Caddy on one origin. A user can sign up, create a household, and add household-scoped recipes (tenant isolation enforced by both the repo layer and Postgres RLS). CI gates lint + typecheck + tests on green. A pre-P1 hardening pass (PR #1) automated RLS-coverage (a build-time guard fails if any `household_id` table lacks RLS), fixed local DB dev-ex (`pnpm test:local`, dotenv in `db:migrate`), and bumped CI actions off the deprecated Node 20 runtime — closing backlog #5 and #7. Remaining P0 deferrals are tracked in [the deferred/hardening backlog](superpowers/plans/2026-06-19-p0-deferred-and-hardening.md). **Next concrete step:** write the P1 spec → plan (recipe structured core, replacing the disposable P0 `recipes` table).

## Phases

### P0 — Foundations ✅
Repo, CI, Docker skeleton, monorepo layout, Postgres, Better Auth, household model + tenant-scoped data access.
**Exit:** a logged-in user in a household, deployed via `docker compose up`, with an empty but tenant-safe data layer and green CI.
**Done 2026-06-19** (commits `37bb84c..1bb80a5`): exit criterion met in full — one-command deploy delivered (Dockerfiles + migrate-on-boot + Caddy), tenancy enforced by repo layer **and** RLS, CI green. See [plan](superpowers/plans/2026-06-17-p0-foundations.md) + [deferred/hardening backlog](superpowers/plans/2026-06-19-p0-deferred-and-hardening.md).

### P1 — Recipe core ⬜
Manual create/edit/store, canonical recipe format, mobile-first viewing, cook mode (no screen timeout), search by word + filter by ingredient/meal-of-day.
**Exit:** a user can hand-enter recipes and cook from them on a phone; basic search works.

### P2 — Import pipeline ⬜
URL import (deterministic) → image OCR → PDF → text/.doc, all normalized to the canonical format. Enrichment interface with deterministic baseline + optional LLM/OCR provider.
**Exit:** a user can import a week of recipes from mixed sources with consistent output.

### P3 — Plan & shop ⬜
Assign recipes to days, generate shopping list, free-form list editing, check-off mode, department sorting, printing.
**Exit:** a user can plan a week and walk into a store with an organized, check-off list.

### P4 — Scaling, leftovers & freezer ⬜
Portion scaling with per-ingredient non-linear rules; assign extra portions to lunches/freezer; track stored/frozen meals as quick plan options; freshness-aware sequencing.
**Exit:** scaling is accurate per-ingredient and leftovers/frozen meals flow into planning.

### P5 — Share & export ⬜
Magic-link sharing (flat permission), Markdown export/import between instances, PDF export, print.
**Exit:** a recipe can be shared by link and round-tripped between two Hearth instances.

### P6 — Savings: sale ads ⬜
Tiered: (T1) feed sale ads in supported formats → (T2) align planning to sales → (T3) brand/over-stock nudges → (T4) scraping/native integration (feasibility-gated).
**Exit:** at minimum, a user can load a store's sale data and have planning surface aligned recipes.

### P7 — Budget & analytics ⬜
Receipt import + parse/itemize, spend-over-time tracking, savings analysis tied back to planning.
**Exit:** a user can import receipts and see grocery spend trends.

### Cross-cutting (ongoing)
Multi-tenant hardening · data-portability/export · offline/PWA polish · accessibility · public-instance readiness (gated on "if I love the product").

## Open questions backlog

Resolved in the 2026-06-17 deep brainstorm (→ [DECISION_LOG.md](DECISION_LOG.md)):

1. ✅ Recipe storage format → structured core (D9)
2. ✅ Search/filter set → Postgres FTS + ingredient/meal-of-day/tag MVP (D16)
3. ✅ Deterministic-vs-LLM line → core deterministic, import/receipts optional-LLM (D14)
4. ✅ External services/deps → tesseract.js, JS scrapers, optional LLM, no Python sidecar (D14, D23)
5. ✅ Scaling-rule model → `scalingMode` enum + smart defaults (D12)
6. ✅ Sale-ad ingestion → tiered, T1 structured import (D18)
7. ✅ Receipt parsing → enrichment + learned aliases + full budget loop (D19)
8. ✅ Inventory/pantry → lightweight opt-in (D20)
9. ✅ License → AGPL-3.0, copyright-retained (D21)
10. ✅ Borrow-from / UI inspiration → see [INSPIRATION.md](INSPIRATION.md)

Resolved in the 2026-06-17 UI/layout design session (→ [DECISION_LOG.md](DECISION_LOG.md) 24–30, [UI spec](superpowers/specs/2026-06-17-ui-design-p0-p1-design.md)):

11. ✅ UI/layout design for the five key screens + design system + app shell → D24–D30

Resolved during 2026-06-19 P0 execution:

- ✅ **Better Auth ↔ Drizzle integration** — drizzle adapter owns auth/org tables (schema passed explicitly); domain tables FK to `organization.id`.
- ✅ **RLS vs app-layer tenant scoping** → both (D31): repo-layer `withHousehold` + lint guard *and* Postgres RLS via an unprivileged `hearth_app` role.
- ✅ **`docker compose up` P0 exit reconciliation** → full one-command app deploy delivered in P0 (D32), not deferred.
- ✅ **Design-token ramps / dark-theme values** — settled in `apps/web/src/styles/tokens.css`.

Still open (next sessions):

- **PWA offline-sync conflict resolution** — deferred; see [deferred/hardening backlog](superpowers/plans/2026-06-19-p0-deferred-and-hardening.md) #9.
- **Public-instance readiness** (email verification, auth rate-limiting, first-boot secret gen, prod TLS) — deferred from P0; backlog #1–4. Becomes "P0.5" if hosting is pursued.

Surfaced by the 2026-06-18 P0 plan stress test (details + rationale in [DECISION_LOG.md](DECISION_LOG.md#pending-decisions)) — still open, answer before the phase each gates:

- **Audience-vs-delivery tension** — non-technical primary audience vs self-host-only delivery; is the honest near-term audience the homelab secondary?
- **Solo-build scope / "dogfood line"** — differentiators (P4/P6/P7) are hardest and last; define the minimal weekly-use slice and pull one differentiator forward as an early proof.
- **Sale-ad T1 input availability** — validate that any real store ships structured sale data before committing the P6 architecture, or it falls through to LLM and breaks deterministic-first.
- **Data export scheduling** — pull a basic structured export earlier than P5 to honor "no lock-in" before early adopters can churn.

## Session log

Append a short entry per working session so context survives across months.

- **2026-06-17** — Ran FOSS landscape research (deep-research, 101 agents). Decided to build Hearth. Locked: TS full-stack, React/Vite PWA + Fastify/tRPC + Postgres, Better Auth + optional OIDC, single-tenant-first/MT-ready. Authored north-star docs. Then ran a deep feature brainstorm → **Decisions 9–23**: structured-core recipe model, canonical Food entity, scaling rules, unit system, deterministic/LLM boundary, portion ledger (leftovers/freezer/freshness), search+filters, shopping-list sorting, tiered sale ads, full receipt→budget loop, opt-in pantry, AGPL-3.0, magic-link sharing, pnpm monorepo skeleton. Wrote [INSPIRATION.md](INSPIRATION.md).
- **2026-06-18** — Stress-tested the P0 foundations plan before execution. Folded execution-affecting fixes inline into the plan (Better Auth/Fastify Set-Cookie + spike-first, cross-origin→Vite proxy, missing onboarding slice, ESLint JSX, dotenv path, tenant-isolation lint guard + RLS decision, disposable-`recipes`-table note, `docker compose up` exit-criterion mismatch). Logged five strategic open questions (audience-vs-self-host, solo-build scope/dogfood line, sale-ad T1 input, earlier data export, RLS) to the Decision Log pending section + this backlog. **Next: execute the P0 plan in a fresh session.**
- **2026-06-20** — **Pre-P1 foundation hardening (PR #1, squash-merged to `main`).** Confirmed the post-P0 state is genuinely clean (verified working tree + all gates green; the only test "failures" were a stopped local Postgres, not code). Then closed the two backlog items that are foundational *before* P1 adds new domain tables: **#5** — automated the RLS-discipline convention with `apps/server/src/db/rls.test.ts` (catalog-introspection guard, proven to red-flag a non-compliant table); **#7** — bumped CI actions off the deprecated Node 20 runtime (checkout v7 / setup-node v6 / action-setup v6). Also fixed two local dev-ex papercuts found while verifying: `pnpm db:migrate` now loads the repo-root `.env` (no manual `DATABASE_URL`), and a one-command `pnpm test:local` (db up → migrate → test). Self-reviewed via parallel finder agents + CI; one flagged issue (vitest `expect(value, message)`) empirically refuted. **Next: write the P1 (Recipe core) spec → plan, replacing the disposable P0 `recipes` table with the structured core (D9).**
- **2026-06-19** — **Executed the P0 foundations plan end-to-end (all 12 tasks, on `main`, CI green).** Stack live via `docker compose up`: Postgres + Fastify/tRPC/Better-Auth + React PWA behind Caddy on one origin. Verified the full onboarding + tenant-isolation flow three ways (in-process tests, Vite dev proxy, containerized `:8080`). Took the two pre-execution decisions: **D31** (adopt Postgres RLS now as defense-in-depth — proven to block a forgotten `WHERE`) and **D32** (containerize the app in P0 for true one-command deploy → added Task 12). Deviations forced by gaps the tests caught are logged in the [plan's completion banner](superpowers/plans/2026-06-17-p0-foundations.md). Captured all P0 deferrals in a new [deferred/hardening backlog](superpowers/plans/2026-06-19-p0-deferred-and-hardening.md). **Next: write the P1 (Recipe core) spec → plan, replacing the disposable P0 `recipes` table with the structured core (D9).**
- **2026-06-17 (cont.)** — UI/layout design session with the visual companion. Designed all five priority screens + the shared design system + responsive app shell → **Decisions 24–30** and the [UI/UX design spec](superpowers/specs/2026-06-17-ui-design-p0-p1-design.md): Fresh Market theme on semantic design tokens (swappable themes + dark mode), bottom-tabs⇄left-rail shell, segmented recipe view + single-scroll Focus cook mode (wake lock, stacking timer tray, ingredient peek), week-agenda planner with source-coded slots + "use what you have" picker, department-grouped sink-away shopping list, source-tile import with confidence-flagged review, library with chips + smart-search tokens. **Next: writing-plans to turn the UI spec (with the P0/P1 backlog) into an implementation plan.**
