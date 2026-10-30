# Hearth — Roadmap

> **Living doc — updated every working session.** Keep this current as the single source of truth for "where are we and what's next." Each phase becomes its own spec → plan → build cycle when we reach it.

_Last updated: 2026-09-24 (verified in the browser and on production images; one-container deploy; follow-ups #15-#24)_

## How to read this

- Phases are **roughly ordered**, not rigid. Differentiators are deliberately staged after a usable core so we ship value early.
- Each phase has an **exit criterion** — the thing that's true when the phase is "done."
- Status keys: `⬜ not started` · `🟦 in progress` · `✅ done`.

## Current status

**Phase: in daily use.** Hearth has run on the author's unraid box since late September 2026, and
real recipes are being loaded, most of them from cookbooks.

> **2026-09-23: launch blockers cleared.** In one session, on `main`:
> - **#10** fixed the `Publish images` workflow, which had failed on every push since import
>   landed. Both images now push to GHCR (`hearth-server`, `hearth-web`), and the matrix no longer
>   cancels one image when the other fails.
> - **#11** built the P3 planner MVP ([spec](specs/2026-09-23-meal-planner-mvp-design.md), D44,
>   D45): a week of Breakfast/Lunch/Dinner slots, and Build shopping list, which adds only the
>   meals not on the list yet.
> - **#12** made foods keep one name. Size, freshness and prep words move to the ingredient note,
>   there are more units, amounts in words are read, units show in the plural, and water stays off
>   the list.
> - **#13** got the app ready for a cookbook-sized load: delete a recipe, a Source field for book
>   and page, notes and times, photo import of up to 4 pages per recipe, a verification link
>   resent on sign-in, and a shopping list that refreshes itself.
> - An end-user guide now lives in [`docs/user-guide/`](user-guide/README.md).
>
> About 1,400 unit and integration tests and 6 Playwright specs, all green.

