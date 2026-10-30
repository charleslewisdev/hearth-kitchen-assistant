import { and, eq, or, asc, desc, sql, inArray, isNotNull, type SQL } from 'drizzle-orm';
import { alias } from 'drizzle-orm/pg-core';
import { TRPCError } from '@trpc/server';
import {
  parseIngredientLine,
  normalizeFoodName,
  slugify,
  splitRecipeLink,
  recipeTitleKey,
  type RecipeType,
} from '@hearth/shared';
import {
  recipe,
  recipeIngredient,
  recipeStep,
  tag,
  recipeTags,
  food,
  cookLogEntry,
} from '../db/schema';
import { withHousehold } from './tenant';
import { listRecipeFiles, recipeFileIds, type RecipeFileView } from './recipe-files';
import { removeFiles } from '../files';
import type { Tx } from './tenant';
import { findOrCreateFood } from './foods';
import { linkImportDraft } from './import-drafts';

// A recipe's types; the name is older than the types that are not meals.
export type MealType = RecipeType;
export type ScalingMode = 'linear' | 'fixed' | 'sublinear' | 'manual';

/** Another recipe, as a link to it needs it. */
export interface RecipeRef {
  id: string;
  slug: string;
  title: string;
}

export interface AssembledIngredient {
  id: string;
  position: number;
  quantity: number | null;
  unit: string | null;
  /** The same amount in the other system, when the recipe prints one ("3 cups (360g)"). */
  altQuantity: number | null;
  altUnit: string | null;
  note: string | null;
  rawText: string;
  scalingMode: ScalingMode;
  foodId: string | null;
  foodName: string | null;
  department: string | null;
  /** The recipe this line is made from, when it links one. */
  linkedRecipe: RecipeRef | null;
}

export interface AssembledStep {
  id: string;
  position: number;
  text: string;
}

export interface AssembledRecipe {
  id: string;
  title: string;
  slug: string;
  description: string | null;
  servings: number;
  prepMinutes: number | null;
  cookMinutes: number | null;
  sourceUrl: string | null;
  sourceName: string | null;
  mealTypes: MealType[];
  ingredients: AssembledIngredient[];
  steps: AssembledStep[];
  tags: string[];
  /** The recipes that link to this one from an ingredient line, by title. */
  usedIn: RecipeRef[];
  /** Photos, source pages and a source PDF, and which photo is the cover. */
  files: RecipeFileView[];
  coverFileId: string | null;
  rating: number | null;
}

// A recipe "card" — the summary fields shown in a list view, with its tag names but not the
// assembled ingredients or steps. One query: the tags come from a correlated subquery.
export interface RecipeCard {
  id: string;
  title: string;
  slug: string;
  description: string | null;
  servings: number;
  mealTypes: MealType[];
  prepMinutes: number | null;
  cookMinutes: number | null;
  tags: string[];
  createdAt: Date;
  updatedAt: Date;
  coverFileId: string | null;
  rating: number | null;
  cookCount: number;
  lastCookedOn: string | null;
}

export interface CreateRecipeInput {
  title: string;
  servings?: number;
  mealTypes?: MealType[];
  tags?: string[];
  ingredientLines?: string[];
  /**
   * The recipe each ingredient line links to, by id, in line order, when the caller knows it: the
   * editor does, from the picker and from the links it loaded. A line with an id here links that
   * recipe whatever its `[[Title]]` token says, so two recipes sharing a title, or a renamed one,
   * never stop the parent from saving. A null, or no array at all, falls back to the token's title.
   */
  ingredientLinks?: (string | null)[];
  steps?: string[];
  /**
   * Where the recipe came from, as a link: set by the importer for a page, and typed or fixed by
   * the cook in the editor (a recipe pasted because its page would not fetch still has one).
   * Like the details below, `undefined` on update leaves it as it is and `null` clears it, so a
   * caller that does not carry the field cannot erase it.
   */
  sourceUrl?: string | null;
  /**
   * The optional details a cook types in: notes shown under the title, where a recipe came from
   * when that is not a link ("Joy of Cooking, p. 212"), and times. On update, `undefined` leaves
   * a field as it is and `null` clears it, so a caller that does not know a field cannot erase it.
   */
  description?: string | null;
  sourceName?: string | null;
  prepMinutes?: number | null;
  cookMinutes?: number | null;
}

