/**
 * An amount the way a cook reads it: `½`, `1 ¾`, `⅓`, rather than `0.5`, `1.75`, `0.333`.
 *
 * Quantities are stored as numbers (`parseQuantity` turns `1 1/2` into 1.5) and scaling
 * multiplies them, so everything a screen shows arrives as a decimal, often a long one: 1/4 tsp
 * scaled from 4 servings to 3 is 0.1875, which `scale` rounds to 0.188. Nobody owns a 0.188
 * teaspoon.
 *
 * The fractional part snaps to the nearest measure a kitchen has - eighths, thirds - when it is
 * within `SNAP` of one. Otherwise the number is shown to two places, which is what a scaled
 * amount that is not a kitchen measure honestly is.
 *
 * Metric units stay decimal: "½ g" is not how anybody writes 0.5 g, and 250 g scaled is 187.5 g.
 */

/** How far from a kitchen fraction a value may be and still be shown as one. */
const SNAP = 0.02;

const FRACTIONS: ReadonlyArray<readonly [number, string]> = [
  [1 / 8, '⅛'],
  [1 / 4, '¼'],
  [1 / 3, '⅓'],
  [3 / 8, '⅜'],
  [1 / 2, '½'],
  [5 / 8, '⅝'],
  [2 / 3, '⅔'],
  [3 / 4, '¾'],
  [7 / 8, '⅞'],
];

/** Units measured in decimals. Matches the tokens `normalizeUnit` produces, plus `kg`. */
const METRIC = new Set(['g', 'kg', 'ml', 'l']);

function decimal(value: number): string {
  return String(Math.round(value * 100) / 100);
}

export function formatQuantity(quantity: number, unit?: string | null): string {
  if (!Number.isFinite(quantity) || quantity < 0) return String(quantity);
  if (unit != null && METRIC.has(unit.toLowerCase())) return decimal(quantity);

  const whole = Math.floor(quantity);
  const rest = quantity - whole;

  if (rest < SNAP) return String(whole);
  if (1 - rest < SNAP) return String(whole + 1);

  for (const [value, glyph] of FRACTIONS) {
    if (Math.abs(rest - value) < SNAP) return whole === 0 ? glyph : `${whole} ${glyph}`;
  }
  return decimal(quantity);
}
