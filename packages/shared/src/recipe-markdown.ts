import { RECIPE_TYPES, type RecipeType } from './recipe-types';
import { slugify } from './slug';

/**
 * A recipe as a Markdown file, for export and for importing it back (D52).
 *
 * Front matter carries the fields a person would not want to hunt for in prose (title, servings,
 * times, types, tags, rating, source), and the body carries the recipe as anyone would write it:
 * `## Ingredients` as a list, `## Method` as a numbered list, `## Notes` as text. Human-readable
 * first, and deterministic: `parseRecipeMarkdown(recipeToMarkdown(r))` is `r` again.
 *
 * Every front-matter value is written as JSON (a quoted string, an integer, or a flow list of
 * strings), which is valid YAML too, so any YAML tool reads the file and this module needs no
 * YAML library. Reading is more forgiving, for a file somebody wrote or edited by hand: bare and
 * single-quoted strings, `[a, b]` and block lists are all accepted.
 *
 * Ingredient lines are the line as the cook wrote it, with a linked recipe as the editor's own
 * `[[Title]]` token, so the second measure in "3 cups (360g) flour" and the link both come back
 * when the line is saved and parsed again.
 *
 * Everything here is read from untrusted text. It is line by line, with no regex that can
 * backtrack across a line, and the front matter is capped (`MAX_FRONT_MATTER`).
 */

/** The fields a Markdown recipe carries: what `recipe.create` takes, plus the rating. */
export interface MarkdownRecipe {
  title: string;
  servings: number;
  prepMinutes: number | null;
  cookMinutes: number | null;
  types: RecipeType[];
  tags: string[];
  rating: number | null;
  sourceName: string | null;
  sourceUrl: string | null;
  /** The recipe's notes, shown under its title in Hearth: the `## Notes` section. */
  description: string | null;
  /** Each line as written, with a linked recipe as a `[[Title]]` token. */
  ingredientLines: string[];
  steps: string[];
}

/** Written into every export, so a later format can tell an old file from a new one. */
export const MARKDOWN_FORMAT_VERSION = 1;

/** How much text may sit between the two `---` lines before it is not taken as front matter. */
const MAX_FRONT_MATTER = 50_000;

/** The same bound `recipe.update` puts on a time. */
const MAX_MINUTES = 10_000;

const quote = (value: string) => JSON.stringify(value);
const list = (values: readonly string[]) => `[${values.map(quote).join(', ')}]`;

/**
 * A numbered step. Lines after its first are indented under the marker, so Markdown keeps them
 * in the step; a blank line inside it stays empty, with no trailing spaces for an editor to strip.
 */
function stepLines(text: string, number: number): string[] {
  const marker = `${number}. `;
  const [first = '', ...rest] = text.split('\n');
  const indent = ' '.repeat(marker.length);
  return [marker + first, ...rest.map((line) => (line.trim() === '' ? '' : indent + line))];
}

/** The text with any run of newlines at its end made one. A loop: `/\n+$/` is quadratic. */
function endWithOneNewline(text: string): string {
  let end = text.length;
  while (end > 0 && text.charCodeAt(end - 1) === 10) end--;
  return text.slice(0, end) + '\n';
}

