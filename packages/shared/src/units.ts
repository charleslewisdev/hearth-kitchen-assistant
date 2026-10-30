/** The distinct canonical unit tokens Hearth normalizes to. */
export const CANONICAL_UNITS = [
  'cup',
  'tbsp',
  'tsp',
  'g',
  'oz',
  'lb',
  'ml',
  'l',
  'clove',
  'can',
  'kg',
  'bunch',
  'sprig',
  'stalk',
  'slice',
  'piece',
  'pinch',
  'dash',
  'handful',
  'package',
  'jar',
  'box',
  'bag',
  'bottle',
  'head',
  'stick',
  'packet',
  'dozen',
  'pint',
  'quart',
  'gallon',
  'fl oz',
] as const;

export type CanonicalUnit = (typeof CANONICAL_UNITS)[number];

/** Maps lowercased aliases to their canonical token. */
const ALIASES: Record<string, CanonicalUnit> = {
  cup: 'cup',
  cups: 'cup',
  c: 'cup',
  tablespoon: 'tbsp',
  tablespoons: 'tbsp',
  tbsp: 'tbsp',
  // How printed recipes and old cookbooks abbreviate it; "2 tbl olive oil" made a Food called
  // "tbl olive oil".
  tbl: 'tbsp',
  tbls: 'tbsp',
  tbs: 'tbsp',
  teaspoon: 'tsp',
  teaspoons: 'tsp',
  tsp: 'tsp',
  gram: 'g',
  grams: 'g',
  g: 'g',
  ounce: 'oz',
  ounces: 'oz',
  oz: 'oz',
  pound: 'lb',
  pounds: 'lb',
  lb: 'lb',
  lbs: 'lb',
  ml: 'ml',
  milliliter: 'ml',
  milliliters: 'ml',
  millilitre: 'ml',
  millilitres: 'ml',
  l: 'l',
  liter: 'l',
  liters: 'l',
  litre: 'l',
  litres: 'l',
  clove: 'clove',
  cloves: 'clove',
  can: 'can',
  cans: 'can',
  kg: 'kg',
  kilogram: 'kg',
  kilograms: 'kg',
  kilo: 'kg',
  kilos: 'kg',
  // Counts of a thing as it is sold or picked. Before these were units, "1 bunch cilantro" made
  // a Food called "bunch cilantro", and the list could not combine it with anything.
  bunch: 'bunch',
  bunches: 'bunch',
  sprig: 'sprig',
  sprigs: 'sprig',
  stalk: 'stalk',
  stalks: 'stalk',
  slice: 'slice',
  slices: 'slice',
  piece: 'piece',
  pieces: 'piece',
  pinch: 'pinch',
  pinches: 'pinch',
  dash: 'dash',
  dashes: 'dash',
  handful: 'handful',
  handfuls: 'handful',
  package: 'package',
  packages: 'package',
  pkg: 'package',
  pkgs: 'package',
  jar: 'jar',
  jars: 'jar',
  box: 'box',
  boxes: 'box',
  bag: 'bag',
  bags: 'bag',
  bottle: 'bottle',
  bottles: 'bottle',
  head: 'head',
  heads: 'head',
  stick: 'stick',
  sticks: 'stick',
  packet: 'packet',
  packets: 'packet',
  dozen: 'dozen',
  pint: 'pint',
  pints: 'pint',
  pt: 'pint',
  quart: 'quart',
  quarts: 'quart',
  qt: 'quart',
  gallon: 'gallon',
  gallons: 'gallon',
  gal: 'gallon',
  // Itself, so a stored unit reads back the same; the parser takes it as two words.
  'fl oz': 'fl oz',
};

/**
 * The first word of a two-word unit, "fl oz" and "fluid ounces", and the words that may follow
 * it. Kept apart from ALIASES because one word alone is not a unit: "2 fl bananas" is not.
 */
export const FLUID_WORDS = new Set(['fl', 'fluid']);
export const OUNCE_WORDS = new Set(['oz', 'ounce', 'ounces']);

/**
 * Normalize a unit word to its canonical token, or `null` if unrecognized.
 *
 * The single-letter abbreviations `T` (tablespoon) and `t` (teaspoon) are
 * case-sensitive, so they are resolved before the input is lowercased.
 */
export function normalizeUnit(input: string): CanonicalUnit | null {
  const trimmed = input.trim().replace(/\.$/, '');
  if (trimmed === 'T') return 'tbsp';
  if (trimmed === 't') return 'tsp';
  const key = trimmed.toLowerCase();
  return ALIASES[key] ?? null;
}
