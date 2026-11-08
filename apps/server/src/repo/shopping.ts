import { and, eq, ne, inArray, isNull, isNotNull, asc, sql } from 'drizzle-orm';
import { TRPCError } from '@trpc/server';
import {
  scale,
  itemMergeKey,
  mergeUnit,
  unitFactor,
  unitFamily,
  unitsInFamily,
  isNeverBought,
  parseIngredientLine,
  quantityToBuy,
  type ScalingMode,
} from '@hearth/shared';
import type { ListAmount } from '@hearth/shared';
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

export interface Candidate {
  foodId: string | null;
  name: string;
  quantity: number | null;
  unit: string | null;
  note: string | null;
  department: string | null;
  sourceRecipeId: string;
}

// Add a recipe's ingredients to the active list, scaled from the recipe's own
// serving count to `servings`, aggregating where possible. A range buys its high end
// (`quantityToBuy`, D53), and from there it aggregates like any single amount.
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
      quantityHigh: recipeIngredient.quantityHigh,
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
    // The high end of a range ("2-3 cloves" buys 3), so the list never runs short (D53).
    const quantity = quantityToBuy(
      ing.quantity == null ? null : Number(ing.quantity),
      ing.quantityHigh == null ? null : Number(ing.quantityHigh),
    );
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
  const candidates = await recipeListCandidates(tx, householdId, recipeId, servings);
  if (!candidates) {
    throw new TRPCError({ code: 'NOT_FOUND', message: 'Recipe not found' });
  }
  await addCandidatesTx(tx, householdId, candidates);
}

// What adding a recipe at `servings` would put on the list, linked recipes expanded; null when
// the household has no such recipe.
export async function recipeListCandidates(
  tx: Tx,
  householdId: string,
  recipeId: string,
  servings: number,
): Promise<Candidate[] | null> {
  return recipeCandidates(tx, householdId, recipeId, () => servings, new Set(), {
    left: MAX_EXPANSIONS,
  });
}