/** The recipe as a Markdown file, ending in a newline. */
export function recipeToMarkdown(recipe: MarkdownRecipe): string {
  const front = [
    '---',
    `hearth_format: ${MARKDOWN_FORMAT_VERSION}`,
    `title: ${quote(recipe.title)}`,
  ];
  front.push(`servings: ${recipe.servings}`);
  if (recipe.prepMinutes !== null) front.push(`prep_minutes: ${recipe.prepMinutes}`);
  if (recipe.cookMinutes !== null) front.push(`cook_minutes: ${recipe.cookMinutes}`);
  if (recipe.types.length > 0) front.push(`types: ${list(recipe.types)}`);
  if (recipe.tags.length > 0) front.push(`tags: ${list(recipe.tags)}`);
  if (recipe.rating !== null) front.push(`rating: ${recipe.rating}`);
  if (recipe.sourceName !== null) front.push(`source_name: ${quote(recipe.sourceName)}`);
  if (recipe.sourceUrl !== null) front.push(`source_url: ${quote(recipe.sourceUrl)}`);
  front.push('---');

  const body = [
    '',
    `# ${recipe.title.replace(/\s+/g, ' ').trim()}`,
    '',
    '## Ingredients',
    '',
    ...recipe.ingredientLines.map((line) => `- ${line}`),
    ...(recipe.ingredientLines.length > 0 ? [''] : []),
    '## Method',
    '',
    ...recipe.steps.flatMap((step, i) => stepLines(step, i + 1)),
    ...(recipe.steps.length > 0 ? [''] : []),
  ];
  // Notes last, so whatever they hold (a `##` line, a list) can only ever be read as notes.
  if (recipe.description !== null) body.push('## Notes', '', recipe.description, '');
  return endWithOneNewline([...front, ...body].join('\n'));
}

/** Text with Windows line ends and a byte-order mark taken out. */
function normalize(text: string): string {
  return (text.charCodeAt(0) === 0xfeff ? text.slice(1) : text).replace(/\r\n?/g, '\n');
}

/**
 * Where the front matter ends, or null when the text has none: the text must open with a `---`
 * line and close it with another within `MAX_FRONT_MATTER` characters. Whether what sits between
 * them is a recipe's front matter, rather than a paste that opens with a horizontal rule, is
 * decided in `readRecipeMarkdown` by its keys.
 */
function frontMatterEnd(text: string): number | null {
  if (!text.startsWith('---\n')) return null;
  const close = text.indexOf('\n---', 3);
  if (close === -1 || close > MAX_FRONT_MATTER) return null;
  const after = text.charAt(close + 4);
  return after === '\n' || after === '' ? close : null;
}

/** One YAML scalar as a string: JSON double quotes, single quotes, or bare. */
function scalar(raw: string): string {
  const value = raw.trim();
  if (value.length >= 2 && value.startsWith('"') && value.endsWith('"')) {
    try {
      const parsed: unknown = JSON.parse(value);
      if (typeof parsed === 'string') return parsed;
    } catch {
      // Not JSON after all: fall through and take the text between the quotes.
    }
    return value.slice(1, -1);
  }
  if (value.length >= 2 && value.startsWith("'") && value.endsWith("'")) {
    return value.slice(1, -1).replaceAll("''", "'");
  }
  return value;
}

/** A YAML flow list (`["a", "b"]` or `[a, b]`), or null when the value is not one. */
function flowList(raw: string): string[] | null {
  const value = raw.trim();
  if (!value.startsWith('[') || !value.endsWith(']')) return null;
  try {
    const parsed: unknown = JSON.parse(value);
    if (Array.isArray(parsed)) return parsed.filter((v): v is string => typeof v === 'string');
  } catch {
    // Bare items, which JSON does not allow: split them by hand.
  }
  const inner = value.slice(1, -1).trim();
  return inner === '' ? [] : inner.split(',').map(scalar);
}

/** The front matter as key to raw value, with a block list's items joined into a flow list. */
function readFrontMatter(block: string): Map<string, string | string[]> {
  const fields = new Map<string, string | string[]>();
  let listKey: string | null = null;
  for (const line of block.split('\n')) {
    const trimmed = line.trim();
    if (trimmed === '' || trimmed.startsWith('#')) continue;
    // "  - item" under a key with no value of its own.
    // "  - item" or "- item" under a key with no value of its own (YAML allows both).
    if (listKey !== null && (trimmed.startsWith('- ') || trimmed === '-')) {
      const items = fields.get(listKey);
      if (Array.isArray(items)) items.push(scalar(trimmed.slice(1)));
      continue;
    }
    listKey = null;
    const colon = line.indexOf(':');
    if (colon < 1 || colon > 40) continue;
    const key = line.slice(0, colon).trim().toLowerCase();
    const value = line.slice(colon + 1).trim();
    if (value === '') {
      fields.set(key, []);
      listKey = key;
    } else {
      fields.set(key, value);
    }
  }
  return fields;
}

