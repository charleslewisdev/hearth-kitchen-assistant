import * as cheerio from 'cheerio';
import { emptyDraft, field, MEAL_TYPES } from './draft';
import type { RecipeDetails } from './draft';
import { durationMinutes } from './duration';
import type { MealType, RecipeDraft } from './draft';
import { draftFromText } from './from-text';

/**
 * Turning a fetched page into a draft, deterministically.
 *
 * schema.org JSON-LD first, because a recipe site that wants a rich card in search results
 * publishes one and keeps it accurate; microdata second, because that is what an older blog or
 * a WordPress theme from the recipe-card era emits; the paste heuristics over the article text
 * third, when neither is present.
 *
 * Confidence is `high` only for what the structured data actually stated. Anything derived -
 * a meal type inferred from a category word, a step list split out of one blob, a title taken
 * from the page's `<title>` - is `low`, which is what puts it in front of the cook on the
 * review screen.
 *
 * D38: nothing here logs. A recipe title, an ingredient line and a source URL are all user
 * content, and this is the most tempting place in the codebase to debug by printing what was
 * just parsed.
 */

/** Servings above this are not a serving count. Real recipes top out well below it. */
const MAX_SERVINGS = 999;

type JsonValue = string | number | boolean | null | JsonValue[] | { [key: string]: JsonValue };

/** Whatever the value is, as a list: JSON-LD uses a bare value and a one-element array freely. */
function asArray(value: JsonValue | undefined): JsonValue[] {
  if (value === undefined || value === null) return [];
  return Array.isArray(value) ? value : [value];
}

/**
 * A JSON-LD string as readable text.
 *
 * Sites put markup and HTML entities inside JSON-LD strings routinely - RecipeTin Eats writes
 * `1/5&quot;` inside an instruction - so the value has to be run through an HTML parser rather
 * than used as-is. That also strips the `<p>` and `<a>` some sites wrap instructions in.
 */
function text(value: JsonValue | undefined): string {
  if (typeof value === 'number') return String(value);
  if (typeof value !== 'string') return '';
  const decoded = value.includes('<') || value.includes('&') ? cheerio.load(value).text() : value;
  return decoded.replace(/\s+/g, ' ').trim();
}

/** How deep `flattenNodes` follows arrays and `@graph`. Real pages nest two or three levels. */
const MAX_JSON_LD_DEPTH = 32;

/**
 * Every node in a JSON-LD document, flattened out of `@graph` and nested arrays.
 *
 * Bounded in depth: `JSON.parse` accepts nesting far past the call stack, and a page of `[[[...`
 * otherwise threw a RangeError that surfaced as a 500 rather than "no recipe here".
 */
function flattenNodes(parsed: JsonValue, out: Record<string, JsonValue>[] = [], depth = 0) {
  if (depth > MAX_JSON_LD_DEPTH) return out;
  if (Array.isArray(parsed)) {
    for (const entry of parsed) flattenNodes(entry, out, depth + 1);
    return out;
  }
  if (parsed === null || typeof parsed !== 'object') return out;
  const node = parsed as Record<string, JsonValue>;
  out.push(node);
  if (node['@graph']) flattenNodes(node['@graph'], out, depth + 1);
  return out;
}

/**
 * Whether a node claims to be a Recipe.
 *
 * `@type` is compared with any `schema.org/` prefix stripped, because an older self-hosted blog
 * writes `http://schema.org/Recipe` in full - and those blogs are exactly what the microdata
 * path further down exists to serve, so refusing the spelling defeated the point of having it.
 */