// Blank text is no text: the form sends what is in the box, and an emptied box means "none".
function textOrNull(value: string | null | undefined): string | null | undefined {
  if (value === undefined || value === null) return value;
  const trimmed = value.trim();
  return trimmed === '' ? null : trimmed;
}

function optionalDetails(input: CreateRecipeInput) {
  const details: Partial<typeof recipe.$inferInsert> = {};
  const description = textOrNull(input.description);
  const sourceName = textOrNull(input.sourceName);
  if (description !== undefined) details.description = description;
  if (sourceName !== undefined) details.sourceName = sourceName;
  if (input.sourceUrl !== undefined) details.sourceUrl = input.sourceUrl;
  if (input.prepMinutes !== undefined) details.prepMinutes = input.prepMinutes;
  if (input.cookMinutes !== undefined) details.cookMinutes = input.cookMinutes;
  return details;
}

// Find the canonical `tag` row for a household by normalized name, creating it if
// absent. Mirrors `findOrCreateFood`: dedup on `normalizedName` so "Quick" and
// "quick" fold to one row. Composes inside the recipe-create transaction.
async function findOrCreateTag(tx: Tx, householdId: string, rawName: string) {
  const normalizedName = normalizeFoodName(rawName);
  const [existing] = await tx
    .select()
    .from(tag)
    .where(and(eq(tag.householdId, householdId), eq(tag.normalizedName, normalizedName)));
  if (existing) return existing;

  const [created] = await tx
    .insert(tag)
    .values({ householdId, name: rawName, normalizedName })
    .returning();
  return created!;
}

// How deep the save-time cycle check follows links. A real chain (pizza → dough → poolish) is two
// or three long; the cap only bounds the walk if data ever holds something stranger.
const MAX_LINK_DEPTH = 10;

// Whether following ingredient links from `start` ever reaches `target`, which would make saving
// the link a cycle (the shopping list would expand the two recipes into each other forever).
async function linksReach(tx: Tx, householdId: string, start: string, target: string) {
  const seen = new Set([start]);
  let frontier = [start];
  for (let depth = 0; depth < MAX_LINK_DEPTH && frontier.length > 0; depth++) {
    const rows = await tx
      .select({ linked: recipeIngredient.linkedRecipeId })
      .from(recipeIngredient)
      .where(
        and(
          eq(recipeIngredient.householdId, householdId),
          inArray(recipeIngredient.recipeId, frontier),
          isNotNull(recipeIngredient.linkedRecipeId),
        ),
      );
    frontier = [];
    for (const { linked } of rows) {
      if (linked === target) return true;
      if (linked !== null && !seen.has(linked)) {
        seen.add(linked);
        frontier.push(linked);
      }
    }
  }
  return false;
}

