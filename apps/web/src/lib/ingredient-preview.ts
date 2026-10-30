import { formatQuantity, unitLabel, type parseIngredientLine } from '@hearth/shared';

/**
 * The "quantity · unit · food" line under an ingredient the cook is typing or reviewing.
 *
 * Parts the parser could not fill are left out rather than rendered blank, so a bare `salt`
 * reads as `salt` and not as ` ·  · salt`.
 *
 * Shared by the recipe form and the import review screen. They show the same thing for the same
 * reason - here is the line you gave me, here is what I made of it - and a second copy would
 * drift into two slightly different previews of one parser.
 */
export function previewLabel(parsed: ReturnType<typeof parseIngredientLine>): string {
  const parts: string[] = [];
  if (parsed.quantity != null) parts.push(formatQuantity(parsed.quantity, parsed.unit));
  if (parsed.unit) parts.push(unitLabel(parsed.unit, parsed.quantity));
  // The second measure, so a cook sees "3 · cups · or 360 g · flour" and knows the grams were
  // understood as an amount rather than kept as a note.
  if (parsed.altQuantity !== undefined && parsed.altUnit !== undefined) {
    parts.push(
      `or ${formatQuantity(parsed.altQuantity, parsed.altUnit)} ${unitLabel(parsed.altUnit, parsed.altQuantity)}`,
    );
  }
  if (parsed.foodName) parts.push(parsed.foodName);
  return parts.join(' · ');
}
