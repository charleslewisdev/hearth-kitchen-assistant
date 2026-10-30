/**
 * What kind of recipe this is, for filing and scanning the library.
 *
 * The first five are meals; the last four are recipes that are usually part of another one: a
 * side, a drink, a sauce or dressing, and a base (a stock, a dough, a spice mix) that other
 * recipes are built on. Listed in the order the editor and the library show them.
 *
 * Not the planner's slots: those are `PLAN_MEALS`, and the database keeps the two apart
 * (`recipe_type` for recipes, `meal_type` for plan entries), so a plan can never hold a "sauce"
 * meal.
 */
export const RECIPE_TYPES = [
  'breakfast',
  'lunch',
  'dinner',
  'snack',
  'dessert',
  'side',
  'drink',
  'sauce',
  'base',
] as const;

export type RecipeType = (typeof RECIPE_TYPES)[number];

/** Sorts a recipe's types into `RECIPE_TYPES` order, whatever order they were ticked in. */
export function sortRecipeTypes<T extends string>(types: readonly T[]): T[] {
  const rank = (t: string) => (RECIPE_TYPES as readonly string[]).indexOf(t);
  return [...types].sort((a, b) => rank(a) - rank(b));
}
