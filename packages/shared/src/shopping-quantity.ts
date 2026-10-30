import type { CanonicalUnit } from './units';

/**
 * Units a shop sells whole: nobody buys a sixth of a clove or a third of a stalk. Measured units
 * (cup, tbsp, g, ...) and `dozen` are not here; their fractions are real amounts.
 */
export const COUNT_UNITS: ReadonlySet<CanonicalUnit> = new Set<CanonicalUnit>([
  'clove',
  'piece',
  'slice',
  'stalk',
  'sprig',
  'head',
  'stick',
  'bunch',
  'can',
  'jar',
  'package',
  'box',
  'bag',
  'bottle',
  'packet',
  'handful',
  'pinch',
  'dash',
]);

/** How far past a whole number an amount may be and still count as that whole (float noise). */
const NOISE = 1e-6;

/**
 * Kitchen measures a list rounds up to the next quarter or third of. Nobody shops for "0.29 cup";
 * they look for enough for ⅓ of one.
 */
const KITCHEN_MEASURES: ReadonlySet<string> = new Set([
  'cup',
  'tbsp',
  'tsp',
  'oz',
  'lb',
  'pint',
  'quart',
  'gallon',
  'fl oz',
]);

/** Small metric units, rounded up to a whole one: "187.5 g" is 188 g to anyone buying it. */
const WHOLE_METRIC: ReadonlySet<string> = new Set(['g', 'ml']);

/** The steps within one whole a kitchen measure rounds up to. */
const STEPS = [0, 1 / 4, 1 / 3, 1 / 2, 2 / 3, 3 / 4, 1];

/**
 * How far over a step an amount may be and still be that step. Scaled quantities are stored to
 * three places, so ⅔ comes back as 0.667, and it must not round up to ¾.
 */
const STEP_SLACK = 0.005;

function upToStep(quantity: number): number {
  const whole = Math.floor(quantity);
  const rest = quantity - whole;
  const step = STEPS.find((s) => rest <= s + STEP_SLACK) ?? 1;
  return whole + step;
}

/**
 * The amount the shopping list shows for an item, always at least what the recipes need:
 * - counted items (a count unit, or no unit, as in "3 eggs") round up to a whole one, so
 *   "16.17 cloves garlic" is 17;
 * - kitchen measures round up to the next quarter or third, so "0.29 cup" is ⅓ and "3.83 tbsp"
 *   is 4;
 * - grams and millilitres round up to a whole one.
 * The stored quantity stays exact so merges keep summing exactly; this is only for display.
 * `kg`, `l`, `dozen` and units it does not know are returned unchanged.
 */
export function shoppingQuantity(quantity: number | null, unit: string | null): number | null {
  if (quantity === null || !Number.isFinite(quantity) || quantity <= 0) return quantity;
  if (unit === null || (COUNT_UNITS as ReadonlySet<string>).has(unit)) {
    return Math.ceil(quantity - NOISE);
  }
  if (KITCHEN_MEASURES.has(unit)) return upToStep(quantity);
  if (WHOLE_METRIC.has(unit)) return Math.ceil(quantity - NOISE);
  return quantity;
}
