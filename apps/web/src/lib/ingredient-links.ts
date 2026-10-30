import { recipeLinkToken, recipeTitleKey, splitRecipeLink } from '@hearth/shared';

/** The index of the line the caret is on, counting every line including blank ones. */
export function lineIndexAt(text: string, caret: number): number {
  return text.slice(0, caret).split('\n').length - 1;
}

/**
 * The text with line `index` linked to `title`, or unlinked when `title` is null, and where the
 * caret belongs afterwards (the end of that line). Any token already on the line is replaced.
 */
export function setLineLink(
  text: string,
  index: number,
  title: string | null,
): { text: string; caret: number } {
  const lines = text.split('\n');
  const current = lines[index] ?? '';
  const bare = splitRecipeLink(current).text;
  lines[index] = title === null ? bare : `${bare} ${recipeLinkToken(title)}`.trim();
  const caret = lines.slice(0, index + 1).join('\n').length;
  return { text: lines.join('\n'), caret };
}

/** Whether the cook just typed the `[[` that opens the picker at `caret`. */
export function openedLinkAt(text: string, caret: number): boolean {
  return text.slice(Math.max(0, caret - 2), caret) === '[[';
}

export interface RecipeOption {
  id: string;
  title: string;
}

/**
 * The recipes a picker search offers: titles starting with the query first, then titles that
 * contain it, each group alphabetical. The recipe being edited is never offered.
 */
export function matchRecipes(
  recipes: readonly RecipeOption[],
  query: string,
  excludeId: string | null,
  limit = 8,
): RecipeOption[] {
  const key = recipeTitleKey(query);
  const scored = recipes
    .filter((r) => r.id !== excludeId)
    .map((r) => ({ r, title: recipeTitleKey(r.title) }))
    .filter(({ title }) => title.includes(key))
    .sort(
      (a, b) =>
        Number(b.title.startsWith(key)) - Number(a.title.startsWith(key)) ||
        a.title.localeCompare(b.title),
    );
  return scored.slice(0, limit).map(({ r }) => r);
}
