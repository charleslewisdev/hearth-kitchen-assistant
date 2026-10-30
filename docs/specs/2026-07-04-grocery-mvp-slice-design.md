# Grocery MVP Slice — Design

> **Validated design** from the 2026-07-04 brainstorming session. Re-scopes and re-sequences the near-term build to reach a usable **grocery-planning MVP** as fast as possible **without cutting corners** — every artifact is kept or additive, nothing is thrown away or reshaped later.

_Status: design approved → ready for implementation planning._
_Milestone: **Grocery MVP** — a trimmed P1 (recipe core) + a pulled-forward slice of P3 (shopping list)._

## Why this exists (the dogfood line)

The ROADMAP open-questions backlog and DECISION_LOG both carried a standing pending question: **"define the minimal weekly-use slice (the dogfood line) and pull one capability forward as an early proof."** This design answers it.

The MVP the author will actually use weekly is: **plan groceries from recipes, then CRUD the resulting list** (add staples by hand, edit, check off in-store). That goal spans a *slice* of P1 (enough recipe CRUD to have ingredients) and a *slice* of P3 (list generation + editing) — but needs **none** of P1's cook-mode/search polish and **none** of P2 (import) or P3's calendar planning. So we re-sequence to hit it first.

**No corners cut** is the governing constraint: the trimmed items are *deferred*, not hacked. They slot back in additively exactly as the [P1 recipe-core design](2026-06-21-p1-recipe-core-design.md) already promised.

## Scope — keep / trim / add

Relative to the [P1 recipe-core plan](../plans/2026-06-21-p1-recipe-core.md):

### Keep unchanged (the foundation — no trimming)
- **Phase A** — the full 6-table recipe schema + RLS on every table. Bedrock.
- **Phase B** — the full deterministic core (ingredient-line parser, unit/food-name normalization, `scale()`, seed food→department dictionary). The parser and department seed are *exactly* what the shopping list needs, so building all of B is not over-building.

### Trim from P1 (defer as fast-follow increments — additive)
- **Server:** keep `create` / `get` / `list` / `update` / `delete`; **drop FTS `search`** (plan Task C4) → plain list ordered by recency.
- **Web:** keep **Library** (simple card grid; no filter chips, no smart-search), **Create/Edit** (keep the live-parse preview — cheap and high-value), **View** (segmented panes optional; **keep the servings scaler**).
- **Drop Cook mode** (plan Task D5) entirely for now.

### Add (the pulled-forward grocery slice)
- Shopping-list schema (2 tables) + repo + tRPC router + one screen.

The servings scaler is **kept in the MVP** (decided this session): `scale()` already ships in Phase B, the View screen just adds a stepper, and it directly touches grocery quantities (scale a recipe before adding it → the list quantities scale too).

## Shopping-list data model (relational — no JSON)

Two new household-scoped tables, each with `household_id` + RLS (grant to `hearth_app`, `ENABLE`+`FORCE`, household policy — the `rls.test.ts` guard enforces coverage).

### `shopping_list`
`id` (uuid pk) · `household_id` (text → organization, RLS) · `name` · `created_at`.
**MVP: one active list per household.** Multiple named lists is a clean additive follow-up.

### `shopping_list_item`
`id` (uuid pk) · `household_id` (RLS) · `list_id` (FK → shopping_list, cascade) · `food_id?` (FK → food; null if unmatched) · `name` · `quantity?` (numeric) · `unit?` (normalized token) · `department?` · `checked` (bool, default false) · `source` (enum `recipe` | `manual`) · `source_recipe_id?` (FK → recipe, set null on delete) · `position` (int).

**Forward-compat:** additions only. Later phases add columns (e.g. `base_quantity`/`base_unit` for cross-recipe unit aggregation, `store_layout_id`) — never reshape these identities.

## Five behavioral decisions

