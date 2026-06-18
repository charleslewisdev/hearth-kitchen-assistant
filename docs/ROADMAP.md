# Hearth — Roadmap

> **Living doc — updated every working session.** Keep this current as the single source of truth for "where are we and what's next." Each phase becomes its own spec → plan → build cycle when we reach it.

_Last updated: 2026-06-17 (UI/layout design session)_

## How to read this

- Phases are **roughly ordered**, not rigid. Differentiators are deliberately staged after a usable core so we ship value early.
- Each phase has an **exit criterion** — the thing that's true when the phase is "done."
- Status keys: `⬜ not started` · `🟦 in progress` · `✅ done`.

## Current status

**Phase: Planning / foundation-setting.**
North-star docs being authored. No application code yet. Next concrete step after docs: the **deep feature-by-feature brainstorm**, starting with the recipe storage-format decision.

## Phases

### P0 — Foundations ⬜
Repo, CI, Docker skeleton, monorepo layout, Postgres, Better Auth, household model + tenant-scoped data access.
**Exit:** a logged-in user in a household, deployed via `docker compose up`, with an empty but tenant-safe data layer and green CI.

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

Still open (next sessions):

- Better Auth ↔ Drizzle integration specifics; RLS vs app-layer tenant scoping; PWA offline-sync conflict resolution (deferred to P0/relevant specs).
- Exact design-token ramps, spacing scale, dark-theme values (settled during implementation).

Surfaced by the 2026-06-18 P0 plan stress test (details + rationale in [DECISION_LOG.md](DECISION_LOG.md#pending-decisions)):

- **Audience-vs-delivery tension** — non-technical primary audience vs self-host-only delivery; is the honest near-term audience the homelab secondary?
- **Solo-build scope / "dogfood line"** — differentiators (P4/P6/P7) are hardest and last; define the minimal weekly-use slice and pull one differentiator forward as an early proof.
- **Sale-ad T1 input availability** — validate that any real store ships structured sale data before committing the P6 architecture, or it falls through to LLM and breaks deterministic-first.
- **Data export scheduling** — pull a basic structured export earlier than P5 to honor "no lock-in" before early adopters can churn.
- **`docker compose up` P0 exit reconciliation** — the P0 plan ships db-in-compose only; decide whether full one-command app deploy + TLS is in P0 or P0.5.

## Session log

Append a short entry per working session so context survives across months.

- **2026-06-17** — Ran FOSS landscape research (deep-research, 101 agents). Decided to build Hearth. Locked: TS full-stack, React/Vite PWA + Fastify/tRPC + Postgres, Better Auth + optional OIDC, single-tenant-first/MT-ready. Authored north-star docs. Then ran a deep feature brainstorm → **Decisions 9–23**: structured-core recipe model, canonical Food entity, scaling rules, unit system, deterministic/LLM boundary, portion ledger (leftovers/freezer/freshness), search+filters, shopping-list sorting, tiered sale ads, full receipt→budget loop, opt-in pantry, AGPL-3.0, magic-link sharing, pnpm monorepo skeleton. Wrote [INSPIRATION.md](INSPIRATION.md).
- **2026-06-18** — Stress-tested the P0 foundations plan before execution. Folded execution-affecting fixes inline into the plan (Better Auth/Fastify Set-Cookie + spike-first, cross-origin→Vite proxy, missing onboarding slice, ESLint JSX, dotenv path, tenant-isolation lint guard + RLS decision, disposable-`recipes`-table note, `docker compose up` exit-criterion mismatch). Logged five strategic open questions (audience-vs-self-host, solo-build scope/dogfood line, sale-ad T1 input, earlier data export, RLS) to the Decision Log pending section + this backlog. **Next: execute the P0 plan in a fresh session.**
- **2026-06-17 (cont.)** — UI/layout design session with the visual companion. Designed all five priority screens + the shared design system + responsive app shell → **Decisions 24–30** and the [UI/UX design spec](superpowers/specs/2026-06-17-ui-design-p0-p1-design.md): Fresh Market theme on semantic design tokens (swappable themes + dark mode), bottom-tabs⇄left-rail shell, segmented recipe view + single-scroll Focus cook mode (wake lock, stacking timer tray, ingredient peek), week-agenda planner with source-coded slots + "use what you have" picker, department-grouped sink-away shopping list, source-tile import with confidence-flagged review, library with chips + smart-search tokens. **Next: writing-plans to turn the UI spec (with the P0/P1 backlog) into an implementation plan.**
