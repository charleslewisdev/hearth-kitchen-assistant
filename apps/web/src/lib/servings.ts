import { formatQuantityRange } from '@hearth/shared';

/**
 * How many a recipe serves, as the screen shows it: "4–6" while the cook has not scaled it, and
 * the one number they picked once they have (D53). A recipe's servings are the low end of its
 * range and the base the scaler scales from, so "at the recipe's own servings" is the range.
 */
export function servingsText(
  servings: number,
  recipe: { servings: number; servingsHigh?: number | null },
): string {
  return servings === recipe.servings
    ? formatQuantityRange(recipe.servings, recipe.servingsHigh)
    : String(servings);
}

/**
 * The "serves up to" box as the save sends it: a whole number above the servings, or null for
 * an empty box or one that does not make a range (the server refuses a range that runs
 * downward, and "4 to 4" is just 4).
 */
export function servingsHighFrom(text: string, servings: number): number | null {
  const n = Number.parseInt(text, 10);
  return Number.isNaN(n) || n <= servings ? null : n;
}
