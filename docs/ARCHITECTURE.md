# Hearth — Architecture & Tech Posture

> **North-star doc.** High-level posture, not a detailed technical spec. Per-slice specs live in [`superpowers/specs/`](superpowers/specs/). Locked choices are recorded in [DECISION_LOG.md](DECISION_LOG.md).

_Last updated: 2026-06-17_

## Foundational decisions (locked)

| Area | Decision | Rationale |
|---|---|---|
| **Language/stack** | TypeScript full-stack | One language end to end; matches the author's existing projects; huge ecosystem. |
| **Frontend** | React + Vite, as a **PWA** | Mobile-first cooking context; installable; offline-capable core. |
| **API** | Node + **Fastify** with **tRPC** | End-to-end type safety from DB to UI; fast; low ceremony. |
| **Database** | **Postgres** | Relational integrity for recipes/plans/lists; strong JSON support; row-level scoping for tenancy. |
| **Auth** | **Better Auth** (embedded) + optional OIDC | Ships in the box (no cloud dependency for self-host); Organizations plugin = household/tenant; OIDC for homelabbers. |
| **Tenancy** | Single-household first, **multi-tenant-ready by design** | Avoid a painful retrofit if we host publicly later. |
| **Deploy** | `docker compose up` (app + Postgres) | Primary path for non-technical self-hosters. |

## System shape

```
┌─────────────────────────────────────────────┐
│  React PWA (Vite)                            │
│  - mobile-first, cook mode, offline core     │
└───────────────┬─────────────────────────────┘
                │ tRPC (typed)
┌───────────────▼─────────────────────────────┐
│  Fastify API (Node/TS)                       │
│  - Better Auth (sessions, OIDC, orgs)        │
│  - domain services (recipes, plans, lists…)  │
│  - enrichment interface (see below)          │
└───────┬───────────────────────┬──────────────┘
        │                       │ (optional, behind interface)
┌───────▼────────┐    ┌─────────▼─────────────┐
│  Postgres      │    │  Enrichment providers │
│  household-    │    │  - deterministic base │
│  scoped rows   │    │  - LLM / OCR (BYO key)│
└────────────────┘    │  - Python sidecar?    │
                      └───────────────────────┘
```

## Multi-tenancy model

- The tenant unit is the **household** (Better Auth "organization"). A user belongs to one or more households.
- **Every domain table carries `household_id`.** Every query is tenant-scoped by default — enforced at the data-access layer, not left to callers.
- Single-tenant self-host is simply "one household." Flipping on public multi-tenant signup is a feature toggle + signup flow, **not** a schema migration.
- Consider Postgres Row-Level Security as defense-in-depth (decision deferred to the data-model spec).

## Auth posture

- **Better Auth** runs inside the app: email/password, sessions, 2FA, social login, and the **Organizations** plugin for households.
- **Optional OIDC** lets homelab users delegate to an existing Authentik/Authelia/Keycloak — opt-in, never required.
- No core feature may depend on an external auth service being reachable. The basic install authenticates entirely on its own.

## AI-optional boundary (critical)

The single most important architectural rule: **AI is an enhancement, never a dependency.**

- Define an **enrichment interface** for the fuzzy tasks: recipe import/parsing, image OCR, receipt parsing.
- Each capability has a **deterministic baseline** that works with no external services (e.g., structured-data scraping for URLs, manual entry, rule-based parsing).
- Optional **providers** plug in behind the interface: an LLM (BYO OpenAI/Anthropic/Ollama key) or OCR engine for higher-quality extraction.
- If the TS ecosystem proves insufficient for OCR/scraping/receipts, isolate a **Python sidecar** behind the same interface — it stays out of the core request path and is optional to run.
- Whether any given feature *needs* an LLM or can be fully deterministic is an open question tracked per-feature in the [Roadmap](ROADMAP.md) and resolved during the deep brainstorm.

## Cross-cutting concerns

- **Data portability:** export everything (recipes as Markdown/structured, full account export). A first-class feature, not an afterthought — it backs the "no lock-in" principle.
- **Offline:** the cooking/viewing/shopping-list paths should work without connectivity (PWA service worker + local cache). Sync on reconnect.
- **Testing (first-class — see Decision 11):** the deterministic core (scaling, unit conversion, shopping aggregation, food-mapping, parsers, receipt itemization) is built **test-first (TDD)** with thorough unit suites and is testable with no network/AI. Typed contracts (tRPC + zod) plus tests at the domain-service boundary. **CI gates on green** before any merge.
- **Observability:** minimal by default (non-technical users), with opt-in logging for power users.

## Monorepo layout (Decision 23)

pnpm workspaces:

```
packages/shared      pure domain logic (scale, units, aggregation) + Zod schemas — the TDD core
packages/enrichment  import / OCR / receipt providers behind the enrichment interface
apps/server          Fastify + tRPC + Better Auth + Drizzle ORM + Postgres
apps/web             React + Vite PWA
```

Pure, side-effect-free domain logic lives in `packages/shared` so it can be exhaustively unit-tested in isolation (Vitest). ORM: **Drizzle** (SQL-first, strong types, suits tenant-scoped queries). **No Python sidecar initially** — tesseract.js, JS recipe-scrapers, and JS PDF parsing keep us single-language; revisit only if they prove insufficient.

## Open architectural questions

Resolved during the 2026-06-17 deep brainstorm (see [DECISION_LOG.md](DECISION_LOG.md)):

- ✅ Recipe storage format → structured core (D9)
- ✅ Monorepo layout & package boundaries → D23
- ✅ Deterministic/LLM line per task → D14
- ✅ Sale-ad ingestion architecture → D18 (tiered)
- ✅ Receipt parsing pipeline + budget link → D19
- ✅ Python sidecar? → D23 (no, not initially)

Still open (for later specs):

- Exact Better Auth ↔ Drizzle integration and session/OIDC config details.
- Row-Level Security vs. app-layer-only tenant scoping (defense-in-depth call).
- PWA offline-sync conflict-resolution strategy.
