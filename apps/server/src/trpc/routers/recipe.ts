import { z } from 'zod';
import { MAX_URL_LENGTH } from '@hearth/enrichment';
import { RECIPE_TYPES } from '@hearth/shared';
import { router, protectedProcedure } from '../trpc';
import {
  createRecipe,
  getRecipe,
  updateRecipe,
  deleteRecipe,
  searchRecipes,
  listTagCounts,
  listSourceNames,
} from '../../repo/recipes';
import { setRecipeRating } from '../../repo/cook-log';

/**
 * The types a recipe can be filed under (`RECIPE_TYPES`: the meals, plus side, drink, sauce and
 * base).
 *
 * Exported for the same reason `MAX_SEARCH_LENGTH` is: `packages/enrichment` has to map a
 * source's own category words ("Main Course", "Quick Breads") onto this vocabulary, and it
 * cannot import the server, so it restates the list. `draft-contract.test.ts` compares the two
 * against each other, and it can only do that if this one is reachable.
 */
export const MEAL_TYPES = RECIPE_TYPES;

/**
 * The longest search string any procedure will pass on.
 *
 * A recipe search box has no use for more, and the point of the cap is that an arbitrarily long
 * string is refused here rather than becoming a tsquery, a prefix scan, or a bound parameter.
 * Exported because `food.list` is fed by this same box and has to agree: a second, looser limit
 * there would just be the hole this one closes.
 */
export const MAX_SEARCH_LENGTH = 100;

const searchString = z.string().max(MAX_SEARCH_LENGTH);

/**
 * Where an imported recipe came from.
 *
 * `http` and `https` only, and it is not decoration: this value is rendered as an `href` on the
 * recipe screen, and React does not sanitize one. A `javascript:` URL saved through this
 * procedure by anybody in the household would be a script that runs for everybody else in it.
 * The importer only ever produces the two schemes the fetcher allows; this is what makes the
 * procedure safe for a caller that is not the importer.
 *
 * `MAX_URL_LENGTH` is the fetcher's own cap, so a link that could be imported can be stored.
 */
const sourceUrl = z
  .string()
  .max(MAX_URL_LENGTH)
  .refine((value) => /^https?:\/\//i.test(value), {
    message: 'A source link has to be http or https.',
  });

// The editable fields of a recipe, shared by `create` and `update`. Every list
// defaults to empty / servings to 1 so a caller can send just a title.
const recipeFields = {
  title: z.string().min(1),
  servings: z.number().int().positive().default(1),
  mealTypes: z.array(z.enum(MEAL_TYPES)).default([]),
  tags: z.array(z.string()).default([]),
  ingredientLines: z.array(z.string()).default([]),
  // The linked recipe's id per line, where the editor knows it (see CreateRecipeInput).
  ingredientLinks: z.array(z.string().uuid().nullable()).optional(),
  steps: z.array(z.string()).default([]),
  // Optional details; see CreateRecipeInput for what undefined and null mean on update.
  description: z.string().max(5000).nullable().optional(),
  sourceName: z.string().max(200).nullable().optional(),
  prepMinutes: z.number().int().min(0).max(10_000).nullable().optional(),
  cookMinutes: z.number().int().min(0).max(10_000).nullable().optional(),
  sourceUrl: sourceUrl.nullable().optional(),
};

export const recipeRouter = router({
  // Create a recipe (+ children) for the active household.
  create: protectedProcedure
    // `importDraftId`: the photo or PDF import this was saved from, which the save links.
    .input(z.object({ ...recipeFields, importDraftId: z.string().uuid().optional() }))
    .mutation(({ ctx, input }) => createRecipe(ctx.householdId, input)),

  // Fetch one fully assembled recipe by UUID or slug. Returns null if not found
  // in the active household.
  get: protectedProcedure
    .input(z.object({ idOrSlug: z.string().min(1) }))
    .query(({ ctx, input }) => getRecipe(ctx.householdId, input.idOrSlug)),

  // Replace a recipe's full state. Returns null when the id isn't in the household.
  update: protectedProcedure
    .input(z.object({ id: z.string().uuid(), ...recipeFields }))
    .mutation(({ ctx, input }) => {
      const { id, ...rest } = input;
      return updateRecipe(ctx.householdId, id, rest);
    }),

  // Delete a recipe (children cascade). Returns whether a row was removed.
  delete: protectedProcedure
    .input(z.object({ id: z.string().uuid() }))
    .mutation(({ ctx, input }) => deleteRecipe(ctx.householdId, input.id)),

  /**
   * The household's recipes as summary cards.
   *
   * With no input this is the whole library, newest first, which is what the Library asks for
   * before the cook has typed anything. The optional parameters are D30's search box and filter
   * chips. It stays `list` rather than becoming `search`: the design specifies one endpoint whose
   * params drive text plus filters, and the two names would be the same question asked twice.
   */
  list: protectedProcedure
    .input(
      z
        .object({
          text: searchString.optional(),
          ingredient: searchString.optional(),
          mealType: z.enum(MEAL_TYPES).optional(),
          tag: searchString.optional(),
        })
        .optional(),
    )
    .query(({ ctx, input }) => searchRecipes(ctx.householdId, input ?? {})),

  // The household's overall rating of a recipe, 1 to 5, or null to clear it. Its own procedure
  // rather than part of `update`: the stars are tapped on the recipe screen, not in the form.
  setRating: protectedProcedure
    .input(z.object({ id: z.string().uuid(), rating: z.number().int().min(1).max(5).nullable() }))
    .mutation(({ ctx, input }) => setRecipeRating(ctx.householdId, input.id, input.rating)),

  // The household's sources with their counts, for suggestions in the Source box.
  sourceNames: protectedProcedure.query(({ ctx }) => listSourceNames(ctx.householdId)),

  // The tag chips the Library offers, with the recipe count behind each (D30).
  tagCounts: protectedProcedure.query(({ ctx }) => listTagCounts(ctx.householdId)),
});
