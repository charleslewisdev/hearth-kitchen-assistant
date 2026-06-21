# P1 — Recipe Core Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Build the deterministic core test-first (@superpowers:test-driven-development). Reference @react-testing-library, @vitest, @react-router-declarative-mode, and @playwright-skill where noted.

**Goal:** Replace the disposable P0 `recipes` table with the structured recipe core so a user can hand-enter recipes, cook from them on a phone, and search by word / ingredient / meal-of-day / tag.

**Architecture:** Six household-scoped relational tables (`food`, `recipe`, `recipe_ingredient`, `recipe_step`, `tag`, `recipe_tags`), each with Postgres RLS. A pure, test-first deterministic core in `packages/shared` (ingredient-line parser, unit/food normalization, linear `scale()`) used isomorphically by both server (source of truth on save) and client (live preview). A tRPC `recipe` router over `withHousehold` repos. A React PWA with four screens (Library, Create/Edit, View, Cook) routed by `react-router-dom`. Postgres FTS for search.

**Tech Stack:** TypeScript, Drizzle ORM + Postgres (RLS), tRPC v11, Fastify, Vitest, React 18 + `@trpc/react-query`, `react-router-dom`, Playwright.

**Design reference:** [`docs/superpowers/specs/2026-06-21-p1-recipe-core-design.md`](../specs/2026-06-21-p1-recipe-core-design.md). Decisions D9/D10/D12/D13/D16/D24–30 + D31 (RLS).

---

## Conventions the executor must follow

- **Run from repo root.** Tests need Postgres: `pnpm db:up && pnpm db:migrate` once, then `pnpm test` (or `pnpm test:local` to do all three). Local DB is on host port **5433**.
- **Tenancy is non-negotiable.** Every new table carries `household_id` and is reached only via `withHousehold(...)` (`apps/server/src/repo/recipes.ts` is the reference). The merged RLS guard (`apps/server/src/db/rls.test.ts`) fails CI if any `household_id` table lacks RLS+policy+grant — treat a guard failure as a real defect, not a test to relax.
- **Relational over JSON/raw-text** (standing user preference): proper columns/tables, never JSON blobs. `recipe_ingredient.raw_text` is the one allowed source-text column and is *provenance only* — never parsed at query time.
- **TDD for the deterministic core.** Phase B is strictly red→green→commit per behavior. Pure functions, no DB.
- **Commit after every green step.** Conventional Commits (`feat:`/`test:`/`refactor:`…), lowercase, imperative. No AI attribution.
- **Migrations:** generate the table DDL with `pnpm --filter @hearth/server db:generate`, then hand-author the RLS/FTS/index migration as a custom SQL file mirroring `apps/server/drizzle/0001_rls_recipes.sql` (`--> statement-breakpoint` between statements).

---

## Phase A — Schema & migration

Replaces the disposable `recipes` table. After this phase the app will not compile until the server is rewritten in Phase C — that is expected; Phase A ends on a green migration + green RLS guard, with `recipes`-dependent code temporarily broken (we delete it in C).

### Task A1: Define the recipe-core Drizzle schema

**Files:**
- Modify: `apps/server/src/db/schema.ts` (remove the `recipes` table + `Recipe` types; add the six tables)

**Step 1: Replace the `recipes` table definition** with the new schema. Keep `export * from './auth-schema';` and the `organization` import.

