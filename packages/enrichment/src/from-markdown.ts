import { readRecipeMarkdown } from '@hearth/shared';
import { emptyDraft, field, type RecipeDraft } from './draft';

/**
 * A draft from a Markdown recipe with front matter: a Hearth export (D52), or a file written in
 * its format. Null when the text has no front matter, which sends a paste to `draftFromText`.
 *
 * The file states its fields outright, so they are all `high`: the review screen has nothing to
 * flag except a title or servings the file left out. The format itself is `recipe-markdown.ts`
 * in `@hearth/shared`, beside the writer, so the two cannot drift apart.
 */
export function draftFromMarkdown(text: string): RecipeDraft | null {
  const read = readRecipeMarkdown(text);
  if (read === null) return null;
  const { recipe, stated } = read;
  const draft = emptyDraft({
    kind: 'markdown',
    sourceName: recipe.sourceName,
    sourceUrl: recipe.sourceUrl,
    rating: recipe.rating,
  });
  draft.title = stated.title ? field(recipe.title, 'high', recipe.title) : draft.title;
  draft.servings = stated.servings
    ? field(recipe.servings, 'high', String(recipe.servings))
    : draft.servings;
  // The review screen's Up to box starts from this, so the save sends the file's range (D53).
  draft.servingsHigh = recipe.servingsHigh;
  draft.mealTypes = field(recipe.types, 'high', recipe.types.join(', ') || null);
  draft.tags = field(recipe.tags, 'high', recipe.tags.join(', ') || null);
  draft.ingredientLines = field(recipe.ingredientLines, 'high', null);
  draft.steps = field(recipe.steps, 'high', null);
  draft.details = {
    description: recipe.description,
    prepMinutes: recipe.prepMinutes,
    cookMinutes: recipe.cookMinutes,
  };
  return draft;
}
