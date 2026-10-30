/**
 * The word lists `parseIngredientLine` uses to take a food's name apart from how the recipe
 * describes it. Lookups, not patterns: every list here is explicit, so what the parser strips
 * is something a test names.
 *
 * Foods are deduped by name, so "large cloves garlic", "medium garlic cloves" and "garlic
 * cloves" were three Foods and the shopping list could not add them up. The rule (decided with
 * the household that piloted it): a word that says how big, how fresh or how prepared the food
 * is moves to the ingredient's note, and a word that changes what you buy stays in the name.
 * "freshly ground black pepper" is black pepper; "ground cumin" is not cumin.
 */

/**
 * Words that describe the food without changing what you buy. Deliberately absent, because they
 * do change it: dried, ground, smoked, frozen, crushed, salted, unsalted, whole, heavy, sour,
 * brown, dark, light, sweet, hot, the colours, extra-virgin, low-sodium, toasted, roasted,
 * shredded, firm, raw, lean, organic, flaky, full-fat.
 */
const DESCRIPTORS = new Set([
  // size
  'large',
  'small',
  'medium',
  'medium-large',
  'medium-small',
  'small-medium',
  'medium-sized',
  'large-sized',
  'small-sized',
  'extra-large',
  'extra-small',
  'jumbo',
  'baby',
  'big',
  // freshness
  'fresh',
  'ripe',
  'day-old',
  // preparation
  'chopped',
  'diced',
  'minced',
  'sliced',
  'grated',
  'crumbled',
  'torn',
  'peeled',
  'halved',
  'quartered',
  'cubed',
  'trimmed',
  'rinsed',
  'drained',
  'beaten',
  'sifted',
  'mashed',
  'julienned',
  'thin',
  'thick',
  'packed',
  'softened',
  'melted',
  // temperature
  'room-temperature',
  'boiling',
  'warm',
  'lukewarm',
  'cold',
  'ice-cold',
  'chilled',
  // how the measure was filled
  'heaping',
  'heaped',
  'level',
  'scant',
  'generous',
  // the one-word spellings of the adverb phrases below
  'finely-chopped',
  'roughly-chopped',
  'coarsely-chopped',
  'freshly-ground',
  'freshly-grated',
  'freshly-squeezed',
  'thinly-sliced',
]);

/** Two-word descriptors, written without the hyphen. */
const DESCRIPTOR_PAIRS = new Set([
  'extra large',
  'extra small',
  'ice cold',
  'room temperature',
  'day old',
]);

/**
 * A descriptor that starts a food's own name, which stays whole: baby back ribs are not back
 * ribs, and cold brew is not brew.
 */
const NAME_PAIRS = new Set(['baby back', 'baby bella', 'baby corn', 'cold brew']);

/** Adverbs, stripped only together with the preparation word after them. */
const ADVERBS = new Set([
  'finely',
  'roughly',
  'coarsely',
  'thinly',
  'thickly',
  'freshly',
  'lightly',
  'firmly',
  'loosely',
  'very',
  'well',
  'newly',
]);

/**
 * Preparation words that are a buying word on their own and a description after an adverb:
 * "ground cumin" is a jar, "freshly ground black pepper" is black pepper and a grinder.
 */
const AFTER_ADVERB = new Set(['ground', 'cracked', 'squeezed', 'toasted', 'crushed']);

/**
 * Words that describe water and nothing else. "hot" is a buying word for sauce and peppers, and
 * "tap" is not an adjective at all, so they are stripped only when all that follows is water.
 */
const WATER_WORDS = new Set(['hot', 'tap', 'filtered', 'lukewarm', 'boiling', 'warm', 'cold']);

/** How many leading descriptors one line gives up. Real lines carry three at most. */
const MAX_DESCRIPTORS = 8;

function waterFollows(words: string[], from: number): boolean {
  const last = words.length - 1;
  if ((words[last] ?? '').toLowerCase() !== 'water') return false;
  for (let i = from; i < last; i++) {
    if (!WATER_WORDS.has((words[i] ?? '').toLowerCase())) return false;
  }
  return true;
}

/**
 * Split the descriptors off the front of a food: `finely chopped fresh parsley` gives
 * `finely chopped fresh` and `parsley`. The last word is never taken, so a line that is nothing
 * but descriptors ("2 large") keeps them as its food rather than ending up with none.
 */
