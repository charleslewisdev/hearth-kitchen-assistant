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
 * An amount as a recipe states it: one number, or a range from `low` to `high` ("2-3 cloves",
 * "4 to 6"). `high` is null for a single amount, and otherwise always greater than `low`: a
 * "2-2" or a reversed "3-2" says nothing a single number does not, so it reads as its low end.
 */
export interface QuantityRange {
  low: number;
  high: number | null;
}

/**
 * Where a range splits: a hyphen, an en-dash, or the word "to" or "or". The lookbehind starts the
 * word match only at the beginning of a run of whitespace, so a long run cannot restart it at
 * every character.
 */
const RANGE_SPLIT = /[-–]|(?<!\s)\s+(?:to|or)\s/;

/**
 * Parse a leading quantity expression, which may be a range, into its low and high ends, or
 * `null` when no leading numeric/fraction can be parsed.
 *
 * Each end handles: whole numbers (`2`), decimals (`1.5`), ascii fractions (`1/2`), mixed
 * numbers (`1 1/2`), unicode fractions (`½`), and whole+unicode-fraction adjacency or spacing
 * (`1½`, `1 ½`). Ranges are `1-2`, `1–2`, `4 to 5` and `2 or 3` (D53).
 */
export function parseQuantityRange(input: string): QuantityRange | null {
  const trimmed = input.trim();
  if (trimmed === '') return null;

  const [lowText = '', highText] = trimmed.split(RANGE_SPLIT, 2);
  const low = parseAmount(lowText.trim());
  if (low === null) return null;
  const high = highText === undefined ? null : parseAmount(highText.trim());
  return { low, high: high !== null && high > low ? high : null };
}

/**
 * The low end of {@link parseQuantityRange}: the whole amount when it is not a range. For
 * callers that only ever hold one number, such as a second measure in brackets.
 */
export function parseQuantity(input: string): number | null {
  return parseQuantityRange(input)?.low ?? null;
}

/** One amount, with no range in it. */
function parseAmount(text: string): number | null {
  if (text === '') return null;

  const fractionChars = UNICODE_FRACTION_CHARS.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

  // whole + unicode fraction, adjacent or space-separated: `1½`, `1 ½`
  let match = text.match(new RegExp(`^(\\d+)\\s*([${fractionChars}])`));
  if (match) {
    const fraction = match[2] ?? '';
    return Number(match[1]) + (UNICODE_FRACTIONS[fraction] ?? 0);
  }

  // bare unicode fraction: `½`
  match = text.match(new RegExp(`^([${fractionChars}])`));
  if (match) {
    const fraction = match[1] ?? '';
    return UNICODE_FRACTIONS[fraction] ?? null;
  }

  // mixed number: `1 1/2`
  match = text.match(/^(\d+)\s+(\d+)\/(\d+)/);
  if (match) {
    return Number(match[1]) + Number(match[2]) / Number(match[3]);
  }

  // ascii fraction: `1/2`
  match = text.match(/^(\d+)\/(\d+)/);
  if (match) {
    return Number(match[1]) / Number(match[2]);
  }

  // whole number or decimal: `2`, `1.5`, `.5`
  match = text.match(/^(\d*\.?\d+)/);
  if (match) {
    return Number(match[1]);
  }

  return null;
}
