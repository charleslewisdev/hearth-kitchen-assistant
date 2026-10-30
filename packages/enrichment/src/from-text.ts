import { MAX_TEXT_LENGTH, parseIngredientLine } from '@hearth/shared';
import { emptyDraft, field } from './draft';
import { repairOcrAmounts } from './ocr-amounts';
import type { DraftSource, RecipeDraft } from './draft';

/**
 * Reading a recipe out of a blob of text, by shape.
 *
 * This is the bottom rung of the whole importer, and the other two sources of Phase K are this
 * one with a decoder in front: a PDF's text layer and a photo's OCR output both arrive here as
 * lines. `draftFromHtml` falls through to it as well, when a page carries neither JSON-LD nor
 * microdata.
 *
 * Two rules shape everything below:
 *
 *  - **Confidence is `low` for every field.** This is inference. Nothing here was stated by
 *    anybody, and the review screen exists to make correcting a guess cheap.
 *  - **The one parser decides what an amount is.** `parseIngredientLine` from `@hearth/shared`
 *    is what tells this module whether a line leads with a quantity, so the vocabulary of
 *    amounts and units cannot drift from the one `createRecipe` uses on the same lines later.
 *    There is no second quantity regex in this file.
 *
 * D38: nothing here logs. Every string that passes through is user content.
 */

/**
 * How many amount-leading lines it takes before a run of them is an ingredient list.
 *
 * Three, because a blog post saying "add 2 tablespoons of patience" is not a recipe and one
 * measurement in a paragraph must not produce a draft. Real recipes reach three ingredients
 * essentially always; `from-text.test.ts` holds both halves of that trade.
 */
const MIN_INGREDIENT_LINES = 3;

/**
 * An earlier run of amount lines at least this share of the longest one's length is taken as
 * the ingredient list instead of it (`longestAmountRun`).
 */
const NEAR_LONGEST = 0.8;

/**
 * How many non-amount lines may sit inside an ingredient list without ending it.
 *
 * Two, which covers the section label ("For the topping:") and the quantity-less staple
 * ("Salt and pepper") that appear in the middle of real lists.
 *
 * It is NOT what keeps the method out of the list, and it cannot be: a heading and a first step
 * are exactly two lines, so a method whose second line leads with an amount is inside this gap.
 * That job belongs to `leadsWithAmount`, which refuses a step ordinal and a bare number over
 * `MAX_AMOUNT_WITHOUT_UNIT`. Both of those have tests that fail when they are removed, and the
 * fixture that fails them is a numbered method with no heading over it.
 */
const INGREDIENT_GAP = 2;

/**
 * How many amount lines make a list when a yield line sits directly above them. A two-line list
 * is real ("1 cucumber", "12 slices white bread", then butter and pepper with no amounts), and
 * the yield line is what says a recipe starts there.
 */
const MIN_UNDER_YIELD = 2;

/** A sub-list label is a few words: "For the curried beef", "DOUGH". */
const MAX_LABEL_WORDS = 5;

