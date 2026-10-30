# Milestone B — Cook Mode & Library Search: Implementation Plan

**Goal:** Finish P1. A cook can find a recipe in a library that has grown past a screenful, and cook from it on a phone without the screen going dark.

**Architecture:** Two independent slices. **Search** turns the existing param-less `recipe.list` into a params-driven query over the `search_tsv` column and GIN indexes that already exist but have never been queried. **Cook mode** replaces a 13-line placeholder route with the Focus screen from D26. Neither needs a migration; neither touches auth, tenancy, or the mail layer.

**Tech Stack:** Postgres FTS (`websearch_to_tsquery`) · Drizzle · tRPC 11 · React 18 · Screen Wake Lock API.

**Design:** already approved, do not re-litigate. [P1 recipe-core design](../specs/2026-06-21-p1-recipe-core-design.md) §3 and §4; decisions **D16** (FTS + three filters), **D26** (segmented view, Focus cook mode), **D30** (library grid, chips, smart tokens).

---

## Read this before Task 1

**1. The FTS column does not contain tags, and the design says it does.** `0003_rls_recipe_core.sql` generates `search_tsv` from `title` (weight A) and `description` (weight B) only. The design's "description/tags weight B" was never implementable: a Postgres generated column can only reference its own row, and tags live in `recipe_tags`.

Do **not** add a trigger-maintained tsvector to fix this. Match tags **relationally** in the same query - a recipe matches if its `search_tsv` matches the text **or** it carries a tag matching it. That satisfies D30's "title/tag matches" with no migration and no second source of truth. Say so in a comment where the query is built, and correct the design doc's sentence.

**2. Everything the search needs already exists in the database.** `recipe_search_tsv_idx` (GIN on `search_tsv`), `recipe_meal_types_idx` (GIN on the `meal_types` enum array), `recipe_ingredient_food_idx` and `recipe_ingredient_recipe_idx`. Built during the Grocery MVP and never queried once. **Verify each is actually used** by your final query with `EXPLAIN`, and say which are not - an unused GIN index on a table this size will still look fast, so a plan that seq-scans will pass a timing test.

**3. Use `websearch_to_tsquery`, not `plainto_tsquery` or `to_tsquery`.** It accepts what a person types - quoted phrases, `or`, leading `-` for exclusion - and never throws on malformed input. `to_tsquery` throws a syntax error on a bare apostrophe, which a recipe search box will receive on its first day.

**4. Wake Lock is not universally available and needs a secure context.** `navigator.wakeLock` is absent in Firefox and older Safari, and undefined on plain `http://` origins other than `localhost`. Cook mode must work without it - the screen dims, that is all. Never let its absence throw, and never gate the screen on it.

**Repo conventions:** tests beside the code as `*.test.ts(x)`; server tests hit a real Postgres in a single fork and reset via `resetDb()`; web tests use React Testing Library following `ShoppingList.test.tsx`. `noUncheckedIndexedAccess` is on. Comments explain *why*. No em-dashes. Commit per task. Postgres is on 5433.

---

## Phase H — Library search and filters

### Task H1: `searchRecipes` in the repo layer

**Files:** modify `apps/server/src/repo/recipes.ts` · modify `apps/server/src/repo/recipes.test.ts`

Replace `listRecipes(householdId)` with `searchRecipes(householdId, params)` where params is `{ text?, ingredient?, mealType?, tag? }`, all optional. Empty params must return what `listRecipes` returned, in the same order, so the existing Library keeps working while H3 is unbuilt.

Behaviour:
- **text** - `websearch_to_tsquery('english', $1)` against `search_tsv`, **OR** a match on a tag name. Rank with `ts_rank_cd`, title above body (the weights already encode that); order by rank, then `created_at` descending.
- **ingredient** - join `recipe_ingredient → food`, keep recipes having a food whose `normalized_name` matches. This is D30's `contains {ingredient}` token and the payoff of the canonical Food model.
- **meal-of-day** - array containment against `meal_types`.
- **tag** - via `recipe_tags`.

Filters combine with AND; a recipe matching an ingredient twice appears once.

**Tests** (real Postgres, `resetDb()` first): each filter alone; all four combined; empty params equals the old ordering; a recipe is not duplicated by two matching ingredients; **tenant isolation** - household B's recipe never appears in A's results for any parameter combination; and a text query containing an apostrophe, a quoted phrase, and a bare `-` does not throw.

Then run `EXPLAIN (ANALYZE, BUFFERS)` on the fully-loaded query and record which indexes are used in your report.

### Task H2: `recipe.search` and `food.list`

**Files:** modify `apps/server/src/trpc/routers/recipe.ts` · create `apps/server/src/trpc/routers/food.ts` · modify `routers/index.ts` · tests