function isRecipeNode(node: Record<string, JsonValue>): boolean {
  return asArray(node['@type']).some(
    (t) => typeof t === 'string' && t.replace(/^https?:\/\/schema\.org\//, '') === 'Recipe',
  );
}

/**
 * How much recipe a node actually carries.
 *
 * Used to choose BETWEEN candidates, because a page can hold several genuine `Recipe` nodes and
 * the first is regularly the wrong one: a "you might also like" sidebar card sits in the
 * `@graph` ahead of the real recipe, with a name and a single ingredient reading "see post".
 * Taking the first imported the teaser; scoring by how much is on the node takes the recipe.
 */
function recipeWeight(node: Record<string, JsonValue>): number {
  const ingredients = asArray(node['recipeIngredient'] ?? node['ingredients']).length;
  const instructions = asArray(node['recipeInstructions']).length;
  return ingredients + instructions;
}

/**
 * The most substantial `Recipe` node across all of the page's JSON-LD blocks, or `null`.
 *
 * Every block is read before choosing, rather than returning at the first hit, so a stub in one
 * script does not hide a real recipe in the next.
 */
function findRecipeNode($: cheerio.CheerioAPI): Record<string, JsonValue> | null {
  const candidates: Record<string, JsonValue>[] = [];
  for (const element of $('script[type="application/ld+json"]').toArray()) {
    let parsed: JsonValue;
    try {
      parsed = JSON.parse($(element).text()) as JsonValue;
    } catch {
      // A block that does not parse is not a reason to abandon the page: sites emit several,
      // and a broken analytics one should not cost the cook the recipe in the next one.
      continue;
    }
    candidates.push(...flattenNodes(parsed).filter(isRecipeNode));
  }
  if (candidates.length === 0) return null;

  // `reduce` rather than a sort, so ties keep the earlier node: where two are equally
  // substantial the one the page listed first is the one it means.
  return candidates.reduce((best, node) => (recipeWeight(node) > recipeWeight(best) ? node : best));
}

/* ------------------------------------------------------------------- fields */

/**
 * A serving count out of whatever `recipeYield` turned out to be.
 *
 * From the fixtures, so from real sites: `["5"]` (Budget Bytes), `["4","4 (Large bowls)"]`
 * (Minimalist Baker), `["16 servings", ...]` (King Arthur) and `"1 loaf, 10 serving(s)"`
 * (Food.com) - where the FIRST number is the loaf and the second is the answer. A bare number
 * (`6`) is handled too and is covered by a test, though no fixture happens to emit one. So a bare number wins over prose, and "N servings" wins over "the first
 * number in the string", which is only taken as a last resort and is flagged when it is.
 */
function readServings(raw: JsonValue | undefined): {
  value: number;
  confidence: 'high' | 'low';
  raw: string | null;
} {
  const candidates = asArray(raw)
    .map((entry) => text(entry))
    .filter((entry) => entry !== '');
  if (candidates.length === 0) return { value: 1, confidence: 'low', raw: null };

  const rawText = candidates.join(', ');
  const sane = (n: number): boolean => Number.isInteger(n) && n >= 1 && n <= MAX_SERVINGS;

  for (const candidate of candidates) {
    if (/^\d+$/.test(candidate) && sane(Number(candidate))) {
      return { value: Number(candidate), confidence: 'high', raw: rawText };
    }
  }
  for (const candidate of candidates) {
    // `(?<!\d)` keeps this linear: without it every digit of a long run starts a fresh attempt.
    const named = candidate.match(/(?<!\d)(\d+)\s*(?:serving|portion|people|serves)/i);
    if (named && sane(Number(named[1]))) {
      return { value: Number(named[1]), confidence: 'high', raw: rawText };
    }
  }
  for (const candidate of candidates) {
    const first = candidate.match(/\d+/);
    if (first && sane(Number(first[0]))) {
      // A number, but not one the page called a serving count: "24 cookies" is a yield.
      return { value: Number(first[0]), confidence: 'low', raw: rawText };
    }
  }
  return { value: 1, confidence: 'low', raw: rawText };
}

/** Split one blob of instructions into steps. Only reached when the site gave a single string. */
function splitInstructionBlob(blob: string): string[] {
  const byLine = blob
    .split(/\r?\n+/)
    .map((line) => line.trim())
    .filter((line) => line !== '');
  if (byLine.length > 1) return byLine;

  // One line, so look for the numbering a site uses when it writes steps as running prose.
  const byNumber = blob
    .split(/(?:^|\s)\d+[.)]\s+/)
    .map((part) => part.trim())
    .filter((part) => part !== '');
  return byNumber.length > 1 ? byNumber : byLine;
}

/**
 * `recipeInstructions` as a list of steps, and whether the shape was given or inferred.
 *
 * Handles the shapes real sites emit: plain strings (King Arthur), `HowToStep` objects
 * (Budget Bytes, Food.com, RecipeTin Eats), `HowToSection` wrappers holding their own steps,
 * and a single blob that has to be split.
 */
