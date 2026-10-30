import { and, eq, isNull, isNotNull, asc, sql } from 'drizzle-orm';
import { TRPCError } from '@trpc/server';
import {
  scale,
  itemMergeKey,
  isNeverBought,
  parseIngredientLine,
  type ScalingMode,
} from '@hearth/shared';
import {
  shoppingList,
  shoppingListItem,
  recipe,
  recipeIngredient,
  food,
  type ShoppingList,
} from '../db/schema';
import { withHousehold, type Tx } from './tenant';
import { findOrCreateFood } from './foods';

export type ItemSource = 'recipe' | 'manual';

// The client-facing shape of a shopping-list item. Mirrors the row, but the
// `numeric` quantity column (a string|null in Postgres/Drizzle) is coerced to a
// number|null for ergonomic use on the client (design decision: quantities are
// numbers everywhere above the repo boundary).
export interface ShoppingItem {
  id: string;
  householdId: string;
  listId: string;
  foodId: string | null;
  name: string;
  quantity: number | null;
  unit: string | null;
  note: string | null;
  department: string | null;
  checked: boolean;
  source: ItemSource;
  sourceRecipeId: string | null;
  position: number;
}

export interface ActiveList {
  list: ShoppingList;
  items: ShoppingItem[];
}

// Patch shape for `updateItem` — only these scalar fields are editable. Quantity
// is accepted as a number|null and stored back as the numeric column's string|null.
export interface ItemPatch {
  name?: string;
  quantity?: number | null;
  unit?: string | null;
  department?: string | null;
  position?: number;
}

// Map a raw DB row to the client shape, coercing the numeric quantity string to a
// number (or null). Single place the string<->number boundary is crossed on read.
function toItem(row: typeof shoppingListItem.$inferSelect): ShoppingItem {
  return {
    id: row.id,
    householdId: row.householdId,
    listId: row.listId,
    foodId: row.foodId,
    name: row.name,
    quantity: row.quantity == null ? null : Number(row.quantity),
    unit: row.unit,
    note: row.note,
    department: row.department,
    checked: row.checked,
    source: row.source,
    sourceRecipeId: row.sourceRecipeId,
    position: row.position,
  };
}

// Get the household's single shopping list, creating it on first access. The MVP
// models exactly one active list per household, so we take the first existing row
// (there should only ever be one) or insert a fresh one.
async function getOrCreateList(tx: Tx, householdId: string): Promise<ShoppingList> {
  const [existing] = await tx
    .select()
    .from(shoppingList)
    .where(eq(shoppingList.householdId, householdId))
    .orderBy(asc(shoppingList.createdAt))
    .limit(1);
  if (existing) return existing;

  const [created] = await tx.insert(shoppingList).values({ householdId }).returning();
  return created!;
}

// Load the active list plus its items in a STABLE display order: by department
// (NULLs last, so uncategorised items sink to the bottom), then position, then
// name. Grouping into department sections is a client concern; the repo only
// guarantees a deterministic order. Runs on a caller-supplied tx so it can be
// reused inside larger mutations (e.g. addRecipeToList) within one transaction.
async function loadActiveList(tx: Tx, householdId: string): Promise<ActiveList> {
  const list = await getOrCreateList(tx, householdId);

  const rows = await tx
    .select()
    .from(shoppingListItem)
    .where(and(eq(shoppingListItem.householdId, householdId), eq(shoppingListItem.listId, list.id)))
    .orderBy(
      sql`${shoppingListItem.department} asc nulls last`,
      asc(shoppingListItem.position),
      asc(shoppingListItem.name),
    );

  return { list, items: rows.map(toItem) };
}

// The next `position` value for a new item in a list: (current max) + 1, or 0 for
// an empty list. Positions are dense-ish append order; gaps left by deletes are
// fine (order only needs to be monotonic, not contiguous).
async function nextPosition(tx: Tx, listId: string): Promise<number> {
  const [row] = await tx
    .select({ max: sql<number | null>`max(${shoppingListItem.position})` })
    .from(shoppingListItem)
    .where(eq(shoppingListItem.listId, listId));
  const max = row?.max;
  return max == null ? 0 : Number(max) + 1;
}

