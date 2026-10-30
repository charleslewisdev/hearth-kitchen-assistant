/**
 * Links from an ingredient line to another recipe ("1 pizza dough" → the household's dough recipe).
 *
 * In the editor a link is written into the line as `[[Recipe Title]]`, which the recipe picker
 * inserts so nobody has to type a title exactly. The server resolves the title to a recipe id and
 * stores the line without the token, so renaming the linked recipe never breaks the link; the
 * editor writes the token back from the linked recipe's current title when it loads.
 */

// Bounded, and no `[`, `]` or newline inside, so each start position gives up after at most 200
// characters and a hostile run of `[[` stays linear.
const LINK_TOKEN = /\[\[([^[\]\n]{1,200})\]\]/;
const LINK_TOKENS = /\s{0,20}\[\[[^[\]\n]{1,200}\]\]/g;

export interface SplitRecipeLink {
  /** The line with every link token removed, trimmed: what the ingredient parser reads. */
  text: string;
  /** The title inside the first token, trimmed, or null when the line links nothing. */
  linkTitle: string | null;
}

/** Separate a line's recipe link from its ingredient text. Only the first token counts. */
export function splitRecipeLink(line: string): SplitRecipeLink {
  const match = LINK_TOKEN.exec(line);
  const title = match?.[1]?.trim() ?? '';
  return {
    text: match ? line.replace(LINK_TOKENS, '').trim() : line.trim(),
    linkTitle: title === '' ? null : title,
  };
}

/**
 * The key two titles are compared on: case, spacing and brackets ignored. Brackets because a
 * token cannot hold them, so a recipe titled "Dough [sourdough]" is linked as "Dough sourdough".
 */
export function recipeTitleKey(title: string): string {
  return title.replace(/[[\]]/g, ' ').toLowerCase().trim().replace(/\s+/g, ' ');
}

/** The token that links a line to the recipe with this title. */
export function recipeLinkToken(title: string): string {
  return `[[${title
    .replace(/[[\]\n]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 200)}]]`;
}

/** A line as the editor shows it: the ingredient text, then the link token when there is one. */
export function withRecipeLink(text: string, linkTitle: string | null): string {
  return linkTitle === null ? text : `${text} ${recipeLinkToken(linkTitle)}`;
}