export function splitLeadingDescriptors(text: string): { descriptors: string; rest: string } {
  const words = text.split(' ');
  const last = words.length - 1;
  let i = 0;
  for (let taken = 0; taken < MAX_DESCRIPTORS && i < last; taken++) {
    const word = (words[i] ?? '').toLowerCase();
    const next = (words[i + 1] ?? '').toLowerCase();
    const pair = `${word} ${next}`;
    if (NAME_PAIRS.has(pair)) break;
    if (DESCRIPTOR_PAIRS.has(pair) && i + 1 < last) {
      i += 2;
    } else if (DESCRIPTORS.has(word)) {
      i += 1;
    } else if (
      ADVERBS.has(word) &&
      (DESCRIPTORS.has(next) || AFTER_ADVERB.has(next)) &&
      i + 1 < last
    ) {
      i += 2;
    } else if (WATER_WORDS.has(word) && waterFollows(words, i + 1)) {
      i += 1;
    } else {
      break;
    }
  }
  return { descriptors: words.slice(0, i).join(' '), rest: words.slice(i).join(' ') };
}

const NUMBER_WORDS: Record<string, number> = {
  a: 1,
  an: 1,
  one: 1,
  two: 2,
  three: 3,
  four: 4,
  five: 5,
  six: 6,
  seven: 7,
  eight: 8,
  nine: 9,
  ten: 10,
  eleven: 11,
  twelve: 12,
};

/** After "a", these make it a vague amount rather than one of something: "a few sprigs". */
const VAGUE_AFTER_A = new Set(['few', 'couple', 'little', 'bit', 'lot', 'dozen', 'good']);

function isAAn(word: string): boolean {
  return word === 'a' || word === 'an';
}

/**
 * An amount written in words at the very start of a line: `a`, `an`, `one`..`twelve`, `half`,
 * `a half`, `half a`, `one and a half`, `one-and-a-half`. Returns the amount and how many words
 * it took, or null. A line of nothing but the amount ("One") is not one: there is no food.
 */
export function leadingAmountWords(words: string[]): { quantity: number; taken: number } | null {
  const [w0 = '', w1 = '', w2 = '', w3 = ''] = words.slice(0, 4).map((w) => w.toLowerCase());
  let quantity: number;
  let taken: number;

  const parts = w0.split('-', 5);
  const whole = NUMBER_WORDS[parts[0] ?? ''];
  if (
    parts.length === 4 &&
    whole !== undefined &&
    !isAAn(parts[0] ?? '') &&
    parts[1] === 'and' &&
    parts[2] === 'a' &&
    parts[3] === 'half'
  ) {
    quantity = whole + 0.5;
    taken = 1;
  } else if (w0 === 'half') {
    if (w1 === 'and') return null; // "half and half" is a food
    quantity = 0.5;
    taken = isAAn(w1) ? 2 : 1;
  } else if (NUMBER_WORDS[w0] !== undefined) {
    quantity = NUMBER_WORDS[w0];
    taken = 1;
    if (isAAn(w0)) {
      if (VAGUE_AFTER_A.has(w1)) return null;
      if (w1 === 'half') {
        quantity = 0.5;
        taken = 2;
      }
    } else if (w1 === 'and' && w2 === 'a' && w3 === 'half') {
      quantity += 0.5;
      taken = 4;
    }
  } else {
    return null;
  }
  return words.length > taken ? { quantity, taken } : null;
}

/** Units that a line may lead with and no amount, meaning one: "Pinch crushed red pepper flakes". */
export const ONE_WITHOUT_AMOUNT = new Set(['pinch', 'dash', 'handful']);

/**
 * Units that hold something, after which the words describe what is inside as it is sold:
 * "1 can diced tomatoes" is a can of diced tomatoes, not a can of tomatoes to dice.
 */
export const CONTAINER_UNITS = new Set(['can', 'jar', 'package', 'box', 'bag', 'bottle', 'packet']);

/** Units a size in front of the unit may be measured in: "14-ounce", "1-pound", "6-inch". */
export const SIZE_UNITS = new Set(['oz', 'lb', 'g', 'kg', 'ml', 'l']);
export const LENGTH_WORDS = new Set(['inch', 'inches', 'cm']);