```ts
import { pgTable, uuid, text, integer, numeric, timestamp, primaryKey, index, pgEnum } from 'drizzle-orm/pg-core';
import { organization } from './auth-schema';

export * from './auth-schema';

export const mealType = pgEnum('meal_type', ['breakfast', 'lunch', 'dinner', 'snack', 'dessert']);
export const scalingMode = pgEnum('scaling_mode', ['linear', 'fixed', 'sublinear', 'manual']);

const household = () =>
  text('household_id').notNull().references(() => organization.id, { onDelete: 'cascade' });

export const food = pgTable(
  'food',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    householdId: household(),
    name: text('name').notNull(),
    normalizedName: text('normalized_name').notNull(),
    department: text('department'),
    createdAt: timestamp('created_at').notNull().defaultNow(),
  },
  (t) => ({ byHouseholdNorm: index('food_household_norm_idx').on(t.householdId, t.normalizedName) }),
);

export const recipe = pgTable('recipe', {
  id: uuid('id').primaryKey().defaultRandom(),
  householdId: household(),
  title: text('title').notNull(),
  slug: text('slug').notNull(),
  description: text('description'),
  servings: integer('servings').notNull().default(1),
  prepMinutes: integer('prep_minutes'),
  cookMinutes: integer('cook_minutes'),
  sourceUrl: text('source_url'),
  sourceName: text('source_name'),
  mealTypes: mealType('meal_types').array().notNull().default([]),
  createdAt: timestamp('created_at').notNull().defaultNow(),
  updatedAt: timestamp('updated_at').notNull().defaultNow(),
});

export const recipeIngredient = pgTable('recipe_ingredient', {
  id: uuid('id').primaryKey().defaultRandom(),
  householdId: household(),
  recipeId: uuid('recipe_id').notNull().references(() => recipe.id, { onDelete: 'cascade' }),
  foodId: uuid('food_id').references(() => food.id, { onDelete: 'restrict' }),
  position: integer('position').notNull(),
  quantity: numeric('quantity'),
  unit: text('unit'),
  note: text('note'),
  rawText: text('raw_text').notNull(),
  scalingModeValue: scalingMode('scaling_mode').notNull().default('linear'),
});

export const recipeStep = pgTable('recipe_step', {
  id: uuid('id').primaryKey().defaultRandom(),
  householdId: household(),
  recipeId: uuid('recipe_id').notNull().references(() => recipe.id, { onDelete: 'cascade' }),
  position: integer('position').notNull(),
  text: text('text').notNull(),
});

export const tag = pgTable(
  'tag',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    householdId: household(),
    name: text('name').notNull(),
    normalizedName: text('normalized_name').notNull(),
  },
  (t) => ({ byHouseholdNorm: index('tag_household_norm_idx').on(t.householdId, t.normalizedName) }),
);

export const recipeTags = pgTable(
  'recipe_tags',
  {
    householdId: household(),
    recipeId: uuid('recipe_id').notNull().references(() => recipe.id, { onDelete: 'cascade' }),
    tagId: uuid('tag_id').notNull().references(() => tag.id, { onDelete: 'cascade' }),
  },
  (t) => ({ pk: primaryKey({ columns: [t.recipeId, t.tagId] }) }),
);

export type Recipe = typeof recipe.$inferSelect;
export type NewRecipe = typeof recipe.$inferInsert;
export type Food = typeof food.$inferSelect;
export type RecipeIngredient = typeof recipeIngredient.$inferSelect;
export type RecipeStep = typeof recipeStep.$inferSelect;
```

> Note: the generated `search_tsv` tsvector column is added by the hand-written migration (Task A3), not Drizzle — drizzle-kit doesn't model `GENERATED ALWAYS … tsvector` cleanly. The repo selects explicit columns, so the un-modeled column is harmless.