/** A short line in capitals, letters and spaces only: a cookbook's sub-list head. */
const CAPITALS_LABEL = /^[\p{Lu}'’&\- ]{3,40}$/u;

/**
 * A bare number this large is not an ingredient amount.
 *
 * The line that forced this is a wrapped step: OCR returns "425F and put a 10-inch cast iron"
 * as its own line, `parseIngredientLine` reads 425 off the front of it, and without this it
 * joined the ingredient list. An ingredient with a three-figure amount and no unit is not a
 * shape real recipes use - "200 g flour" carries its unit - so requiring either a unit or a
 * small number costs nothing and closes it.
 */
const MAX_AMOUNT_WITHOUT_UNIT = 100;

/**
 * An ingredient line is short.
 *
 * Measured over the 74 ingredient lines in the seven saved page fixtures: the median is 5
 * words, the 90th percentile is 9, and the longest is 26 - a Minimalist Baker line carrying two
 * parenthetical asides. Twenty admits all but that one, and still refuses the wrapped sentence
 * of prose this is here to refuse ("2 tablespoons of the reserved fat go into the pan with the
 * shallots and").
 *
 * A longer line INSIDE a list is kept regardless: the cap decides what can anchor a run, not
 * what survives inside one.
 */
const MAX_INGREDIENT_WORDS = 20;

/**
 * And how long it may be in CHARACTERS, which is the cap that actually bounds the work.
 *
 * The word cap counts space-separated tokens, so a line with no spaces in it is one word
 * however long it is - and a PDF's text layer produces exactly that, because items sharing a
 * baseline are joined with no separator. Without this, a 7,122-byte PDF whose text layer was
 * 100,000 "(" characters reached `parseIngredientLine` as a single "one-word" line and blocked
 * the process for 3,372ms; 13,681 bytes blocked it for 12,952ms.
 *
 * The regex that made that quadratic is bounded now too (`ingredient.ts`), so this is the
 * second of two locks rather than the only one. 300 characters is well above the longest
 * ingredient line in the seven saved page fixtures, which is 134; the median is 26.
 */
const MAX_INGREDIENT_CHARS = 300;

/**
 * How long a line with NO amount on it may be and still be taken into a list.
 *
 * Tighter than `MAX_INGREDIENT_WORDS`, because extending a run into a line with nothing
 * measurable on it is the riskier of the two moves: what it is reaching for is the staple at the
 * bottom of a list, and those are short. Measured over the same fixtures: ten of the 74
 * ingredient lines carry no quantity, and the longest of them is "Salt and plenty of black
 * pepper", at six words.
 *
 * The cost of getting this wrong is visible: at 20 words, the wrapped first line of a method
 * ("Roll the pastry out and line the tin, then chill it while the oven comes up to tem-") is
 * short enough and, ending in a hyphen rather than a full stop, is not caught by the sentence
 * test either - so it joined the ingredient list and left "perature." as the only step.
 */
const MAX_QUANTITYLESS_WORDS = 8;

/**
 * A food has a word in it. "1X" and "2X" are the scale buttons above an ingredient list on
 * Allrecipes, and a select-all paste of the page brings them along; `parseIngredientLine` reads
 * them as 1 of a food called "X".
 */
const HAS_WORD = /\p{L}{2}/u;

/** What an amount in figures can start with: a digit, a decimal point, or a fraction glyph. */
const LEADING_FIGURE = '0123456789.½⅓⅔¼¾⅕⅛';

/**
 * The share of a list's amount lines that must have a blank line above them before the list is
 * read as blank-separated (`blankSeparated`). Most rather than all, because OCR runs two
 * ingredients together now and then, and a continuation that starts with an amount ("½ inch
 * (1.5 cm) thick and toasted") counts against it.
 */
const BLANK_SEPARATED_SHARE = 2 / 3;

/** A repeated line this short, with no full stop, is a caption. */
const MAX_CAPTION_WORDS = 6;

/** A title is a phrase. Anything longer is a sentence that happened to be at the top. */
const MAX_TITLE_LENGTH = 120;

/** Above this, a number is not a serving count. Matches `from-html.ts`. */
const MAX_SERVINGS = 999;

/** The words a source uses to name the ingredient list. */
const INGREDIENT_HEADING = /^\W*(ingredients?|you will need|what you(?:'ll| will) need)\W*$/i;

/** The words a source uses to name the method. */
const STEP_HEADING = /^\W*(instructions?|directions?|method|steps?|preparation|procedure)\W*$/i;

/** The words that mean the recipe is over and what follows is commentary. */
const TRAILER_HEADING =
  /^\W*((?:my )?(?:private )?notes?|nutrition(?: (?:facts|information))?|tips?|variations?|equipment|storage|to store)(?: \([^)]{0,40}\))?\W*$/i;

/**
 * The start of a line that begins what follows a recipe, with its content on the same line: a
 * cookbook sets "Per Serving Calories: 236; Total Fat: 7g" and "Ingredient tip: Tomato paste
 * is..." as run-in heads, so `TRAILER_HEADING`, which wants the heading on a line of its own,
 * never sees them. Unmatched, the nutrition line joined the ingredient list and the tip became
 * the end of the last step. Anchored, with no repetition, so linear.
 */
const TRAILER_LEAD =
  /^(?:per serving\b|ingredient tips?:|nutrition(?:al)? (?:facts|info(?:rmation)?)\b)/i;

/**
 * A tip set as a run-in head: "Tip:", "Prep tip:", "Cook's tip:", "chica tip:". What follows it
 * is kept as part of the description rather than dropped, which is where the owner put every
 * one of them by hand.
 */
const TIP_LEAD = /^[\p{L}'’]{0,12} ?tips?:/iu;

/**
 * A photo caption: "Opposite, above: Rosa, Maria Moschi, and Maria." A cookbook sets these in the
 * margin, and a column-at-a-time reading puts them after the last step.
 */
const CAPTION_LEAD = /^(?:opposite|above|below|left|right|overleaf)\b ?[,:]/i;

/**
 * The nutrition line with its start cut off by the page edge: "TION INFORMATION PER SERVING:".
 * Short lines only, because "per serving" can be in a sentence of the method.
 */
const PER_SERVING = /\b(?:information|info) per serving\b|\bper serving:/i;
const MAX_NUTRITION_HEAD_WORDS = 8;

/**
 * A nutrition line with no heading on it: "5g fat | 4g protein | 27g complex carbohydrates".
 * Two nutrients with an amount each, which a step does not have. Bounded: linear.
 */
const NUTRIENT =
  /\b\d{1,4} ?m?g (?:fat|protein|(?:complex )?carbohydrates?|sugars?|(?:dietary )?fib(?:er|re)|sodium|cholesterol)\b/gi;
const MIN_NUTRIENTS = 2;

/** Whether a line starts what comes after the recipe. */
function isTrailer(text: string): boolean {
  return (
    TRAILER_HEADING.test(text) ||
    (text.match(NUTRIENT)?.length ?? 0) >= MIN_NUTRIENTS ||
    TRAILER_LEAD.test(text) ||
    TIP_LEAD.test(text) ||
    CAPTION_LEAD.test(text) ||
    (words(text) <= MAX_NUTRITION_HEAD_WORDS && PER_SERVING.test(text))
  );
}

/**
 * What a printed book puts on every page: the running header or footer ("THE WORLD'S BEST
 * BRUNCHES", "YEAST BREADS 149", "176 THE ALL-PURPOSE BAKER'S COMPANION") and the bare page
 * number. Capitals with no lower-case letter, a few words, a page number at either end or none.
 * A step is never set that way. Bounded: linear.
 */
const PAGE_NUMBER = /^\d{1,3}$/;
const RUNNING_HEAD = /^(?:\d{1,3} )?[\p{Lu}'’&,.\- ]{3,60}(?: \d{1,3})?$/u;
const MAX_RUNNING_HEAD_WORDS = 6;

function isPageFurniture(text: string): boolean {
  if (PAGE_NUMBER.test(text)) return true;
  return words(text) <= MAX_RUNNING_HEAD_WORDS && RUNNING_HEAD.test(text) && /\p{Lu}{3}/u.test(text);
}

/**
 * A step number at the start of a line: `1.`, `2)`, or `Step 3`.
 *
 * Matched BEFORE the amount test, because `parseIngredientLine('1. Heat the oven')` reads a
 * quantity of 1 off it exactly as it reads one off `1 tsp salt`. Without this the whole method
 * of a numbered recipe reads as an ingredient list.
 *
 * `Step 3` is how Food & Wine, Delish and Serious Eats number a printed method, often on a line
 * of its own above the step. Without it that method was one step, "Step 1 Gather the
 * ingredients. Step 2 Season the chicken...". The word is followed by at most three spaces and
 * the number by an optional colon, so the pattern stays linear.
 */
const STEP_ORDINAL = /^(?:\d{1,2}[.)]\s+|step {1,3}\d{1,2}(?![\d/])[:.]?(?:\s+|$))/i;

/** The list markers a paste arrives with, ahead of the amount. */
const BULLET = /^[-–—*•·▪◦●○■]+\s+/;

/**
 * What OCR makes of a printed bullet: a lone `e`, `«`, `©`, `¢` or `+`, sometimes after a `|` from the
 * page edge. Measured on photographs of printed web recipes: of 22 bulleted lines tesseract
 * returned, 21 started with one of these.
 *
 * Stripped only when an amount or a capital letter follows, because a lone `e` or `o` is a word
 * in the Italian a family recipe is written in ("e poi il sale"), and in that it is followed by a
 * lower-case word.
 */
const OCR_BULLET = /^(?:\| ?)?[eo«»©®¢+|] {1,3}(?=[\d¼½¾⅓⅔⅛A-Z])/;

/**
 * The header and footer a browser prints on every page, which reach this module inside a PDF's
 * text layer and a photograph of a printout: "6/24/18, 10:10 AM", "Page 1 of 3", and the page's
 * address. OCR reads the colon of the time as `*` or `)` often enough to allow for it.
 *
 * All bounded and anchored to a word boundary, so each is linear however long the line.
 */
const PRINT_TIMESTAMP = /(?:^| )\d{1,2}\/\d{1,2}\/\d{2,4},? \d{1,2}[:*.)]\d{2} ?[ap]m(?= |$)/gi;
const PRINT_PAGE_NUMBER = /(?:^| )page \d{1,3} of \d{1,3}(?= |$)/gi;
const LEADING_URL = /^(?:https?:\/\/|www\.)\S/i;
/** Chrome's page counter, "1/3", which is a line of its own once the footer is split. */
const PAGE_COUNTER = /^\d{1,3}\/\d{1,3}$/;

/** A line that starts with a web address and has little else on it is a printed footer. */
const MAX_FOOTER_WORDS = 8;

/** A line with the print chrome taken out of it, or '' when that was all it was. */
function withoutPrintChrome(text: string): string {
  const kept = text.replace(PRINT_TIMESTAMP, ' ').replace(PRINT_PAGE_NUMBER, ' ').trim();
  if (LEADING_URL.test(kept) && words(kept) <= MAX_FOOTER_WORDS) return '';
  if (PAGE_COUNTER.test(kept)) return '';
  return kept;
}

/**
 * "8 servings", "Serves 8", "Yield: 6", "Makes about 12": a yield statement, not an ingredient.
 *
 * The second pattern only allows a colon, whitespace and one hedging word between the verb and
 * the number. A looser gap - anything non-numeric up to some length - reads "Serves well with 4
 * slices of bread" as four servings.
 */
const SERVINGS_PATTERNS = [
  /\b(\d+)\s+(?:servings?|portions?)\b/i,
  /\b(?:serves|makes|yields?)\b:?\s*(?:about\s+|around\s+|roughly\s+)?(\d+)/i,
] as const;

/**
 * A yield given as a label with its number on the next line, which is what a paste of a page
 * that lays its recipe facts out as a grid produces: "Servings:" and then "4".
 */
const SERVINGS_LABEL = /^(?:servings|serves|yields?|makes)\s?:?$/i;
const BARE_COUNT = /^\d{1,3}$/;

/** One line of the input, with the blank lines around it remembered rather than kept. */
interface Line {
  text: string;
  /**
   * Whether at least one empty line came before this one.
   *
   * Kept as a flag rather than as a line, because it is only ever a hint: tesseract puts a
   * blank line between every ingredient and between some steps but not others (the fixture in
   * `from-text.test.ts` is its verbatim output), so paragraph breaks are the LAST signal this
   * module reaches for, not the first.
   */
  blankBefore: boolean;
  /**
   * Whether the line arrived with a list marker in front of it. A method set as a bulleted list
   * (a Serious Eats or Milk Street print) has no numbers and no blank lines in a PDF, and the
   * bullets are the only thing that says where one step ends.
   */
  bulleted: boolean;
}

interface Block {
  start: number;
  end: number;
}

function words(text: string): number {
  return text.split(' ').length;
}

function isHeading(text: string): boolean {
  return INGREDIENT_HEADING.test(text) || STEP_HEADING.test(text) || TRAILER_HEADING.test(text);
}

/** Whether a line states a yield. Used both to read it and to keep it out of the ingredients. */
function servingsIn(text: string): number | null {
  for (const pattern of SERVINGS_PATTERNS) {
    const match = text.match(pattern);
    const value = match ? Number(match[1]) : NaN;
    if (Number.isInteger(value) && value >= 1 && value <= MAX_SERVINGS) return value;
  }
  return null;
}

/** The input as non-empty lines, bullets stripped and runs of whitespace collapsed. */
function toLines(text: string): Line[] {
  const lines: Line[] = [];
  let blankBefore = false;
  for (const raw of text.split(/\r?\n/)) {
    const collapsed = raw.replace(/\s+/g, ' ').trim();
    const unbulleted = collapsed.replace(BULLET, '').replace(OCR_BULLET, '');
    const tidy = withoutPrintChrome(unbulleted.trim());
    if (tidy === '') {
      blankBefore = true;
      continue;
    }
    // A bullet OCR misread ("e Rinse the pork") is still a bullet: on a printout whose method is
    // a bulleted list with even line spacing, it is the only thing that says where a step ends.
    lines.push({ text: tidy, blankBefore, bulleted: unbulleted !== collapsed });
    blankBefore = false;
  }
  return lines;
}

/**
 * A step number a cookbook prints in bold with no full stop after it: "1 Peel the cucumber".
 * `parseIngredientLine` reads that as 1 of a food called "Peel the cucumber...", so without this
 * the whole method of such a book became its ingredient list.
 */
const BARE_ORDINAL = /^(\d{1,2}) (?=\p{Lu})/u;

/** A bare-numbered step has at least this many words before its first full stop. */
const MIN_BARE_STEP_WORDS = 5;

/**
 * Turn "1 Peel the cucumber" into "1. Peel the cucumber" where the page is numbering its method.
 *
 * Three things have to agree, because "2 Leeks, trimmed and sliced" has the same shape: the line
 * is long enough to be an instruction, its paragraph runs to a full stop, and it is part of a
 * count, with the step before or after it numbered one less or one more.
 */
function numberBareSteps(lines: Line[]): void {
  const numberOf = (i: number): number | null => {
    const text = lines[i]!.text;
    const dotted = text.match(/^(\d{1,2})[.)] /);
    if (dotted) return Number(dotted[1]);
    return bareStep(lines, i) ? Number(text.match(BARE_ORDINAL)![1]) : null;
  };
  const numbered: [number, number][] = [];
  for (let i = 0; i < lines.length; i++) {
    const n = numberOf(i);
    if (n !== null) numbered.push([i, n]);
  }
  for (let k = 0; k < numbered.length; k++) {
    const [i, n] = numbered[k]!;
    if (!BARE_ORDINAL.test(lines[i]!.text)) continue;
    const before = numbered[k - 1]?.[1];
    const after = numbered[k + 1]?.[1];
    if (before === n - 1 || after === n + 1) {
      lines[i]!.text = lines[i]!.text.replace(BARE_ORDINAL, '$1. ');
    }
  }
}

function bareStep(lines: Line[], i: number): boolean {
  const text = lines[i]!.text;
  if (!BARE_ORDINAL.test(text) || parseIngredientLine(text).unit !== null) return false;
  // Counted over the paragraph, because OCR can break a step after its first words ("7 To make"
  // on a line of its own).
  let count = 0;
  for (let j = i; j < lines.length && (j === i || !lines[j]!.blankBefore); j++) {
    if (j > i && BARE_ORDINAL.test(lines[j]!.text)) break;
    count += words(lines[j]!.text);
    if (/[.!?]/.test(lines[j]!.text)) return count >= MIN_BARE_STEP_WORDS;
  }
  return false;
}

/**
 * Whether a line looks like it leads with an ingredient amount.
 *
 * The quantity and the unit both come from `parseIngredientLine`, so this asks the same
 * question `createRecipe` will ask of the same line rather than a similar one.
 */
function leadsWithAmount(text: string): boolean {
  // Length first, so nothing further down - including `parseIngredientLine` - is ever handed a
  // line whose size was not checked.
  if (text.length > MAX_INGREDIENT_CHARS) return false;
  if (words(text) > MAX_INGREDIENT_WORDS) return false;
  if (STEP_ORDINAL.test(text)) return false;
  if (servingsIn(text) !== null) return false;
  // The parser also reads an amount written as a word ("a green bell pepper", "One-and-a-half
  // cans"), and prose starts with those too: "One year ago: Onion Soup" is not an ingredient.
  // Finding the list asks for figures; a worded line inside it still joins through the gap.
  if (!LEADING_FIGURE.includes(text[0] ?? '')) return false;
  const parsed = parseIngredientLine(text);
  if (parsed.quantity === null || !HAS_WORD.test(parsed.foodName)) return false;
  return parsed.unit !== null || parsed.quantity <= MAX_AMOUNT_WITHOUT_UNIT;
}

/**
 * Whether a line could belong to an ingredient list without leading with an amount.
 *
 * Used only to extend a run FORWARD, never backward, and the asymmetry is the point. Below a
 * list is the method, and a sentence ends in a full stop, which this refuses. Above one are the
 * title and the yield line, and this would take both of them in quite happily: "Serves 8" is
 * two words with no full stop on it, so the word cap is not what would stop it either.
 */
function couldBeIngredient(text: string): boolean {
  if (text.length > MAX_INGREDIENT_CHARS) return false;
  if (words(text) > MAX_QUANTITYLESS_WORDS) return false;
  if (isHeading(text) || isTrailer(text)) return false;
  if (STEP_ORDINAL.test(text)) return false;
  return !/[.!?]$/.test(text);
}

/**
 * The run of amount-leading lines that is the recipe's ingredient list, tolerating small gaps:
 * the one with the most lines in it, unless an earlier one comes close (`NEAR_LONGEST`).
 *
 * The earlier one wins a near tie because a page with two lists on it is a recipe with a
 * sub-recipe under it ("Meat Ragu" below a sformato that calls for "1 Recipe Meat Ragu"), and
 * the main list comes first. Taking the longest by one line imported the sauce and dropped the
 * dish.
 */
function longestAmountRun(
  lines: Line[],
  amounts: boolean[],
  labels: boolean[],
): Block | null {
  const runs: (Block & { hits: number })[] = [];
  let start = -1;
  let end = -1;
  let hits = 0;
  let gap = 0;
  const close = () => {
    if (start !== -1) runs.push({ start, end, hits });
  };

  for (let i = 0; i < amounts.length; i++) {
    if (!amounts[i]) {
      // A sub-list's label ("DOUGH", "For the filling") joins the lists either side of it; it
      // is how a list is split, not where it ends. So does a line in lower case, which is an
      // ingredient wrapped in a narrow column ("1 pound dried red kidney" / "beans, picked over
      // and" / "rinsed, or 2 15-ounce cans"). Only other lines count toward the gap.
      if (!labels[i] && !/^\p{Ll}/u.test(lines[i]!.text)) gap += 1;
      continue;
    }
    if (start === -1 || gap > INGREDIENT_GAP) {
      close();
      start = i;
      hits = 0;
    }
    end = i;
    hits += 1;
    gap = 0;
  }
  close();

  const most = Math.max(0, ...runs.map((run) => run.hits));
  if (most < MIN_INGREDIENT_LINES) {
    // A short list is still a list when the page has said a recipe starts there: a yield line
    // directly above it ("SERVES 6" over "1 cucumber" and "12 slices white bread").
    const underYield = runs.find(
      (run) =>
        run.hits >= MIN_UNDER_YIELD &&
        run.start > 0 &&
        servingsIn(lines[run.start - 1]!.text) !== null,
    );
    return underYield ? { start: underYield.start, end: underYield.end } : null;
  }
  const chosen = runs.find(
    (run) => run.hits >= Math.max(MIN_INGREDIENT_LINES, NEAR_LONGEST * most),
  );
  return chosen ? { start: chosen.start, end: chosen.end } : null;
}

/**
 * Whether a line names a sub-list rather than being one of its ingredients: "For the topping:",
 * "Dressing:", "FOR THE CURRIED BEEF", "DOUGH". A short line in capitals counts, because a
 * cookbook sets its sub-list heads that way and OCR does not keep the colour or the weight.
 */
function isSectionLabel(text: string): boolean {
  if (SECTION_LABEL.test(text)) return true;
  if (text.endsWith(':') && words(text) <= MAX_LABEL_WORDS) return true;
  return words(text) <= MAX_LABEL_WORDS && CAPITALS_LABEL.test(text);
}

/** Where the ingredient list is: what the headings say if they say it, otherwise its shape. */
function findIngredientBlock(lines: Line[], amounts: boolean[]): Block | null {
  const heading = lines.findIndex((line) => INGREDIENT_HEADING.test(line.text));
  const method = lines.findIndex((line) => STEP_HEADING.test(line.text));

  // Both named, in that order: the source has said where the list is, and it is more reliable
  // than shape - it is the one case where a list of bare foods ("Flour", "Sugar") is readable.
  if (heading >= 0 && method > heading + 1) return { start: heading + 1, end: method - 1 };

  const labels = lines.map((line, i) => !amounts[i] && isSectionLabel(line.text));
  const run = longestAmountRun(lines, amounts, labels);
  if (!run) return null;

  // Take in the trailing quantity-less lines a list ends with ("Flaky salt, for serving"), but
  // not a paragraph of prose that follows it with no heading between: a cookbook's tip box,
  // whose heading OCR can lose, reads line by line like more short ingredients.
  let end = run.end;
  while (
    end + 1 < lines.length &&
    couldBeIngredient(lines[end + 1]!.text) &&
    !(lines[end + 1]!.blankBefore && startsProse(lines, end + 1))
  ) {
    end += 1;
  }

  // An "Ingredients" heading above the run pulls the start up to it, so a quantity-less first
  // line is not left out; without one the run starts where the amounts start.
  const start = heading >= 0 && heading + 1 < run.start ? heading + 1 : run.start;
  return { start, end };
}

/**
 * Whether the paragraph starting at this line is prose: it runs to a full stop, and is longer
 * than anything an ingredient list would hold without an amount on it.
 */
function startsProse(lines: Line[], from: number): boolean {
  let count = 0;
  for (let i = from; i < lines.length && (i === from || !lines[i]!.blankBefore); i++) {
    count += words(lines[i]!.text);
    if (/[.!?]$/.test(lines[i]!.text)) return count > MAX_QUANTITYLESS_WORDS;
  }
  return false;
}

/** Where the method is: after the step heading if there is one, otherwise after the list. */
function findStepBlock(lines: Line[], ingredients: Block): Block | null {
  const method = lines.findIndex((line) => STEP_HEADING.test(line.text));
  let start = method > ingredients.end ? method + 1 : ingredients.end + 1;

  // A trailer BEFORE the method is not the end of it. A cookbook page read a column at a time
  // puts the nutrition line under the ingredient column ahead of the method column beside it;
  // the method resumes at the next numbered step or method heading.
  if (start < lines.length && isTrailer(lines[start]!.text)) {
    const resume = lines.findIndex(
      (line, i) => i > start && (STEP_ORDINAL.test(line.text) || STEP_HEADING.test(line.text)),
    );
    if (resume === -1) return null;
    start = STEP_HEADING.test(lines[resume]!.text) ? resume + 1 : resume;
  }

  let end = lines.length - 1;
  for (let i = start; i < lines.length; i++) {
    if (isTrailer(lines[i]!.text)) {
      end = i - 1;
      break;
    }
  }
  return end >= start ? { start, end } : null;
}

/**
 * Join the lines one step was wrapped across.
 *
 * A word broken by a hyphen at the end of a line is put back together; anything else is joined
 * with a space. The hyphen rule is what a PDF's text layer does at the right margin and what
 * OCR copies from it, and it only fires when the next line continues in lower case, so
 * "10-inch" and "all-purpose" - where the hyphen is inside a line - are untouched.
 */
function joinWrapped(group: Line[]): string {
  let joined = '';
  for (const line of group) {
    if (joined === '') {
      joined = line.text;
    } else if (/[a-z]-$/.test(joined) && /^[a-z]/.test(line.text)) {
      joined = joined.slice(0, -1) + line.text;
    } else {
      joined = `${joined} ${line.text}`;
    }
  }
  return joined.trim();
}

/**
 * The method as a list of steps.
 *
 * Numbering first, blank lines second, and one step as the floor. Numbering wins because it is
 * the signal that survives both decoders: OCR's blank lines are unreliable (see `Line`), and a
 * PDF's text layer has no blank lines in it at all.
 *
 * Never sentence-splitting. A step is usually several sentences, and "Bake for 25 min. at
 * 350F" would come apart in the middle.
 */
function toSteps(lines: Line[], block: Block): { steps: string[]; leadIn: string | null } {
  const candidates = lines
    .slice(block.start, block.end + 1)
    .filter((line) => !isHeading(line.text) && !isPageFurniture(line.text))
    // "SERVES 2" printed under the last step is the yield, read a column late.
    .filter((line) => !(servingsIn(line.text) !== null && words(line.text) <= 3));

  // A short line that repeats is a caption, not a step: a paste of an Allrecipes page carries
  // the photo credit "Dotdash Meredith Food Studios" under every step's picture.
  const seen = new Map<string, number>();
  for (const line of candidates) seen.set(line.text, (seen.get(line.text) ?? 0) + 1);
  const within = candidates.filter(
    (line) =>
      seen.get(line.text)! < 2 || words(line.text) > MAX_CAPTION_WORDS || /[.!?]$/.test(line.text),
  );

  const numbered = within.filter((line) => STEP_ORDINAL.test(line.text)).length >= 2;
  // In a numbered method, what comes before step 1 is not a step: it is a tip box or a headnote
  // read into the gap between the list and the method.
  let leadIn: string | null = null;
  if (numbered) {
    const first = within.findIndex((line) => STEP_ORDINAL.test(line.text));
    const before = within.splice(0, first);
    const text = joinWrapped(before);
    // Only a paragraph that starts as one: a lower-case start is the tail of something OCR
    // split, such as the end of step 1 read out of its column.
    if (isProse(text) && /^\p{Lu}/u.test(text)) leadIn = text;
  }
  const bulleted = !numbered && within.filter((line) => line.bulleted).length >= 2;
  const groups: Line[][] = [];
  let afterLabel = false;
  for (const line of within) {
    const starts = numbered
      ? STEP_ORDINAL.test(line.text)
      : bulleted
        ? line.bulleted || afterLabel
        : line.blankBefore;
    // In a bulleted method, a short line ending in a colon is a label over the bullets below it
    // ("TO CRISP IN THE OVEN:"), not the end of the bullet above it; it stands alone, as it
    // does when the method is split by blank lines.
    const label = bulleted && !line.bulleted && line.text.endsWith(':') && words(line.text) <= 6;
    afterLabel = label;
    if (starts || label || groups.length === 0) groups.push([line]);
    else groups[groups.length - 1]!.push(line);
  }

  // The number comes off each step: every screen that shows steps numbers them itself, so
  // keeping it would show the cook "1. 1. Heat the oven".
  const steps = groups
    .map((group) => joinWrapped(group).replace(STEP_ORDINAL, '').trim())
    .filter((step) => step !== '');

  // A method with no numbers has no way to say where it starts, and a two-column page read a
  // column at a time can put the headnote at its head: "Antioquia in northwest Colombia is one
  // of the most beautiful places on Earth..." above "Heat the oil". A first paragraph that does
  // not start with an instruction, and reads as a story, is the headnote.
  if (!numbered && steps.length >= MIN_STEPS_FOR_HEADNOTE && isStory(steps[0]!)) {
    return { steps: steps.slice(1), leadIn: steps[0]! };
  }
  return { steps, leadIn };
}

/** A method this long before its first paragraph can be taken as a headnote. */
const MIN_STEPS_FOR_HEADNOTE = 3;

/**
 * How an instruction starts: an imperative, or the clause a cook sets before one. Not every
 * verb in a kitchen, only enough that a first step is never mistaken for a story; a paragraph
 * must also be long or personal (`isStory`) before it is moved.
 */
const INSTRUCTION_START =
  /^(?:add|arrange|bake|beat|blend|boil|bring|brown|brush|chill|chop|coat|combine|cook|cool|cover|cream|cut|dice|discard|dissolve|divide|drain|drizzle|dust|fill|finish|fold|fry|garnish|grate|grease|grill|heat|in|if|knead|layer|let|line|make|marinate|mash|meanwhile|melt|mix|once|peel|place|pour|preheat|prepare|press|put|reduce|remove|rinse|roast|roll|rub|saute|sauté|scatter|season|serve|set|simmer|slice|soak|spoon|spread|sprinkle|start|steam|stir|strain|stuff|take|to|toast|top|toss|transfer|trim|turn|using|wash|when|while|whisk|with|wrap)\b/i;

/** First person, the voice of a headnote and never of a step. */
const FIRST_PERSON = /\b(?:I|I'm|I've|my|we|we're|our)\b/;

/** A headnote this long reads as one even in the third person. */
const MIN_STORY_WORDS = 50;

function isStory(paragraph: string): boolean {
  if (INSTRUCTION_START.test(paragraph)) return false;
  return FIRST_PERSON.test(paragraph) || words(paragraph) >= MIN_STORY_WORDS;
}

/**
 * A line as a title, or null when it is not one.
 *
 * Refused: a breadcrumb ("Meals & Cooking > Recipe Headquarters", from a printed page's
 * navigation), and OCR noise that has no word in it ("BE TT Ga", "a5 |"), which is what tesseract
 * returns for a photograph above the recipe's first line. A real title has a word of three
 * letters or more in it; "Pho" does.
 *
 * Trimmed: the site after a bar, because a printed page's header is its `<title>`, and that is
 * "Shakshuka with Feta Recipe | Molly Yeh | Food Network".
 */
function asTitle(text: string): string | null {
  if (text.includes(' > ')) return null;
  const title = text.split(' | ')[0]!.trim();
  if (!/\p{L}{3}/u.test(title)) return null;
  return title;
}

/**
 * Whether an ingredient line was cut off and the next line carries on with it.
 *
 * A narrow column wraps an ingredient onto a second line ("1½ teaspoons Aleppo pepper or 1" /
 * "teaspoon hot paprika plus ¼ teaspoon" / "cayenne pepper"), and each piece reads as an
 * ingredient on its own. The next line has to lead with no amount and start in lower case, and
 * this line has to end where a phrase cannot: a comma, an open bracket, a joining word, or a
 * bare number. That leaves "½ cup peas" followed by "salt" as two ingredients, which they are.
 *
 * A next line that opens with a bracket joins whatever this one ends with, because an aside is
 * never an ingredient of its own: "1 ½ teaspoons harissa, plus more to taste" / "(brands vary
 * in heat)".
 */
function continuesOnNextLine(text: string): boolean {
  const open = text.split('(').length - text.split(')').length;
  if (open > 0) return true;
  return /(?:[,(\d]|\p{L}-|\b(?:and|or|plus|for|with|of|to|into|about|in))$/iu.test(text);
}

/**
 * A line that starts with a joining word carries on the one above it, whatever that ended with:
 * no ingredient starts with "and" ("1 cup Carmona Olives, pitied" / "and halved").
 */
const CONTINUING_WORD = /^(?:and|or|plus|then|into|with)\b/;

/** Two pieces of one wrapped line, with a word the margin hyphenated put back together. */
function joinLine(previous: string, next: string): string {
  return /\p{L}-$/u.test(previous) && /^\p{Ll}/u.test(next)
    ? `${previous}${next}`
    : `${previous} ${next}`;
}

/**
 * A section label without the colon that usually marks one: "To Marinate", "For the sauce",
 * "Other Ingredients". Printed web recipes set these as subheadings, and a subheading has no
 * colon after it. Only tested against lines that lead with no amount.
 */
const SECTION_LABEL =
  /^(?:(?:for|to make) (?:the )?[^,\s][^,]{0,40}|to marinate|(?:other|remaining|main) ingredients)$/i;

/** The ingredient lines inside a block: no headings, no section labels, no yield statement. */
function toIngredients(lines: Line[], block: Block, amounts: boolean[]): string[] {
  const separated = blankSeparated(lines, block, amounts);
  const kept: string[] = [];
  let keptAt = -1;
  for (let i = block.start; i <= block.end; i++) {
    const text = lines[i]!.text;
    if (isHeading(text)) continue;
    if (servingsIn(text) !== null) continue;
    const previous = kept[kept.length - 1];
    // Asked before the label test below: in a blank-separated list, "for serving" under
    // "Sliced raw vegetables," is the end of that ingredient, not a "For the ..." label.
    const wrappedInList =
      separated &&
      previous !== undefined &&
      keptAt === i - 1 &&
      !lines[i]!.blankBefore &&
      (!amounts[i] || continuesOnNextLine(previous));
    if (STEP_ORDINAL.test(text)) continue;
    if (wrappedInList && HAS_WORD.test(text)) {
      kept[kept.length - 1] = joinLine(previous, text);
      keptAt = i;
      continue;
    }
    const wrapped =
      !separated &&
      previous !== undefined &&
      !amounts[i] &&
      HAS_WORD.test(text) &&
      (text.startsWith('(') ||
        CONTINUING_WORD.test(text) ||
        (/^\p{Ll}/u.test(text) && continuesOnNextLine(previous)));
    // "For the topping:" is a label, not a food. Left in, it becomes a Food row and then a line
    // on the shopping list. Asked after the wrap, so "for spreading" under "butter, at room
    // temperature," stays the end of the butter.
    if (!wrapped && !amounts[i] && isSectionLabel(text)) continue;
    if (!HAS_WORD.test(text)) continue;
    if (wrapped) {
      kept[kept.length - 1] = joinLine(previous, text);
    } else {
      kept.push(text);
    }
    keptAt = i;
  }
  return kept;
}

/**
 * Whether the list puts a blank line between one ingredient and the next, so that a line
 * WITHOUT one in front of it is the ingredient above it, wrapped.
 *
 * A cookbook with a narrow ingredient column sets each ingredient as its own paragraph, with
 * more space above it than between its own lines ("1 (12-ounce) jar roasted" / "red peppers,
 * drained"), and a photo import turns that space into a blank line (`reading-order.ts`). Read
 * line by line, "red peppers, drained" is an ingredient of its own, and a jar of peppers is two
 * rows on the shopping list. The ordinary rule in `toIngredients` cannot join it: "roasted"
 * could end an ingredient as well as any word could.
 *
 * Only when the list itself says so, which is most of its amount lines having a blank above
 * them. A paste has no blank lines inside a list at all, and that rule stays as it was.
 */
function blankSeparated(lines: Line[], block: Block, amounts: boolean[]): boolean {
  let counted = 0;
  let blank = 0;
  for (let i = block.start + 1; i <= block.end; i++) {
    if (!amounts[i]) continue;
    counted += 1;
    if (lines[i]!.blankBefore) blank += 1;
  }
  return counted >= MIN_INGREDIENT_LINES - 1 && blank >= BLANK_SEPARATED_SHARE * counted;
}

/**
 * A draft from a blob of text, or `null` when there is no recipe in it.
 *
 * `null` rather than an empty draft, for the same reason `draftFromHtml` returns it: pasting an
 * article about cooking is an ordinary thing to do, and it deserves a sentence rather than a
 * review screen of blank flagged fields.
 */
export function draftFromText(text: string, source: DraftSource): RecipeDraft | null {
  // The bound `MAX_TEXT_LENGTH` claims to be, enforced here rather than at each caller, so that
  // it is true for all four sources instead of the one whose input schema happens to check it.
  // A PDF's text layer and a photo's OCR output both arrive through this function and neither
  // passes through a zod schema on the way.
  if (text.length > MAX_TEXT_LENGTH) return null;

  const lines = toLines(text);
  if (lines.length === 0) return null;

  // A photo's text, and a scanned PDF's, has its fractions misread (`ocr-amounts.ts`). A paste
  // and a PDF's text layer have the page's own characters, and are left as they are.
  const guessed: string[] = [];
  if (source.kind === 'image' || source.kind === 'pdf') {
    for (const line of lines) {
      const repaired = repairOcrAmounts(line.text);
      line.text = repaired.text;
      if (repaired.guessed) guessed.push(repaired.text);
    }
  }
  numberBareSteps(lines);

  const amounts = lines.map((line) => leadsWithAmount(line.text));
  const block = findIngredientBlock(lines, amounts);
  if (!block) return null;

  const ingredientLines = toIngredients(lines, block, amounts);
  if (ingredientLines.length === 0) return null;

  const titleAt = findTitle(lines, block, amounts);
  const stepBlock = findStepBlock(lines, block);
  const read = stepBlock ? toSteps(lines, stepBlock) : { steps: [], leadIn: null };
  let steps = read.steps;
  let headnote = headnoteBefore(lines, titleAt, block);
  if (steps.length === 0) {
    // A page that sets its method to the left of the list, read a column at a time, has the
    // method ABOVE the list: between the headnote and the first ingredient.
    const before = methodBefore(lines, titleAt, block);
    if (before.length > 0) {
      headnote = before[0]!;
      steps = before.slice(1);
    }
  }
  const tips = tipsIn(lines, block.end + 1);
  const description = [headnote, read.leadIn, ...tips]
    .filter((part) => part !== null)
    .map((part) => part.replace(NOTE_JUNK, ''))
    .join('\n\n');
  const times = timesIn(lines);

  const draft = emptyDraft(source);
  draft.ingredientLines = field(ingredientLines, 'low', null);
  draft.steps = field(steps, 'low', null);
  draft.details.description = description === '' ? null : description;
  draft.details.prepMinutes = times.prep;
  draft.details.cookMinutes = times.cook;
  draft.amountsToCheck = ingredientLines.filter((line) =>
    guessed.some((repaired) => line.includes(repaired)),
  );

  // Not from an ingredient line, because "1 cup sugar" is not a yield and a recipe that states
  // its yield does so above the list or below the method.
  //
  // Inside the list's bounds is allowed for a line that leads with no amount, because a heading
  // above the list pulls those bounds up over whatever sits between: "Original recipe (1X)
  // yields 4 servings" on Allrecipes is below "Ingredients" and above the first amount.
  for (let i = 0; i < lines.length; i++) {
    if (i >= block.start && i <= block.end && amounts[i]) continue;
    const text = lines[i]!.text;
    const next = lines[i + 1]?.text ?? '';
    const servings =
      servingsIn(text) ??
      (SERVINGS_LABEL.test(text) && BARE_COUNT.test(next) ? Number(next) : null);
    if (servings !== null && servings >= 1) {
      draft.servings = field(servings, 'low', servingsIn(text) !== null ? text : `${text} ${next}`);
      break;
    }
  }

  if (titleAt !== -1) {
    const candidate = lines[titleAt]!.text;
    draft.title = field(tidyTitle(asTitle(candidate)!), 'low', candidate);
  }

  return draft;
}

/** The index of the line that is the title: the first phrase above the list. -1 for none. */
function findTitle(lines: Line[], block: Block, amounts: boolean[]): number {
  for (let i = 0; i < block.start; i++) {
    const candidate = lines[i]!.text;
    if (isHeading(candidate) || amounts[i] || servingsIn(candidate) !== null) continue;
    if (candidate.length > MAX_TITLE_LENGTH) continue;
    if (asTitle(candidate) === null) continue;
    return i;
  }
  return -1;
}

/** A label a book prints in front of its title: "Recipe French Toast". */
const TITLE_LABEL = /^recipe:? (?=\S)/i;

/** The words a title leaves in lower case, unless one starts it. */
const MINOR_WORDS = new Set([
  'a', 'an', 'and', 'or', 'the', 'of', 'with', 'in', 'on', 'for', 'to', 'at', 'by',
  'alla', 'al', 'di', 'e', 'con', 'de', 'la', 'le', 'y',
]);

/**
 * A title in title case, which is how the owner writes every one. A book that sets its titles
 * in capitals ("ORECCHIETTE PASTA SALAD"), in lower case ("easy gaucho beans") or in sentence
 * case ("Classic cucumber sandwiches") is recased. A title with a capital after its first word
 * is the book's own styling ("Pasta alla Norma") and is kept.
 */
function tidyTitle(title: string): string {
  const bare = title.replace(TITLE_LABEL, '');
  const later = bare.split(' ').slice(1).join(' ');
  const styled = /\p{Lu}/u.test(later) && /\p{Ll}/u.test(bare);
  if (styled) return bare;
  return bare
    .toLowerCase()
    .split(' ')
    .map((word, i) =>
      i > 0 && MINOR_WORDS.has(word)
        ? word
        : word.replace(/(^|-)(\p{L})/gu, (_m, dash: string, letter: string) => dash + letter.toUpperCase()),
    )
    .join(' ');
}

/** The paragraphs between the title and the list, each joined into one string. */
function paragraphsBefore(lines: Line[], titleAt: number, block: Block): string[] {
  const paragraphs: Line[][] = [];
  for (let i = titleAt + 1; i < block.start; i++) {
    const line = lines[i]!;
    if (line.blankBefore || paragraphs.length === 0) paragraphs.push([line]);
    else paragraphs[paragraphs.length - 1]!.push(line);
  }
  return paragraphs.map(joinWrapped);
}

/**
 * A paragraph of prose: long enough, and with a sentence in it, or long enough that OCR losing
 * the full stop at its end does not matter ("...makes this a truly luxurious teatime treat").
 */
const MIN_PROSE_WORDS = 8;
const MIN_UNPUNCTUATED_PROSE_WORDS = 15;
function isProse(paragraph: string): boolean {
  const count = words(paragraph);
  if (count < MIN_PROSE_WORDS) return false;
  return /[.!?](?: |$)/.test(paragraph) || count >= MIN_UNPUNCTUATED_PROSE_WORDS;
}

/** The mark OCR reads in front of a paragraph from a drop cap or an ornament: "@ Another". */
const NOTE_JUNK = /^[@©®=|}~*] {1,3}(?=\p{Lu})/u;

/**
 * "Prep Time: 20 minutes", "Cook time 1 hour 10 minutes": the times a page states on a line of
 * their own. The label and the amount must be on the same line; a sidebar that sets "PREP" and
 * "TIME" on separate lines with the number somewhere else is not read. Bounded: linear.
 */
const TIME_LINE =
  /^(prep(?:aration)?|cook(?:ing)?|bake|baking) ?time:? {0,3}(?:(\d{1,2}) ?(?:hours?|hrs?|h)\b)? {0,3}(?:(\d{1,3}) ?(?:minutes?|mins?|m)\b)?/i;

function timesIn(lines: Line[]): { prep: number | null; cook: number | null } {
  const times = { prep: null as number | null, cook: null as number | null };
  for (const line of lines) {
    const match = line.text.match(TIME_LINE);
    if (!match || (match[2] === undefined && match[3] === undefined)) continue;
    const minutes = Number(match[2] ?? 0) * 60 + Number(match[3] ?? 0);
    if (minutes === 0) continue;
    const which = /^prep/i.test(match[1]!) ? 'prep' : 'cook';
    times[which] ??= minutes;
  }
  return times;
}

/**
 * The headnote: a paragraph of prose between the title and the list, when there is only one.
 * Two or more is the method set above the list (`methodBefore`), and that decides for itself.
 */
function headnoteBefore(lines: Line[], titleAt: number, block: Block): string | null {
  const prose = paragraphsBefore(lines, titleAt, block).filter(
    (paragraph) => isProse(paragraph) && !leadsWithAmount(paragraph.split(' ').slice(0, 6).join(' ')),
  );
  return prose.length === 1 ? prose[0]! : null;
}

/** The capitals a run-in step head is set in: "MAKE THE SQUASH Preheat the oven". */
const RUN_IN_HEAD = /^(?:[\p{Lu}'’-]{2,20} ){1,5}(?=\p{Lu}\p{Ll})/u;

/**
 * The method, when it sits above the list: each paragraph of prose between the title and the
 * list, with a run-in head taken off it. The first is the headnote when there is more than one.
 * A paragraph is split again where a line ends a sentence and the next starts one, which is how
 * an indented paragraph reads once OCR has taken the indent away.
 */
function methodBefore(lines: Line[], titleAt: number, block: Block): string[] {
  const groups: Line[][] = [];
  for (let i = titleAt + 1; i < block.start; i++) {
    const line = lines[i]!;
    const previous = lines[i - 1]!;
    const starts =
      groups.length === 0 ||
      line.blankBefore ||
      (/[.!?]$/.test(previous.text) && /^\p{Lu}/u.test(line.text));
    if (starts) groups.push([line]);
    else groups[groups.length - 1]!.push(line);
  }
  const prose = groups.map(joinWrapped).filter((text) => /[.!?]$/.test(text) && words(text) >= 5);
  if (prose.length < 2) return [];
  return prose.map((text) => text.replace(RUN_IN_HEAD, ''));
}

/** The tips after the list, each with its lead kept: "Tip: If using canned beans...". */
function tipsIn(lines: Line[], from: number): string[] {
  const tips: string[] = [];
  for (let i = from; i < lines.length; i++) {
    if (!TIP_LEAD.test(lines[i]!.text)) continue;
    const group = [lines[i]!];
    for (let j = i + 1; j < lines.length && !lines[j]!.blankBefore && !isTrailer(lines[j]!.text); j++) {
      group.push(lines[j]!);
    }
    tips.push(joinWrapped(group).replace(/^[\p{L}'’]{0,12} ?tips?:/iu, 'Tip:'));
  }
  return tips;
}
