# P1 — Recipe Core: Design

> **Validated design** from the 2026-06-21 brainstorming session. Turns the locked recipe decisions (D9, D10, D12, D13, D16, D24–30) into a concrete, buildable P1 slice and schema. The next step is a detailed implementation plan (`writing-plans`).

_Status: design approved → ready for implementation planning._
_Phase: **P1 — Recipe core.** Replaces the disposable P0 `recipes` table with the structured core._

## P1 exit criterion (from ROADMAP)

> A user can hand-enter recipes and cook from them on a phone; basic search works.

Manual create/edit/store · canonical structured format · mobile-first viewing · cook mode (no screen timeout) · search by word + filter by ingredient / meal-of-day / tag.

## Scope decisions made this session

Five forks were resolved during the brainstorm; they govern everything below:

1. **Thin-but-real Food entity.** P1 builds the *real* canonical `food` table and foreign-keys to it from day one, but only the columns ingredient-search needs (`name`, `normalized_name`, `department`). The richer columns (default unit, scaling hints, density, shelf-life, merge lineage) are added by later phases.
2. **Linear scaling only.** The `scaling_mode` enum field is stored per D12, but P1 implements only `linear`. Non-linear modes are P4 and slot in additively.
3. **Natural-line entry + deterministic parser.** Users type natural ingredient lines ("2 cups flour, sifted"); a pure, test-first parser structures them. A manual field-override is the escape hatch. The parser is **reused by P2 import**.
4. **Relational over JSON/raw-text** (user preference). `recipe_step` is rows, tags are a normalized `tag` + `recipe_tags` join — not JSON arrays or `text[]`. Scales better as features land.
5. **Forward-compat = additive only.** P1 locks table *identities and relationships*. Every P1→full extension must be a new nullable column / new table, never a reshape-and-backfill.

---

## Section 1 — Core data model

Six new household-scoped tables replace the disposable `recipes` table. **Every table carries `household_id` + RLS** (grant to `hearth_app`, `ENABLE`+`FORCE`, household policy) — the merged RLS-coverage guard (`apps/server/src/db/rls.test.ts`) now fails CI if any is forgotten.

### `food` — canonical entity (thin in P1)
| column | type | notes |
|---|---|---|
| `id` | uuid pk | |
| `household_id` | text → organization | RLS; households own their Foods |
| `name` | text | display name |
| `normalized_name` | text | case-folded/trimmed/light-singularized, for dedup + fuzzy match |
| `department` | text? | set from seeded food→department dictionary at auto-create |
| `created_at` | timestamptz | |

*Later (additive):* `default_unit`, `default_scaling_mode`, `density`, `shelf_life_days`, `merged_into_id`. The seed dictionary is reference data used at creation, not rows.

### `recipe`
`id` · `household_id` · `title` · `slug` · `description?` · `servings` (base yield) · `prep_minutes?` · `cook_minutes?` · `source_url?` · `source_name?` · `created_at` · `updated_at` · `meal_types` (enum array: `breakfast|lunch|dinner|snack|dessert`) · plus a generated `search_tsv` tsvector (see §4).

### `recipe_ingredient`
`id` · `recipe_id` (FK cascade) · `household_id` · `food_id` (FK food; null only if unmatched) · `position` · `quantity?` (numeric) · `unit?` (normalized token; null = "to taste") · `note?` (prep) · `raw_text` (original typed line — **provenance only**, see §2) · `scaling_mode` (enum, default `linear`).

### `recipe_step`
`id` · `recipe_id` (FK cascade) · `household_id` · `position` · `text`. Rows, not JSON — clean reordering + future per-step timers / ingredient links.

### `tag` + `recipe_tags`
`tag`: `id` · `household_id` · `name` · `normalized_name`. `recipe_tags`: (`recipe_id`, `tag_id`) join. Normalized so D30 filter **chips show counts** and tags rename without a `text[]`→table migration.

**Forward-compat rule (locked):** additions only — new nullable columns / new tables. No reshape of these identities.

---

## Section 2 — Deterministic core (`packages/shared`, test-first per D11)

### Ingredient-line parser
Input: one natural line. Output: `{ quantity?, unit?, foodName, note? }`. Handles deterministically:
- unicode + ascii fractions and ranges — `½`, `1 1/2`, `1–2`
- unit vocabulary — `cup/tbsp/tsp/g/kg/ml/l/oz/lb/can/clove/…`
- unitless / "to taste" / "a pinch" → null quantity (first-class, D13)
- parenthetical + trailing notes — `(14 oz)`, `, sifted`

This is the same function **P2 import** feeds scraped/OCR'd lines into — core, not throwaway.

### `raw_text` is provenance only
The parser's *structured* output (`quantity/unit/food_id/note`) is the **single source of truth** for all math, scaling, and search. Nothing re-parses `raw_text` at query time. We keep the original line solely so the user can re-edit *their* words and re-parse, and so a low-confidence parse is correctable (seed of the D29 review pattern). It sits *alongside* the relational fields, never instead of them.

### Food auto-mapping
`foodName` → `normalized_name` → reuse an existing household `Food` or create one, assigning `department` from the seeded dictionary. Deterministic, no AI.