// Resolve each line's link to a recipe id in this household, or null for a line that links
// nothing. An id the caller sent must be one of this household's recipes; otherwise the line's
// `[[Title]]` token is matched by title. A title that matches no recipe, or two, is refused rather
// than guessed, and so is a link back to the recipe being saved, directly or through the recipes
// it links. The
// refusals are UNPROCESSABLE_CONTENT, which input validation never uses, so the editor can show
// the sentence as it is. They name the line by number only, never what the cook typed (D38).
async function resolveLinks(
  tx: Tx,
  householdId: string,
  recipeId: string,
  titles: (string | null)[],
  sentIds: (string | null)[],
): Promise<(string | null)[]> {
  if (titles.every((title) => title === null)) return titles.map(() => null);

  // Every title in the household, compared in JS on the same key the editor uses. One small
  // query per save that links anything, which at household scale is cheaper than being clever.
  const byKey = new Map<string, string[]>();
  const known = new Set<string>();
  const rows = await tx
    .select({ id: recipe.id, title: recipe.title })
    .from(recipe)
    .where(eq(recipe.householdId, householdId));
  for (const row of rows) {
    known.add(row.id);
    const key = recipeTitleKey(row.title);
    byKey.set(key, [...(byKey.get(key) ?? []), row.id]);
  }

  const resolved: (string | null)[] = [];
  for (let i = 0; i < titles.length; i++) {
    const title = titles[i];
    if (title == null) {
      resolved.push(null);
      continue;
    }
    const line = `Ingredient ${i + 1}`;
    const sent = sentIds[i] ?? null;
    const ids =
      sent !== null ? (known.has(sent) ? [sent] : []) : (byKey.get(recipeTitleKey(title)) ?? []);
    if (ids.length === 0) {
      throw new TRPCError({
        code: 'UNPROCESSABLE_CONTENT',
        message: `${line} links to a recipe that is not in your library.`,
      });
    }
    if (ids.length > 1) {
      throw new TRPCError({
        code: 'UNPROCESSABLE_CONTENT',
        message: `${line} links to a title two recipes share. Rename one of them first.`,
      });
    }
    const id = ids[0]!;
    if (id === recipeId) {
      throw new TRPCError({
        code: 'UNPROCESSABLE_CONTENT',
        message: `${line} links this recipe to itself.`,
      });
    }
    if (await linksReach(tx, householdId, id, recipeId)) {
      throw new TRPCError({
        code: 'UNPROCESSABLE_CONTENT',
        message: `${line} links to a recipe that already uses this one.`,
      });
    }
    resolved.push(id);
  }
  return resolved;
}

// Insert a recipe's child rows (ingredients parsed + mapped to foods, ordered
// steps, deduped tag links) for an already-existing `recipeId`. Assumes the recipe
// currently has NO children of these kinds — create writes into a fresh recipe;
// update deletes the old child rows first, then calls this. Shared so create and
// update never duplicate the child-writing logic (DRY).
async function insertRecipeChildren(
  tx: Tx,
  householdId: string,
  recipeId: string,
  input: Pick<CreateRecipeInput, 'tags' | 'ingredientLines' | 'ingredientLinks' | 'steps'>,
) {
  const { tags = [], ingredientLines = [], ingredientLinks = [], steps = [] } = input;

  // Ingredients, in input order (position starts at 0). A line's link token is resolved and
  // stored as `linkedRecipeId`; the parser and `rawText` see the line without it.
  const split = ingredientLines.map(splitRecipeLink);
  const links = await resolveLinks(
    tx,
    householdId,
    recipeId,
    split.map((s) => s.linkTitle),
    ingredientLinks,
  );
  for (let position = 0; position < ingredientLines.length; position++) {
    const { text, linkTitle } = split[position]!;
    // A line that is only an amount and a link ("1 [[Pizza Dough]]") keeps the title as its food,
    // so it still reads, and still shops, as something if the linked recipe is deleted later.
    const line =
      linkTitle === null
        ? ingredientLines[position]!
        : parseIngredientLine(text).foodName === ''
          ? `${text} ${linkTitle}`.trim()
          : text;
    const parsed = parseIngredientLine(line);
    const food =
      parsed.foodName === '' ? null : await findOrCreateFood(tx, householdId, parsed.foodName);

    await tx.insert(recipeIngredient).values({
      householdId,
      recipeId,
      foodId: food?.id ?? null,
      position,
      quantity: parsed.quantity == null ? null : String(parsed.quantity),
      unit: parsed.unit,
      altQuantity: parsed.altQuantity === undefined ? null : String(parsed.altQuantity),
      altUnit: parsed.altUnit ?? null,
      note: parsed.note,
      rawText: line,
      scalingModeValue: 'linear',
      linkedRecipeId: links[position],
    });
  }

  // Steps, in input order (position starts at 0).
  for (let position = 0; position < steps.length; position++) {
    await tx.insert(recipeStep).values({
      householdId,
      recipeId,
      position,
      text: steps[position]!,
    });
  }

  // Tags: dedup within the input by normalized name, then link each once.
  const seen = new Set<string>();
  for (const rawName of tags) {
    const key = normalizeFoodName(rawName);
    if (key === '' || seen.has(key)) continue;
    seen.add(key);
    const tagRow = await findOrCreateTag(tx, householdId, rawName);
    await tx.insert(recipeTags).values({ householdId, recipeId, tagId: tagRow.id });
  }
}