// ── Public API ──────────────────────────────────────────────────────────────

// Return the household's active shopping list (created on first access) plus its
// items in stable display order.
export async function getActiveList(householdId: string): Promise<ActiveList> {
  return withHousehold(householdId, (tx) => loadActiveList(tx, householdId));
}

interface Candidate {
  foodId: string | null;
  name: string;
  quantity: number | null;
  unit: string | null;
  note: string | null;
  department: string | null;
  sourceRecipeId: string;
}

// Add a recipe's ingredients to the active list, scaled from the recipe's own
// serving count to `servings`, aggregating where possible.
//
// Aggregation (design decision 3, via `itemMergeKey`): a candidate merges into an
// existing RECIPE item on the same list when they share a non-null food, the same
// unit (both-null units count as equal), and both carry a real quantity — in which
// case the quantities are summed. Unmatched foods and "to taste" (null quantity)
// lines never merge and always insert a new row. Manual items are intentionally
// excluded from the merge target (a hand-added staple keeps its own row), so a
// recipe never mutates a manual item's quantity.
//
// Not-found handling: an unknown recipe id, or one owned by another household,
// isn't visible here (household filter + RLS), so we throw a clear error rather
// than silently no-op — callers treat this as a bad request.
export async function addRecipeToList(
  householdId: string,
  recipeId: string,
  servings: number,
): Promise<ActiveList> {
  return withHousehold(householdId, async (tx) => {
    await addRecipeToListTx(tx, householdId, recipeId, servings);
    return loadActiveList(tx, householdId);
  });
}

// How many links deep the list follows (pizza → dough → poolish is two), and how many linked
// recipes one add may expand in total, so a recipe that links the same sub-recipe on many lines,
// many levels down, cannot turn one add into thousands of queries. Past either, or on a link
// back to a recipe already being expanded, the line goes on the list as itself.
const MAX_LINK_DEPTH = 5;
const MAX_EXPANSIONS = 50;

// A recipe's shopping candidates at `servingsFor(its own servings)`, with every linked line
// replaced by the linked recipe's own candidates. A linked line stands for whole batches of that recipe: one batch per
// unit of a unitless quantity ("2 pizza doughs"), and one batch when the line has a unit
// ("250 g starter" is not 250 batches), scaled with the recipe it is in, so doubling Binulati
// doubles the dough. `expanding` holds the recipes on the current path; `budget` counts the
// expansions left for the whole add.
async function recipeCandidates(
  tx: Tx,
  householdId: string,
  recipeId: string,
  servingsFor: (base: number) => number,
  expanding: ReadonlySet<string>,
  budget: { left: number },
): Promise<Candidate[] | null> {
  const [recipeRow] = await tx
    .select({ id: recipe.id, servings: recipe.servings })
    .from(recipe)
    .where(and(eq(recipe.householdId, householdId), eq(recipe.id, recipeId)));
  if (!recipeRow) return null;

  const ingredients = await tx
    .select({
      foodId: recipeIngredient.foodId,
      quantity: recipeIngredient.quantity,
      unit: recipeIngredient.unit,
      note: recipeIngredient.note,
      rawText: recipeIngredient.rawText,
      scalingMode: recipeIngredient.scalingModeValue,
      linkedRecipeId: recipeIngredient.linkedRecipeId,
      foodName: food.name,
      department: food.department,
    })
    .from(recipeIngredient)
    .leftJoin(food, eq(recipeIngredient.foodId, food.id))
    .where(eq(recipeIngredient.recipeId, recipeRow.id))
    .orderBy(asc(recipeIngredient.position));

  const path = new Set(expanding).add(recipeRow.id);
  const servingsChange = { from: recipeRow.servings, to: servingsFor(recipeRow.servings) };
  const candidates: Candidate[] = [];
  for (const ing of ingredients) {
    const quantity = ing.quantity == null ? null : Number(ing.quantity);
    const mode = ing.scalingMode as ScalingMode;

    const linked = ing.linkedRecipeId;
    if (linked !== null && !path.has(linked) && path.size <= MAX_LINK_DEPTH && budget.left > 0) {
      budget.left--;
      const perRecipe = ing.unit === null && quantity !== null ? quantity : 1;
      const batches = scale({ quantity: perRecipe, mode }, servingsChange) ?? 1;
      const expanded = await recipeCandidates(
        tx,
        householdId,
        linked,
        (base) => base * batches,
        path,
        budget,
      );
      if (expanded) {
        candidates.push(...expanded);
        continue;
      }
    }

    // Water is in the recipe and never on the list (`isNeverBought`). An ingredient with no
    // Food is judged by the food its line parses to.
    if (isNeverBought(ing.foodName ?? parseIngredientLine(ing.rawText).foodName)) continue;

    candidates.push({
      foodId: ing.foodId,
      // Fall back to the raw line when the ingredient isn't mapped to a food.
      name: ing.foodName ?? ing.rawText,
      quantity: scale({ quantity, mode }, servingsChange),
      unit: ing.unit,
      note: ing.note,
      department: ing.department,
      sourceRecipeId: recipeRow.id,
    });
  }
  return candidates;
}

