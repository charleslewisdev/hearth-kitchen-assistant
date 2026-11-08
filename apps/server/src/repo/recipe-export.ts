import { and, asc, eq, inArray } from 'drizzle-orm';
import { alias } from 'drizzle-orm/pg-core';
import { recipeToMarkdown, withRecipeLink, type MarkdownRecipe } from '@hearth/shared';
import { recipe, recipeIngredient, recipeStep, recipeTags, tag } from '../db/schema';
import { withHousehold } from './tenant';

/** One recipe as an export writes it: its id and slug beside the Markdown file's text. */
export interface ExportedRecipe {
  id: string;
  slug: string;
  title: string;
  markdown: string;
}

/**
 * A household's recipes as Markdown (D52), oldest first, or just the one with `recipeId`.
 *
 * Four queries however many recipes there are, inside one household-scoped transaction, so the
 * files are a consistent snapshot. Each ingredient line is the cook's own text with a linked
 * recipe written back as its `[[Title]]` token, exactly as the editor shows it, so importing the
 * file saves the line through the same parser and resolves the same link. Tags are sorted by
 * name, so the same recipe always exports the same text.
 *
 * Not exported, because a Markdown file has nowhere to put them or they belong to the household
 * rather than the recipe: photos and source files, the cook log, tag colours and food
 * departments. An empty array is a recipe id the household does not have.
 */
export async function exportRecipes(
  householdId: string,
  recipeId?: string,
): Promise<ExportedRecipe[]> {
  return withHousehold(householdId, async (tx) => {
    const rows = await tx
      .select()
      .from(recipe)
      .where(
        and(
          eq(recipe.householdId, householdId),
          recipeId === undefined ? undefined : eq(recipe.id, recipeId),
        ),
      )
      .orderBy(asc(recipe.createdAt), asc(recipe.id));
    if (rows.length === 0) return [];
    const ids = rows.map((r) => r.id);

    const linked = alias(recipe, 'linked');
    const ingredientRows = await tx
      .select({
        recipeId: recipeIngredient.recipeId,
        rawText: recipeIngredient.rawText,
        linkedTitle: linked.title,
      })
      .from(recipeIngredient)
      .leftJoin(linked, eq(recipeIngredient.linkedRecipeId, linked.id))
      .where(
        and(eq(recipeIngredient.householdId, householdId), inArray(recipeIngredient.recipeId, ids)),
      )
      .orderBy(asc(recipeIngredient.recipeId), asc(recipeIngredient.position));

    const stepRows = await tx
      .select({ recipeId: recipeStep.recipeId, text: recipeStep.text })
      .from(recipeStep)
      .where(and(eq(recipeStep.householdId, householdId), inArray(recipeStep.recipeId, ids)))
      .orderBy(asc(recipeStep.recipeId), asc(recipeStep.position));

    const tagRows = await tx
      .select({ recipeId: recipeTags.recipeId, name: tag.name })
      .from(recipeTags)
      .innerJoin(tag, eq(recipeTags.tagId, tag.id))
      .where(and(eq(recipeTags.householdId, householdId), inArray(recipeTags.recipeId, ids)))
      .orderBy(asc(recipeTags.recipeId), asc(tag.name));

    const group = <T extends { recipeId: string }, V>(items: T[], value: (item: T) => V) => {
      const by = new Map<string, V[]>();
      for (const item of items) {
        const list = by.get(item.recipeId);
        if (list) list.push(value(item));
        else by.set(item.recipeId, [value(item)]);
      }
      return by;
    };
    const lines = group(ingredientRows, (i) => withRecipeLink(i.rawText, i.linkedTitle));
    const steps = group(stepRows, (s) => s.text);
    const tags = group(tagRows, (t) => t.name);

    return rows.map((row) => {
      const md: MarkdownRecipe = {
        title: row.title,
        servings: row.servings,
        servingsHigh: row.servingsHigh,
        prepMinutes: row.prepMinutes,
        cookMinutes: row.cookMinutes,
        types: row.mealTypes,
        tags: tags.get(row.id) ?? [],
        rating: row.rating,
        sourceName: row.sourceName,
        sourceUrl: row.sourceUrl,
        description: row.description,
        ingredientLines: lines.get(row.id) ?? [],
        steps: steps.get(row.id) ?? [],
      };
      return { id: row.id, slug: row.slug, title: row.title, markdown: recipeToMarkdown(md) };
    });
  });
}
