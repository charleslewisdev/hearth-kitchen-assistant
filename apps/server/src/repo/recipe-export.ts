import { and, asc, eq, inArray } from 'drizzle-orm';
import { alias } from 'drizzle-orm/pg-core';
import { recipeToMarkdown, withRecipeLink, type MarkdownRecipe } from '@hearth/shared';
import { recipe, recipeFile, recipeIngredient, recipeStep, recipeTags, tag } from '../db/schema';
import { withHousehold } from './tenant';
import type { RecipeFileKind } from './recipe-files';

/** One of a recipe's files as an export needs it: which bytes to read and where they go. */
export interface ExportedFile {
  id: string;
  kind: RecipeFileKind;
}

/**
 * One recipe as an export writes it: its id and slug beside the Markdown file's text, and its
 * files for the zip.
 */
export interface ExportedRecipe {
  id: string;
  slug: string;
  title: string;
  /** The Markdown without file keys, as the single-recipe download sends it. */
  markdown: string;
  /** What `markdown` was written from, so the zip can write it again with `files`. */
  recipe: MarkdownRecipe;
  /** Photos in gallery order, then source pages in reading order, then the PDF. */
  files: ExportedFile[];
  coverFileId: string | null;
}

/**
 * A household's recipes as Markdown (D52), oldest first, or just the one with `recipeId`.
 *
 * Five queries however many recipes there are, inside one household-scoped transaction, so the
 * export is a consistent snapshot. Each ingredient line is the cook's own text with a linked
 * recipe written back as its `[[Title]]` token, exactly as the editor shows it, so importing the
 * file saves the line through the same parser and resolves the same link. Tags are sorted by
 * name, so the same recipe always exports the same text.
 *
 * Each recipe also carries its file rows (ids and kinds only) and its cover's id, so the zip
 * download can put photos and source scans beside the Markdown and list them in its front
 * matter. The single-recipe download is Markdown alone and has no place for them.
 *
 * Not exported, because they belong to the household rather than the recipe or have nowhere to
 * go: the cook log, tag colours and food departments. An empty array is a recipe id the household
 * does not have.
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

    const fileRows = await tx
      .select({
        id: recipeFile.id,
        recipeId: recipeFile.recipeId,
        kind: recipeFile.kind,
        position: recipeFile.position,
      })
      .from(recipeFile)
      .where(and(eq(recipeFile.householdId, householdId), inArray(recipeFile.recipeId, ids)))
      .orderBy(asc(recipeFile.recipeId), asc(recipeFile.kind), asc(recipeFile.position));

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
    const files = group(fileRows, (f): ExportedFile => ({ id: f.id, kind: f.kind }));

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
      return {
        id: row.id,
        slug: row.slug,
        title: row.title,
        markdown: recipeToMarkdown(md),
        recipe: md,
        files: files.get(row.id) ?? [],
        coverFileId: row.coverFileId,
      };
    });
  });
}