// The body of `addRecipeToList` on a caller's transaction, so the planner's Build shopping list
// adds a week of recipes in one transaction and aggregates exactly as adding them one by one.
// Linked recipes are expanded into their ingredients, and each such item's `sourceRecipeId` is
// the recipe it came from (the dough, not the pizza).
export async function addRecipeToListTx(
  tx: Tx,
  householdId: string,
  recipeId: string,
  servings: number,
): Promise<void> {
  const candidates = await recipeCandidates(tx, householdId, recipeId, () => servings, new Set(), {
    left: MAX_EXPANSIONS,
  });
  if (!candidates) {
    throw new TRPCError({ code: 'NOT_FOUND', message: 'Recipe not found' });
  }

  const list = await getOrCreateList(tx, householdId);
  let position = await nextPosition(tx, list.id);

  for (const candidate of candidates) {
    const key = itemMergeKey({
      foodId: candidate.foodId,
      unit: candidate.unit,
      quantity: candidate.quantity,
    });

    if (key !== null) {
      // key non-null guarantees foodId and quantity are non-null.
      const [existing] = await tx
        .select()
        .from(shoppingListItem)
        .where(
          and(
            eq(shoppingListItem.householdId, householdId),
            eq(shoppingListItem.listId, list.id),
            eq(shoppingListItem.source, 'recipe'),
            // Never top up an item that's already checked off — a re-add of a
            // food whose only prior row is "done" must surface as a fresh,
            // active (unchecked) row, not silently vanish into the Done group.
            eq(shoppingListItem.checked, false),
            eq(shoppingListItem.foodId, candidate.foodId!),
            // both-null units are equal; a named unit matches exactly.
            candidate.unit == null
              ? isNull(shoppingListItem.unit)
              : eq(shoppingListItem.unit, candidate.unit),
            isNotNull(shoppingListItem.quantity),
          ),
        )
        .limit(1);

      if (existing) {
        // Re-round the merged sum the SAME way `scale()` does (3 dp) so
        // floating-point noise (e.g. 0.1 + 0.2) never leaks to the client.
        const sum = Math.round((Number(existing.quantity) + candidate.quantity!) * 1000) / 1000;
        await tx
          .update(shoppingListItem)
          .set({ quantity: String(sum) })
          .where(
            and(
              eq(shoppingListItem.householdId, householdId),
              eq(shoppingListItem.id, existing.id),
            ),
          );
        continue;
      }
    }

    await tx.insert(shoppingListItem).values({
      householdId,
      listId: list.id,
      foodId: candidate.foodId,
      name: candidate.name,
      quantity: candidate.quantity == null ? null : String(candidate.quantity),
      unit: candidate.unit,
      note: candidate.note,
      department: candidate.department,
      checked: false,
      source: 'recipe',
      sourceRecipeId: candidate.sourceRecipeId,
      position: position++,
    });
  }
}