### Units (P1 scope)
Store `quantity` + a **normalized unit token** as entered. Linear scaling multiplies `quantity`; there's no shopping aggregation yet, so D13's **canonical-base (g/ml/count) conversion lands with P3** (the aggregation forcing function), added as nullable `base_*` columns then. Deferring is additive.

### `scale()` (linear)
Pure, tested: `scaledQty = quantity × target / base`. Shaped so non-linear `scaling_mode`s slot in at P4; P1 implements `linear` only.

---

## Section 3 — Application surface

### tRPC `recipe` router
Replaces the disposable P0 router; every procedure protected + household-scoped via `withHousehold`/RLS:
- `recipe.create` / `recipe.update` — take title, servings, `mealTypes`, tags, ingredient **lines**, steps. Server parses lines, resolves/creates Foods, writes recipe + ingredients + steps + tags in **one transaction**. Update reconciles children (re-parses only changed lines).
- `recipe.get` (id or slug) — full structured recipe (ingredients-with-Food, ordered steps, tags).
- `recipe.list` / `recipe.search` — one endpoint; params drive FTS text + filters (ingredient / meal-of-day / tag).
- `recipe.delete`. Minimal `food.list` for the "contains {ingredient}" autocomplete only.

### Isomorphic parser
The parser lives in `packages/shared`: the **client** calls it for a *live preview* as you type each line (powers manual override); the **server** calls the same function as source of truth on save. One implementation, two call sites.

### Three screens (D25–26, D30)
1. **Create/Edit** — title, servings, meal types, tags; paste-friendly multiline ingredients field where each line shows its parsed `{qty·unit·food·note}` with an inline "fix" override; add/reorder steps; save.
2. **Recipe view** — segmented Ingredients⇄Steps, prominent **servings scaler**, sticky *Start Cooking*.
3. **Cook mode (Focus)** — full-screen single-scroll, **Wake Lock**, tap-to-check steps (ephemeral client state), stacking timer tray (durations parsed from step text client-side), ingredient-peek bottom sheet with **scaled** amounts.

---

## Section 4 — Search & library

### Postgres FTS (D16, no external service)
`recipe.search_tsv` is a `GENERATED ALWAYS` tsvector — `title` weight **A**, `description`/tags weight **B** — with a **GIN index**. Stays correct on every write, no trigger. Query ranks title above body; order by rank then recency.

### Three MVP filters, all relational
- **Ingredient** — join `recipe_ingredient → food`, keep recipes with a `food` whose `normalized_name` matches. This *is* D30's **"contains {ingredient}"** smart token; the payoff of the canonical Food model.
- **Meal-of-day** — `meal_types` array containment (GIN-indexed).
- **Tag** — via `recipe_tags`; the join also yields the **counts** behind D30 filter chips.

### Library screen (D30)
2-up card grid over that search; **quick filter chips** (meal types + popular tags w/ counts) for a no-typing browse path; a **Filters sheet** to combine; smart-search input offering **removable tokens** (`contains tomato`, title/tag matches). One surface, two paths in.

**Deferred per D16 (additive predicates later):** total-time, cuisine, dietary, source, "cookable-now".

---

## Section 5 — Build sequence, scope boundary, testing

### Build order (vertical slice, deterministic-core-first)
1. **Schema & migration** — drop disposable `recipes`; add the six tables + FTS/array indexes; RLS+grant+policy on every table (guard enforces); seed the food→department dictionary.
2. **Deterministic core** (`packages/shared`, **TDD**) — parser, Food normalization, unit-token normalization, `scale()`. Thorough suites before anything calls them.
3. **Server** — Food-mapping repo, recipe repo (create/update/get/list/search) with `withHousehold` + tenant-isolation tests, tRPC router, FTS/search integration tests against Postgres.
4. **Web** — Create/Edit (live-parse preview + override) → View (segmented + scaler) → Cook mode (Focus + Wake Lock + timer tray + ingredient peek) → Library (grid + chips + tokens).
5. **E2E** — one Playwright happy path: create → view → scale → cook → search.

Each layer green before the next; CI gates lint + typecheck + test throughout.

### Explicitly OUT of P1 (all additive later — none box us in)
| Deferred | Lands in | How it's additive |
|---|---|---|
| Non-linear scaling | P4 | `scaling_mode` stored now; new branches in `scale()` |
| Canonical-base units + shopping aggregation | P3 | nullable `base_*` columns on `recipe_ingredient` |
| Density / shelf-life / portion ledger | P4 | new `food` columns + new portion tables |
| Food merge UI + default-unit intelligence | later | `merged_into_id` + new `food` columns |
| Import (URL / OCR / PDF) | P2 | **reuses** the P1 parser |
| Planning, shopping, sharing, pantry, sales, budget | P3+ | new tables/routers |
| total-time / cuisine / dietary / cookable-now filters | Core | new search predicates |

### Testing (D11)
TDD for the deterministic core; per-repo tenant-isolation tests; the RLS guard auto-covers the new tables; FTS/search integration tests against Postgres; a thin E2E for the cook happy path. Green CI throughout.
