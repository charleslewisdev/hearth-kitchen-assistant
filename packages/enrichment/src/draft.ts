import { RECIPE_TYPES } from '@hearth/shared';

/**
 * The one shape every import source produces.
 *
 * A draft is NOT a recipe. Nothing here is written to `recipe`, `recipe_ingredient`,
 * `recipe_step` or `recipe_tags`: the review screen edits a draft and then submits it through
 * the existing `recipe.create`, so import has no second write path into the recipe tables and
 * inherits every guarantee that procedure already has.
 */

/**
 * How sure the source made us about one field. Binary, never a score.
 *
 * A float would invite precision no source can justify: tesseract's per-word confidence is not
 * commensurable with "this JSON-LD had no `recipeYield`", and the review screen only ever asks
 * one question of a field, which is whether to flag it.
 */
export type Confidence = 'high' | 'low';

/**
 * The recipe-type vocabulary a draft can carry: `RECIPE_TYPES` from `@hearth/shared`, which the
 * server's router uses too. `draft-contract.test.ts` in `apps/server` still checks the two
 * agree, in case either stops taking it from there.
 */
export const MEAL_TYPES = RECIPE_TYPES;

export type MealType = (typeof MEAL_TYPES)[number];

/** One field of a draft: what to save, how sure we are, and what the source actually said. */
export interface DraftField<T> {
  value: T;
  confidence: Confidence;
  /**
   * The source's own words for this field, or `null` when the source said nothing and the
   * value is a fallback.
   *
   * Kept beside the parsed value because that is what lets the review screen show the cook what
   * it read and what it made of it, side by side: "4 servings" next to `4`, and a yield of
   * "1 loaf, 10 serving(s)" next to the 10 that was pulled out of it.
   */
  raw: string | null;
}

/**
 * Where a draft came from, for the review screen's source panel.
 *
 * Only the URL kind carries anything, and what it carries is provenance the recipe keeps: it
 * becomes `recipe.source_url` on save, which is how a cook gets back to the headnote, the
 * comments or the photo. The other three have nothing of that sort to keep - a file name is not
 * somewhere anybody can return to - so they name the kind and stop there.
 */
export type DraftSource =
  | { kind: 'url'; url: string }
  | { kind: 'text' }
  | { kind: 'pdf' }
  | { kind: 'image' };

/** The fields `recipe.create` takes, each wrapped with its confidence and the source's words. */
export interface RecipeDraft {
  title: DraftField<string>;
  servings: DraftField<number>;
  mealTypes: DraftField<MealType[]>;
  tags: DraftField<string[]>;
  ingredientLines: DraftField<string[]>;
  steps: DraftField<string[]>;
  /**
   * What a page states outright and a cook would otherwise retype: its headnote and its times.
   * Plain values rather than fields, because only structured data ever fills them, so there is
   * nothing for the review screen to flag; `null` means the source did not say.
   */
  details: RecipeDetails;
  /**
   * Ingredient lines whose amount OCR garbled past reading, so the importer put in its best
   * guess: "% cup" with nothing on the page to say whether that was ¼, ½ or ¾. The review
   * screen marks these lines; a cook who edits one has checked it.
   */
  amountsToCheck: string[];
  source: DraftSource;
}

export interface RecipeDetails {
  description: string | null;
  prepMinutes: number | null;
  cookMinutes: number | null;
}

/** What `recipe.create` is given. Deliberately the create input's shape and nothing more. */
export interface RecipeCreateInput {
  title: string;
  servings: number;
  mealTypes: MealType[];
  tags: string[];
  ingredientLines: string[];
  steps: string[];
  /**
   * Where the recipe came from, when there is somewhere to go back to.
   *
   * Optional, and a recipe typed by hand simply does not set it - which is what keeps an
   * imported recipe from being a special case downstream. It is how a cook gets back to the
   * headnote, the comments or the photograph, none of which the structured core keeps.
   */
  sourceUrl?: string;
  description?: string;
  prepMinutes?: number;
  cookMinutes?: number;
}

export function field<T>(value: T, confidence: Confidence, raw: string | null): DraftField<T> {
  return { value, confidence, raw };
}

/**
 * A draft that claims nothing.
 *
 * Every field starts `low` with no source words, so a source that fails to find something
 * leaves it flagged for the cook rather than silently asserting a default. `servings` is 1
 * because that is what `recipe.create` defaults to, and a draft that never learned the yield
 * should land on the same number a hand-typed recipe would.
 */
export function emptyDraft(source: DraftSource): RecipeDraft {
  return {
    title: field('', 'low', null),
    servings: field(1, 'low', null),
    mealTypes: field<MealType[]>([], 'low', null),
    tags: field<string[]>([], 'low', null),
    ingredientLines: field<string[]>([], 'low', null),
    steps: field<string[]>([], 'low', null),
    details: { description: null, prepMinutes: null, cookMinutes: null },
    amountsToCheck: [],
    source,
  };
}

/**
 * Strip the draft down to what `recipe.create` accepts.
 *
 * The one part of `source` that survives is a URL, because that is the only kind of provenance
 * a cook can act on: a link goes back to the headnote and the comments, and a file name does
 * not go anywhere. The kind itself does not survive - it belongs to the review screen, and
 * a saved recipe is a saved recipe.
 */
export function draftToCreateInput(draft: RecipeDraft): RecipeCreateInput {
  return {
    title: draft.title.value,
    servings: draft.servings.value,
    mealTypes: draft.mealTypes.value,
    tags: draft.tags.value,
    ingredientLines: draft.ingredientLines.value,
    steps: draft.steps.value,
    ...(draft.source.kind === 'url' ? { sourceUrl: draft.source.url } : {}),
    ...(draft.details.description !== null ? { description: draft.details.description } : {}),
    ...(draft.details.prepMinutes !== null ? { prepMinutes: draft.details.prepMinutes } : {}),
    ...(draft.details.cookMinutes !== null ? { cookMinutes: draft.details.cookMinutes } : {}),
  };
}
