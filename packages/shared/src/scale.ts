/**
 * How an ingredient's quantity responds to a change in serving count.
 * Mirrors the DB `scaling_mode` enum.
 *
 * - `linear`    — scales in direct proportion to servings (default).
 * - `fixed`     — never scales (e.g. "1 bay leaf").
 * - `sublinear` — scales less than proportionally (e.g. spices, salt).
 * - `manual`    — the cook adjusts by hand; the app leaves it alone.
 */
export type ScalingMode = 'linear' | 'fixed' | 'sublinear' | 'manual';

/**
 * Scale an ingredient quantity from one serving count to another.
 *
 * P1 implements linear scaling only; `fixed`/`sublinear`/`manual` pass through
 * unscaled (see P4 marker below). A `null` quantity ("to taste") never scales.
 *
 * Linear results are rounded to 3 decimal places — enough precision for
 * kitchen quantities without surfacing floating-point noise (e.g. 0.42857… →
 * 0.429).
 *
 * Edge guard: a `from` of 0 would divide by zero, so we return the quantity
 * unchanged rather than produce Infinity/NaN.
 */
export function scale(
  ingredient: { quantity: number | null; mode: ScalingMode },
  servings: { from: number; to: number },
): number | null {
  const { quantity, mode } = ingredient;

  // "To taste" quantities are unquantified and never scale.
  if (quantity === null) return null;

  // P4: implement non-linear scaling modes.
  if (mode !== 'linear') return quantity;

  // Divide-by-zero guard: an unknown/zero source serving count can't be scaled
  // meaningfully, so leave the quantity unchanged.
  if (servings.from === 0) return quantity;

  const scaled = (quantity * servings.to) / servings.from;

  // Round to 3 decimal places.
  return Math.round(scaled * 1000) / 1000;
}