// Put candidates on the active list, each merged into a matching item or added as its own row.
export async function addCandidatesTx(
  tx: Tx,
  householdId: string,
  candidates: Candidate[],
): Promise<void> {
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

      // Added in the database rather than read-add-write, so an amount edited on another phone
      // in the meantime is added to, not overwritten.
      if (
        existing &&
        (await addToAmount(tx, householdId, existing.id, {
          quantity: candidate.quantity!,
          unit: candidate.unit,
        }))
      ) {
        continue;
      }
      if (await mergeInFamily(tx, householdId, list.id, candidate)) continue;
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

// Take `quantity` of a food in `unit` off the active list's unchecked recipe items: the item in
// that unit first, then any in the same family (#12, D61). An item brought to zero is removed.
// Checked items are bought and never taken from, so whatever cannot be taken is left alone.
export async function subtractFromListTx(
  tx: Tx,
  householdId: string,
  { foodId, quantity, unit }: { foodId: string; quantity: number; unit: string | null },
): Promise<void> {
  const list = await getOrCreateList(tx, householdId);
  const family = unitFamily(unit);
  const rows = await tx
    .select({
      id: shoppingListItem.id,
      quantity: shoppingListItem.quantity,
      unit: shoppingListItem.unit,
    })
    .from(shoppingListItem)
    .where(
      and(
        eq(shoppingListItem.householdId, householdId),
        eq(shoppingListItem.listId, list.id),
        eq(shoppingListItem.source, 'recipe'),
        eq(shoppingListItem.checked, false),
        eq(shoppingListItem.foodId, foodId),
        isNotNull(shoppingListItem.quantity),
        unit === null
          ? isNull(shoppingListItem.unit)
          : family === null
            ? eq(shoppingListItem.unit, unit)
            : inArray(shoppingListItem.unit, unitsInFamily(family)),
      ),
    )
    .orderBy(asc(shoppingListItem.position))
    .for('update');
  // The same unit first, so a cup comes off the cup row before a tbsp row is converted.
  rows.sort((x, y) => Number(x.unit !== unit) - Number(y.unit !== unit));

  let left = quantity; // in `unit`
  for (const row of rows) {
    if (left <= 0) break;
    const toRow = row.unit === unit ? 1 : unitFactor(unit!, row.unit!);
    if (toRow === null) continue;
    const have = Number(row.quantity);
    const take = Math.min(have, left * toRow);
    const rest = Math.round((have - take) * 1000) / 1000;
    const where = and(eq(shoppingListItem.householdId, householdId), eq(shoppingListItem.id, row.id));
    if (rest <= 0) await tx.delete(shoppingListItem).where(where);
    else await tx.update(shoppingListItem).set({ quantity: String(rest) }).where(where);
    left -= take / toRow;
  }
}

// Merge a candidate into an unchecked recipe item of the same food whose unit is in the same
// family (#17, D13): "4 tbsp flour" and "1 cup flour" become "1.25 cup flour". The item is kept in
// `mergeUnit`'s choice, so its own amount is converted too, in the same statement and only while
// it still has the unit it was read with. Volume never meets weight, and a count unit has no
// family, so those stay separate rows. Returns whether it merged.
async function mergeInFamily(
  tx: Tx,
  householdId: string,
  listId: string,
  candidate: Candidate,
): Promise<boolean> {
  const family = unitFamily(candidate.unit);
  if (family === null || candidate.foodId === null || candidate.quantity === null) return false;
  const [existing] = await tx
    .select({ id: shoppingListItem.id, unit: shoppingListItem.unit })
    .from(shoppingListItem)
    .where(
      and(
        eq(shoppingListItem.householdId, householdId),
        eq(shoppingListItem.listId, listId),
        eq(shoppingListItem.source, 'recipe'),
        eq(shoppingListItem.checked, false),
        eq(shoppingListItem.foodId, candidate.foodId),
        inArray(shoppingListItem.unit, unitsInFamily(family)),
        isNotNull(shoppingListItem.quantity),
      ),
    )
    .orderBy(asc(shoppingListItem.position))
    .limit(1);
  if (!existing?.unit) return false;

  const target = mergeUnit(existing.unit, candidate.unit!);
  const existingFactor = target === null ? null : unitFactor(existing.unit, target);
  const adding = target === null ? null : unitFactor(candidate.unit!, target);
  if (target === null || existingFactor === null || adding === null) return false;

  const updated = await tx
    .update(shoppingListItem)
    .set({
      quantity: sql`round(${shoppingListItem.quantity} * ${String(existingFactor)}::numeric + ${String(candidate.quantity * adding)}::numeric, 3)`,
      unit: target,
    })
    .where(
      and(
        eq(shoppingListItem.householdId, householdId),
        eq(shoppingListItem.id, existing.id),
        eq(shoppingListItem.checked, false),
        eq(shoppingListItem.unit, existing.unit),
        isNotNull(shoppingListItem.quantity),
      ),
    )
    .returning({ id: shoppingListItem.id });
  return updated.length > 0;
}

// Add `quantity` to an item's amount in one statement, re-rounded to 3 dp the way `scale()`
// rounds, so floating-point noise (0.1 + 0.2) never reaches the client. Only while the item is
// still unchecked with an amount in `unit`, which another phone may have changed since it was
// read; returns whether it added.
async function addToAmount(
  tx: Tx,
  householdId: string,
  itemId: string,
  { quantity, unit }: { quantity: number; unit: string | null },
): Promise<boolean> {
  const updated = await tx
    .update(shoppingListItem)
    .set({ quantity: sql`round(${shoppingListItem.quantity} + ${String(quantity)}::numeric, 3)` })
    .where(
      and(
        eq(shoppingListItem.householdId, householdId),
        eq(shoppingListItem.id, itemId),
        eq(shoppingListItem.checked, false),
        unit == null ? isNull(shoppingListItem.unit) : eq(shoppingListItem.unit, unit),
        isNotNull(shoppingListItem.quantity),
      ),
    )
    .returning({ id: shoppingListItem.id });
  return updated.length > 0;
}

// Add a single hand-typed staple to the active list. The line is parsed for a
// leading quantity/unit; the food name (if any) is resolved to a `food` row so the
// item inherits a department. Manual items are NEVER aggregated — a hand-added
// staple always becomes its own row (see addRecipeToList for the recipe path).
export async function addManualItem(householdId: string, text: string): Promise<ShoppingItem> {
  return withHousehold(householdId, async (tx) => {
    const parsed = parseIngredientLine(text);
    // "2-3 limes" typed onto the list is 3, as a recipe's range would be (D53).
    const toBuy = quantityToBuy(parsed.quantity, parsed.quantityHigh ?? null);
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
        quantity: toBuy == null ? null : String(toBuy),
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

const sameAmount = (row: { quantity: string | null; unit: string | null }, amount: ListAmount) =>
  (row.quantity == null ? null : Number(row.quantity)) === amount.quantity &&
  row.unit === amount.unit;

// Set one item's amount and unit to what the cook typed (parsed by the caller), D54.
//
// - `seen` is the amount the cook was looking at when they started the edit. If the item no
//   longer has it (another phone edited it, or a recipe was added onto it), the edit is refused
//   with CONFLICT rather than overwriting that change. The row is locked while it is compared.
// - Setting the amount the item already has succeeds without a change, so a resent request
//   (a dropped signal) is harmless.
// - The edit is the item's new amount: a later recipe add of the same food and unit adds to it.
// - When the UNIT changes on an unchecked recipe item and another unchecked recipe item of the
//   same food already has the new unit, the two merge, exactly as two recipe adds would: that
//   row takes the sum and the edited row is deleted. Staples and checked rows never merge, as on
//   add, and a change of amount alone never merges rows.
// Returns the item that holds the amount afterwards (the merged-into row on a merge).
export async function setItemAmount(
  householdId: string,
  itemId: string,
  amount: ListAmount,
  seen: ListAmount,
): Promise<ShoppingItem> {
  return withHousehold(householdId, async (tx) => {
    const [row] = await tx
      .select()
      .from(shoppingListItem)
      .where(and(eq(shoppingListItem.householdId, householdId), eq(shoppingListItem.id, itemId)))
      .for('update');
    if (!row) throw new TRPCError({ code: 'NOT_FOUND', message: 'Item not found' });
    if (sameAmount(row, amount)) return toItem(row);
    if (!sameAmount(row, seen)) {
      throw new TRPCError({ code: 'CONFLICT', message: 'Item amount changed' });
    }

    const mergeable =
      amount.unit !== row.unit &&
      amount.quantity !== null &&
      row.foodId !== null &&
      row.source === 'recipe' &&
      !row.checked;
    if (mergeable) {
      const [target] = await tx
        .select({ id: shoppingListItem.id })
        .from(shoppingListItem)
        .where(
          and(
            eq(shoppingListItem.householdId, householdId),
            eq(shoppingListItem.listId, row.listId),
            ne(shoppingListItem.id, row.id),
            eq(shoppingListItem.source, 'recipe'),
            eq(shoppingListItem.checked, false),
            eq(shoppingListItem.foodId, row.foodId!),
            amount.unit == null
              ? isNull(shoppingListItem.unit)
              : eq(shoppingListItem.unit, amount.unit),
            isNotNull(shoppingListItem.quantity),
          ),
        )
        .orderBy(asc(shoppingListItem.position))
        .limit(1)
        .for('update');
      if (
        target &&
        (await addToAmount(tx, householdId, target.id, {
          quantity: amount.quantity!,
          unit: amount.unit,
        }))
      ) {
        await tx
          .delete(shoppingListItem)
          .where(
            and(eq(shoppingListItem.householdId, householdId), eq(shoppingListItem.id, row.id)),
          );
        const [merged] = await tx
          .select()
          .from(shoppingListItem)
          .where(
            and(eq(shoppingListItem.householdId, householdId), eq(shoppingListItem.id, target.id)),
          );
        return toItem(merged!);
      }
    }

    const [updated] = await tx
      .update(shoppingListItem)
      .set({
        quantity: amount.quantity == null ? null : String(amount.quantity),
        unit: amount.unit,
      })
      .where(and(eq(shoppingListItem.householdId, householdId), eq(shoppingListItem.id, row.id)))
      .returning();
    return toItem(updated!);
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
