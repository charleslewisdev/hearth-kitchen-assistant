# Grocery MVP Implementation Plan

**Goal:** Ship the Grocery MVP — a household user can hand-enter recipes (CRUD) with a servings scaler, generate a department-grouped shopping list from them, and CRUD that list (manual staples, edit, sink-away check-off).

**Architecture:** This plan **reuses most of the [P1 recipe-core plan](2026-06-21-p1-recipe-core.md)** and layers a shopping-list slice on top. Recipe-core Phases A (schema) + B (deterministic core) are built in full. Phase C (server) is built minus FTS search. Phase D (web) is built minus cook mode, keeping the servings scaler. Two new tables (`shopping_list`, `shopping_list_item`, both RLS), a pure aggregation helper, a `shoppingList` tRPC router, and one shopping-list screen are added. Design: [Grocery MVP slice design](../specs/2026-07-04-grocery-mvp-slice-design.md), Decision [D33](../DECISION_LOG.md).

**Tech Stack:** TypeScript, Drizzle ORM + Postgres (RLS), tRPC v11, Fastify, Vitest, React 18 + `@trpc/react-query`, `react-router-dom`, Playwright.

---

## How this plan relates to the P1 plan

The [P1 recipe-core plan](2026-06-21-p1-recipe-core.md) is the source of truth for every **reused** task — do not re-derive its code here; open it and execute the referenced task exactly, applying any **delta** noted below. This plan gives **full detail only for new work** (shopping-list schema, aggregation, repo, router, screen, and the adjusted E2E).

| P1 plan task | In Grocery MVP? | Delta |
|---|---|---|
| A1 schema, A2 migration, A3 RLS+FTS+indexes | ✅ as-is | Extended by **Task S1** (add the 2 shopping-list tables to the same migration wave) |
| B1–B6 deterministic core | ✅ as-is | Plus **Task S2** (`itemMergeKey` aggregation helper, TDD) |
| C1 food repo, C2 create, C3 get, C5 update+delete, C6 router | ✅ as-is | C6: **omit the `search` procedure**; `list` stays plain |
| **C4 recipe search (FTS + filters)** | ❌ deferred | P1 fast-follow — do not build |
| D1 routing | ✅ as-is | Add `/shop` as a real route (was placeholder); add `/recipes/:slug/cook` still as placeholder |
| D2 Library | ✅ simplified | Card grid + "+ New recipe" + **recipe multi-select "Add to shopping list"**; **no** search input / filter chips / smart tokens |
| D3 Create/Edit | ✅ as-is | Keep the live-parse preview |
| D4 View + scaler | ✅ as-is | **Keep the servings scaler**; segmented panes optional; add an **"Add to list"** button (uses current scaled servings) |
| **D5 Cook mode** | ❌ deferred | P1 fast-follow — do not build |
| E1 E2E | ✅ replaced | **Task S6** replaces it with the recipe→list→staple→check-off happy path |

New tasks are prefixed **S** (shopping) and slot in as noted below.

---

## Conventions the executor must follow

Identical to the P1 plan's conventions — re-read them there. In short: run from repo root; Postgres on host **5433** (`pnpm db:up && pnpm db:migrate`, or `pnpm test:local`); **every new table carries `household_id` + RLS** and is reached only via `withHousehold` (`apps/server/src/repo/recipes.ts` is the reference; the `rls.test.ts` guard fails CI on any uncovered table — treat a failure as a real defect); **relational over JSON/raw-text**; **TDD** for the deterministic core (`packages/shared`); commit after every green step with Conventional Commits (lowercase, imperative, **no AI attribution**); generate table DDL with `db:generate` then hand-author the RLS migration mirroring `apps/server/drizzle/0001_rls_recipes.sql`.

---

## Phase A — Schema (recipe core + shopping list)

Execute **P1 plan Tasks A1, A2, A3 exactly**, then insert **Task S1 between A1 and A2** so the shopping-list tables land in the same generated migration and share one RLS migration.

### Task S1: Add the shopping-list tables to the schema

**Do this right after P1 Task A1's schema edit, before A2's `db:generate`.**

**Files:** Modify `apps/server/src/db/schema.ts` (append below the recipe-core tables).

**Step 1: Add the enum + two tables.** After the `recipeTags` table and before the `export type` block:

