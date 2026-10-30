/**
 * Tag suggestions for a recipe, from the household's own tags and what an import found.
 *
 * The rule that shapes it: a tag is only filled in for the cook when the household ALREADY uses
 * it. A site's keywords are SEO ("baked pork tenderloin recipe", "palakura chicken"), and
 * copying them in made a new tag per import, so they are only ever offered, one tap each, after
 * a filter drops the obvious junk. That keeps the tag list the household's vocabulary rather
 * than every site's.
 *
 *  - `chosen`: existing tags named in the title, or matching one of the site's keywords or its
 *    cuisine ("Italian" on a page that says Italian).
 *  - `offered`: existing tags an ingredient names ("Pork" for "2 lb pork loin"), then the site's
 *    keywords that pass the filter, as new tags.
 *
 * Matching is by words, not substrings, with a light plural fold: tag "Chicken" matches
 * "Chicken Thighs" and "chickens" but not "Chickpea". Tokenizing is one split on a character
 * class, linear in the input, and every input is capped before it is read.
 */

/** Past this many characters a field is not read further. A title or keyword is far shorter. */
const MAX_FIELD = 500;
/** A site keyword longer than this many words is a sentence, not a tag. */
const MAX_KEYWORD_WORDS = 3;

function fold(word: string): string {
  const lower = word.toLowerCase();
  if (lower.length > 3 && lower.endsWith('ies')) return `${lower.slice(0, -3)}y`;
  if (lower.length > 3 && lower.endsWith('es') && /(?:ch|sh|x|o)es$/.test(lower)) {
    return lower.slice(0, -2);
  }
  if (lower.length > 3 && lower.endsWith('s') && !lower.endsWith('ss')) return lower.slice(0, -1);
  return lower;
}

/** A field as folded words. `&` stays a word so "Quick & easy" keeps its shape. */
export function tagWords(text: string): string[] {
  return text
    .slice(0, MAX_FIELD)
    .split(/[^\p{L}\p{N}&]+/u)
    .filter((w) => w !== '')
    .map(fold);
}

/** Whether `needle` occurs in `hay` as consecutive words. */
function containsPhrase(hay: string[], needle: string[]): boolean {
  if (needle.length === 0 || needle.length > hay.length) return false;
  outer: for (let i = 0; i + needle.length <= hay.length; i++) {
    for (let j = 0; j < needle.length; j++) if (hay[i + j] !== needle[j]) continue outer;
    return true;
  }
  return false;
}

/** A site keyword worth offering as a new tag, or not. */
function usefulKeyword(keyword: string, titleWords: ReadonlySet<string>): boolean {
  const words = tagWords(keyword);
  if (words.length === 0 || words.length > MAX_KEYWORD_WORDS) return false;
  if (words.some((w) => w === 'recipe')) return false;
  // Every word already in the title: the site restating the name ("chicken saag").
  if (words.every((w) => titleWords.has(w))) return false;
  return true;
}

export interface TagSuggestionInput {
  title: string;
  ingredientLines: readonly string[];
  /** The keywords and cuisine a page carried; empty for a photo, PDF or paste. */
  siteTags: readonly string[];
}

export interface TagSuggestions {
  chosen: string[];
  offered: string[];
}

export function suggestTags(
  input: TagSuggestionInput,
  existing: readonly string[],
): TagSuggestions {
  const title = tagWords(input.title);
  const titleSet = new Set(title);
  const siteWords = input.siteTags.slice(0, 50).map(tagWords);
  const ingredientWords = input.ingredientLines.slice(0, 200).map(tagWords);

  const chosen: string[] = [];
  const offered: string[] = [];
  const taken = new Set<string>();
  const add = (list: string[], name: string) => {
    const key = tagWords(name).join(' ');
    if (key === '' || taken.has(key)) return;
    taken.add(key);
    list.push(name);
  };

  for (const tag of existing) {
    const words = tagWords(tag);
    if (words.length === 0) continue;
    const inTitle = containsPhrase(title, words);
    const inSite = siteWords.some((site) => site.join(' ') === words.join(' '));
    if (inTitle || inSite) add(chosen, tag);
  }
  for (const tag of existing) {
    const words = tagWords(tag);
    if (ingredientWords.some((line) => containsPhrase(line, words))) add(offered, tag);
  }
  for (const keyword of input.siteTags.slice(0, 50)) {
    if (usefulKeyword(keyword, titleSet)) add(offered, keyword.trim());
  }
  return { chosen, offered };
}
