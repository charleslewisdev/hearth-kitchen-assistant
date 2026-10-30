import { normalizeUnit } from '@hearth/shared';

/**
 * Putting back the fractions tesseract cannot read.
 *
 * The English model has almost no ½, ¼ or ¾ in its training, so a cookbook's fraction glyphs
 * come back as whatever they look like. Measured on the owner's first ten cookbook photos
 * (2026-09-27), eight of them lost at least one amount this way, and one lost enough that no
 * ingredient list was found at all:
 *
 *  - ½ as `Y2`, `¥2`, `V2`, `%2`, `Y%`, `Yz`, and `72` when nothing stands in front of it;
 *  - ¼ as `Ya`, `Va`, `Y4`, `7a`;
 *  - and a bare `%`, `Y`, `Yi`, `Ys`, `'%`, `"a` or `"` for any of them: the same `%` was ¼ of a
 *    cup of water, ½ an onion and ¾ of a cup of dip on three different pages.
 *
 * The first two groups have one reading and are simply replaced. The last group is decided by
 * the metric amount the line prints beside it when there is one ("% cup (57g) water" can only
 * be ¼ cup), and otherwise becomes ½ and is reported as a guess, so the review screen can point
 * at the line. Only amount positions are touched: the start of a line, and inside a method only
 * a certain reading in front of a unit ("another V2 teaspoon").
 *
 * Every pattern is anchored or bounded, and each runs once per line: linear.
 */

export interface RepairedLine {
  text: string;
  /** Whether an amount on this line was a guess the page did not settle. */
  guessed: boolean;
}

const HALF = new Set(['Y2', 'y2', '¥2', 'V2', '%2', 'Y%', 'Yz', 'Vz', '¥z', '%z']);
const QUARTER = new Set(['Ya', 'Va', 'Y4', 'V4', '7a']);
const AMBIGUOUS = new Set(['%', '%:', "'%", 'Y', 'Yi', 'Vi', 'Ys', '"a', '"']);

/** The US units a `72` has to be followed by to be a ½: "72 g" is seventy-two grams. */
const US_UNITS = new Set(['cup', 'tbsp', 'tsp', 'lb', 'oz', 'inch']);

/**
 * An amount at the start of a line: an optional whole number, then a token OCR makes of a
 * fraction glyph. Stray marks OCR puts in front of a line (`=`, `}`, `|`) go with it.
 * Alternatives longest first, so `%2` is not read as `%` followed by a 2.
 */
