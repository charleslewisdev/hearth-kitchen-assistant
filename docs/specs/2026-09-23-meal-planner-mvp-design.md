# Meal planner MVP (P3, first slice)

_2026-09-23. Status: approved in conversation; decisions D44 and D45._

## Why now

The owner wants Hearth on the unraid box by about 2026-09-30, good enough to plan a week of meals
and shop for it. Recipes, import, cook mode, search and the shopping list already work. The Plan
tab is a "coming soon" stub. This slice fills it with the smallest planner that turns a week of
meals into one shopping list.

## Scope

In:

- A week view: seven days, each with Breakfast, Lunch and Dinner rows (D27's defaults).
- Put a recipe in a slot with a serving count. A slot may hold several recipes (a main and a side).
- Change an entry's servings, move it to another day or meal, remove it.
- Step to the previous or next week, and back to this week.
- **Build shopping list** adds the week's meals to the household's list through the existing
  scaling and aggregation. Each entry remembers that it was added, so a second tap adds only the
  meals that are new since the first (D44).
- Which day a week starts on is a household setting, Sunday by default (D45), changed on the More
  screen.

Out, and why:

- Leftovers, frozen portions and the source colours of D27 need D15's portion ledger (P4). Every
  entry is "cook fresh" for now.
- Freshness-aware ordering needs shelf-life data nobody has entered.
- Drag and drop between slots. Moving is a menu action in this slice.
- Free-text entries without a recipe ("eating out"). Additive later as a nullable `recipe_id` and a
  `note` column.
- Removing a meal's items from the list when the meal is removed from the plan. Items on a list
  have been edited and checked by then; guessing which to pull is worse than leaving them.

## Data model

Two new tables, both carrying `household_id`, behind RLS, reached through `withHousehold()`.

`meal_plan_entry`

| column           | type                                  | notes                                                        |
| ---------------- | ------------------------------------- | ------------------------------------------------------------ |
| id               | uuid pk                               |                                                              |
| household_id     | text not null → organization, cascade |                                                              |
| plan_date        | date not null                         | the household's local calendar day; no time zone             |
| meal             | meal_type not null                    | the existing enum; the UI offers breakfast, lunch and dinner |
| recipe_id        | uuid not null → recipe, cascade       | deleting a recipe drops it from the plan                     |
| servings         | integer not null, check > 0           |                                                              |
| added_to_list_at | timestamptz null                      | set by Build shopping list; null means not on the list yet   |
| created_at       | timestamptz not null default now()    | orders entries within a slot                                 |

Index `(household_id, plan_date)`: every read is one household's seven days.

`household_settings`

| column       | type                                    | notes                                         |
| ------------ | --------------------------------------- | --------------------------------------------- |
| household_id | text pk → organization, cascade         | one row per household, created on first write |
| week_start   | smallint not null default 0, check 0..6 | 0 is Sunday, matching `Date.getUTCDay()`      |

A settings table rather than a column on Better Auth's `organization`, because that table's shape
belongs to the auth library and its HTTP routes write it. A missing row means the defaults.

`plan_date` is a `date` and every date crosses the API as a `YYYY-MM-DD` string. The client says
what "today" is, because the server's clock and the household's differ. The week arithmetic is
pure code in `packages/shared` over UTC dates, so no local-time conversion happens anywhere.

## API (tRPC `plan` router)

- `plan.week({ date })` returns the week containing `date` under the household's `weekStart`:
  `{ start, weekStart, entries }`, where each entry carries its recipe's id, slug, title and own
  serving count.
- `plan.add({ date, meal, recipeId, servings })` returns the entry.
- `plan.update({ id, servings?, date?, meal? })` returns the entry, or NOT_FOUND.
- `plan.remove({ id })`.
- `plan.buildList({ start })` adds every entry in `[start, start + 7)` whose `added_to_list_at` is
  null to the list, in one transaction with setting the timestamp, and returns how many it added.
- `plan.weekStart()` and `plan.setWeekStart({ weekStart })`.

`buildList` reuses the body of `shopping.addRecipeToList` on the same transaction, so a week
aggregates exactly as adding recipes one by one does.

## Screen

`/plan`: a header with the week's range and previous, this-week and next buttons; seven day cards
(today outlined); inside each, three meal rows. An entry shows the recipe title (a link to the
recipe), a servings stepper, an "on list" mark once added, and a menu with Move and Remove. "+ Add"
on a row opens a dialog: a search box over the library (`recipe.list`), and a servings field that
starts at the recipe's own. The week header is sticky and holds a button that reads "Build shopping list (N new)" and is
disabled when N is 0; after it runs it links to the list. It sits at the top rather than D27's bottom bar because the
shell's tab bar already occupies the bottom of a phone screen.

On a wide screen the day cards sit in a grid instead of a column. D27's 7-column drag grid is the
follow-up.

## Tests

- Shared: week start for each `weekStart` value, month and year boundaries, leap day.
- Repo: tenancy (another household's entries are invisible and untouchable), add/update/remove,
  week bounds, build adds only unadded entries, scales by entry servings, aggregates across
  entries, a second build adds nothing, an entry moved into the week after a build is added.
- RLS: the two tables join `rls.test.ts`'s coverage.
- Web: the week renders entries into their slots, add via the dialog, build calls the mutation.
- E2E: plan two recipes, build, see merged items on the list.