function readSteps(raw: JsonValue | undefined): { value: string[]; confidence: 'high' | 'low' } {
  if (typeof raw === 'string') {
    const blob = text(raw);
    // `text()` collapses newlines, so split the original and clean each piece.
    const parts = splitInstructionBlob(raw)
      .map((part) => text(part))
      .filter((p) => p !== '');
    return { value: parts.length > 0 ? parts : blob === '' ? [] : [blob], confidence: 'low' };
  }

  const steps: string[] = [];
  const walk = (entries: JsonValue[]): void => {
    for (const entry of entries) {
      if (typeof entry === 'string') {
        const line = text(entry);
        if (line !== '') steps.push(line);
        continue;
      }
      if (entry === null || typeof entry !== 'object' || Array.isArray(entry)) continue;
      const node = entry as Record<string, JsonValue>;
      // A section holds its own steps; flatten it rather than losing them or keeping its name.
      if (node['itemListElement']) {
        walk(asArray(node['itemListElement']));
        continue;
      }
      // `||`, not `??`: a `HowToStep` with an empty `text` and a real `name` is a step, and
      // nullish coalescing would take the empty string and drop it.
      const line = text(node['text']) || text(node['name']);
      if (line !== '') steps.push(line);
    }
  };
  walk(asArray(raw));
  return { value: steps, confidence: 'high' };
}

/** Ingredient lines exactly as the site wrote them, so `parseIngredientLine` sees the original. */
function readIngredients(raw: JsonValue | undefined): string[] {
  return asArray(raw)
    .map((entry) => text(entry))
    .filter((entry) => entry !== '');
}

/** Lowercase and strip diacritics, so "Entrée" and "entree" are the same word. */
function fold(value: string): string {
  return value.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().trim();
}

/**
 * A site's own category words mapped onto Hearth's meal types.
 *
 * `recipeCategory` only, deliberately, not `keywords`. Keywords are a marketing field - Budget
 * Bytes files this one under "Baked Chicken, Easy Dinner, Weeknight Dinner" - and folding them
 * in makes `raw` a list the cook cannot match against what they see on the page. The category
 * is the field a site actually files a recipe under; the keywords become tags instead.
 *
 * Always low confidence: "Main Course" is a fair guess at dinner and it is still a guess, and
 * the whole point of the review screen is that correcting a guess is cheap.
 */
function readMealTypes(...raws: (JsonValue | undefined)[]): {
  value: MealType[];
  raw: string | null;
} {
  const words = raws
    .flatMap((raw) => asArray(raw).map((entry) => text(entry)))
    .filter((w) => w !== '');
  if (words.length === 0) return { value: [], raw: null };

  const found = new Set<MealType>();
  for (const word of words.map(fold)) {
    // As a word (with an optional plural), not as a substring: "Dinnerware" is not dinner.
    // The rules below already matched on word boundaries; this one was the loose one.
    for (const mealType of MEAL_TYPES) {
      if (new RegExp(`\\b${mealType}s?\\b`).test(word)) found.add(mealType);
    }
    if (/\b(main|entree|supper)\b/.test(word)) found.add('dinner');
    if (/\bbrunch\b/.test(word)) found.add('breakfast');
    if (/\b(appetizer|starter)\b/.test(word)) found.add('snack');
    if (/\b(sweet|cake|cookie|pudding)\b/.test(word)) found.add('dessert');
    if (/\b(beverage|cocktail|smoothie)s?\b/.test(word)) found.add('drink');
    if (/\b(condiment|dressing|marinade|gravy|gravies|salsa)s?\b/.test(word)) found.add('sauce');
    if (/\b(basic|stock|broth)s?\b/.test(word)) found.add('base');
  }
  // Emitted in MEAL_TYPES order rather than discovery order, so the result does not depend on
  // which of `recipeCategory` and `keywords` a site happened to list first.
  return { value: MEAL_TYPES.filter((m) => found.has(m)), raw: words.join(', ') };
}

/**
 * Keywords and cuisines as tags.
 *
 * Split on commas AND on the double semicolon King Arthur uses, because a keyword string is a
 * free-text field and every site punctuates it differently.
 */
function readTags(...raws: (JsonValue | undefined)[]): { value: string[]; raw: string | null } {
  const parts = raws
    .flatMap((raw) => asArray(raw).map((entry) => text(entry)))
    .flatMap((entry) => entry.split(/;;|[,;]/))
    .map((entry) => entry.trim())
    .filter((entry) => entry !== '');
  if (parts.length === 0) return { value: [], raw: null };
  // Deduped case-insensitively, keeping the site's own capitalisation for the survivor.
  const seen = new Map<string, string>();
  for (const part of parts) if (!seen.has(fold(part))) seen.set(fold(part), part);
  return { value: [...seen.values()], raw: parts.join(', ') };
}