**Step 2: Typecheck** (will fail in dependent files — that's fine here):
Run: `pnpm --filter @hearth/server exec tsc -p tsconfig.json --noEmit`
Expected: errors only in `repo/recipes.ts`, `trpc/routers/recipe.ts`, tests (resolved in C). `schema.ts` itself: no errors.

**Step 3: Commit**
```bash
git add apps/server/src/db/schema.ts
git commit -m "feat(server): recipe-core drizzle schema (food/recipe/ingredient/step/tag)"
```

### Task A2: Generate the table migration

**Step 1:** Run `pnpm --filter @hearth/server db:generate`. Drizzle writes `apps/server/drizzle/0002_*.sql` + updates `meta/`. Review it: it should `DROP TABLE recipes`, `CREATE TYPE meal_type`/`scaling_mode`, and create the six tables + the two `index` definitions.

**Step 2:** Apply locally: `pnpm db:up && pnpm db:migrate`. Expected: `migrations applied successfully!`

**Step 3: Commit**
```bash
git add apps/server/drizzle
git commit -m "feat(server): generate recipe-core table migration"
```

### Task A3: Hand-write the RLS + FTS + index migration

**Files:**
- Create: `apps/server/drizzle/0003_rls_recipe_core.sql`
- Modify: `apps/server/drizzle/meta/_journal.json` (add an entry mirroring how `0001` was registered — copy the shape of the existing custom-migration journal entry; tag/idx values follow the existing pattern)

> The journal hand-edit mirrors exactly what was done for `0001_rls_recipes.sql`. Inspect `meta/_journal.json` for the `0001` entry and append a `0003` entry with `"breakpoints": true`. (Alternatively run `db:generate` with an empty schema diff to let drizzle-kit scaffold an empty custom migration, then fill it.)

**Step 1: Author the migration.** For **each** of the six tables: grant DML to `hearth_app`, `ENABLE` + `FORCE` RLS, and add a household policy. Then add the FTS column + indexes.

```sql
-- Tenant isolation for the recipe core (Decision 31), mirroring 0001_rls_recipes.sql.
-- The hearth_app role already exists (created in 0001).

-- recipe ---------------------------------------------------------------
GRANT SELECT, INSERT, UPDATE, DELETE ON recipe TO hearth_app;
--> statement-breakpoint
ALTER TABLE recipe ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE recipe FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY recipe_household_isolation ON recipe
  USING (household_id = current_setting('app.current_household', true))
  WITH CHECK (household_id = current_setting('app.current_household', true));
--> statement-breakpoint
-- repeat the GRANT/ENABLE/FORCE/POLICY block for: food, recipe_ingredient,
-- recipe_step, tag, recipe_tags (same four statements each, policy name
-- <table>_household_isolation).

-- Full-text search (D16): generated tsvector, title weight A, description weight B.
ALTER TABLE recipe
  ADD COLUMN search_tsv tsvector
  GENERATED ALWAYS AS (
    setweight(to_tsvector('english', coalesce(title, '')), 'A') ||
    setweight(to_tsvector('english', coalesce(description, '')), 'B')
  ) STORED;
--> statement-breakpoint
CREATE INDEX recipe_search_tsv_idx ON recipe USING gin (search_tsv);
--> statement-breakpoint
CREATE INDEX recipe_meal_types_idx ON recipe USING gin (meal_types);
--> statement-breakpoint
CREATE INDEX recipe_ingredient_food_idx ON recipe_ingredient (food_id);
--> statement-breakpoint
CREATE INDEX recipe_ingredient_recipe_idx ON recipe_ingredient (recipe_id);
```

**Step 2: Apply & verify** — `pnpm db:migrate`. Expected: applied successfully.

**Step 3: Update `test/db.ts` truncate list.**
- Modify `apps/server/test/db.ts`: replace `recipes` with the new tables (FK-safe via CASCADE):
```ts
truncate table recipe_tags, tag, recipe_step, recipe_ingredient, recipe, food,
  "member", "invitation", "organization", "session", "account", "verification", "user"
  restart identity cascade;
```

**Step 4: Run the RLS guard** — it now covers every new `household_id` table:
Run: `pnpm --filter @hearth/server exec vitest run src/db/rls.test.ts`
Expected: PASS, listing `food, recipe, recipe_ingredient, recipe_step, recipe_tags, recipe` (and `tag` if you add `household_id` — note: `tag`/`recipe_tags` also have `household_id`, so they're covered too). If any table is flagged, the migration missed it — fix the migration, don't touch the test.

**Step 5: Commit**
```bash
git add apps/server/drizzle apps/server/test/db.ts
git commit -m "feat(server): RLS policies + FTS + indexes for recipe core"
```

---

## Phase B — Deterministic core (`packages/shared`, strict TDD)

Pure functions, no DB. Each task is red→green→commit. Use @superpowers:test-driven-development. Export everything from `packages/shared/src/index.ts`. Run a single file with `pnpm --filter @hearth/shared exec vitest run src/<file>.test.ts`.

### Task B1: Unit-token normalization

**Files:** Create `packages/shared/src/units.ts`, `packages/shared/src/units.test.ts`.

**Step 1: Failing test.**
```ts
import { describe, it, expect } from 'vitest';
import { normalizeUnit } from './units';

describe('normalizeUnit', () => {
  it.each([
    ['cup', 'cup'], ['cups', 'cup'], ['c', 'cup'],
    ['tablespoon', 'tbsp'], ['tbsp', 'tbsp'], ['T', 'tbsp'],
    ['teaspoon', 'tsp'], ['tsp', 'tsp'], ['t', 'tsp'],
    ['gram', 'g'], ['grams', 'g'], ['g', 'g'],
    ['ounce', 'oz'], ['oz', 'oz'], ['pound', 'lb'], ['lbs', 'lb'],
    ['ml', 'ml'], ['milliliter', 'ml'], ['l', 'l'], ['liter', 'l'],
    ['clove', 'clove'], ['cloves', 'clove'], ['can', 'can'],
  ])('maps %s -> %s', (input, expected) => {
    expect(normalizeUnit(input)).toBe(expected);
  });
  it('returns null for unknown / unitless words', () => {
    expect(normalizeUnit('pinch')).toBeNull();
    expect(normalizeUnit('')).toBeNull();
  });
});
```
**Step 2:** Run → FAIL (`normalizeUnit is not a function`).
**Step 3:** Implement `units.ts`: a `Record<string, CanonicalUnit>` alias map (case-insensitive lookup on a trimmed, lowercased, trailing-`.`-stripped key); return mapped token or `null`. Export `CANONICAL_UNITS` set too (used by the parser).
**Step 4:** Run → PASS. **Step 5:** add `export * from './units';` to `index.ts`; commit `feat(shared): canonical unit-token normalization`.

### Task B2: Quantity parsing

**Files:** Create `packages/shared/src/quantity.ts` + test.

**Step 1: Failing test** — cover: `'2'`→2, `'1/2'`→0.5, `'1 1/2'`→1.5, `'½'`→0.5, `'1½'`→1.5, `'1.5'`→1.5, `''`→null, `'a'`→null. Ranges: `parseQuantity('1-2')`/`'1–2'` → take the **low** end (1) for P1 (document this; ranges are not modeled yet), with a follow-up note.
**Step 2:** FAIL. **Step 3:** implement: unicode-fraction table (`½⅓¼¾…`), `whole + fraction`, decimal, range (split on `-`/`–`, take first). Return `number | null`.
**Step 4:** PASS. **Step 5:** export; commit `feat(shared): quantity parsing (fractions, unicode, ranges)`.

### Task B3: Food-name normalization

**Files:** Create `packages/shared/src/food-name.ts` + test.

**Step 1: Failing test** — `normalizeFoodName('Tomatoes')`→`'tomato'`, `'  Olive Oil '`→`'olive oil'`, `'eggs'`→`'egg'`, `'flour'`→`'flour'`. Light singularize only (`-ies`→`-y`, trailing `-es`/`-s`), lowercase, collapse whitespace. Document that this is intentionally simple (full lemmatization is later).
**Step 2:** FAIL. **Step 3:** implement. **Step 4:** PASS. **Step 5:** export; commit `feat(shared): food-name normalization`.

### Task B4: Ingredient-line parser

**Files:** Create `packages/shared/src/ingredient.ts` + test. Depends on B1–B3.

**Step 1: Failing test** — assert `parseIngredientLine` returns `{ quantity, unit, foodName, note }`:
```ts
expect(parseIngredientLine('2 cups flour')).toEqual({ quantity: 2, unit: 'cup', foodName: 'flour', note: null });
expect(parseIngredientLine('1 1/2 tsp salt')).toEqual({ quantity: 1.5, unit: 'tsp', foodName: 'salt', note: null });
expect(parseIngredientLine('3 cloves garlic, minced')).toEqual({ quantity: 3, unit: 'clove', foodName: 'garlic', note: 'minced' });
expect(parseIngredientLine('1 (14 oz) can diced tomatoes')).toEqual({ quantity: 1, unit: 'can', foodName: 'diced tomatoes', note: '14 oz' });
expect(parseIngredientLine('salt to taste')).toEqual({ quantity: null, unit: null, foodName: 'salt', note: 'to taste' });
expect(parseIngredientLine('2 eggs')).toEqual({ quantity: 2, unit: null, foodName: 'eggs', note: null });
```
**Step 2:** FAIL. **Step 3:** implement the tokenizer: extract leading quantity (B2) → optional parenthetical (→ note) → optional unit word (B1; if the next word isn't a canonical unit, there's no unit and it's part of the food) → split trailing `, …`/` to taste` into `note` → remainder is `foodName` (trimmed, raw, **not** normalized — normalization happens at Food mapping). Keep `foodName` as the user's words; `note` holds prep/qualifiers.
**Step 4:** PASS (iterate until all cases green; add cases for tricky inputs you discover). **Step 5:** export; commit `feat(shared): deterministic ingredient-line parser`.

### Task B5: Linear `scale()`

**Files:** Create `packages/shared/src/scale.ts` + test.

**Step 1: Failing test:**
```ts
expect(scale({ quantity: 2, mode: 'linear' }, { from: 4, to: 8 })).toBe(4);
expect(scale({ quantity: 2, mode: 'linear' }, { from: 4, to: 2 })).toBe(1);
expect(scale({ quantity: null, mode: 'linear' }, { from: 4, to: 8 })).toBeNull(); // "to taste" never scales
// non-linear modes are P4: explicitly fall back to the unscaled quantity for now
expect(scale({ quantity: 2, mode: 'fixed' }, { from: 4, to: 8 })).toBe(2);
```
**Step 2:** FAIL. **Step 3:** implement: `null`→`null`; `linear`→`quantity * to / from`; any other mode→`quantity` (unscaled), with a `// P4: implement non-linear modes` marker. Round to a sensible precision (e.g. 3 significant places) — add a test pinning the rounding.
**Step 4:** PASS. **Step 5:** export; commit `feat(shared): linear ingredient scaling`.

### Task B6: Seed food→department dictionary

**Files:** Create `packages/shared/src/food-departments.ts` + test.

**Step 1: Failing test** — `departmentFor('tomato')`→`'Produce'`, `'milk'`→`'Dairy'`, `'chicken breast'`→`'Meat & Seafood'`, `'flour'`→`'Baking'`, `'unknownthing'`→`null`. Keys are normalized names (B3).
**Step 2:** FAIL. **Step 3:** implement a seeded `Record<normalizedName, department>` (start with ~60 common foods across Produce/Dairy/Meat & Seafood/Bakery/Baking/Pantry/Frozen/Beverages; lookup tries exact normalized name, then last word). Document it's a starter seed, extended over time.
**Step 4:** PASS. **Step 5:** export; commit `feat(shared): seed food→department dictionary`.

**End of Phase B:** `pnpm --filter @hearth/shared exec vitest run` all green; `pnpm lint` clean.

---

## Phase C — Server: repos + tRPC router

Delete the disposable recipe code and rebuild over the new schema. All DB access via `withHousehold` (copy the helper from the current `repo/recipes.ts`). Each repo function gets a tenant-isolation test in the style of `apps/server/src/repo/recipes.test.ts` (two households, assert no cross-read/write).

### Task C1: Food-mapping repo

**Files:** Create `apps/server/src/repo/foods.ts` + `foods.test.ts`. Reuse/extract `withHousehold` into a shared module `apps/server/src/repo/tenant.ts` (move it out of `recipes.ts`; re-export for compatibility) — DRY, since multiple repos need it.

**Behavior:** `findOrCreateFood(tx, householdId, rawFoodName)` → normalize (B3) → `select` existing `food` by `(household_id, normalized_name)` → if absent `insert` with `department = departmentFor(normalized)` → return the `food` row. Takes a `tx` so it composes inside the recipe-create transaction.

**Tests (TDD):** (1) creates a food with department set; (2) returns the same food for `'Tomatoes'` and `'tomato'` (dedup via normalization); (3) two households get separate foods for the same name (isolation). Red→green→commit `feat(server): household food-mapping repo`.

### Task C2: Recipe create

**Files:** Create `apps/server/src/repo/recipes.ts` (rewrite) + expand `recipes.test.ts`.

**Behavior:** `createRecipe(householdId, input)` where input = `{ title, servings, mealTypes, tags: string[], ingredientLines: string[], steps: string[] }`. Inside one `withHousehold` tx:
1. insert `recipe` (slug via `slugify`, `mealTypes`);
2. for each ingredient line: `parseIngredientLine` → `findOrCreateFood` → insert `recipe_ingredient` (`position`, `quantity`, `unit`, `note`, `rawText`=line, `foodId`);
3. for each step: insert `recipe_step` with `position`;
4. for each tag: find-or-create `tag` (normalized) → insert `recipe_tags`.
Return the created recipe id/slug.

**Tests (TDD):** (1) creates a recipe with N ingredients mapped to foods + ordered steps + tags; (2) `raw_text` preserved per ingredient; (3) two ingredient lines naming the same food reuse one `food` row; (4) tenant isolation (household B cannot read A's recipe — extend the existing isolation test). Commit `feat(server): structured recipe create with parsing + food mapping`.

### Task C3: Recipe get (assembled)

**Behavior:** `getRecipe(householdId, idOrSlug)` → recipe + ingredients (ordered, joined to `food` for name/department) + steps (ordered) + tags. Returns `null` if not found / other household.

**Tests:** (1) returns fully assembled structure; (2) returns `null` for another household's recipe (RLS already proven, but assert at repo level); (3) ingredients/steps come back in `position` order. Commit `feat(server): assembled recipe get`.

### Task C4: Recipe list + search (FTS + filters)

**Behavior:** `searchRecipes(householdId, { q?, ingredient?, mealType?, tag? })`:
- base: select recipe card fields (`id, title, slug, mealTypes`, prep/cook minutes);
- if `q`: `where search_tsv @@ websearch_to_tsquery('english', q)` ordered by `ts_rank`;
- if `ingredient`: `where exists (select 1 from recipe_ingredient ri join food f on f.id = ri.food_id where ri.recipe_id = recipe.id and f.normalized_name = normalizeFoodName(ingredient))`;
- if `mealType`: `where meal_types @> array[mealType]`;
- if `tag`: exists-join through `recipe_tags`→`tag`;
- default order: `created_at desc`.
Use Drizzle `sql` fragments for the tsquery/array bits.

**Tests (TDD, against Postgres):** seed 3 recipes; assert (1) `q:'soup'` returns only the soup; (2) `ingredient:'tomato'` returns recipes containing tomato (the headline filter); (3) `mealType:'dinner'` filters; (4) `tag:'quick'` filters; (5) combined `q + mealType` narrows; (6) isolation: another household's matching recipe never appears. Commit `feat(server): recipe search over FTS + ingredient/meal/tag filters`.

### Task C5: Recipe update + delete

**Behavior:** `updateRecipe(householdId, id, input)` — update scalar fields; reconcile children by **replace-within-transaction** (delete this recipe's `recipe_ingredient`/`recipe_step`/`recipe_tags`, re-insert from input; re-parse lines). Simpler and correct for P1; optimize to diff later if needed. `deleteRecipe(householdId, id)` — delete recipe (cascade removes children).

**Tests:** (1) update changes title + re-parses ingredients; (2) update is household-scoped; (3) delete removes recipe + children; (4) delete is household-scoped. Commit `feat(server): recipe update + delete`.

### Task C6: tRPC router

**Files:** Rewrite `apps/server/src/trpc/routers/recipe.ts`; update `apps/server/src/server.test.ts`.

**Procedures** (all `protectedProcedure`, Zod inputs):
- `create` (mutation) — input schema: `{ title: z.string().min(1), servings: z.number().int().positive().default(1), mealTypes: z.array(z.enum([...])).default([]), tags: z.array(z.string()).default([]), ingredientLines: z.array(z.string()).default([]), steps: z.array(z.string()).default([]) }`
- `get` (query) — `{ idOrSlug: z.string() }`
- `search` (query) — `{ q?, ingredient?, mealType?, tag? }` all optional
- `update` (mutation), `delete` (mutation), `list` (query → `search({})`).

**Tests:** extend `server.test.ts` — sign in, create org (reuse the existing harness), call `create` then `get`/`search` through the tRPC caller; assert round-trip. Commit `feat(server): recipe tRPC router (create/get/search/update/delete)`.

**End of Phase C:** `pnpm typecheck` clean; `pnpm test` green; `pnpm lint` clean.

---

## Phase D — Web (React PWA)

Four screens. Introduce `react-router-dom` for navigation (cook mode is a full-screen route, not a tab — D25). Use @react-router-declarative-mode and @react-testing-library. Styling: CSS Modules + the existing semantic tokens in `apps/web/src/styles/tokens.css` (never raw hex — D24).

### Task D1: Add routing

**Files:** add `react-router-dom` to `apps/web/package.json`; modify `apps/web/src/App.tsx`, `apps/web/src/app/AppShell.tsx`.

**Behavior:** keep the auth/org gating in `App`, then wrap the authed tree in `<BrowserRouter>`. Routes: `/` + `/recipes` (Library), `/recipes/new` (Create), `/recipes/:slug` (View), `/recipes/:slug/cook` (Cook — rendered **outside** `AppShell**, full-screen), `/plan`,`/shop`,`/more` (placeholders). AppShell tab buttons become `NavLink`s; `aria-current` from `NavLink`'s active state.

**Tests:** RTL render of AppShell asserts links point to the right paths and the active link gets `aria-current`. Commit `feat(web): react-router navigation + full-screen cook route`.

### Task D2: Library screen

**Files:** rewrite `apps/web/src/routes/Recipes.tsx` → `Library.tsx` (+ `.module.css`, test).

**Behavior:** `trpc.recipe.search.useQuery(filters)`; 2-up responsive card grid (token-based); a search input that debounces into `q`; filter **chips** for meal types and tags (tags/counts from results); the "contains {ingredient}" token sets `ingredient`. A prominent "+ New recipe" → `/recipes/new`. Empty state.

**Tests:** RTL — renders cards from mocked query data; typing filters; chip toggles a filter. Commit `feat(web): recipe library with search + filter chips`.

### Task D3: Create/Edit screen

**Files:** create `apps/web/src/routes/RecipeEdit.tsx` (+ css, test).

**Behavior:** controlled form — title, servings, meal-type multiselect, tags input; a **multiline ingredients textarea** where each non-empty line renders a live parsed preview using the **isomorphic** `parseIngredientLine` from `@hearth/shared` (`{qty·unit·food·note}`) with an inline "fix" affordance (edit the line); a steps list (add/remove/reorder); Save → `trpc.recipe.create` (or `update` when `:slug` present) → navigate to `/recipes/:slug`.

**Tests:** RTL — typing "2 cups flour" shows a parsed preview `2 · cup · flour`; submit calls the mutation with `ingredientLines`. Commit `feat(web): create/edit recipe with live-parse preview`.

### Task D4: Recipe view + scaler

**Files:** create `apps/web/src/routes/RecipeView.tsx` (+ css, test).

**Behavior:** `trpc.recipe.get`; **segmented** Ingredients⇄Steps control (D26); a **servings scaler** (stepper) that recomputes displayed amounts via `scale()` from `@hearth/shared` (base = recipe.servings); sticky **Start Cooking** → `/recipes/:slug/cook`. Ingredient amounts render scaled; "to taste" (null qty) never scales.

**Tests:** RTL — doubling servings doubles a numeric amount and leaves "to taste" unchanged; segmented toggle switches panes. Commit `feat(web): recipe view with segmented panes + servings scaler`.

### Task D5: Cook mode (Focus)

**Files:** create `apps/web/src/routes/CookMode.tsx` (+ css, test) and a small `useWakeLock` hook + a `parseTimers` helper (reuse B2-style duration parse: "simmer 20 minutes" → 20:00).

**Behavior (D26):** full-screen single-scroll; current step enlarged, completed steps dim; **tap-to-check** steps (ephemeral `useState`, not persisted); a sticky dark **timer tray** that stacks timers parsed from step text; **Wake Lock** via `navigator.wakeLock` (guarded for unsupported browsers); an **Ingredients peek** bottom sheet showing scaled amounts; an exit back to the view.

**Tests:** RTL — tapping a step toggles its done class; a step mentioning "20 minutes" surfaces a startable timer; `useWakeLock` no-ops gracefully when the API is absent (mock `navigator.wakeLock`). Commit `feat(web): focus cook mode with wake lock + timer tray`.

**End of Phase D:** `pnpm --filter @hearth/web build` succeeds; web tests green; `pnpm lint` + `pnpm typecheck` clean.

---

## Phase E — End-to-end happy path

### Task E1: Playwright cook-to-search flow

**Files:** add Playwright (`@playwright/test`) to the workspace; create `e2e/playwright.config.ts` + `e2e/recipe-core.spec.ts`; add a `test:e2e` script that starts the app (against the local DB) and runs the spec. Use @playwright-skill.

**Spec (one happy path):** sign up → create household → create a recipe (title, 2–3 ingredient lines incl. one with a unit, two steps, a meal type, a tag) → see it in the Library → open it → scale servings (assert an amount changes) → enter Cook mode (assert steps render) → back to Library → search by an ingredient and by `q` (assert the recipe appears). Keep it deterministic; no external network.

**Commit** `test(e2e): recipe-core happy path (create → cook → search)`.

**End of Phase E:** `pnpm test` (unit/integration) + `pnpm test:e2e` green locally; push branch and confirm CI green. Update `.github/workflows/ci.yml` only if E2E should gate CI (decide at execution time — may keep E2E local-only initially to keep CI fast; if so, `log` that choice in the PR).

---

## Definition of done (P1 exit criterion)

- A logged-in household user can **hand-enter** a recipe (natural ingredient lines parsed into structured `food`-mapped ingredients + ordered steps + tags), **view** it on a phone with a working **servings scaler**, **cook** from it in full-screen Focus mode with screen-wake-lock, and **search** the library by word, **ingredient**, meal-of-day, and tag.
- Deterministic core (parser, units, food-name, scale, departments) is exhaustively unit-tested (D11).
- Every new table is RLS-protected; the RLS guard passes; per-repo tenant-isolation tests pass.
- `pnpm lint`, `pnpm typecheck`, `pnpm test` green in CI; design doc + ROADMAP updated; `recipes` (singular `recipe`) replaces the disposable P0 table with **no remaining references** to the old shape.

## Out of scope (deferred — additive later, per design §5)

Non-linear scaling (P4) · canonical-base units + shopping aggregation (P3) · density/shelf-life/portion-ledger (P4) · Food merge UI + default-unit intelligence (later) · import/OCR (P2, reuses the parser) · planning/shopping/sharing/pantry/sales/budget (P3+) · total-time/cuisine/dietary/cookable-now filters (Core).
