import { measureIn, slashMeasure, systemOf, type Measure } from './measure-system';
import { parseQuantity } from './quantity';
import { FLUID_WORDS, normalizeUnit, OUNCE_WORDS } from './units';
import {
  CONTAINER_UNITS,
  LENGTH_WORDS,
  ONE_WITHOUT_AMOUNT,
  SIZE_UNITS,
  leadingAmountWords,
  splitLeadingDescriptors,
} from './ingredient-words';

/** The structured shape a single typed ingredient line decomposes into. */
export interface ParsedIngredientLine {
  /** Numeric amount, or `null` when the line carries no leading quantity. */
  quantity: number | null;
  /** Canonical unit token (e.g. `cup`, `tsp`), or `null` when there is none. */
  unit: string | null;
  /** The user's RAW food words, un-normalized (normalization happens later). */
  foodName: string;
  /** Preparation / packaging aside (e.g. `minced`, `14 oz`, `to taste`). */
  note: string | null;
  /**
   * The same amount in the other system, when the line prints one: the 360 g of "3 cups (360g)
   * flour". Absent rather than null when there is none (`measure-system.ts`).
   */
  altQuantity?: number;
  altUnit?: string;
}

const UNICODE_FRACTIONS = '½⅓⅔¼¾⅕⅛';

/** One amount on its own, richest form first: `1 1/2`, `1½`, `½`, `1/2`, `1.5`. */
const AMOUNT =
  `\\d+\\s+\\d+/\\d+` + // mixed number: "1 1/2"
  `|\\d+\\s*[${UNICODE_FRACTIONS}]` + // whole + unicode fraction: "1½", "1 ½"
  `|[${UNICODE_FRACTIONS}]` + // bare unicode fraction: "½"
  `|\\d+/\\d+` + // ascii fraction: "1/2"
  `|\\d*\\.?\\d+`; // whole or decimal: "2", "1.5", ".5"

/**
 * An amount as one end of a range, with every run bounded.
 *
 * A range has to FAIL on most lines - "2 cups" is not one - and a failing match backtracks. Over
 * `AMOUNT`'s unbounded `\\d*\\.?\\d+` that means trying every split of a run of digits, which
 * measured 6.8 seconds on a line of 100,000 of them. Nothing in a kitchen needs five digits at
 * either end of a range. The plain amount below is still unbounded, and it cannot backtrack,
 * because it is the last alternative and always matches once it starts.
 */
const RANGE_END =
  `\\d{1,4}\\s{1,3}\\d{1,4}/\\d{1,4}` +
  `|\\d{1,4}\\s{0,3}[${UNICODE_FRACTIONS}]` +
  `|[${UNICODE_FRACTIONS}]` +
  `|\\d{1,4}/\\d{1,4}` +
  `|\\d{0,4}\\.?\\d{1,4}`;

/**
 * Matches a leading quantity token. Alternatives are ordered longest-first so
 * that, at the anchored start, richer forms win before simpler prefixes: a
 * range (`1 1/2 to 2`) is consumed whole, and so is a mixed number (`1 1/2`)
 * rather than collapsing to `1`.
 *
 * A range is written with a dash or with a word: `2-3`, `4 to 5`, `2 or 3`,
 * `¾ to 1`. The word form is how most printed recipes write it, and before it
 * was matched "4 to 5 tablespoons olive oil" read as 4 of a food called "to 5
 * tablespoons olive oil", which became a Food row and a shopping-list line.
 * Anchored at the start and bounded around the word, so it stays linear.
 */
const LEADING_QUANTITY = new RegExp(
  '^(' +
    `(?:${RANGE_END})\\s{0,3}[-–]\\s{0,3}(?:${RANGE_END})` + // range: "1-2", "1 – 2", "1/4-1/2"
    `|(?:${RANGE_END})\\s{1,3}(?:to|or)\\s{1,3}(?:${RANGE_END})(?![\\w/])` + // "4 to 5", "2 or 3"
    `|${AMOUNT}` +
    ')',
);

/**
 * A parenthetical aside anywhere in the line, e.g. `(14 oz)`.
 *
 * The `{0,200}` is a security bound, not a style choice. Unbounded (`[^)]*`), this is quadratic
 * on a line of open parentheses with no closing one: the engine tries `\(` at every position,
 * lets `[^)]*` run to the end of the line, then backtracks it one character at a time looking
 * for a `\)` that is not there. Measured through the real PDF path before the bound: a
 * 7,122-byte PDF whose text layer is 100,000 "(" characters took 3,372ms, and 13,681 bytes took
 * 12,952ms - and Node is single-threaded, so during those the server answered nobody.
 *
 * 200 characters is far above a real aside: the longest ingredient line in the seven saved page
 * fixtures is 134 characters in total.
 *
 * One level of nesting is read as part of the aside. WP Recipe Maker, which most recipe blogs
 * run, wraps an ingredient's notes in a second pair of brackets: "2 cloves garlic ((minced))",
 * "1 Tbsp sake ((or dry sherry))". Stopping at the first `)` left the other one in the food name,
 * and the first real import made a Food called "garlic )" and one called "mirin )". An aside
 * with an aside inside it ("(3/4 lb; 3/4 inch (2 cm) thick)") comes out whole the same way.
 *
 * Still linear: each repetition is either one character that is not a bracket or one bracketed
 * run with no bracket inside it, so the first character decides which, and nothing is retried.
 */