/** The page's own `<title>`, with the site name after a separator trimmed off. */
function pageTitle($: cheerio.CheerioAPI): string {
  // Whitespace is collapsed before splitting: `\s+` on both sides of the separator is
  // quadratic over a long run of spaces with no separator in it.
  const raw = $('title').first().text().replace(/\s+/g, ' ').trim();
  return raw.split(/ [|–—] /)[0]?.trim() ?? '';
}

/* -------------------------------------------------------------- article text */

/**
 * The readable text of a page, with its line structure kept.
 *
 * `cheerio`'s `.text()` concatenates every text node with nothing between them, so an
 * ingredient `<ul>` comes back as "3 leeks2 Tbsp butter500 g potatoes" - one line, in which the
 * heuristics can see no list at all. Every block-level element therefore gets a newline
 * appended before the text is taken, and a `<td>` gets a space so the cells of one row join
 * into one line rather than three.
 *
 * It works over its OWN parse of the html rather than the caller's, because it removes half the
 * document to do its job. `draftFromHtml` is only paying for the second parse on the path where
 * there was no structured data to find.
 *
 * Scoped to `<article>`, then `<main>`, then the body: a recipe blog puts three more amounts in
 * the sidebar under "more from the blog", and unscoped they land in the draft.
 */
function articleText(html: string): string {
  const $ = cheerio.load(html);
  $('script, style, noscript, template, nav, header, footer, aside, form, iframe, svg').remove();
  $('br').replaceWith('\n');
  $('td, th').each((_, el) => {
    $(el).append(' ');
  });
  $('p, div, li, tr, h1, h2, h3, h4, h5, h6, section, article, blockquote, dt, dd, pre').each(
    (_, el) => {
      $(el).append('\n');
    },
  );

  for (const selector of ['article', 'main', 'body']) {
    const scope = $(selector).first();
    if (scope.length > 0) return scope.text();
  }
  return $.root().text();
}

/* ---------------------------------------------------------------- microdata */

/** The same fields again, read out of `itemprop` attributes instead of JSON-LD. */
function recipeFromMicrodata($: cheerio.CheerioAPI): Record<string, JsonValue> | null {
  const scope = $('[itemscope][itemtype*="schema.org/Recipe" i]').first();
  if (scope.length === 0) return null;

  const values = (prop: string): string[] =>
    scope
      .find(`[itemprop="${prop}"]`)
      .toArray()
      .map((el) => {
        const node = $(el);
        // `<meta itemprop=... content=...>` carries its value in an attribute, not as text.
        return (node.attr('content') ?? node.text()).replace(/\s+/g, ' ').trim();
      })
      .filter((value) => value !== '');

  const first = (prop: string): string | undefined => values(prop)[0];

  const node: Record<string, JsonValue> = { '@type': 'Recipe' };
  const name = first('name');
  if (name !== undefined) node['name'] = name;
  const yieldValue = first('recipeYield');
  if (yieldValue !== undefined) node['recipeYield'] = yieldValue;
  node['recipeIngredient'] = [...values('recipeIngredient'), ...values('ingredients')];

  // A SINGLE instruction element is handed over as a string rather than as a one-element array,
  // so `readSteps` treats it the way it treats a single JSON-LD string: split it, and mark the
  // result `low` because the split is inference. Real microdata pages put the whole method in
  // one `<div itemprop="recipeInstructions">`, and wrapping that in an array made it come back
  // as one unsplit paragraph asserted at `high` - which is exactly the thing the review screen
  // exists to flag. Several elements are several steps, and stay `high`.
  const instructions = values('recipeInstructions');
  node['recipeInstructions'] = instructions.length === 1 ? (instructions[0] ?? '') : instructions;
  node['recipeCategory'] = values('recipeCategory');
  node['recipeCuisine'] = values('recipeCuisine');
  node['keywords'] = values('keywords');
  for (const prop of ['prepTime', 'cookTime', 'totalTime', 'description']) {
    const value = first(prop);
    if (value !== undefined) node[prop] = value;
  }
  return node;
}

/** The longest headnote kept, matching what `recipe.create` accepts for a description. */
const MAX_DESCRIPTION = 5000;

