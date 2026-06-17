# Hearth — Roadmap

> **Living doc — updated every working session.** Keep this current as the single source of truth for "where are we and what's next." Each phase becomes its own spec → plan → build cycle when we reach it.

_Last updated: 2026-06-17_

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

Tracked here until resolved in a brainstorm or spec; resolutions move to [DECISION_LOG.md](DECISION_LOG.md).

1. **Recipe storage format** — Markdown+frontmatter vs structured relational vs Cooklang canonical. *(next up)*
2. Exact search/filter set (which filters ship in MVP).
3. Per-task deterministic-vs-LLM line (import, OCR, receipts).
4. External services/dependencies (OCR engine, scraping libs, LLM providers).
5. Per-ingredient scaling-rule model (how rules are expressed/stored).
6. Sale-ad ingestion formats and tier-1 scope.
7. Receipt parsing approach + itemization depth.
8. Inventory/pantry tracking — in scope, and how deep?
9. License choice (AGPL vs MIT vs other).
10. Which "borrow from" patterns/UI inspirations to adopt per project (Mealie/Tandoor/Grocy/KitchenOwl/Cooklang).

## Session log

Append a short entry per working session so context survives across months.

- **2026-06-17** — Ran FOSS landscape research (deep-research, 101 agents). Decided to build Hearth. Locked: TS full-stack, React/Vite PWA + Fastify/tRPC + Postgres, Better Auth + optional OIDC, single-tenant-first/MT-ready. Authored north-star docs. Next: deep feature brainstorm starting with recipe format.