function stringField(value: string | string[] | undefined): string | null {
  if (typeof value !== 'string') return null;
  const text = scalar(value).trim();
  return text === '' ? null : text;
}

function listField(value: string | string[] | undefined): string[] {
  const items = typeof value === 'string' ? flowList(value) : (value ?? null);
  return (items ?? []).map((item) => item.trim()).filter((item) => item !== '');
}

function integerField(
  value: string | string[] | undefined,
  min: number,
  max: number,
): number | null {
  if (typeof value !== 'string') return null;
  const text = scalar(value);
  if (!/^-?\d{1,9}$/.test(text)) return null;
  const n = Number(text);
  return n >= min && n <= max ? n : null;
}

/** The keys this format writes; front matter needs one of them to be read as a recipe's. */
const FRONT_MATTER_KEYS = [
  'hearth_format',
  'title',
  'servings',
  'prep_minutes',
  'cook_minutes',
  'types',
  'tags',
  'rating',
  'source_name',
  'source_url',
];

const RECIPE_TYPE_SET: ReadonlySet<string> = new Set(RECIPE_TYPES);

/** The section a `##` heading opens, by its name, or `other` for one this format does not use. */
type Section = 'ingredients' | 'method' | 'notes' | 'other';
const SECTION_NAMES: Record<string, Section> = {
  ingredients: 'ingredients',
  method: 'method',
  steps: 'method',
  directions: 'method',
  instructions: 'method',
  notes: 'notes',
};

/** "1. ", "12) " or a bare "3." at the start of a line: a numbered step's marker. */
const STEP_MARKER = /^\d{1,4}[.)](?: |$)/;
/** "- ", "* " or "+ " at the start of a line: a list item's marker. */
const BULLET_MARKER = /^[-*+](?: |$)/;

/** How many spaces a line starts with. */
function leadingSpaces(line: string): number {
  let n = 0;
  while (line.charCodeAt(n) === 32) n++;
  return n;
}

/** A Markdown recipe as read, with which of the fields that have a fallback the file stated. */
export interface ReadMarkdownRecipe {
  recipe: MarkdownRecipe;
  stated: { title: boolean; servings: boolean };
}

/**
 * Read a Markdown recipe, or null when the text has no front matter (plain text and Markdown
 * without it go through the ordinary text import instead). The title is the front matter's, or
 * the first `#` heading's, or empty; every other field falls back to what a typed recipe has.
 */
export function parseRecipeMarkdown(input: string): MarkdownRecipe | null {
  return readRecipeMarkdown(input)?.recipe ?? null;
}