/**
 * The headnote and the times, when the page states them. Cook time falls back to total minus
 * prep, since many sites state only those two; a total with no prep says nothing about either.
 */
function readDetails(node: Record<string, JsonValue>): RecipeDetails {
  const description = text(node['description']).slice(0, MAX_DESCRIPTION);
  const prep = durationMinutes(firstValue(node['prepTime']));
  let cook = durationMinutes(firstValue(node['cookTime']));
  const total = durationMinutes(firstValue(node['totalTime']));
  if (cook === null && prep !== null && total !== null && total > prep) cook = total - prep;
  return {
    description: description === '' ? null : description,
    prepMinutes: prep,
    cookMinutes: cook,
  };
}

/** A property that a page may state as one value or as a list of them. */
function firstValue(value: JsonValue | undefined): JsonValue | undefined {
  return Array.isArray(value) ? value[0] : value;
}

/* ------------------------------------------------------------------- public */

/**
 * The structured half of a page, as a draft, or `null` when the page states no recipe.
 *
 * Split out from `draftFromHtml` so the third rung below reads as a fall-through rather than as
 * a branch buried inside the same function.
 */
function draftFromStructuredData($: cheerio.CheerioAPI, url: string): RecipeDraft | null {
  // Both sources are considered, and a node with a name and nothing else does not win. A stub
  // is a "recipe" card on a category page or a partial graph, and preferring it over real
  // microdata below told the cook a page with a recipe on it had none.
  const fromJsonLd = findRecipeNode($);
  const node =
    fromJsonLd && recipeWeight(fromJsonLd) > 0
      ? fromJsonLd
      : (recipeFromMicrodata($) ?? fromJsonLd);
  if (!node) return null;

  const ingredientLines = readIngredients(node['recipeIngredient'] ?? node['ingredients']);
  const steps = readSteps(node['recipeInstructions']);

  // Nothing but a title, from either source. Importing it would hand the cook an empty draft,
  // and the heuristics below get a turn at the page instead.
  if (ingredientLines.length === 0 && steps.value.length === 0) return null;

  const draft = emptyDraft({ kind: 'url', url });

  const name = text(node['name']);
  const fallbackTitle = pageTitle($);
  draft.title =
    name !== ''
      ? field(name, 'high', name)
      : field(fallbackTitle, 'low', fallbackTitle === '' ? null : fallbackTitle);

  const servings = readServings(node['recipeYield']);
  draft.servings = field(servings.value, servings.confidence, servings.raw);

  draft.ingredientLines = field(ingredientLines, 'high', null);
  draft.steps = field(steps.value, steps.confidence, null);

  const mealTypes = readMealTypes(node['recipeCategory']);
  draft.mealTypes = field(mealTypes.value, 'low', mealTypes.raw);

  const tags = readTags(node['keywords'], node['recipeCuisine']);
  draft.tags = field(tags.value, 'low', tags.raw);

  draft.details = readDetails(node);

  return draft;
}

/**
 * A draft from a fetched page, or `null` when the page has no recipe on it.
 *
 * Three rungs, each falling into the next: JSON-LD, then microdata, then the paste heuristics
 * over the article text. The third rung is what a self-hosted blog from before the rich-card
 * era needs, and it is `draftFromText` - the same implementation the Text, PDF and Photo
 * sources reach, so there is one set of heuristics in this package arrived at four ways.
 *
 * `null` rather than an empty draft: "this is an article about pepper, not a recipe" is an
 * ordinary thing for a cook to paste, and it deserves a plain sentence rather than a review
 * screen full of blank flagged fields.
 */
export function draftFromHtml(html: string, url: string): RecipeDraft | null {
  const $ = cheerio.load(html);

  const stated = draftFromStructuredData($, url);
  if (stated) return stated;

  const inferred = draftFromText(articleText(html), { kind: 'url', url });
  // The page's own `<title>` first, and the line above the ingredients only when there is none.
  // That line is the heuristic's best guess for a paste, where nothing else names the recipe;
  // on a page it is whatever the blog put between the headline and the list. On Smitten Kitchen
  // that is "One year ago: Vidalia Onion Soup with Wild Rice", which became the title of a Greek
  // salad in the first real import test.
  if (inferred) {
    const stated = pageTitle($);
    if (stated !== '') inferred.title = field(stated, 'low', stated);
  }
  return inferred;
}