// Create a recipe and all its child rows (ingredients parsed + mapped to foods,
// ordered steps, deduped tags) inside ONE household-scoped transaction. Every row
// carries `householdId`; RLS enforces the same boundary structurally.
export async function createRecipe(
  householdId: string,
  input: CreateRecipeInput & {
    /** The photo or PDF import this recipe was saved from (`import-drafts.ts`). */
    importDraftId?: string;
  },
): Promise<{ id: string; slug: string }> {
  const { title, servings = 1, mealTypes = [] } = input;

  return withHousehold(householdId, async (tx) => {
    const slug = slugify(title);

    const [created] = await tx
      .insert(recipe)
      .values({
        householdId,
        title,
        slug,
        servings,
        mealTypes,
        ...optionalDetails(input),
      })
      .returning({ id: recipe.id, slug: recipe.slug });
    const { id } = created!;

    await insertRecipeChildren(tx, householdId, id, input);
    if (input.importDraftId) await linkImportDraft(tx, householdId, input.importDraftId, id);

    return { id, slug };
  });
}

// Replace a recipe's full state (scalars + all children) inside ONE household-scoped
// transaction. `input` is the same shape as create and is treated as the NEW full
// state. Children are reconciled by REPLACE-WITHIN-TRANSACTION: delete the existing
// ingredient/step/tag-link rows, then re-insert from `input` exactly as create does
// (a diff-based reconcile is out of scope for P1).
//
// The slug is kept STABLE across updates — it is only generated on create — so links
// and URLs that reference a recipe by slug don't break when its title changes.
// Returns `{ id, slug }` on success, or `null` when no recipe with `id` belongs to
// `householdId` (not-found / another household's recipe → no-op, null).
export async function updateRecipe(
  householdId: string,
  id: string,
  input: CreateRecipeInput,
): Promise<{ id: string; slug: string } | null> {
  const { title, servings = 1, mealTypes = [] } = input;

  return withHousehold(householdId, async (tx) => {
    // Scoped existence check: the household filter (plus RLS) means another
    // household's recipe simply isn't visible here, so this returns null for it.
    const [existing] = await tx
      .select({ id: recipe.id, slug: recipe.slug })
      .from(recipe)
      .where(and(eq(recipe.householdId, householdId), eq(recipe.id, id)));
    if (!existing) return null;

    // Update scalar fields; keep slug stable, bump updatedAt.
    await tx
      .update(recipe)
      .set({ title, servings, mealTypes, ...optionalDetails(input), updatedAt: new Date() })
      .where(and(eq(recipe.householdId, householdId), eq(recipe.id, id)));

    // Replace children: clear existing rows, then re-insert from input.
    await tx.delete(recipeIngredient).where(eq(recipeIngredient.recipeId, id));
    await tx.delete(recipeStep).where(eq(recipeStep.recipeId, id));
    await tx.delete(recipeTags).where(eq(recipeTags.recipeId, id));

    await insertRecipeChildren(tx, householdId, id, input);

    return { id, slug: existing.slug };
  });
}