const LEADING =
  /^(?:[=}|] {0,2})?(\d{1,3})?( ?)(%2|%z|%:|'%|"a|[YVy¥][2z%]|[YV][a4i]|7a|Ys|72|%|Y|")(?=[ \-)]|$)/;

/** "1 2 tsp": a whole number and a ½ read as a 2, which only a unit after it gives away. */
const SPLIT_HALF = /^(\d{1,2}) 2 (?=\S)/;

/** A whole number with its fraction read as a full stop: "2. teaspoons". */
const FRACTION_AS_STOP = /^(\d{1,2})\. (?=\p{Ll})/u;

/** "I cup", "I garlic clove": a 1 read as a capital I. */
const CAPITAL_ONE = /^I (?=\S)/;

/** A step number read as "I.", or run into its first word: "4.Ina large bowl". */
const ORDINAL_I = /^I\. /;
const ORDINAL_RUN_ON = /^(\d{1,2})\.(?=\p{Lu})/u;

/** A certain token inside a line, in front of a unit: "another V2 teaspoon", "(Y2-inch)". */
const INLINE =
  /(?<![\p{L}\p{N}%])(\d{1,2})?([YV¥][2z]|%2|[YV]a)(?=[ -](?:cups?|teaspoons?|tablespoons?|tsp|tbsp|inch|inches|pounds?|ounces?|oz|lb)\b)/gu;

/**
 * An ambiguous token inside a line, in front of a unit: "sliced lengthwise Yi inch (6 mm)
 * thick". Repaired only when the metric amount after it settles it, because nothing points the
 * cook at a guess made in the middle of a line.
 */
const INLINE_AMBIGUOUS =
  /(?<![\p{L}\p{N}%'"])(Yi|Vi|Ys|Y|%)(?= (?:cups?|teaspoons?|tablespoons?|tsp|tbsp|inch|inches|pounds?|ounces?|oz|lb)\b)/gu;

/** The metric amount a line prints beside a US one: "(57g)", "(1,587 g)", "(6 mm)". */
const METRIC = /\((\d{1,3}(?:,\d{3})?(?:\.\d{1,2})?) ?(g|kg|ml|l|mm|cm)\b/i;

const FRACTIONS: ReadonlyArray<[number, string]> = [
  [1 / 4, '¼'],
  [1 / 3, '⅓'],
  [1 / 2, '½'],
  [2 / 3, '⅔'],
  [3 / 4, '¾'],
];

/** Millilitres, grams or millimetres in one of each US unit. */
const VOLUME_ML: Record<string, number> = { cup: 236.6, tbsp: 14.79, tsp: 4.93 };
const WEIGHT_G: Record<string, number> = { lb: 453.6, oz: 28.35 };
const LENGTH_MM: Record<string, number> = { inch: 25.4, inches: 25.4 };

/**
 * How far, as a log ratio, a converted amount may sit from the printed metric one and still be
 * the same: about 20%, because a book rounds its metric ("½ inch (1.5 cm)" is 18% over).
 */
const SAME_AMOUNT = 0.2;

/**
 * Grams per millilitre that a line can be read as when it gives a volume in grams. Water, milk
 * and oil sit inside this; flour and sugar do not, and for those the grams settle nothing.
 */
const LIQUID_DENSITY: [number, number] = [0.8, 1.15];

const METRIC_SCALE: Record<string, [number, 'ml' | 'g' | 'mm']> = {
  g: [1, 'g'],
  kg: [1000, 'g'],
  ml: [1, 'ml'],
  l: [1000, 'ml'],
  mm: [1, 'mm'],
  cm: [10, 'mm'],
};

/** The unit a word names, including the lengths `normalizeUnit` does not keep. */
function unitOf(word: string): string | null {
  const bare = word.toLowerCase().replace(/[.,]$/, '');
  if (bare === 'inch' || bare === 'inches') return 'inch';
  return normalizeUnit(bare);
}

/**
 * Which fraction an ambiguous token is, from the metric amount printed beside it, or null when
 * the line does not settle it.
 */
function settledByMetric(whole: number, rest: string): number | null {
  const unit = unitOf(rest.split(' ', 1)[0] ?? '');
  const metric = rest.match(METRIC);
  if (unit === null || !metric) return null;
  const [scale, kind] = METRIC_SCALE[metric[2]!.toLowerCase()]!;
  const printed = Number(metric[1]!.replace(',', '')) * scale;

  // A volume given in grams depends on what it is, so there the grams have to fit exactly one
  // reading. Every other pair converts exactly, and the nearest reading wins if it is close.
  if (kind === 'g' && VOLUME_ML[unit]) {
    const liquid = FRACTIONS.filter(([fraction]) => {
      const density = printed / ((whole + fraction) * VOLUME_ML[unit]!);
      return density >= LIQUID_DENSITY[0] && density <= LIQUID_DENSITY[1];
    });
    return liquid.length === 1 ? liquid[0]![0] : null;
  }
  const per =
    kind === 'ml' ? VOLUME_ML[unit] : kind === 'g' ? WEIGHT_G[unit] : LENGTH_MM[unit];
  if (per === undefined) return null;
  let best: number | null = null;
  let distance = Infinity;
  // Thirds are a volume's: nobody prints ⅔ of an inch or of a pound.
  const readings = kind === 'ml' ? FRACTIONS : FRACTIONS.filter(([f]) => f !== 1 / 3 && f !== 2 / 3);
  for (const [fraction] of readings) {
    const off = Math.abs(Math.log(printed / ((whole + fraction) * per)));
    if (off < distance) {
      best = fraction;
      distance = off;
    }
  }
  return distance <= SAME_AMOUNT ? best : null;
}

function glyph(fraction: number): string {
  return FRACTIONS.find(([value]) => value === fraction)![1];
}

/** Whether one of the next two words is a unit: what makes "I" a 1 and "2" a ½. */
function unitFollows(rest: string): boolean {
  return rest.split(' ', 2).some((word) => unitOf(word) !== null);
}

/** The line with its leading amount repaired, and whether that took a guess. */
function repairLeading(text: string): RepairedLine {
  if (ORDINAL_I.test(text)) return { text: text.replace(ORDINAL_I, '1. '), guessed: false };
  if (ORDINAL_RUN_ON.test(text))
    return { text: text.replace(ORDINAL_RUN_ON, '$1. '), guessed: false };

  // "2. teaspoons instant yeast": a fraction read as a full stop. A step number is followed by
  // a capital, never by a unit.
  const dotted = text.match(FRACTION_AS_STOP);
  if (dotted) {
    const rest = text.slice(dotted[0].length);
    if (unitOf(rest.split(' ', 1)[0] ?? '') !== null) {
      const whole = Number(dotted[1]);
      const settled = settledByMetric(whole, rest);
      return { text: `${whole}${glyph(settled ?? 1 / 2)} ${rest}`, guessed: settled === null };
    }
  }

  const split = text.match(SPLIT_HALF);
  if (split) {
    const rest = text.slice(split[0].length);
    if (unitOf(rest.split(' ', 1)[0] ?? '') !== null) {
      return { text: `${split[1]}½ ${rest}`, guessed: true };
    }
  }

  if (CAPITAL_ONE.test(text) && unitFollows(text.slice(2))) {
    return { text: `1 ${text.slice(2)}`, guessed: false };
  }

  const match = text.match(LEADING);
  if (!match) return { text, guessed: false };
  const [all, wholeText, space, token] = match as unknown as [
    string,
    string | undefined,
    string,
    string,
  ];
  const rest = text.slice(all.length).trimStart();
  const nextWord = rest.split(' ', 1)[0] ?? '';

  // Without a whole number in front, the token has to be followed by what an amount is followed
  // by: a unit, or a lower-case word ("% finely diced yellow onion") unless the token is a bare
  // Y, which is also a word. "72 cup" is a ½; "72" in
  // front of anything but a US unit is a number. An ambiguous token set apart from its whole
  // number ("2 % milk") is left alone, since that is how a percentage is written.
  if (wholeText === undefined) {
    const unit = unitOf(nextWord);
    if (token === '72' && !US_UNITS.has(unit ?? '')) return { text, guessed: false };
    const lowerCase = token !== 'Y' && /^\p{Ll}/u.test(nextWord);
    if (unit === null && !nextWord.startsWith('-') && !lowerCase) {
      return { text, guessed: false };
    }
  } else if (space !== '' && AMBIGUOUS.has(token)) {
    return { text, guessed: false };
  }
  const whole = wholeText === undefined ? 0 : Number(wholeText);

  let fraction: number;
  let guessed = false;
  if (HALF.has(token) || token === '72') fraction = 1 / 2;
  else if (QUARTER.has(token)) fraction = 1 / 4;
  else if (AMBIGUOUS.has(token)) {
    const settled = settledByMetric(whole, rest);
    fraction = settled ?? 1 / 2;
    guessed = settled === null;
  } else return { text, guessed: false };

  const amount = `${whole === 0 ? '' : whole}${glyph(fraction)}`;
  const joined = rest.startsWith('-') || rest === '' ? `${amount}${rest}` : `${amount} ${rest}`;
  return { text: joined, guessed };
}

/**
 * A British book's three-way measure, "250g/9oz/2¼ cups plain flour", with the g read as a 9 and
 * the oz as `02` or `0z`: "2509/902/2'% cups". The g is only taken for a 9 at the start of a
 * line in front of a slash and a figure, and `02` only in front of a slash; `0z` is never a
 * number, so it is read as oz anywhere.
 */
const GRAMS_AS_NINE = /^(\d{2,4})9(?=\/\d)/;
const OUNCES_AS_ZERO_TWO = /(?<![\p{L}\p{N}])(\d{1,2}[½¼¾]?)02(?=\/)/gu;
const OUNCES_AS_ZERO_Z = /(?<![\p{L}\p{N}])(\d{1,2}[½¼¾]?)0z\b/gu;
const SLASH_MEASURE = /^\d{1,4}g\/\d{1,2}[½¼¾]?oz\/(?=\S)/;

/** "Thsp": tesseract's usual reading of a printed Tbsp. */
const TBSP = /\bThsp\b/g;

/** The metric and imperial parts of a three-way measure repaired, then its US part. */
function repairSlashMeasure(line: string): RepairedLine | null {
  const text = line
    .replace(GRAMS_AS_NINE, '$1g')
    .replace(OUNCES_AS_ZERO_TWO, '$1oz')
    .replace(OUNCES_AS_ZERO_Z, '$1oz');
  const head = text.match(SLASH_MEASURE);
  if (!head) return text === line ? null : { text, guessed: false };
  const tail = repairLeading(text.slice(head[0].length));
  return { text: `${head[0]}${tail.text}`, guessed: tail.guessed };
}

/**
 * One OCR line with its fraction glyphs put back: the leading amount by the rules above, and
 * any certain token in front of a unit further along.
 */
export function repairOcrAmounts(line: string): RepairedLine {
  const measured = repairSlashMeasure(line.replace(TBSP, 'Tbsp'));
  const leading = measured ?? repairLeading(line.replace(TBSP, 'Tbsp'));
  const text = leading.text.replace(
    INLINE,
    (_all, whole: string | undefined, token: string) =>
      `${whole ?? ''}${QUARTER.has(token) ? '¼' : '½'}`,
  );
  const settled = text.replace(INLINE_AMBIGUOUS, (token: string, _t: string, at: number) => {
    const fraction = settledByMetric(0, text.slice(at + token.length + 1, at + token.length + 60));
    return fraction === null ? token : glyph(fraction);
  });
  return { text: settled, guessed: leading.guessed };
}