```ts
export const itemSource = pgEnum('item_source', ['recipe', 'manual']);

export const shoppingList = pgTable('shopping_list', {
  id: uuid('id').primaryKey().defaultRandom(),
  householdId: household(),
  name: text('name').notNull().default('Shopping list'),
  createdAt: timestamp('created_at').notNull().defaultNow(),
});

export const shoppingListItem = pgTable(
  'shopping_list_item',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    householdId: household(),
    listId: uuid('list_id').notNull().references(() => shoppingList.id, { onDelete: 'cascade' }),
    foodId: uuid('food_id').references(() => food.id, { onDelete: 'set null' }),
    name: text('name').notNull(),
    quantity: numeric('quantity'),
    unit: text('unit'),
    note: text('note'),
    department: text('department'),
    checked: boolean('checked').notNull().default(false),
    source: itemSource('source').notNull(),
    sourceRecipeId: uuid('source_recipe_id').references(() => recipe.id, { onDelete: 'set null' }),
    position: integer('position').notNull().default(0),
  },
  (t) => ({ byList: index('shopping_list_item_list_idx').on(t.listId, t.position) }),
);
```

Add `boolean` to the `drizzle-orm/pg-core` import list (P1 A1 imports `pgTable, uuid, text, integer, numeric, timestamp, primaryKey, index, pgEnum` — add `boolean`).

**Step 2: Add types** to the `export type` block:
```ts
export type ShoppingList = typeof shoppingList.$inferSelect;
export type ShoppingListItem = typeof shoppingListItem.$inferSelect;
```

**Step 3: Typecheck** `schema.ts` only (dependent files still broken from A1, expected):
Run: `pnpm --filter @hearth/server exec tsc -p tsconfig.json --noEmit` — `schema.ts` clean.

**Step 4: Commit**
```bash
git add apps/server/src/db/schema.ts
git commit -m "feat(server): shopping-list schema (shopping_list + shopping_list_item)"
```

### Delta for Task A2 (generate migration)
Unchanged — the generated `0002_*.sql` now also creates `item_source`, `shopping_list`, `shopping_list_item`, and their index. Review that it does.

### Delta for Task A3 (RLS + FTS + indexes)
In the hand-written `0003_rls_recipe_core.sql`, **also** emit the GRANT/ENABLE/FORCE/POLICY block for **`shopping_list`** and **`shopping_list_item`** (same four statements each, policy name `<table>_household_isolation`) alongside the six recipe-core tables. Both carry `household_id`, so the `rls.test.ts` guard will demand them.

Also extend the `apps/server/test/db.ts` truncate list (P1 A3 Step 3) to include the new tables, FK-safe first:
```ts
truncate table shopping_list_item, shopping_list, recipe_tags, tag, recipe_step,
  recipe_ingredient, recipe, food,
  "member", "invitation", "organization", "session", "account", "verification", "user"
  restart identity cascade;
```

Run the RLS guard (P1 A3 Step 4) — expect it to now also list `shopping_list, shopping_list_item`. Commit with the recipe-core RLS migration (or as a follow-up commit `feat(server): RLS policies for shopping-list tables`).

---

## Phase B — Deterministic core

Execute **P1 plan Tasks B1–B6 exactly** (TDD, `packages/shared`). Then add:

### Task S2: Shopping-item merge key (aggregation, TDD)

The one pure rule behind list aggregation (design decision 3): two items merge iff **same food + same unit, both with a real quantity**. Unmatched food (`foodId` null) or "to taste" (`quantity` null) never merges.

**Files:** Create `packages/shared/src/shopping.ts` + `packages/shared/src/shopping.test.ts`.

**Step 1: Failing test.**
```ts
import { describe, it, expect } from 'vitest';
import { itemMergeKey } from './shopping';

const base = { foodId: 'f1', unit: 'cup', quantity: 1 };

describe('itemMergeKey', () => {
  it('same food + same unit + real quantity share a key', () => {
    expect(itemMergeKey(base)).toBe(itemMergeKey({ ...base, quantity: 2 }));
  });
  it('different unit -> different key', () => {
    expect(itemMergeKey(base)).not.toBe(itemMergeKey({ ...base, unit: 'g' }));
  });
  it('different food -> different key', () => {
    expect(itemMergeKey(base)).not.toBe(itemMergeKey({ ...base, foodId: 'f2' }));
  });
  it('null unit is distinct from a named unit but mergeable with itself', () => {
    expect(itemMergeKey({ ...base, unit: null })).toBe(itemMergeKey({ foodId: 'f1', unit: null, quantity: 5 }));
    expect(itemMergeKey({ ...base, unit: null })).not.toBe(itemMergeKey(base));
  });
  it('null quantity ("to taste") never merges', () => {
    expect(itemMergeKey({ ...base, quantity: null })).toBeNull();
  });
  it('unmatched food (null foodId) never merges', () => {
    expect(itemMergeKey({ ...base, foodId: null })).toBeNull();
  });
});
```