// Delete a recipe scoped to one household. The child rows (ingredients, steps, tag
// links) are removed by the FK `onDelete: 'cascade'`. Deleting another household's
// recipe id matches no row (household filter + RLS) and removes nothing. Returns
// `true` when a recipe row was deleted, `false` otherwise.
export async function deleteRecipe(householdId: string, id: string): Promise<boolean> {
  // The file rows cascade with the recipe; their bytes on disk are removed once that has
  // committed, so a rolled-back delete never loses a photo.
  const { deleted, fileIds } = await withHousehold(householdId, async (tx) => {
    const fileIds = await recipeFileIds(tx, id);
    const rows = await tx
      .delete(recipe)
      .where(and(eq(recipe.householdId, householdId), eq(recipe.id, id)))
      .returning({ id: recipe.id });
    return { deleted: rows.length > 0, fileIds };
  });
  if (deleted && fileIds.length > 0) await removeFiles(householdId, fileIds);
  return deleted;
}

// The library query's parameters. All optional and combined with AND; the empty object is the
// unfiltered library, which is what the Library screen asks for before the cook types anything.
export interface SearchRecipesParams {
  /** Free text from the search box, matched against title, description and tag names. */
  text?: string;
  /** A food name; matches recipes that use it. Normalized here, so "Tomatoes" finds "tomato". */
  ingredient?: string;
  mealType?: MealType;
  tag?: string;
}

// The generated `search_tsv` column (migration 0003: title weight A, description weight B).
// It is not declared in `db/schema.ts` - Drizzle has no `GENERATED ALWAYS` tsvector to declare -
// so the query reaches it through raw SQL. Unqualified lower-case, which is how Postgres folds
// the identifier anyway.
const SEARCH_TSV = sql`recipe.search_tsv`;

// Search a household's recipes, returning summary "cards" (no assembled children). Scoped to the
// household via `withHousehold` + an explicit `householdId` filter (RLS enforces the same
// boundary). With no parameters this is the plain newest-first list.
//
// Ordering: by text rank first when there is text (the tsvector's A/B weights are what put a
// title hit above a description hit), then by recency. With no text there is no rank to sort on
// and recency is the whole order.
//
// Neither GIN index is reachable from this query, and that is not a fixable oversight. Measured
// with EXPLAIN (ANALYZE, BUFFERS) over a 5000-recipe household: `@@` (ts_match_vq) and `@>`
// (arraycontains) are both `proleakproof = false`, so Postgres will not evaluate them as index
// quals ahead of the row-level-security quals on `recipe`, and filters them during a sequential
// scan instead. The identical query run by a role RLS does not apply to picks
// `recipe_search_tsv_idx` and `recipe_meal_types_idx` immediately. The ingredient EXISTS below
// IS index-driven (`recipe_ingredient_food_idx`), because `=` on uuid is leakproof. At household
// scale the scan is well under a millisecond, so this is recorded rather than worked around:
// D31's structural isolation outranks the index.
/**
 * The words typed so far, for matching the last one as a prefix, or null when there is nothing
 * to widen.
 *
 * The Library searches on every keystroke, and `websearch_to_tsquery` matches whole words only,
 * so the grid emptied at "chick" and came back at "chicken". Only plain words are widened: once
 * the cook types websearch syntax (a quote, `or`, or a `-` where Postgres reads an exclusion) the
 * query is theirs and stays exact, because widening "-chicken" would bring back what they asked
 * to leave out. Tokens are letters and digits only, so nothing typed can reach `to_tsquery`'s
 * own operators.
 */