1. **No calendar / day-assignment.** Select recipes → "add to list." Day-planning + freshness sequencing stay in P3/P4. This is the biggest scope-saver and keeps the MVP honest.
2. **Scaling snapshots into the list.** Adding a recipe at the chosen servings *copies* the scaled quantities into `shopping_list_item` rows. The list is a working document you then edit — not a live re-computing link back to the recipe.
3. **Light aggregation only.** Merge items with the **same `food_id` + same `unit`** by summing quantity. **Different units stay as separate lines** — no volume↔weight or cross-unit conversion (that is the deferred D13 canonical-base work landing in full P3; doing it half-way *would* be cutting a corner, so we don't). Unitless / "to taste" (null quantity) never aggregates.
4. **Manual staples reuse the parser.** A free-text add ("2 dozen eggs", "paper towels") runs through the same `parseIngredientLine` + food-mapping, so staples get a `department` and group alongside recipe items. Consistent, deterministic, no separate code path.
5. **Department-grouped, check-off, sink-away.** Grouping is free from `food.department`. Checked items sink to a collapsed "Done (n)" group (D28 default) so the active list shrinks in-store. Check state is persisted server-side.

## Application surface (grocery slice)

### tRPC `shoppingList` router (all protected + household-scoped via `withHousehold`/RLS)
- `get` — the household's active list, items grouped/ordered by department then position.
- `addRecipe` — `{ recipeId, servings }` → scale the recipe's ingredients (snapshot), find-or-merge into items per decision 3.
- `addItem` — `{ text }` → parse + food-map → append a `manual` item.
- `updateItem` — edit name/quantity/unit/department/position.
- `toggleChecked` — `{ itemId, checked }`.
- `removeItem` — `{ itemId }`.
- `clearChecked` — bulk-remove checked items (in-store convenience).

### One screen — Shopping list
Department-grouped, check-off (sink-away), a free-form add bar, an "add recipe(s)" entry that lists the library for multi-select, and a "clear checked" action. Built on the existing semantic tokens (no raw hex, D24).

Recipe reach onto the list happens either from the Library (select recipes → add) or a per-recipe "add to list" affordance on the View screen.

## Build sequence (vertical slice)

1. **Schema & migration** — recipe-core Phase A (unchanged) **plus** the 2 shopping-list tables + RLS in the same migration wave.
2. **Deterministic core** — Phase B, full, TDD (unchanged).
3. **Server (recipe)** — Phase C minus Task C4 (no FTS search); plain `list`.
4. **Server (shopping list)** — new repo + router, per-repo tenant-isolation tests, aggregation unit-tested.
5. **Web** — Create/Edit (live-parse) → View (+ scaler, + "add to list") → Library (simple grid, multi-select add) → **Shopping list screen**.
6. **E2E** — one Playwright happy path: create recipe → add to list → add a manual staple → check items off.

Each layer green before the next; CI gates lint + typecheck + test throughout (D11).

## Explicitly OUT of the Grocery MVP (all additive later — none box us in)

| Deferred | Lands in | How it's additive |
|---|---|---|
| Cook mode (Focus, wake lock, timer tray) | P1 fast-follow | new full-screen route + hook; no schema change |
| FTS search + filter chips / smart tokens | P1 fast-follow | `search_tsv` + predicates over existing tables |
| Import (URL / OCR / PDF) | P2 | **reuses** the Phase B parser |
| Calendar / day-assignment + freshness | P3 / P4 | new `meal_plan` tables; list already exists |
| Cross-unit shopping aggregation | P3 | nullable `base_*` columns on ingredient + item |
| Multiple named lists / store layouts | later | `shopping_list` already keyed; add rows + `store_layout_id` |
| Non-linear scaling | P4 | new branches in `scale()`; `scaling_mode` already stored |

## Testing (D11)
TDD for the deterministic core (incl. the aggregation merge); per-repo tenant-isolation tests for both new repos; the `rls.test.ts` guard auto-covers the two new `household_id` tables; a thin E2E for the recipe→list→check happy path. Green CI throughout.

## Deferred polish (found during the 2026-07-04 build)

Non-blocking items surfaced by the phase reviews and deliberately left for later (the MVP shipped without them by choice, not omission):

- **One-list uniqueness guard.** `shopping_list` has no unique constraint on `household_id`; `getActiveList` is select-then-insert, so two truly-concurrent first-accesses could create duplicate lists (low probability; reads always pick the oldest). Deferred deliberately: a hard household-unique constraint would fight the planned *multiple named lists* feature — solve it then with an `active` flag rather than a constraint now.
- **Item `note` not editable.** `shoppingList.updateItem` exposes name/quantity/unit/department/position but not `note`; correcting a parsed note means remove + re-add. Add `note` to the patch when inline item editing lands.
- **E2E not in CI.** The Playwright happy path runs locally/manually (`pnpm test:e2e`); it needs the full stack + a browser + live Postgres, which would slow CI. Revisit with a dedicated CI Postgres service once more flows exist.
- **Minor a11y / UX polish.** Segmented control uses `role=tab` without full `tabpanel`/arrow-key semantics; reorderable step rows use index keys; per-item shopping mutations share a pending flag (brief flicker / over-disable). All cosmetic.
- **Parser DRY.** `parseIngredientLine` re-encodes the leading-quantity grammar that `parseQuantity` also owns (it needs the matched span to slice the token). Consider having `parseQuantity` optionally return the consumed length so there's a single source of truth.
