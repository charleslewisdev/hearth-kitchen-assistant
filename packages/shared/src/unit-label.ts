import type { CanonicalUnit } from './units';

/**
 * Each canonical unit as it reads after more than one: "3 cups", "2 cloves". Abbreviations are
 * the same either way ("3 tbsp", "250 g"). Typed over every canonical unit, so a unit added to
 * `CANONICAL_UNITS` without a label here fails the typecheck.
 */
const PLURALS: Record<CanonicalUnit, string> = {
  cup: 'cups',
  tbsp: 'tbsp',
  tsp: 'tsp',
  g: 'g',
  oz: 'oz',
  lb: 'lb',
  ml: 'ml',
  l: 'l',
  kg: 'kg',
  clove: 'cloves',
  can: 'cans',
  bunch: 'bunches',
  sprig: 'sprigs',
  stalk: 'stalks',
  slice: 'slices',
  piece: 'pieces',
  pinch: 'pinches',
  dash: 'dashes',
  handful: 'handfuls',
  package: 'packages',
  jar: 'jars',
  box: 'boxes',
  bag: 'bags',
  bottle: 'bottles',
  head: 'heads',
  stick: 'sticks',
  packet: 'packets',
  // "2 dozen eggs", never "2 dozens".
  dozen: 'dozen',
  pint: 'pints',
  quart: 'quarts',
  gallon: 'gallons',
  'fl oz': 'fl oz',
};

/**
 * How close to 1 an amount may be and still read as one. The same margin `formatQuantity` snaps
 * to a whole number by, so an amount it shows as "1" never reads "1 cups".
 */
const ONE = 1.02;

function isKnown(unit: string): unit is CanonicalUnit {
  return Object.prototype.hasOwnProperty.call(PLURALS, unit);
}

/**
 * The unit as it reads after `quantity`: `unitLabel('cup', 3)` is "cups", `unitLabel('cup', 1)`
 * and `unitLabel('cup', 0.5)` are "cup". A unit that is not canonical (a shopping item's unit can
 * be typed by hand) is returned as it was given.
 */
export function unitLabel(unit: string, quantity: number | null): string {
  if (quantity === null || quantity < ONE || !isKnown(unit)) return unit;
  return PLURALS[unit];
}