`recipe.list` gains an optional input driving `searchRecipes`. Keep the name `list`: it is one endpoint per the design, and renaming it churns the Library for nothing.

`food.list({ q })` returns household foods whose `normalized_name` matches a prefix, capped (20 is plenty), for the `contains {ingredient}` autocomplete **only**. Resist making it a general food API.

**Tests:** the router passes each parameter through; `food.list` is household-scoped and capped; both reject an over-long query string rather than passing it to Postgres.

### Task H3: Library search UI

**Files:** modify `apps/web/src/routes/Library.tsx`, `Library.module.css`, `Library.test.tsx`

Per D30: the existing 2-up card grid, plus **quick filter chips** (meal types, and popular tags with counts) giving a no-typing browse path, a **Filters sheet** to combine them, and a **smart-search input** that offers removable tokens - `contains {ingredient}` from `food.list`, alongside live title and tag matches.

The comment at the top of `Library.tsx` currently says search is deliberately absent and deferred. Replace it, do not leave it contradicting the file.

**Tests:** typing filters the grid; a chip narrows it; a token is removable and re-widens the results; an empty result set says something useful rather than rendering an empty grid; the search input is labelled and keyboard reachable.

---

## Phase I — Cook mode

### Task I1: step-duration parsing

**Files:** create `packages/shared/src/step-timers.ts` and its test

A pure function taking step text and returning the durations it mentions, with the character span of each so the UI can make just that phrase tappable. `simmer for 20 minutes` → one 20-minute duration; `bake 1 hour 10 min` → one 70-minute duration; `let rest 5-10 minutes` → the **longer** bound, because a timer that fires early is worse than one that fires late.

Must not match a temperature (`350F for 20 minutes` has one duration, not two), an ordinal (`step 3`), or a quantity (`2 cups`).

`packages/shared` is the pure, exhaustively-tested core (D11). This belongs there, not in the component.

### Task I2: the Focus screen

**Files:** rewrite `apps/web/src/routes/CookMode.tsx` (currently a 13-line placeholder) · create `CookMode.module.css` · create `CookMode.test.tsx`

Per D26: full-screen single-scroll outside `AppShell` (the route already exists and is already outside it), current step enlarged with done steps dimmed, tap-to-check as **ephemeral client state** - cooking progress is not worth a database write, and reloading mid-recipe starting over is the correct behaviour.

**Wake Lock**: request on mount, release on unmount, re-request on `visibilitychange` (the browser releases it when the tab is hidden and does not give it back). Absent API or a rejected request must degrade silently. See "Read this before Task 1" #4.

**Tests:** steps render and check off; a missing `navigator.wakeLock` does not throw and the screen still works; the lock is released on unmount; the back affordance returns to the recipe.

### Task I3: the timer tray

**Files:** modify `CookMode.tsx` · create a timer component + test

Durations from I1 become tappable phrases inside the step text. Tapping starts a timer that joins a **sticky stacking tray** at the bottom, dark, with rings that continue off-screen - a cook who has scrolled away must still be able to see and stop a timer.

Multiple timers run at once. Each shows what it is for. Firing needs to be noticeable with a phone on a counter and hands busy.

**Tests:** a duration is tappable; a started timer appears in the tray; two run independently; one can be cancelled; the tray survives scrolling away from the step that started it.

### Task I4: the ingredient peek

**Files:** modify `CookMode.tsx` · test

A bottom sheet showing ingredients **at the servings the cook scaled to**, not the recipe's base. That scaling already exists in `packages/shared`'s `scale()` and drives `RecipeView`; the cook mode route must carry the chosen servings through rather than re-deriving it.

**Tests:** the sheet opens and closes; amounts reflect a non-base scale; it is dismissible by keyboard.

### Task I5: Start Cooking, and E2E

**Files:** modify `apps/web/src/routes/RecipeView.tsx` · create `e2e/cook.spec.ts`

Wire the sticky *Start Cooking* affordance (D26) to `/recipes/:slug/cook`, carrying the scaled servings.

**E2E:** seed a recipe, open it, scale it, start cooking, check a step, open the ingredient peek and see scaled amounts, start a timer. Follow `e2e/invite.spec.ts` for fixtures. E2E is out of CI, so your local run is the only evidence - run it twice against the same database.

---

## Definition of done

- [ ] Full suite, typecheck, lint, build green; E2E specs pass twice in a row
- [ ] `EXPLAIN` output recorded showing which of the four pre-existing indexes the search actually uses
- [ ] Tenant isolation tested for every search parameter combination
- [ ] Cook mode works with Wake Lock absent
- [ ] The design doc's "description/tags weight B" sentence corrected
- [ ] `Library.tsx`'s "deliberately no search" comment removed
