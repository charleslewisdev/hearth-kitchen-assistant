# Hearth — Architecture & Tech Posture

> **North-star doc.** High-level posture, not a detailed technical spec. Per-slice specs live in [`specs/`](specs/). Locked choices are recorded in [DECISION_LOG.md](DECISION_LOG.md).

_Last updated: 2026-11-08 (zod lives in the server, D57; one app image, D46; offline list, D56)_

## Foundational decisions (locked)

| Area               | Decision                                                     | Rationale                                                                                                                      |
| ------------------ | ------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------ |
| **Language/stack** | TypeScript full-stack                                        | One language end to end; matches the author's existing projects; huge ecosystem.                                               |
| **Frontend**       | React + Vite, as a **PWA**                                   | Mobile-first cooking context; installable; an offline shopping list.                                                           |
| **API**            | Node + **Fastify** with **tRPC**                             | End-to-end type safety from DB to UI; fast; low ceremony.                                                                      |
| **Database**       | **Postgres**                                                 | Relational integrity for recipes/plans/lists; strong JSON support; row-level scoping for tenancy.                              |
| **Auth**           | **Better Auth** (embedded); optional OIDC planned, not built | Ships in the box (no cloud dependency for self-host); Organizations plugin = household/tenant; OIDC for homelabbers.           |
| **Tenancy**        | Single-household first, **multi-tenant-ready by design**     | Avoid a painful retrofit if we host publicly later.                                                                            |
| **Deploy**         | `docker compose up`: **one app image plus Postgres** (D46)   | Primary path for non-technical self-hosters. The server serves the built web app itself; there is no separate proxy container. |

## System shape

```
┌─────────────────────────────────────────────┐
│  React PWA (Vite)                            │
│  - mobile-first, cook mode, offline list     │
└───────────────┬─────────────────────────────┘
                │ tRPC (typed) + Better Auth routes
┌───────────────▼─────────────────────────────┐
│  Fastify server (Node/TS), one image         │
│  - serves the built web app                  │
│  - Better Auth (sessions, households)        │
│  - tRPC routers (zod input validation)       │
│  - import via packages/enrichment, in process│
└───────┬───────────────────────┬──────────────┘
        │                       │ (optional, not built)
┌───────▼────────┐    ┌─────────▼─────────────┐
│  Postgres      │    │  BYO-key LLM provider │
│  household-    │    │  for messy imports    │
│  scoped rows,  │    │  (D14)                │
│  RLS           │    └───────────────────────┘
└────────────────┘
```

## Multi-tenancy model

- The tenant unit is the **household** (Better Auth "organization"). A user belongs to one or more households.
- **Every domain table carries `household_id`.** Every query is tenant-scoped by default — enforced at the data-access layer (`withHousehold()` in `apps/server/src/repo/tenant.ts`), not left to callers.
- **Postgres Row-Level Security sits behind the repo layer** (D31): each `withHousehold()` transaction drops to the unprivileged `hearth_app` role and sets the active household, which every domain table's policy matches. A forgotten `WHERE` returns nothing rather than another household's rows.
- Single-tenant self-host is simply "one household." An instance holds exactly one household by default, behind a runtime toggle (D41), so public multi-tenant signup is a toggle plus a signup flow, **not** a schema migration.

## Auth posture

- **Better Auth** runs inside the app: email and password with email verification, password reset, sessions, and the **Organizations** plugin for households.
- **Accounts are invite-only** (D36): the owner invites by email, and the first owner signs up with a first-boot setup token (D42).
- **Optional OIDC** (Authentik/Authelia/Keycloak) remains the plan from D4, opt-in and never required. It is not built yet, and neither are 2FA or social login.
- No core feature may depend on an external auth service being reachable. The basic install authenticates entirely on its own.

## AI-optional boundary (critical)

The single most important architectural rule: **AI is an enhancement, never a dependency.**