> **2026-09-24: verified, simplified, hardened.** The planner, food merging, delete, source/notes
> and list sync were checked in a real browser against the test kitchen, and the first-boot flow
> on production images. That found and fixed photo page order (#16) and fractional counts on the
> list (#15). The deploy became **one app image plus Postgres** (#17, D46): the server serves the
> web app, Caddy is gone, and `TRUST_PROXY` names the owner's HAProxy. Then: liquid units and web
> times/headnotes (#18), password reset (#19), plan from a recipe (#20), cook mode surviving a
> reload (#21, D47), a Foods screen to merge and file foods (#22, D48), a tested backup script
> (#23), and a list that survives a dropped signal (#24). About 1,550 tests and 8 Playwright specs.

**Next concrete step:** deploy to unraid with [`deploy/unraid/README.md`](../deploy/unraid/README.md)
and the two XML templates. Container lifecycle is the owner's. Then load real recipes and
collect what breaks.

**Known gaps**, none blocking launch: ranges keep only their low end; a servings change after
Build shopping list does not reach the list (D44); the app cannot cold-start offline; a page
with two recipes on it is read as one.

## Phases

### P0 — Foundations ✅
Repo, CI, Docker skeleton, monorepo layout, Postgres, Better Auth, household model + tenant-scoped data access.
**Exit:** a logged-in user in a household, deployed via `docker compose up`, with an empty but tenant-safe data layer and green CI.
**Done 2026-06-19** (commits `37bb84c..1bb80a5`): exit criterion met in full — one-command deploy delivered (Dockerfiles + migrate-on-boot + Caddy), tenancy enforced by repo layer **and** RLS, CI green. See [plan](plans/2026-06-17-p0-foundations.md) + [deferred/hardening backlog](plans/2026-06-19-p0-deferred-and-hardening.md).

### Grocery MVP ✅ *(re-scope 2026-07-04; built 2026-07-04)*
The dogfood milestone: hand-enter recipes (CRUD) with a servings scaler → generate a department-grouped shopping list → CRUD the list (manual staples, edit, sink-away check-off). = recipe-core Phases A+B in full + trimmed P1 (recipe CRUD + scaler) + a pulled-forward shopping-list slice. Cook mode, FTS search, import, and calendar planning are explicitly deferred as additive fast-follows.
**Exit:** a household user can plan a week's groceries from their recipes and walk into a store with an editable, check-off-able, department-grouped list. See [design](specs/2026-07-04-grocery-mvp-slice-design.md).
**Done 2026-07-04** (branch `feat/grocery-mvp`): exit criterion met in full. 8 relational tables (6 recipe-core + 2 shopping) all RLS-protected; a pure, exhaustively-tested deterministic core (parser/units/food-name/scale/departments/merge-key, 120 tests); tRPC recipe + shopping routers over `withHousehold`; four React screens (Library, Create/Edit with live-parse, View with scaler, Shopping list with department groups + sink-away check-off). **175 unit/integration tests + a Playwright happy-path E2E green; typecheck/lint/build clean.** Deferred polish captured in the [design doc](specs/2026-07-04-grocery-mvp-slice-design.md#deferred-polish-found-during-the-2026-07-04-build) (one-list uniqueness guard, item-note editing, E2E-in-CI, minor a11y).

### P0.5 — Self-host readiness & observability ✅ *(2026-09-08 → 2026-09-09)*
Structured logging (pino, ids-only) · first-boot secret generation + production refusal of the dev default · SMTP mailer with a console fallback · invite-only accounts (email verification, household invitations, Household settings screen) · auth rate limiting · running correctly behind an external TLS-terminating proxy · GHCR image publishing + unraid templates on a private `hearth` network.
**Exit:** the instance runs on unraid behind nginx at a real hostname, a relative accepts an emailed invite and signs in, and structured logs are queryable. Drains the four 🔴 items in the [deferred/hardening backlog](plans/2026-06-19-p0-deferred-and-hardening.md). See [design](specs/2026-09-08-selfhost-cook-import-design.md#milestone-a--p05-foundations).
**Done 2026-09-09** (branch `feat/p05-selfhost-readiness`): **640 tests + 2 Playwright specs green**, up from 190 at the branch point. Structured logging with an ids-only rule (D38, D40) · `PUBLIC_URL`-derived origins and first-boot secret generation that refuses the published dev default · SMTP with a console fallback · **invite-only accounts** (D36) with a first-boot setup token (D42), one household per instance enforced by a unique index behind a runtime toggle (D41), and a trigger that keeps a household from losing its last owner · two-layer rate limiting · Household and accept-invite screens · GHCR publishing plus unraid templates with the proxy chain fixed (D39). All four 🔴 hardening items closed. **The exit criterion is met in code and verified locally; the deployment itself is the owner's to run.**

### P1 — Recipe core (remainder) ✅ *(2026-09-10)*
The polish trimmed out of the Grocery MVP, added back as fast-follows: cook mode (no screen timeout), FTS search by word + filter by ingredient/meal-of-day/tag, segmented view.
**Exit:** a user can cook from a recipe on a phone in Focus mode; library search + filters work.
**Done 2026-09-10** (branch `feat/cook-search-import`): **743 tests**, up from 640. Search wired over the `search_tsv` column and GIN indexes that had existed unused since the Grocery MVP, with tags matched relationally because a generated column cannot reach them. Cook mode replaced a 13-line placeholder with D26's Focus screen. Two findings recorded: [D43](DECISION_LOG.md), that RLS forecloses GIN index use for non-leakproof operators; and that the timer alarm cannot reach a backgrounded tab without a notification permission prompt, deliberately not added.

### P2 — Import pipeline ✅ *(2026-09-10)*
URL import (deterministic) → image OCR → PDF → text/.doc, all normalized to the canonical format. Enrichment interface with deterministic baseline + optional LLM/OCR provider.
**Exit:** a user can import a week of recipes from mixed sources with consistent output.
**Done 2026-09-10** (branch `feat/cook-search-import`): **1101 tests**, up from 743 at the start of the milestone. `packages/enrichment` created at last, with one `RecipeDraft` shape from four sources that fall back into each other, saving through the existing `recipe.create` so there is no second write path. The LLM provider is deliberately **not** built: D14 makes it optional and makes in-the-box OCR mandatory, and tesseract satisfies that alone on a rotated, unevenly lit, blurred page. **The image and PDF fixtures are synthetic, so real cookbook photos are untested** - two-column pages interleave and a wrapped ingredient line becomes two entries. If the owner's own books defeat the baseline, that is the evidence for the LLM provider D14 held in reserve.

### P3 — Plan & shop 🟦 *(list slice pulled into the Grocery MVP; planner MVP 2026-09-23)*
The shopping-list core (generate from recipes, free-form editing, sink-away check-off, department sorting) ships early in the Grocery MVP. P3 proper then adds the **planning** layer on top: assign recipes to days (calendar/agenda), freshness-aware sequencing, multiple named lists / store layouts, cross-unit aggregation, and printing.
**Exit:** a user can plan a week (day-assigned, freshness-aware) and the list reflects it.
**Planner MVP done 2026-09-23** (#11): day-assigned week planning and Build shopping list. Still
open for P3: freshness-aware sequencing, drag and drop, multiple lists and store layouts,
cross-unit aggregation, printing.

### P4 — Scaling, leftovers & freezer ⬜
Portion scaling with per-ingredient non-linear rules; assign extra portions to lunches/freezer; track stored/frozen meals as quick plan options; freshness-aware sequencing.
**Exit:** scaling is accurate per-ingredient and leftovers/frozen meals flow into planning.

### P5 — Share & export ⬜
Magic-link sharing (flat permission), Markdown export/import between instances, PDF export, print.
**Exit:** a recipe can be shared by link and round-tripped between two Hearth instances.
**Pulled forward (2026-09-27, owner request):** sending a recipe to someone outside the household (family asking for recipes) is sequenced right after interactive import parsing, ahead of the rest of P5. The first cut is a read-only share link to one recipe, and a printable or PDF copy. **2026-09-28:** the owner chose to ship Share (plain text through the phone's share sheet, or copy) and Print (a print sheet, Save as PDF) first, with no public surface; the read-only link waits until they have used those.

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

Resolved in the 2026-06-17 UI/layout design session (→ [DECISION_LOG.md](DECISION_LOG.md) 24–30, [UI spec](specs/2026-06-17-ui-design-p0-p1-design.md)):

11. ✅ UI/layout design for the five key screens + design system + app shell → D24–D30

Resolved during 2026-06-19 P0 execution:

- ✅ **Better Auth ↔ Drizzle integration** — drizzle adapter owns auth/org tables (schema passed explicitly); domain tables FK to `organization.id`.
- ✅ **RLS vs app-layer tenant scoping** → both (D31): repo-layer `withHousehold` + lint guard *and* Postgres RLS via an unprivileged `hearth_app` role.
- ✅ **`docker compose up` P0 exit reconciliation** → full one-command app deploy delivered in P0 (D32), not deferred.
- ✅ **Design-token ramps / dark-theme values** — settled in `apps/web/src/styles/tokens.css`.

Still open (next sessions):

- **PWA offline-sync conflict resolution** — deferred; see [deferred/hardening backlog](plans/2026-06-19-p0-deferred-and-hardening.md) #9.
- **Public-instance readiness** (email verification, auth rate-limiting, first-boot secret gen, prod TLS) — deferred from P0; backlog #1–4. Becomes "P0.5" if hosting is pursued.

Surfaced by the 2026-06-18 P0 plan stress test (details + rationale in [DECISION_LOG.md](DECISION_LOG.md#pending-decisions)) — still open, answer before the phase each gates:

- ~~**Audience-vs-delivery tension**~~ **Answered for the near term 2026-09-08 → [D36](DECISION_LOG.md):** the author's own instance will be internet-reachable so family can use it, so public-readiness (verification, rate limiting, TLS, secret hygiene) is being built now as P0.5 rather than deferred. Accounts are invite-only; a hosted multi-tenant offering remains a separate, later question.
- ~~**Solo-build scope / "dogfood line"**~~ **Resolved 2026-07-04 → [D33](DECISION_LOG.md):** the minimal weekly-use slice is grocery planning (recipes → editable list). Re-scoped into a **Grocery MVP** built before P1's cook/search polish. (Pulling a *differentiator* forward as early proof remains open — MVP prioritizes usable-core over moat.)
- **Sale-ad T1 input availability** — validate that any real store ships structured sale data before committing the P6 architecture, or it falls through to LLM and breaks deterministic-first.
- **Data export scheduling** — pull a basic structured export earlier than P5 to honor "no lock-in" before early adopters can churn.

## Session log

Append a short entry per working session so context survives across months.

- **2026-09-09** — **Built P0.5 end to end** (7 phases, ~25 tasks, 70 commits on `feat/p05-selfhost-readiness`). **190 → 640 tests plus 2 Playwright specs.** Subagent-driven TDD with a spec + quality review on every phase; the reviews found something real every time, including four errors in the plan I had written. Locked [D34–D42](DECISION_LOG.md). The recurring lesson, which cost three separate bugs before it was named: **a check is not an enforcer**. The household cap fell to two concurrent writers, the invitation role pin fell to the raw Better Auth endpoint mounted alongside tRPC, and membership fell to every router that trusts `ctx.householdId` - each rule real, tested, and enforced in exactly one of the several places a writer could reach the state. All three now live where every writer must pass: a unique index, an auth middleware, a delete trigger. Second lesson: **four verification techniques found four disjoint bug classes** - reading found recipe titles in log URLs, racing found the concurrency holes, querying the database found a constraint that was absent after every test run, and rendering the page found copy asserting something it could not know. **Next: merge, publish, deploy.**

- **2026-09-08** — **Reviewed the whole project and scoped the next milestone arc.** Verified `main` (Grocery MVP merged as #2; 176 tests / typecheck / lint green — the local `node_modules` was two months stale and needed a `pnpm install`, not a code fix). Corrected the stale "pending merge" status above. Owner's goal: a real unraid instance, reachable by family, to add/import recipes and cook from — with auth, email, rate limiting, TLS and logging done *first* because they are miserable to retrofit. Scoped four shippable milestones (A: P0.5 foundations · B: P1 remainder · C1: URL import · C2: paste/PDF/photo) and locked [D34–D38](DECISION_LOG.md). Wrote the [self-host/cook/import design](specs/2026-09-08-selfhost-cook-import-design.md). **Next: Milestone A.**

- **2026-07-04 (cont.)** — **Built the Grocery MVP end-to-end** in a worktree (`feat/grocery-mvp`): 24 tasks across phases A (schema+RLS+FTS), B (deterministic core), C (recipe server), S (shopping server), D (web), E (E2E). Each phase independently reviewed (adversarial focus on tenant isolation + aggregation/scaling correctness); review findings fixed inline (merged-quantity rounding, NOT_FOUND semantics, add-to-list error surfacing, edit-mode test coverage). Result: 8 RLS-protected relational tables, a 120-test pure core, recipe + shopping tRPC routers, four React screens, and a passing Playwright happy path. **175 unit/integration tests + E2E green; typecheck/lint/build clean.** Deferred (documented, non-blocking): one-list uniqueness guard (revisit with multi-list feature), item-note editing, E2E-in-CI, minor a11y/pending-guard polish. **Next: merge to `main` (PR), then P1 remainder (cook mode + FTS search) or P2 import.**
- **2026-07-04** — **Re-scoped the near-term build into a Grocery MVP** after returning from vacation wanting automated grocery help ASAP without cutting corners. Assessed the plan: phasing philosophy is sound, but the desired MVP (recipes → editable shopping list) spans a *slice* of P1 + a *slice* of P3, while the P1-as-written front-loads cook-mode/search polish and lists don't appear until P3. **Chose to trim P1 and pull the shopping-list slice forward** (→ [D33](DECISION_LOG.md), resolves the long-pending "dogfood line" question). Keep recipe-core Phases A (schema) + B (deterministic core) in full; trim to recipe CRUD + servings scaler (defer cook mode + FTS search); add a 2-table shopping-list slice (relational, RLS) with 5 locked behaviors: no calendar, scaling snapshots into the list, same-food+same-unit aggregation only (no cross-unit conversion — deferred, not half-done), manual staples reuse the parser + get a department, department-grouped sink-away check-off. Wrote the [Grocery MVP slice design](specs/2026-07-04-grocery-mvp-slice-design.md).
- **2026-06-17** — Surveyed the FOSS landscape. Decided to build Hearth. Locked: TS full-stack, React/Vite PWA + Fastify/tRPC + Postgres, Better Auth + optional OIDC, single-tenant-first/MT-ready. Authored north-star docs. Then ran a deep feature brainstorm → **Decisions 9–23**: structured-core recipe model, canonical Food entity, scaling rules, unit system, deterministic/LLM boundary, portion ledger (leftovers/freezer/freshness), search+filters, shopping-list sorting, tiered sale ads, full receipt→budget loop, opt-in pantry, AGPL-3.0, magic-link sharing, pnpm monorepo skeleton. Wrote [INSPIRATION.md](INSPIRATION.md).
- **2026-06-18** — Stress-tested the P0 foundations plan before execution. Folded execution-affecting fixes inline into the plan (Better Auth/Fastify Set-Cookie + spike-first, cross-origin→Vite proxy, missing onboarding slice, ESLint JSX, dotenv path, tenant-isolation lint guard + RLS decision, disposable-`recipes`-table note, `docker compose up` exit-criterion mismatch). Logged five strategic open questions (audience-vs-self-host, solo-build scope/dogfood line, sale-ad T1 input, earlier data export, RLS) to the Decision Log pending section + this backlog.
- **2026-06-21** — **Brainstormed & approved the P1 (Recipe core) design** → [design doc](specs/2026-06-21-p1-recipe-core-design.md). Resolved five scope forks: thin-but-real `food` entity, linear-only scaling (`scaling_mode` stored for P4), natural-line ingredient entry backed by a reusable deterministic parser, **relational over JSON/raw-text** (locked as a standing preference: `recipe_step` rows + normalized `tag`/`recipe_tags`, no JSON arrays), and an additive-only forward-compat rule (P1 locks table identities; later phases only add columns/tables). Settled the 6-table schema, the isomorphic parser, FTS + three relational filters, and the explicit OUT-of-P1 boundary mapped to where each deferral lands.
- **2026-06-20** — **Pre-P1 foundation hardening (PR #1, squash-merged to `main`).** Confirmed the post-P0 state is genuinely clean (verified working tree + all gates green; the only test "failures" were a stopped local Postgres, not code). Then closed the two backlog items that are foundational *before* P1 adds new domain tables: **#5** — automated the RLS-discipline convention with `apps/server/src/db/rls.test.ts` (catalog-introspection guard, proven to red-flag a non-compliant table); **#7** — bumped CI actions off the deprecated Node 20 runtime (checkout v7 / setup-node v6 / action-setup v6). Also fixed two local dev-ex papercuts found while verifying: `pnpm db:migrate` now loads the repo-root `.env` (no manual `DATABASE_URL`), and a one-command `pnpm test:local` (db up → migrate → test). Self-reviewed via parallel finder agents + CI; one flagged issue (vitest `expect(value, message)`) empirically refuted. **Next: write the P1 (Recipe core) spec → plan, replacing the disposable P0 `recipes` table with the structured core (D9).**
- **2026-06-19** — **Executed the P0 foundations plan end-to-end (all 12 tasks, on `main`, CI green).** Stack live via `docker compose up`: Postgres + Fastify/tRPC/Better-Auth + React PWA behind Caddy on one origin. Verified the full onboarding + tenant-isolation flow three ways (in-process tests, Vite dev proxy, containerized `:8080`). Took the two pre-execution decisions: **D31** (adopt Postgres RLS now as defense-in-depth — proven to block a forgotten `WHERE`) and **D32** (containerize the app in P0 for true one-command deploy → added Task 12). Deviations forced by gaps the tests caught are logged in the [plan's completion banner](plans/2026-06-17-p0-foundations.md). Captured all P0 deferrals in a new [deferred/hardening backlog](plans/2026-06-19-p0-deferred-and-hardening.md). **Next: write the P1 (Recipe core) spec → plan, replacing the disposable P0 `recipes` table with the structured core (D9).**
- **2026-06-17 (cont.)** — UI/layout design session with the visual companion. Designed all five priority screens + the shared design system + responsive app shell → **Decisions 24–30** and the [UI/UX design spec](specs/2026-06-17-ui-design-p0-p1-design.md): Fresh Market theme on semantic design tokens (swappable themes + dark mode), bottom-tabs⇄left-rail shell, segmented recipe view + single-scroll Focus cook mode (wake lock, stacking timer tray, ingredient peek), week-agenda planner with source-coded slots + "use what you have" picker, department-grouped sink-away shopping list, source-tile import with confidence-flagged review, library with chips + smart-search tokens. **Next: writing-plans to turn the UI spec (with the P0/P1 backlog) into an implementation plan.**