/** `parseRecipeMarkdown`, also saying whether the title and servings were there or fallbacks. */
export function readRecipeMarkdown(input: string): ReadMarkdownRecipe | null {
  const text = normalize(input);
  const end = frontMatterEnd(text);
  if (end === null) return null;
  const fields = readFrontMatter(text.slice(4, end));
  // Two `---` lines with none of this format's keys between them are horizontal rules in a
  // paste, not front matter: that text belongs to the text importer.
  if (!FRONT_MATTER_KEYS.some((key) => fields.has(key))) return null;
  const bodyLines = text.slice(end + 4).split('\n');

  const ingredientLines: string[] = [];
  const steps: string[] = [];
  const intro: string[] = [];
  const notes: string[] = [];
  let heading: string | null = null;
  let section: Section | 'intro' = 'intro';
  const seen = new Set<Section>();
  // The step being read, how far its continuation lines are indented, and how many blank lines
  // have gone by since its last line: they are the step's only if an indented line follows.
  let step: { lines: string[]; indent: number; blanks: number } | null = null;
  const closeStep = () => {
    if (step) steps.push(step.lines.join('\n'));
    step = null;
  };

  for (const line of bodyLines) {
    // Once both lists have been read, notes run to the end: nothing in them is a heading.
    const notesToEnd = section === 'notes' && seen.has('ingredients') && seen.has('method');
    if (!notesToEnd && line.startsWith('## ')) {
      const named = SECTION_NAMES[line.slice(3).trim().toLowerCase()] ?? 'other';
      // Inside the notes, only a list section not read yet ends them.
      if (section !== 'notes' || (named !== 'other' && named !== 'notes' && !seen.has(named))) {
        closeStep();
        section = named;
        seen.add(named);
        if (named === 'other') notes.push(line);
        continue;
      }
    }
    if (section === 'intro') {
      if (heading === null && line.startsWith('# ')) heading = line.slice(2).trim();
      else intro.push(line);
    } else if (section === 'ingredients') {
      const marker = BULLET_MARKER.exec(line);
      const item = (marker ? line.slice(marker[0].length) : line).trim();
      if (item !== '') ingredientLines.push(item);
    } else if (section === 'method') {
      const marker = STEP_MARKER.exec(line) ?? BULLET_MARKER.exec(line);
      const current = step as { lines: string[]; indent: number; blanks: number } | null;
      const spaces = leadingSpaces(line);
      if (marker) {
        closeStep();
        step = { lines: [line.slice(marker[0].length)], indent: marker[0].length, blanks: 0 };
      } else if (line.trim() === '') {
        // A blank line ends an unnumbered paragraph; inside a numbered step it waits to see.
        if (current && current.indent === 0) closeStep();
        else if (current) current.blanks++;
      } else if (
        current &&
        (current.blanks === 0 || (current.indent > 0 && spaces >= current.indent))
      ) {
        // A continuation: indented under the marker, or straight after the step's last line.
        for (; current.blanks > 0; current.blanks--) current.lines.push('');
        current.lines.push(line.slice(Math.min(current.indent, spaces)));
      } else {
        // An unindented paragraph after a blank line: a step of its own.
        closeStep();
        step = { lines: [line.trim()], indent: 0, blanks: 0 };
      }
    } else {
      notes.push(line);
    }
  }
  closeStep();

  const description = [intro.join('\n').trim(), notes.join('\n').trim()]
    .filter((part) => part !== '')
    .join('\n\n');
  const sourceUrl = stringField(fields.get('source_url'));
  const types = listField(fields.get('types')).map((t) => t.toLowerCase());
  const title = stringField(fields.get('title')) ?? heading ?? '';
  const servings = integerField(fields.get('servings'), 1, 1_000_000);
  const recipe: MarkdownRecipe = {
    title,
    servings: servings ?? 1,
    prepMinutes: integerField(fields.get('prep_minutes'), 0, MAX_MINUTES),
    cookMinutes: integerField(fields.get('cook_minutes'), 0, MAX_MINUTES),
    types: types.filter(
      (t, i): t is RecipeType => RECIPE_TYPE_SET.has(t) && types.indexOf(t) === i,
    ),
    tags: listField(fields.get('tags')),
    rating: integerField(fields.get('rating'), 1, 5),
    sourceName: stringField(fields.get('source_name')),
    // Only a link the recipe screen would follow: http or https, as `recipe.create` insists.
    sourceUrl: sourceUrl !== null && /^https?:\/\//i.test(sourceUrl) ? sourceUrl : null,
    description: description === '' ? null : description,
    ingredientLines,
    steps,
  };
  return { recipe, stated: { title: title !== '', servings: servings !== null } };
}

/** The longest a file's name gets before its number and `.md`. */
const MAX_FILE_STEM = 80;

/**
 * A file name for the recipe, unique among `used` (which it adds to): its slug, or `recipe` for
 * a title with no Latin letters or digits in it, with `-2`, `-3` and so on after a repeat.
 */
export function recipeMarkdownFileName(title: string, used: Set<string>): string {
  const stem = slugify(title).slice(0, MAX_FILE_STEM).replace(/-+$/, '') || 'recipe';
  let name = `${stem}.md`;
  for (let n = 2; used.has(name); n++) name = `${stem}-${n}.md`;
  used.add(name);
  return name;
}