**Step 2:** Run → FAIL (`itemMergeKey is not a function`).

**Step 3: Implement.**
```ts
export interface MergeableItem {
  foodId: string | null;
  unit: string | null;
  quantity: number | null;
}

// Returns a stable key for items that should aggregate together, or null for
// items that must never merge (unmatched food, or unitless "to taste"). Same
// food + same unit + both real quantities => same key (design decision 3).
export function itemMergeKey(item: MergeableItem): string | null {
  if (item.foodId == null || item.quantity == null) return null;
  return `${item.foodId}::${item.unit ?? ''}`;
}
```

**Step 4:** Run → PASS.

**Step 5:** Add `export * from './shopping';` to `packages/shared/src/index.ts`; commit `feat(shared): shopping-item merge key for list aggregation`.

**End of Phase B:** `pnpm --filter @hearth/shared exec vitest run` all green; `pnpm lint` clean.

---

## Phase C — Server: recipe repos + router

Execute **P1 plan Tasks C1, C2, C3, C5, C6** — **skip C4 (recipe search)**.

**Delta for C6 (tRPC router):** build `create`, `get`, `update`, `delete`, and `list` (→ `listRecipes` ordered by recency). **Do not** add the `search` procedure or its Zod input. Everything else in C6 (including the `server.test.ts` round-trip) stays. Commit message: `feat(server): recipe tRPC router (create/get/list/update/delete)`.

**End of Phase C:** `pnpm typecheck` clean; `pnpm test` green; `pnpm lint` clean.

---

## Phase S — Server: shopping-list repo + router

All DB access via `withHousehold` (now in `apps/server/src/repo/tenant.ts` after P1 C1 extracted it). Each repo function gets a tenant-isolation test (two households, no cross-read/write) in the style of `recipes.test.ts`.

### Task S3: Active-list + item repo

**Files:** Create `apps/server/src/repo/shopping.ts` + `apps/server/src/repo/shopping.test.ts`. Reuse `findOrCreateFood` from `apps/server/src/repo/foods.ts` (P1 C1), `parseIngredientLine` + `scale` + `itemMergeKey` from `@hearth/shared`, and the recipe/food/ingredient tables.

**Behavior (each function is one `withHousehold` tx unless noted):**

- **`getActiveList(householdId)`** → find the household's one `shopping_list`; **create it on first access** if absent (`name: 'Shopping list'`). Return `{ list, items }` where items are ordered by `department` (nulls last), then `position`, then `name`. (Grouping into departments is done client-side; the repo just returns a stable order.)

- **`addRecipeToList(householdId, recipeId, servings)`** →
  1. load the recipe (must belong to household) + its `recipe_ingredient` rows joined to `food`;
  2. for each ingredient: `scaledQty = scale({ quantity, mode: scalingModeValue }, { from: recipe.servings, to: servings })`; build a candidate `{ foodId, name: food.name, quantity: scaledQty, unit, note, department: food.department, source: 'recipe', sourceRecipeId: recipeId }`;
  3. get-or-create the active list;
  4. for each candidate: compute `itemMergeKey`. If non-null, `select` an existing item in this list with the same `food_id` and the same `unit` (both-null counts as equal) **and** `quantity is not null`; if found, `update` it to `quantity = existing + candidate` (numeric add); else `insert`. If the key is null (unmatched / "to taste"), always `insert`.
  5. New inserts get `position = (max position in list) + 1`.
  Return the updated `getActiveList` payload.

- **`addManualItem(householdId, text)`** → `parseIngredientLine(text)` → `findOrCreateFood(tx, householdId, parsed.foodName)` (so it gets a department) → insert one item `{ foodId, name: parsed.foodName, quantity, unit, note, department: food.department, source: 'manual', sourceRecipeId: null, position: max+1 }`. (Manual items are **not** aggregated into recipe items — a hand-added staple is intentional; keep it its own row.) Return the inserted item.

- **`updateItem(householdId, itemId, patch)`** → update allowed scalar fields (`name`, `quantity`, `unit`, `department`, `position`), household-scoped. Return the row or null.

- **`setChecked(householdId, itemId, checked)`** → update `checked`, household-scoped.

