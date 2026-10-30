/** Common unicode vulgar fractions mapped to their decimal value. */
const UNICODE_FRACTIONS: Record<string, number> = {
  '½': 0.5,
  '⅓': 1 / 3,
  '⅔': 2 / 3,
  '¼': 0.25,
  '¾': 0.75,
  '⅕': 0.2,
  '⅛': 0.125,
};

const UNICODE_FRACTION_CHARS = Object.keys(UNICODE_FRACTIONS).join('');

/**
 * Parse a leading quantity expression from a string into a number, or `null`
 * when no leading numeric/fraction can be parsed.
 *
 * Handles: whole numbers (`2`), decimals (`1.5`), ascii fractions (`1/2`),
 * mixed numbers (`1 1/2`), unicode fractions (`½`), and whole+unicode-fraction
 * adjacency or spacing (`1½`, `1 ½`).
 *
 * Ranges (`1-2`, `1–2`, `4 to 5`, `2 or 3`) take the FIRST (low) operand. This is a documented P1
 * simplification — P1 does not model ranges yet.
 * TODO(P1+): model quantity ranges (low/high) instead of collapsing to the low end.
 */
export function parseQuantity(input: string): number | null {
  const trimmed = input.trim();
  if (trimmed === '') return null;

  // Ranges: split on a hyphen, an en-dash, or the word "to" or "or", and take the low end only
  // (P1 simplification). The lookbehind starts the word match only at the beginning of a run of
  // whitespace, so a long run cannot restart it at every character.
  const low = (trimmed.split(/[-–]|(?<!\s)\s+(?:to|or)\s/)[0] ?? '').trim();
  if (low === '') return null;

  const fractionChars = UNICODE_FRACTION_CHARS.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

  // whole + unicode fraction, adjacent or space-separated: `1½`, `1 ½`
  let match = low.match(new RegExp(`^(\\d+)\\s*([${fractionChars}])`));
  if (match) {
    const fraction = match[2] ?? '';
    return Number(match[1]) + (UNICODE_FRACTIONS[fraction] ?? 0);
  }

  // bare unicode fraction: `½`
  match = low.match(new RegExp(`^([${fractionChars}])`));
  if (match) {
    const fraction = match[1] ?? '';
    return UNICODE_FRACTIONS[fraction] ?? null;
  }

  // mixed number: `1 1/2`
  match = low.match(/^(\d+)\s+(\d+)\/(\d+)/);
  if (match) {
    return Number(match[1]) + Number(match[2]) / Number(match[3]);
  }

  // ascii fraction: `1/2`
  match = low.match(/^(\d+)\/(\d+)/);
  if (match) {
    return Number(match[1]) / Number(match[2]);
  }

  // whole number or decimal: `2`, `1.5`, `.5`
  match = low.match(/^(\d*\.?\d+)/);
  if (match) {
    return Number(match[1]);
  }

  return null;
}
