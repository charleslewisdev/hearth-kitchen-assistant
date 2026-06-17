# Hearth — Decision Log

> **Append-only record** of locked decisions and *why*. When a decision changes, add a new entry that supersedes the old one (don't delete history). This is how the "why" survives across months and sessions.

_Last updated: 2026-06-17_

| # | Date | Decision | Rationale | Supersedes |
|---|---|---|---|---|
| 1 | 2026-06-17 | **Build a new product (Hearth)** rather than adopt an existing FOSS tool | Research found no end-to-end FOSS product; the 4 hardest/most-wanted features (non-linear scaling, freezer tracking, sale-ad integration, receipt→budget analytics) are unserved across the whole landscape. | — |
| 2 | 2026-06-17 | **TypeScript full-stack** | One language end to end; matches author's existing projects; large ecosystem. Python-strong tasks can be isolated as an optional sidecar. | — |
| 3 | 2026-06-17 | **React (Vite) PWA + Fastify + tRPC + Postgres** | Mobile-first cooking context (PWA); end-to-end type safety (tRPC); relational integrity + JSON + row scoping (Postgres). | — |
| 4 | 2026-06-17 | **Better Auth (embedded) + optional OIDC** | Ships in the box with no cloud dependency for self-host; Organizations plugin = household/tenant; OIDC for homelabbers who already run an IdP. | — |
| 5 | 2026-06-17 | **Single-tenant first, multi-tenant-ready by design** (`household_id` on every row, tenant-scoped queries from day one) | Avoid a painful retrofit if a public multi-tenant instance happens later. | — |
| 6 | 2026-06-17 | **Deterministic-first, AI-optional**, behind a pluggable enrichment interface | Core flows must work offline with zero AI; LLM/OCR is BYO-key enhancement, never a required dependency. | — |
| 7 | 2026-06-17 | **Canonical home for planning docs = the project repo** (`hearth/docs/`) | Version-controlled and co-located with code; matches sibling-project convention. | — |
| 8 | 2026-06-17 | **Working name: "Hearth"** | Warm, accessible to a non-technical mass audience; renameable if a conflict/better idea arises. | — |

## Pending decisions

See the [Roadmap open-questions backlog](ROADMAP.md#open-questions-backlog). Notable near-term:

- **Recipe storage format** (next brainstorm topic).
- **License** (AGPL vs MIT vs other) — affects how others can build on Hearth and whether a hosted commercial instance is viable.
