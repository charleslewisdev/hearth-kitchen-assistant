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
- **Testing:** typed contracts (tRPC + zod) plus tests at the domain-service boundary; the deterministic enrichment baselines must be testable without network.
- **Observability:** minimal by default (non-technical users), with opt-in logging for power users.

## Open architectural questions (resolved during deep brainstorm)

1. **Recipe storage format** — Markdown + frontmatter vs. fully structured relational vs. Cooklang-style canonical form. *First major brainstorm decision.*
2. Monorepo layout & package boundaries (client / server / shared types / enrichment).
3. Where the deterministic/LLM line falls for each enrichment task.
4. Sale-ad ingestion architecture (tiered: manual upload → structured feed → scraping).
5. Receipt parsing pipeline and how it links to budget analytics.
6. Whether a Python sidecar is needed at all, and for which tasks.
