import { parseQuantity } from './quantity';
import { normalizeUnit } from './units';

/**
 * An ingredient's second measure: the one a book prints beside the first in the other system,
 * "3 cups (360g) flour" or "250 g (2 cups) flour". The cook picks which system to read in, and
 * a baker weighing flour on a scale reads the grams.
 *
 * Only what the page printed. Nothing here converts cups to grams, because that needs the
 * density of each food, and the book's own weight is better than any table.
 */

export type MeasureSystem = 'us' | 'metric';

/** Units that belong to the metric system. */
export const METRIC_UNITS: ReadonlySet<string> = new Set(['g', 'kg', 'ml', 'l']);

/** Units that belong to the US system, and that a book gives a metric equivalent for. */
export const US_UNITS: ReadonlySet<string> = new Set([
  'cup',
  'tbsp',
  'tsp',
  'oz',
  'lb',
  'fl oz',
  'pint',
  'quart',
  'gallon',
  'stick',
]);

export function systemOf(unit: string | null): MeasureSystem | null {
  if (unit === null) return null;
  if (METRIC_UNITS.has(unit)) return 'metric';
  if (US_UNITS.has(unit)) return 'us';
  return null;
}

/**
 * An aside that is nothing but a measure: "360g", "1,587 g", "240 ml", "2 cups", "½ cup",
 * "9oz", "4 fl oz". Anchored at both ends and bounded, so linear.
 */
const MEASURE =
  /^(\d{1,3}(?:,\d{3})+|\d{1,5}(?:\.\d{1,3})?|\d{1,3} ?[½¼¾⅓⅔]|[½¼¾⅓⅔]|\d{1,3}\/\d{1,3}|\d{1,3} \d{1,3}\/\d{1,3}) ?((?:fl\.? ?)?[a-z]{1,12})\.?$/i;

export interface Measure {
  quantity: number;
  unit: string;
}

/**
 * An aside read as a measure in one of the two systems, or null when it is anything else.
 *
 * Also an aside that gives both, "8 fl oz/250 ml" or "about 8 oz/250 g", which is how The
 * Newlywed Cookbook prints a cup: the metric half is returned, since the other half is in the
 * same system as the cup in front of it.
 */
export function measureIn(text: string): Measure | null {
  const bare = text.trim().replace(/^about /i, '');
  // The slash between the two measures follows a unit, which tells it from the one inside a
  // fraction ("10 1/2 oz/330 g").
  const slash = bare.search(/\p{L} ?\//u);
  if (slash >= 0) {
    const cut = bare.indexOf('/', slash);
    const first = singleMeasure(bare.slice(0, cut));
    const second = singleMeasure(bare.slice(cut + 1));
    if (first === null || second === null || systemOf(first.unit) === systemOf(second.unit)) {
      return null;
    }
    return systemOf(first.unit) === 'metric' ? first : second;
  }
  return singleMeasure(bare);
}

function singleMeasure(text: string): Measure | null {
  const match = text.trim().match(MEASURE);
  if (!match) return null;
  const unitText = match[2]!.toLowerCase().replace(/\.$/, '');
  const unit = /^fl\.? ?oz$/.test(unitText) ? 'fl oz' : normalizeUnit(unitText);
  if (systemOf(unit) === null) return null;
  const quantity = parseQuantity(match[1]!.replace(/,/g, ''));
  if (quantity === null || quantity <= 0) return null;
  return { quantity, unit: unit! };
}

/**
 * A British book's measure set in front of the US one: "250g/9oz/2¼ cups plain flour" or
 * "90g/3oz milk chocolate". The grams are kept as the second measure and the ounces dropped
 * where a cup measure follows; with nothing after the ounces, the ounces are the first measure.
 */
const SLASH_MEASURE =
  /^(\d{1,4}(?:\.\d{1,2})?) ?(g|kg|ml|l)\/(\d{1,3}(?:\.\d{1,2})?[½¼¾]?) ?(oz|fl oz)(\/| )/i;

export interface SlashMeasure {
  metric: Measure;
  /** The line with the metric part taken off, ready to be parsed as usual. */
  rest: string;
}

export function slashMeasure(line: string): SlashMeasure | null {
  const match = line.match(SLASH_MEASURE);
  if (!match) return null;
  const metric = { quantity: Number(match[1]), unit: match[2]!.toLowerCase() };
  const after = line.slice(match[0].length).trim();
  if (after === '') return null;
  const rest = match[5] === '/' ? after : `${match[3]} ${match[4]} ${after}`;
  return { metric, rest };
}

/** An ingredient's amount, as stored: the first measure and the second, either possibly absent. */
export interface Measured {
  quantity: number | null;
  unit: string | null;
  altQuantity: number | null;
  altUnit: string | null;
}

/**
 * The measure to show a cook who reads in `system`: the second measure when it is in that
 * system and the first is not, otherwise the first. An ingredient with one measure always
 * shows it.
 */
export function pickMeasure(
  ingredient: Measured,
  system: MeasureSystem,
): { quantity: number | null; unit: string | null; alternate: boolean } {
  const useAlt =
    ingredient.altQuantity !== null &&
    systemOf(ingredient.altUnit) === system &&
    systemOf(ingredient.unit) !== system;
  return useAlt
    ? { quantity: ingredient.altQuantity, unit: ingredient.altUnit, alternate: true }
    : { quantity: ingredient.quantity, unit: ingredient.unit, alternate: false };
}