// Add a single hand-typed staple to the active list. The line is parsed for a
// leading quantity/unit; the food name (if any) is resolved to a `food` row so the
// item inherits a department. Manual items are NEVER aggregated — a hand-added
// staple always becomes its own row (see addRecipeToList for the recipe path).
export async function addManualItem(householdId: string, text: string): Promise<ShoppingItem> {
  return withHousehold(householdId, async (tx) => {
    const parsed = parseIngredientLine(text);
    const foodRow =
      parsed.foodName === '' ? null : await findOrCreateFood(tx, householdId, parsed.foodName);

    const list = await getOrCreateList(tx, householdId);
    const position = await nextPosition(tx, list.id);

    const [created] = await tx
      .insert(shoppingListItem)
      .values({
        householdId,
        listId: list.id,
        foodId: foodRow?.id ?? null,
        name: parsed.foodName || text,
        quantity: parsed.quantity == null ? null : String(parsed.quantity),
        unit: parsed.unit,
        note: parsed.note,
        department: foodRow?.department ?? null,
        checked: false,
        source: 'manual',
        sourceRecipeId: null,
        position,
      })
      .returning();

    return toItem(created!);
  });
}

// Update the editable scalar fields of one item, household-scoped. Only whitelisted
// fields are touched; quantity crosses the number->string boundary here. Returns the
// updated item, or null when no item with `itemId` belongs to the household.
export async function updateItem(
  householdId: string,
  itemId: string,
  patch: ItemPatch,
): Promise<ShoppingItem | null> {
  return withHousehold(householdId, async (tx) => {
    const set: Partial<typeof shoppingListItem.$inferInsert> = {};
    if (patch.name !== undefined) set.name = patch.name;
    if (patch.quantity !== undefined) {
      set.quantity = patch.quantity == null ? null : String(patch.quantity);
    }
    if (patch.unit !== undefined) set.unit = patch.unit;
    if (patch.department !== undefined) set.department = patch.department;
    if (patch.position !== undefined) set.position = patch.position;

    // Nothing to change: return the current row (scoped) unchanged.
    if (Object.keys(set).length === 0) {
      const [row] = await tx
        .select()
        .from(shoppingListItem)
        .where(and(eq(shoppingListItem.householdId, householdId), eq(shoppingListItem.id, itemId)));
      return row ? toItem(row) : null;
    }

    const [updated] = await tx
      .update(shoppingListItem)
      .set(set)
      .where(and(eq(shoppingListItem.householdId, householdId), eq(shoppingListItem.id, itemId)))
      .returning();

    return updated ? toItem(updated) : null;
  });
}

// Toggle an item's `checked` flag, household-scoped. Returns the updated item, or
// null when no matching item belongs to the household.
export async function setChecked(
  householdId: string,
  itemId: string,
  checked: boolean,
): Promise<ShoppingItem | null> {
  return withHousehold(householdId, async (tx) => {
    const [updated] = await tx
      .update(shoppingListItem)
      .set({ checked })
      .where(and(eq(shoppingListItem.householdId, householdId), eq(shoppingListItem.id, itemId)))
      .returning();
    return updated ? toItem(updated) : null;
  });
}

// Delete one item, household-scoped. Returns true when a row was removed, false
// otherwise (missing id or another household's item).
export async function removeItem(householdId: string, itemId: string): Promise<boolean> {
  return withHousehold(householdId, async (tx) => {
    const deleted = await tx
      .delete(shoppingListItem)
      .where(and(eq(shoppingListItem.householdId, householdId), eq(shoppingListItem.id, itemId)))
      .returning({ id: shoppingListItem.id });
    return deleted.length > 0;
  });
}

// Delete every checked item on the household's active list. Returns the number of
// items removed.
export async function clearChecked(householdId: string): Promise<number> {
  return withHousehold(householdId, async (tx) => {
    const list = await getOrCreateList(tx, householdId);
    const deleted = await tx
      .delete(shoppingListItem)
      .where(
        and(
          eq(shoppingListItem.householdId, householdId),
          eq(shoppingListItem.listId, list.id),
          eq(shoppingListItem.checked, true),
        ),
      )
      .returning({ id: shoppingListItem.id });
    return deleted.length;
  });
}