- **`removeItem(householdId, itemId)`** → delete, household-scoped.

- **`clearChecked(householdId)`** → delete all `checked = true` items in the active list. Return count.

**Tests (TDD, against Postgres) — write red→green→commit per behavior:**
1. `getActiveList` creates exactly one list on first call and returns it on the second (no duplicate).
2. `addRecipeToList` inserts one item per ingredient with scaled quantities (seed a 2-serving recipe, add at 4 servings, assert quantities doubled; a "to taste" ingredient stays null).
3. **Aggregation:** adding two recipes that share a food+unit yields **one** summed item; a shared food with **different units** yields **two** items; a "to taste" ingredient never merges.
4. `addManualItem('2 dozen eggs')` inserts a `manual` item with a department; `addManualItem('paper towels')` inserts with null quantity/unit.
5. `setChecked` / `clearChecked` / `removeItem` / `updateItem` behave and are household-scoped.
6. **Isolation:** household B cannot read, add to, check, or delete items in household A's list (extend with a second org, as in `recipes.test.ts`).

Commit each behavior: `feat(server): shopping-list get/create + active list`, `feat(server): add recipe to list with scaling + aggregation`, `feat(server): manual staple add via parser`, `feat(server): shopping item update/check/remove/clear`.

### Task S4: `shoppingList` tRPC router

**Files:** Create `apps/server/src/trpc/routers/shopping.ts`; register it in `apps/server/src/trpc/routers/index.ts` (add `shoppingList: shoppingRouter`); extend `apps/server/src/server.test.ts`.

**Step 1: Router** (all `protectedProcedure`, Zod inputs):
```ts
import { z } from 'zod';
import { router, protectedProcedure } from '../trpc';
import * as shopping from '../../repo/shopping';

export const shoppingRouter = router({
  get: protectedProcedure.query(({ ctx }) => shopping.getActiveList(ctx.householdId)),
  addRecipe: protectedProcedure
    .input(z.object({ recipeId: z.string().uuid(), servings: z.number().int().positive() }))
    .mutation(({ ctx, input }) => shopping.addRecipeToList(ctx.householdId, input.recipeId, input.servings)),
  addItem: protectedProcedure
    .input(z.object({ text: z.string().min(1) }))
    .mutation(({ ctx, input }) => shopping.addManualItem(ctx.householdId, input.text)),
  updateItem: protectedProcedure
    .input(z.object({
      itemId: z.string().uuid(),
      name: z.string().min(1).optional(),
      quantity: z.number().nullable().optional(),
      unit: z.string().nullable().optional(),
      department: z.string().nullable().optional(),
      position: z.number().int().optional(),
    }))
    .mutation(({ ctx, input }) => {
      const { itemId, ...patch } = input;
      return shopping.updateItem(ctx.householdId, itemId, patch);
    }),
  toggleChecked: protectedProcedure
    .input(z.object({ itemId: z.string().uuid(), checked: z.boolean() }))
    .mutation(({ ctx, input }) => shopping.setChecked(ctx.householdId, input.itemId, input.checked)),
  removeItem: protectedProcedure
    .input(z.object({ itemId: z.string().uuid() }))
    .mutation(({ ctx, input }) => shopping.removeItem(ctx.householdId, input.itemId)),
  clearChecked: protectedProcedure.mutation(({ ctx }) => shopping.clearChecked(ctx.householdId)),
});
```

**Step 2: Test** — extend `server.test.ts`: sign in + create org (reuse harness), `recipe.create` a recipe, `shoppingList.addRecipe`, `shoppingList.get` (assert items present), `shoppingList.addItem('paper towels')` (assert manual item), `shoppingList.toggleChecked` then `shoppingList.get` (assert checked), `shoppingList.clearChecked` (assert gone).

**Step 3: Commit** `feat(server): shopping-list tRPC router`.

**End of Phase S:** `pnpm typecheck` clean; `pnpm test` green; `pnpm lint` clean.

---

## Phase D — Web

Execute **P1 plan Tasks D1, D2, D3, D4** with the deltas in the table above — **skip D5 (cook mode)**. Key deltas restated:

- **D1 routing:** make `/shop` render the new shopping-list screen (Task S5), not a placeholder. Keep `/recipes/:slug/cook` as a placeholder (or omit the "Start Cooking" button for now).
- **D2 Library:** card grid + "+ New recipe" + a **selection mode**: check recipes → an **"Add N to shopping list"** action that calls `shoppingList.addRecipe` for each (at the recipe's base servings). **No** search input, filter chips, or smart tokens.
- **D4 View:** keep the **servings scaler**; add an **"Add to shopping list"** button that calls `shoppingList.addRecipe({ recipeId, servings: <current scaled servings> })` and toasts success.

Then add:

### Task S5: Shopping-list screen

**Files:** Create `apps/web/src/routes/ShoppingList.tsx` (+ `.module.css`, `ShoppingList.test.tsx`). Styling: CSS Modules + semantic tokens in `apps/web/src/styles/tokens.css` (never raw hex — D24).

**Behavior:**
- `trpc.shoppingList.get.useQuery()`.
- **Group items by `department`** (client-side) into sections; nulls → an "Other" section last. Within a section, unchecked first.
- **Sink-away check-off (D28):** a tappable checkbox per item calls `toggleChecked`; checked items collapse into a `Done (n)` group at the bottom (a `<details>` or a toggle). Optimistic update via `@trpc/react-query` `onMutate` (invalidate `shoppingList.get` on settle).
- **Free-form add bar** at the top: an input + "Add" → `shoppingList.addItem({ text })`; clears on success. Placeholder e.g. `Add a staple — "2 dozen eggs"`.
- **Per-item:** inline edit (name/qty/unit → `updateItem`) is a stretch; MVP minimum is a **remove** (×) → `removeItem`, plus the checkbox.
- **"Clear checked"** button (visible when any checked) → `clearChecked`.
- **Empty state:** "Your list is empty. Add recipes from the Library, or add a staple above."

**Tests (RTL):**
1. renders items grouped by department from mocked query data;
2. clicking a checkbox calls `toggleChecked` with the item id and `true`;
3. typing in the add bar + submit calls `addItem` with the text;
4. checked items appear under a "Done" group.

Commit `feat(web): shopping-list screen with department groups + sink-away check-off`.

**End of Phase D:** `pnpm --filter @hearth/web build` succeeds; web tests green; `pnpm lint` + `pnpm typecheck` clean.

---

## Phase E — End-to-end happy path

### Task S6: Playwright recipe→list→staple→check-off flow

**Files:** add Playwright to the workspace (per P1 E1 setup); create `e2e/playwright.config.ts` + `e2e/grocery-mvp.spec.ts`; add a `test:e2e` script that starts the app against the local DB. Use @playwright-skill.

**Spec (one happy path):** sign up → create household → create a recipe (title, 2–3 ingredient lines incl. one with a unit and one "to taste", two steps, a meal type) → open it → scale servings up (assert an amount changes) → **"Add to shopping list"** → go to `/shop` → assert the recipe's items appear, department-grouped, at scaled quantities → **add a manual staple** ("paper towels") and assert it appears → **check off** an item and assert it moves to Done → **clear checked** and assert it's gone. Deterministic; no external network.

**Commit** `test(e2e): grocery mvp happy path (recipe -> list -> staple -> check off)`.

**End of Phase E:** `pnpm test` + `pnpm test:e2e` green locally; push branch and confirm CI green. Decide at execution time whether E2E gates CI (may stay local-only initially to keep CI fast — if so, `log` that choice in the PR).

---

## Definition of done (Grocery MVP exit criterion)

- A logged-in household user can **hand-enter** a recipe (natural ingredient lines parsed into structured `food`-mapped ingredients + ordered steps), **view** it with a working **servings scaler**, **add it to a shopping list** at the chosen servings, **add manual staples**, see the list **department-grouped**, **check items off** (sink-away), and **clear checked** items.
- Aggregation merges same-food+same-unit items and never merges "to taste"/unmatched or cross-unit items.
- Deterministic core (parser, units, food-name, scale, departments, `itemMergeKey`) is exhaustively unit-tested (D11).
- Every new table (recipe core + `shopping_list` + `shopping_list_item`) is RLS-protected; the RLS guard passes; per-repo tenant-isolation tests pass.
- `pnpm lint`, `pnpm typecheck`, `pnpm test` green in CI; ROADMAP + design doc updated.

## Out of scope (deferred — additive later, per design & D33)

Cook mode + FTS search/filter chips (P1 fast-follow) · import/OCR (P2, reuses the parser) · calendar/day-assignment + freshness sequencing (P3/P4) · cross-unit shopping aggregation via canonical base units (P3) · multiple named lists / store layouts (later) · non-linear scaling (P4) · inline item drag-reorder + qty/unit edit UI (fast-follow).
