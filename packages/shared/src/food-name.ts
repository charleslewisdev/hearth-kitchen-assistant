/**
 * Produce a normalized key for deduping/matching Food entities.
 *
 * Deliberately SIMPLE: lowercase + trim + whitespace collapse, plus a small
 * set of light singularization rules applied to the final word. This is NOT
 * real lemmatization — full lemmatization (irregular plurals, POS awareness,
 * stemming) is a later phase. The goal here is only to fold obvious plurals
 * ("tomatoes" -> "tomato") so equivalent foods dedupe.
 */
export function normalizeFoodName(input: string): string {
  const cleaned = input.toLowerCase().trim().replace(/\s+/g, ' ');
  if (cleaned === '') return '';

  const words = cleaned.split(' ');
  const lastIndex = words.length - 1;
  const lastWord = words[lastIndex] ?? '';
  words[lastIndex] = singularizeWord(lastWord);
  return words.join(' ');
}

const IRREGULAR_PLURALS: Record<string, string> = {
  leaves: 'leaf',
  halves: 'half',
  loaves: 'loaf',
  chilies: 'chili',
  chillies: 'chilli',
};

/**
 * Light singularization of a single word. Order matters: the `-ies`/`-oes`/
 * `-es` cases must be checked before the plain trailing `-s` case so that
 * "tomatoes" -> "tomato" (not "tomatoe") and "berries" -> "berry".
 */
function singularizeWord(word: string): string {
  // Guard against over-stripping very short words ("gas", "is", "as").
  if (word.length <= 3) return word;

  // The irregular plurals recipes actually use, before the rules below turn "leaves" into
  // "leave" and "chilies" into "chily". Not a general -ves rule: "cloves" and "olives" are not.
  const irregular = IRREGULAR_PLURALS[word];
  if (irregular !== undefined) return irregular;

  // berries -> berry, parties -> party
  if (word.endsWith('ies')) return word.slice(0, -3) + 'y';

  // tomatoes -> tomato, potatoes -> potato
  if (word.endsWith('oes')) return word.slice(0, -2);

  // dishes -> dish, boxes -> box, glasses -> glass
  if (/(ch|sh|s|x|z)es$/.test(word)) return word.slice(0, -2);

  // Leave "ss" words alone ("glass", "grass") — dropping -s would mangle them.
  if (word.endsWith('ss')) return word;

  // eggs -> egg, onions -> onion
  if (word.endsWith('s')) return word.slice(0, -1);

  return word;
}