- The fuzzy tasks (recipe import and parsing, image OCR, later receipt parsing) each have a **deterministic baseline** that works with no external services (D14).
- `packages/enrichment` holds that baseline for import: readers for a web page (JSON-LD, then HTML), pasted text, Markdown, PDF (text layer, then OCR), Word `.docx` and photos. Each produces the same `RecipeDraft`, which the cook reviews and saves through `recipe.create`. The server runs it in process; OCR is tesseract.js in the box.
- An optional **provider** (an LLM with the household's own OpenAI/Anthropic/Ollama key) may plug in later for messy inputs. None is built: D14 makes it optional, and the in-the-box baseline has carried real use so far.
- **No Python sidecar** (D23). If the TS ecosystem ever proves insufficient for OCR, scraping or receipts, a sidecar would sit behind the same boundary, out of the core request path and optional to run.

## Cross-cutting concerns

- **Data portability:** export everything. Recipes export as Markdown, one file or the whole library as a zip, and import back (D52). Photos, plans, the cook log and the shopping list are not exported yet, and there is no full account export.
- **Offline:** the service worker precaches the app shell. The shopping list opens with no signal from the device's last copy, and changes made offline are queued and sent on reconnect (D56). Cook mode keeps ticked steps and timers across a reload on the device (D47). Recipes are not kept offline, and edits made offline on two phones have no conflict rule yet ([#11](https://github.com/charleslewisdev/hearth-kitchen-assistant/issues/11)).
- **Testing (first-class — see Decision 11):** the deterministic core (scaling, unit conversion, shopping aggregation, food-mapping, parsers) is built **test-first (TDD)** with thorough unit suites and is testable with no network/AI. Typed contracts (tRPC, with zod validating input in the server's routers) plus tests at the router and repo boundary, and Playwright end-to-end specs. **CI gates on green** before any merge.
- **Observability:** structured JSON logs (pino via Fastify) with an ids-only rule: never recipe content, ingredient text or email bodies (D38, D40). `LOG_LEVEL` sets the verbosity.

## Monorepo layout (D23, corrected by D57)

pnpm workspaces:

```
packages/shared      pure domain logic (parser, units, scale, aggregation, departments), no zod
packages/enrichment  import readers: web page, text, Markdown, PDF, .docx, photo OCR
apps/server          Fastify + tRPC + Better Auth + Drizzle ORM + Postgres; zod schemas
apps/web             React + Vite PWA
```

Pure, side-effect-free domain logic lives in `packages/shared` so it can be exhaustively unit-tested in isolation (Vitest). It has no dependencies, and the other packages consume it from source (`main: ./src/index.ts`). Zod schemas live in the server, in the tRPC routers and `env.ts` (D57). ORM: **Drizzle** (SQL-first, strong types, suits tenant-scoped queries). **No Python sidecar**: tesseract.js, cheerio, unpdf and fflate keep the import path single-language.

## Open architectural questions

Resolved during the 2026-06-17 deep brainstorm (see [DECISION_LOG.md](DECISION_LOG.md)):

- ✅ Recipe storage format → structured core (D9)
- ✅ Monorepo layout & package boundaries → D23, corrected by D57
- ✅ Deterministic/LLM line per task → D14
- ✅ Sale-ad ingestion architecture → D18 (tiered)
- ✅ Receipt parsing pipeline + budget link → D19
- ✅ Python sidecar? → D23 (no, not initially)

Resolved during P0 (2026-06-19):

- ✅ Better Auth ↔ Drizzle integration → the Drizzle adapter owns the auth and organization tables; domain tables reference `organization.id`.
- ✅ Row-Level Security vs. app-layer-only tenant scoping → both (D31).

Still open:

- PWA offline-sync conflict resolution for edits made offline on two devices ([#11](https://github.com/charleslewisdev/hearth-kitchen-assistant/issues/11)).
- OIDC session and provider configuration, when OIDC is built.