const PARENTHETICAL = /\(((?:[^()]|\([^()]{0,200}\)){0,200})\)/;

/**
 * Adjectives a recipe lists with commas in front of the food: "boneless, skinless chicken
 * thighs", "skinless, boneless pork butt". Without this the food was "skinless", which then went
 * on the shopping list as four of something called skinless.
 */
const LISTED_ADJECTIVE =
  /^(?:\w{1,20}less|fresh|ripe|firm|large|small|medium|whole|raw|lean|thick|thin)$/i;
const MAX_LISTED_ADJECTIVES = 3;

/** How many asides one line may give up. Real lines carry two at most. */
const MAX_ASIDES = 3;

/** A whole aside that is itself in brackets, "(minced)" from "((minced))", loses the inner pair. */
const WRAPPED = /^\(([^()]{0,200})\)$/;

/**
 * Trailing "to taste" / "to serve" / "at room temperature" phrasing, treated as a note. The
 * lookbehind starts the match only at the beginning of a run of whitespace, so a long run cannot
 * restart it at every character.
 */
const TRAILING_PHRASE = /(?<!\s)\s+(to\s+(?:taste|serve)|at\s+room\s+temperature)$/i;

/**
 * A size written in front of the unit: "one 14-ounce can", "1 1-pound package", "2 6-inch
 * tortillas". Tested against one word, anchored at both ends and bounded, so it cannot backtrack.
 */
const SIZE_PREFIX = /^(?:\d{1,4}(?:\.\d{1,3})?|\d{1,3}\/\d{1,3})-([a-z]{1,12})\.?$/i;

/**
 * A size glued to its unit with no hyphen, after an amount: the "14oz" of "2 14oz cans". Only
 * tested after an amount, because at the start of a line "250g flour" is 250 grams.
 */
const GLUED_SIZE = /^\d{1,4}(?:\.\d{1,2})?(oz|lb|g|kg|ml|l)$/i;

/** "about 7 tbsp oil": a hedge in front of the amount, kept as a note. */
const ABOUT = /^(about|approximately|approx\.?) (?=[\d½¼¾⅓⅔])/i;

/**
 * A unit with the metric amount after a slash, as Ottolenghi prints a line: "cup/50g",
 * "tbsp/100ml", "oz / 90g", and "0z/200g" where OCR read the o as a zero. Anchored, bounded.
 */
const UNIT_SLASH_METRIC =
  /^([a-z0]{1,12})\.? ?\/ ?(\d{1,5}(?:\.\d{1,2})?) ?(g|kg|ml|l)\b ?/i;

/**
 * A second amount added or taken away after the unit: "¼ cup plus 2 tablespoons wine", "2 cups
 * minus 2 tablespoons flour". It becomes a note; the first amount is what the list buys.
 */
const PLUS_MINUS =
  /^((?:plus|minus) (?:\d{1,3}(?: \d{1,2}\/\d{1,2}|\/\d{1,2})?|[½¼¾⅓⅔]) ?[a-z.]{1,12}) (?=\S)/i;

/**
 * An alternative with an amount of its own, which belongs in the note: "thyme or 1 tsp dried
 * thyme" is thyme. "dry red or white wine", with no amount after the "or", names one thing and
 * stays. The lazy run is bounded, so the search is linear.
 */
const OR_WITH_AMOUNT = /^(.{1,80}?) (or (?:\d|[½¼¾⅓⅔]).*)$/;

/** Collapse runs of whitespace and trim. */
function tidy(text: string): string {
  return text.replace(/\s+/g, ' ').trim();
}

/** The first word of `text` and everything after it. */
function firstWord(text: string): [string, string] {
  const spaceIdx = text.indexOf(' ');
  return spaceIdx === -1 ? [text, ''] : [text.slice(0, spaceIdx), text.slice(spaceIdx + 1)];
}

/** Whether a word is a size such as "14-ounce" or "6-inch". */
function isSizePrefix(word: string): boolean {
  const match = word.match(SIZE_PREFIX);
  if (!match) return false;
  const measure = (match[1] ?? '').toLowerCase();
  const unit = normalizeUnit(measure);
  return (unit !== null && SIZE_UNITS.has(unit)) || LENGTH_WORDS.has(measure);
}