function prefixQueryOf(text: string): { rest: string; last: string } | null {
  // Postgres reads `-` as an exclusion at the start, after whitespace, and after `(`, `)`, `!`,
  // `&`, `|` and `<` - checked in psql. `or` is only ever narrowed by an AND, so it needs no
  // more than the same boundaries.
  if (/"|(?:^|[\s()!&|<])-|(?:^|[\s()!&|<])or(?:[\s()!&|<]|$)/i.test(text)) return null;
  const words = text.match(/[\p{L}\p{N}]+/gu);
  if (words === null) return null;
  return { rest: words.slice(0, -1).join(' & '), last: words[words.length - 1] ?? '' };
}

export async function searchRecipes(
  householdId: string,
  params: SearchRecipesParams = {},
): Promise<RecipeCard[]> {
  const text = params.text?.trim() ?? '';
  // Tag and food names are stored normalized (lower-cased, last word singularized), so anything
  // compared against them goes through the same normalizer first.
  const ingredient = params.ingredient === undefined ? '' : normalizeFoodName(params.ingredient);
  const tagName = params.tag === undefined ? '' : normalizeFoodName(params.tag);

  return withHousehold(householdId, async (tx) => {
    const filters: SQL[] = [eq(recipe.householdId, householdId)];

    // `websearch_to_tsquery` rather than `to_tsquery` or `plainto_tsquery`: it parses what a
    // person types - quoted phrases, `or`, a leading `-` to exclude - and returns an empty query
    // instead of raising on input the others reject, such as a bare apostrophe.
    const tsquery = sql`websearch_to_tsquery('english', ${text})`;
    const prefix = prefixQueryOf(text);
    // Two readings of the last word as a prefix. The english config stems it, so "thighs" still
    // finds "thigh". The simple config keeps a stop word, which the english one drops: without
    // it "on" never reached "onion", nor "be" "bean", and the grid emptied mid-word again.
    const prefixMatch =
      prefix === null
        ? sql`false`
        : sql`(${SEARCH_TSV} @@ to_tsquery('english', ${
            prefix.rest === '' ? `${prefix.last}:*` : `${prefix.rest} & ${prefix.last}:*`
          }) or ${SEARCH_TSV} @@ (to_tsquery('english', ${prefix.rest}) && to_tsquery('simple', ${`${prefix.last}:*`})))`;

    if (text !== '') {
      // D30 asks one box to find title AND tag matches. `search_tsv` holds title and description
      // only: a generated column can read no row but its own, and tags live in `recipe_tags`.
      // So the tag half is matched relationally, in this same statement, rather than by keeping
      // a second copy of the tag text in a trigger-maintained tsvector. Prefix rather than
      // equality because this runs while the cook is still typing.
      //
      // EXISTS, not a join: a recipe carrying two matching tags must still be one row.
      const tagPrefix = normalizeFoodName(text);
      filters.push(
        sql`(${SEARCH_TSV} @@ ${tsquery} or ${prefixMatch} or exists (
          select 1 from ${recipeTags} rt
          join ${tag} t on t.id = rt.tag_id
          where rt.recipe_id = ${recipe.id} and starts_with(t.normalized_name, ${tagPrefix})
        ))`,
      );
    }

    if (ingredient !== '') {
      // D30's `contains {ingredient}` token, and the payoff of the canonical Food model: the
      // match is on the food row, so every spelling that folded into it is found at once.
      // EXISTS again - a recipe naming the same food on two lines must not appear twice.
      filters.push(
        sql`exists (
          select 1 from ${recipeIngredient} ri
          join ${food} f on f.id = ri.food_id
          where ri.recipe_id = ${recipe.id} and f.normalized_name = ${ingredient}
        )`,
      );
    }

    if (params.mealType !== undefined) {
      // Array containment, with the cast the enum array needs to be compared against a text
      // parameter.
      filters.push(sql`${recipe.mealTypes} @> array[${params.mealType}]::recipe_type[]`);
    }

    if (tagName !== '') {
      filters.push(
        sql`exists (
          select 1 from ${recipeTags} rt
          join ${tag} t on t.id = rt.tag_id
          where rt.recipe_id = ${recipe.id} and t.normalized_name = ${tagName}
        )`,
      );
    }

    const orderBy =
      text === ''
        ? [desc(recipe.createdAt)]
        : [desc(sql`ts_rank_cd(${SEARCH_TSV}, ${tsquery})`), desc(recipe.createdAt)];

    return tx
      .select({
        id: recipe.id,
        title: recipe.title,
        slug: recipe.slug,
        description: recipe.description,
        servings: recipe.servings,
        mealTypes: recipe.mealTypes,
        prepMinutes: recipe.prepMinutes,
        cookMinutes: recipe.cookMinutes,
        createdAt: recipe.createdAt,
        updatedAt: recipe.updatedAt,
        coverFileId: recipe.coverFileId,
        rating: recipe.rating,
        // How often and how lately it was cooked, from the log: the "last cooked" line and the
        // Recently cooked / Most cooked sorts. `"recipe"."id"` spelled out, as for tags below.
        cookCount: sql<number>`(select count(*)::int from ${cookLogEntry} c where c.recipe_id = "recipe"."id")`,
        lastCookedOn: sql<
          string | null
        >`(select max(c.cooked_on)::text from ${cookLogEntry} c where c.recipe_id = "recipe"."id")`,
        // The card's tag chips, by name. A correlated subquery rather than a join and GROUP BY,
        // so the filters and ordering above stay exactly as they are. `"recipe"."id"` is spelled
        // out: Drizzle renders a column in a select list unqualified, and a bare "id" in here
        // would be the tag's.
        tags: sql<string[]>`coalesce((
          select array_agg(t.name order by t.name)
          from ${recipeTags} rt join ${tag} t on t.id = rt.tag_id
          where rt.recipe_id = "recipe"."id"
        ), '{}')`,
      })
      .from(recipe)
      .where(and(...filters))
      .orderBy(...orderBy);
  });
}

// Every source the household has typed, with how many recipes carry it, for the Source box's
// suggestions. Exact strings: grouping by book (dropping ", p. 54") is `sourceSuggestions` in
// @hearth/shared, where the web app can do it without another round trip per keystroke.
export async function listSourceNames(
  householdId: string,
): Promise<{ name: string; count: number }[]> {
  return withHousehold(householdId, (tx) =>
    tx
      .select({ name: sql<string>`${recipe.sourceName}`, count: sql<number>`count(*)::int` })
      .from(recipe)
      .where(and(eq(recipe.householdId, householdId), isNotNull(recipe.sourceName)))
      .groupBy(recipe.sourceName)
      .orderBy(desc(sql`count(*)`), asc(recipe.sourceName)),
  );
}

// How many tag chips the Library offers. D30's chips are a no-typing browse path, not a tag
// index: past a dozen they stop being scannable in a row, and the Filters sheet is the way in.
export const TAG_CHIP_LIMIT = 12;

export interface TagCount {
  name: string;
  normalizedName: string;
  count: number;
}

// The household's most-used tags with the number of recipes behind each, for D30's quick filter
// chips. A tag no recipe carries is left out: a chip that can only produce an empty grid is
// worse than no chip, and an INNER JOIN says so without a HAVING clause. Ties break on name, so
// the row of chips is stable between calls rather than reshuffling on every render.
export async function listTagCounts(householdId: string): Promise<TagCount[]> {
  return withHousehold(householdId, (tx) =>
    tx
      .select({
        name: tag.name,
        normalizedName: tag.normalizedName,
        // `::int` because Postgres counts in bigint, which node-postgres hands back as a string.
        count: sql<number>`count(*)::int`,
      })
      .from(tag)
      .innerJoin(recipeTags, eq(recipeTags.tagId, tag.id))
      .where(eq(tag.householdId, householdId))
      .groupBy(tag.id)
      .orderBy(desc(sql`count(*)`), asc(tag.name))
      .limit(TAG_CHIP_LIMIT),
  );
}

// Canonical UUID (any version). Used to decide whether `idOrSlug` may match the
// `recipe.id` uuid column: comparing a non-UUID string to a uuid column errors in
// Postgres ("invalid input syntax for type uuid"), so we only compare the id column
// when the input is actually shaped like a UUID. Slugs are always compared.
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// Fetch a fully assembled recipe (scalars + ordered ingredients with joined
// food name/department + ordered steps + tag names) scoped to one household.
// Returns `null` when nothing matches — including when the recipe belongs to
// another household (both the explicit `householdId` filter and RLS enforce this).
// `idOrSlug` may be either the recipe's UUID or its slug.
export async function getRecipe(
  householdId: string,
  idOrSlug: string,
): Promise<AssembledRecipe | null> {
  return withHousehold(householdId, async (tx) => {
    // Match on slug always; also on id only when the input is a valid UUID, to
    // avoid a Postgres cast error when a slug is passed against the uuid column.
    const identifier = UUID_RE.test(idOrSlug)
      ? or(eq(recipe.id, idOrSlug), eq(recipe.slug, idOrSlug))
      : eq(recipe.slug, idOrSlug);

    const [row] = await tx
      .select()
      .from(recipe)
      .where(and(eq(recipe.householdId, householdId), identifier));
    if (!row) return null;

    const linked = alias(recipe, 'linked');
    const ingredientRows = await tx
      .select({
        id: recipeIngredient.id,
        position: recipeIngredient.position,
        quantity: recipeIngredient.quantity,
        unit: recipeIngredient.unit,
        altQuantity: recipeIngredient.altQuantity,
        altUnit: recipeIngredient.altUnit,
        note: recipeIngredient.note,
        rawText: recipeIngredient.rawText,
        scalingMode: recipeIngredient.scalingModeValue,
        foodId: recipeIngredient.foodId,
        foodName: food.name,
        department: food.department,
        linkedId: linked.id,
        linkedSlug: linked.slug,
        linkedTitle: linked.title,
      })
      .from(recipeIngredient)
      .leftJoin(food, eq(recipeIngredient.foodId, food.id))
      .leftJoin(linked, eq(recipeIngredient.linkedRecipeId, linked.id))
      .where(eq(recipeIngredient.recipeId, row.id))
      .orderBy(asc(recipeIngredient.position));

    const stepRows = await tx
      .select({
        id: recipeStep.id,
        position: recipeStep.position,
        text: recipeStep.text,
      })
      .from(recipeStep)
      .where(eq(recipeStep.recipeId, row.id))
      .orderBy(asc(recipeStep.position));

    const tagRows = await tx
      .select({ name: tag.name })
      .from(recipeTags)
      .innerJoin(tag, eq(recipeTags.tagId, tag.id))
      .where(eq(recipeTags.recipeId, row.id));

    // Recipes that use this one, once each even when one names it on two lines.
    const usedInRows = await tx
      .selectDistinct({ id: recipe.id, slug: recipe.slug, title: recipe.title })
      .from(recipeIngredient)
      .innerJoin(recipe, eq(recipeIngredient.recipeId, recipe.id))
      .where(
        and(
          eq(recipeIngredient.householdId, householdId),
          eq(recipeIngredient.linkedRecipeId, row.id),
        ),
      )
      .orderBy(asc(recipe.title));

    return {
      id: row.id,
      title: row.title,
      slug: row.slug,
      description: row.description,
      servings: row.servings,
      prepMinutes: row.prepMinutes,
      cookMinutes: row.cookMinutes,
      sourceUrl: row.sourceUrl,
      sourceName: row.sourceName,
      mealTypes: row.mealTypes,
      ingredients: ingredientRows.map((i) => ({
        id: i.id,
        position: i.position,
        // `numeric` comes back as a string (or null); coerce to number for the client.
        quantity: i.quantity == null ? null : Number(i.quantity),
        unit: i.unit,
        altQuantity: i.altQuantity == null ? null : Number(i.altQuantity),
        altUnit: i.altUnit,
        note: i.note,
        rawText: i.rawText,
        scalingMode: i.scalingMode,
        foodId: i.foodId,
        foodName: i.foodName,
        department: i.department,
        linkedRecipe:
          i.linkedId === null
            ? null
            : { id: i.linkedId, slug: i.linkedSlug!, title: i.linkedTitle! },
      })),
      steps: stepRows.map((s) => ({ id: s.id, position: s.position, text: s.text })),
      tags: tagRows.map((t) => t.name),
      usedIn: usedInRows,
      files: await listRecipeFiles(tx, row.id),
      coverFileId: row.coverFileId,
      rating: row.rating,
    };
  });
}