/**
 * Parse a natural typed ingredient line into structured parts, deterministically
 * (no AI). Reuses {@link parseQuantity} and {@link normalizeUnit} so the amount
 * and unit vocabularies stay consistent across the app.
 *
 * The original line (`raw_text`) is preserved by the caller; this function only
 * extracts structure and leaves the food's own words as written (normalization happens later).
 * What it does take out of the food is how the recipe describes it - size, freshness,
 * preparation, temperature - which moves to the note (see `ingredient-words.ts`), so that
 * "3 large cloves garlic" and "4 garlic cloves" are both cloves of garlic.
 *
 * Notes are joined with `; ` in the order the line gives them up: a size in front of the unit,
 * parentheticals, descriptors, then the trailing aside.
 */
export function parseIngredientLine(line: string): ParsedIngredientLine {
  let rest = tidy(line);
  const notes: string[] = [];

  // 0. A three-way measure in front: "250g/9oz/2¼ cups plain flour". The grams are the second
  // measure, and the rest of the line is parsed as if the book had printed only the cups.
  let alt: Measure | null = null;
  const slashed = slashMeasure(rest);
  if (slashed) {
    alt = slashed.metric;
    rest = slashed.rest;
  }
  // Which of the notes are measures, by position in `notes`, for step 3b.
  const measureNotes: { at: number; measure: Measure }[] = [];
  const hedge = rest.match(ABOUT);
  if (hedge) {
    notes.push(hedge[1]!.toLowerCase().replace(/\.$/, ''));
    rest = rest.slice(hedge[0].length);
  }
  // Notes that come after the descriptors: "plus 2 tablespoons", "or 1 tsp dried thyme".
  const laterNotes: string[] = [];

  // 1. Leading quantity: digits, or a size that implies one ("1-pound package"), or words ("one
  // and a half", "a"), or a unit that means one on its own ("Pinch crushed red pepper flakes").
  let quantity: number | null = null;
  let quantityText = '';
  const [lead, afterLead] = firstWord(rest);
  const qtyMatch = rest.match(LEADING_QUANTITY);
  if (afterLead !== '' && isSizePrefix(lead)) {
    quantity = 1;
  } else if (qtyMatch) {
    quantity = parseQuantity(qtyMatch[0]);
    quantityText = qtyMatch[0].trim();
    rest = rest.slice(qtyMatch[0].length).trimStart();
  } else {
    const words = rest.split(' ', 6);
    const amount = leadingAmountWords(words);
    if (amount) {
      quantity = amount.quantity;
      for (let i = 0; i < amount.taken; i++) rest = firstWord(rest)[1];
    } else if (afterLead !== '' && ONE_WITHOUT_AMOUNT.has(normalizeUnit(lead) ?? '')) {
      quantity = 1;
    }
  }

  // 1b. A size between the amount and the unit is a note: "one 14-ounce can chickpeas". A length
  // straight after the amount is the size of one piece: "1 inch cinnamon piece".
  let onePiece = false;
  if (quantity !== null) {
    const [word, after] = firstWord(rest);
    if (after !== '' && (isSizePrefix(word) || GLUED_SIZE.test(word))) {
      notes.push(word);
      rest = after;
    } else if (after !== '' && quantityText !== '' && LENGTH_WORDS.has(word.toLowerCase())) {
      notes.push(`${quantityText} ${word}`);
      quantity = 1;
      onePiece = true;
      rest = after;
    }
  }

  // 2. Parenthetical asides -> notes. More than one is common on a recipe blog: "1 cup (125g)
  // all-purpose flour (spooned & leveled)". A bounded number of passes, each one linear, and an
  // aside nested deeper than one level comes out on the second pass as the brackets it left.
  for (let pass = 0; pass < MAX_ASIDES; pass++) {
    const parenMatch = rest.match(PARENTHETICAL);
    if (!parenMatch) break;
    const inner = tidy(parenMatch[1] ?? '').replace(WRAPPED, '$1');
    if (inner !== '') {
      const measure = measureIn(inner);
      if (measure) measureNotes.push({ at: notes.length, measure });
      notes.push(inner);
    }
    rest = tidy(rest.replace(PARENTHETICAL, ' '));
  }

  // 3. Descriptors, then the unit (only meaningful once a quantity anchors the line), then the
  // descriptors after the unit: "3 large cloves garlic", "2 tbsp finely chopped fresh parsley".
  // After a container the words describe what is sold in it, so they stay: "1 can diced
  // tomatoes". "of" after a unit goes: "a handful of parsley".
  if (quantity !== null) {
    const slashed = rest.match(UNIT_SLASH_METRIC);
    if (slashed && normalizeUnit(slashed[1]!.replace(/^0z$/i, 'oz')) !== null) {
      const metric = { quantity: Number(slashed[2]), unit: slashed[3]!.toLowerCase() };
      if (alt === null) alt = metric;
      rest = `${slashed[1]!.replace(/^0z$/i, 'oz')} ${rest.slice(slashed[0].length)}`.trim();
    }
  }
  const descriptors: string[] = [];
  const takeDescriptors = () => {
    const split = splitLeadingDescriptors(rest);
    if (split.descriptors !== '') descriptors.push(split.descriptors);
    rest = split.rest;
  };
  takeDescriptors();
  let unit: string | null = null;
  if (quantity !== null) {
    const [word, after] = firstWord(rest);
    const [second, afterSecond] = firstWord(after);
    const fluidOunce =
      afterSecond !== '' &&
      FLUID_WORDS.has(word.toLowerCase().replace(/\.$/, '')) &&
      OUNCE_WORDS.has(second.toLowerCase().replace(/\.$/, ''));
    if (fluidOunce) {
      unit = 'fl oz';
      rest = afterSecond;
    }
    const canonical = fluidOunce || after === '' ? null : normalizeUnit(word);
    if (canonical) {
      unit = canonical;
      rest = after;
      const [maybeOf, afterOf] = firstWord(rest);
      if (maybeOf.toLowerCase() === 'of' && afterOf !== '') rest = afterOf;
      if (!CONTAINER_UNITS.has(canonical)) takeDescriptors();
    }
  }
  if (quantity !== null) {
    const extra = rest.match(PLUS_MINUS);
    if (extra) {
      laterNotes.push(extra[1]!);
      rest = rest.slice(extra[0].length);
      takeDescriptors();
    }
  }
  if (descriptors.length > 0) notes.push(descriptors.join(' '));

  // 3b. One aside that is the same amount in the other system is the second measure, and comes
  // out of the note: "3 cups (360g)" is 3 cups or 360 g. Two of them ("1 tablespoon (15 g) plus
  // 2 teaspoons (10 g)") say something a single second measure cannot, so they stay notes.
  const primary = systemOf(unit);
  const other = measureNotes.filter(
    ({ measure }) => primary !== null && systemOf(measure.unit) !== primary,
  );
  if (alt === null && other.length === 1 && measureNotes.length === 1) {
    alt = other[0]!.measure;
    notes.splice(other[0]!.at, 1);
  }
  if (alt !== null && systemOf(alt.unit) === primary) alt = null;

  notes.push(...laterNotes);

  // 4. Trailing note: a comma aside, or "to taste"/"to serve". A comma after a lone adjective
  // is inside the food, not the start of a note: "boneless, skinless chicken breasts".
  let commaIdx = rest.indexOf(',');
  for (let hops = 0; commaIdx !== -1 && hops < MAX_LISTED_ADJECTIVES; hops++) {
    const before = rest.slice(0, commaIdx).trim().split(' ');
    if (!LISTED_ADJECTIVE.test(before[before.length - 1] ?? '')) break;
    if (before.length > hops + 1) break;
    commaIdx = rest.indexOf(',', commaIdx + 1);
  }
  if (commaIdx !== -1) {
    const trailing = tidy(rest.slice(commaIdx + 1));
    if (trailing !== '') notes.push(trailing);
    rest = rest.slice(0, commaIdx);
  } else {
    const phraseMatch = rest.match(TRAILING_PHRASE);
    if (phraseMatch) {
      notes.push(tidy(phraseMatch[1] ?? ''));
      rest = rest.slice(0, phraseMatch.index);
    }
  }

  // 5. Whatever remains is the raw food name, less a unit written after it: "4 garlic cloves",
  // and the "piece" of "1 inch cinnamon piece".
  let foodName = tidy(rest);
  const alternative = foodName.match(OR_WITH_AMOUNT);
  if (alternative) {
    foodName = alternative[1]!;
    notes.push(alternative[2]!);
  }
  const foodWords = foodName.split(' ');
  const lastWord = (foodWords[foodWords.length - 1] ?? '').toLowerCase();
  if (
    foodWords.length === 2 &&
    foodWords[0]?.toLowerCase() === 'garlic' &&
    normalizeUnit(lastWord) === 'clove'
  ) {
    foodName = foodWords[0];
    if (quantity !== null && unit === null) unit = 'clove';
  } else if (onePiece) {
    if (foodWords.length > 1 && normalizeUnit(lastWord) === 'piece')
      foodName = foodWords.slice(0, -1).join(' ');
    unit ??= 'piece';
  }
  const note = notes.length > 0 ? notes.join('; ') : null;

  return alt === null
    ? { quantity, unit, foodName, note }
    : { quantity, unit, foodName, note, altQuantity: alt.quantity, altUnit: alt.unit };
}
