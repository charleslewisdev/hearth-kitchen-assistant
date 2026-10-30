import { and, asc, count, eq, ne, sql } from 'drizzle-orm';
import { TRPCError } from '@trpc/server';
import { normalizeFoodName, departmentFor } from '@hearth/shared';
import { food, recipeIngredient, shoppingListItem, type Food } from '../db/schema';
import { FOOD_NAME_TAKEN_MESSAGE } from '../messages';
import { withHousehold } from './tenant';
import type { Tx } from './tenant';

// Find the canonical `food` row for a raw user-entered name within a household,
// creating it if absent. Dedup is by `normalizedName` so "Tomatoes" and "tomato"
// fold to one row. Takes a `tx` (from `withHousehold`) so it composes inside the
// recipe-create transaction later. Scoped to `householdId` at the app layer;
// RLS enforces the same boundary structurally.
export async function findOrCreateFood(
  tx: Tx,
  householdId: string,
  rawFoodName: string,
): Promise<Food> {
  const normalizedName = normalizeFoodName(rawFoodName);

  const [existing] = await tx
    .select()
    .from(food)
    .where(and(eq(food.householdId, householdId), eq(food.normalizedName, normalizedName)));
  if (existing) return existing;

  const [created] = await tx
    .insert(food)
    .values({
      householdId,
      name: rawFoodName,
      normalizedName,
      department: departmentFor(normalizedName),
    })
    .returning();
  return created!;
}

// What the Library's search box needs to offer a `contains {ingredient}` token, and nothing more.
export interface FoodSuggestion {
  id: string;
  name: string;
  normalizedName: string;
}

// How many suggestions one keystroke may produce. A display bound rather than a page size:
// nobody scrolls an autocomplete list, so there is no second page to ask for.
export const FOOD_SUGGESTION_LIMIT = 20;

// The household's foods whose canonical name starts with `q`, for D30's `contains {ingredient}`
// autocomplete. Deliberately narrow: this is not a general food API and should not grow into one.
//
// `q` is normalized the way stored names are, so the plural a cook types ("tomatoes") finds the
// row their recipe created ("tomato"). `starts_with` rather than LIKE because the input comes
// straight from a search box, and LIKE would need `%` and `_` escaped before it meant what was
// typed.
//
// A blank query returns nothing rather than the whole pantry: there is no token to offer for
// something nobody has typed yet. Scoped to the household via `withHousehold` + an explicit
// filter (RLS enforces the same boundary).
export async function searchFoods(householdId: string, q: string): Promise<FoodSuggestion[]> {
  const prefix = normalizeFoodName(q);
  if (prefix === '') return [];

  return withHousehold(householdId, (tx) =>
    tx
      .select({ id: food.id, name: food.name, normalizedName: food.normalizedName })
      .from(food)
      .where(
        and(eq(food.householdId, householdId), sql`starts_with(${food.normalizedName}, ${prefix})`),
      )
      .orderBy(asc(food.normalizedName))
      .limit(FOOD_SUGGESTION_LIMIT),
  );
}

// ── The Foods screen ────────────────────────────────────────────────────────
//
// Where a cook tidies what the parser made: "scallions" and "green onions" become one food, and
// a food filed under Other gets a department. Merging is the tool, because a food is what the
// shopping list adds up by, so two names for one thing is two lines at the store.

export interface FoodRow {
  id: string;
  name: string;
  normalizedName: string;
  department: string | null;
  /** How many recipe ingredient lines point at it. Zero means nothing but maybe a list item. */
  uses: number;
}

export async function listFoods(householdId: string): Promise<FoodRow[]> {
  return withHousehold(householdId, async (tx) => {
    const rows = await tx
      .select({
        id: food.id,
        name: food.name,
        normalizedName: food.normalizedName,
        department: food.department,
        uses: count(recipeIngredient.id),
      })
      .from(food)
      .leftJoin(recipeIngredient, eq(recipeIngredient.foodId, food.id))
      .where(eq(food.householdId, householdId))
      .groupBy(food.id)
      .orderBy(asc(food.normalizedName), asc(food.id));
    return rows.map((r) => ({ ...r, uses: Number(r.uses) }));
  });
}

async function ownFood(tx: Tx, householdId: string, id: string): Promise<Food> {
  const [row] = await tx
    .select()
    .from(food)
    .where(and(eq(food.householdId, householdId), eq(food.id, id)));
  if (!row) throw new TRPCError({ code: 'NOT_FOUND', message: 'Food not found' });
  return row;
}

// A new display name. Refused when another food already normalizes to it, because two foods
// with one name is the duplicate this screen exists to remove: the cook merges instead.
export async function renameFood(householdId: string, id: string, name: string): Promise<void> {
  return withHousehold(householdId, async (tx) => {
    await ownFood(tx, householdId, id);
    const trimmed = name.trim();
    const normalizedName = normalizeFoodName(trimmed);
    if (normalizedName === '') throw new TRPCError({ code: 'BAD_REQUEST', message: 'Name a food' });
    const [clash] = await tx
      .select({ id: food.id })
      .from(food)
      .where(
        and(
          eq(food.householdId, householdId),
          eq(food.normalizedName, normalizedName),
          ne(food.id, id),
        ),
      )
      .limit(1);
    if (clash) throw new TRPCError({ code: 'CONFLICT', message: FOOD_NAME_TAKEN_MESSAGE });
    await tx
      .update(food)
      .set({ name: trimmed, normalizedName })
      .where(and(eq(food.householdId, householdId), eq(food.id, id)));
  });
}

// File a food under a department, or none. Unchecked list items for it move too, so the list
// regroups now rather than on the next build; checked ones are history and stay where they were.
export async function setFoodDepartment(
  householdId: string,
  id: string,
  department: string | null,
): Promise<void> {
  return withHousehold(householdId, async (tx) => {
    await ownFood(tx, householdId, id);
    await tx
      .update(food)
      .set({ department })
      .where(and(eq(food.householdId, householdId), eq(food.id, id)));
    await tx
      .update(shoppingListItem)
      .set({ department })
      .where(
        and(
          eq(shoppingListItem.householdId, householdId),
          eq(shoppingListItem.foodId, id),
          eq(shoppingListItem.checked, false),
        ),
      );
  });
}

// Fold `fromId` into `intoId`: every recipe line and list item pointing at the first now points
// at the second, and the first is deleted. The recipe lines keep their raw text, so nothing a
// cook typed is lost; only which food it counts as changes.
export async function mergeFoods(
  householdId: string,
  fromId: string,
  intoId: string,
): Promise<void> {
  if (fromId === intoId) {
    throw new TRPCError({ code: 'BAD_REQUEST', message: 'A food cannot merge into itself' });
  }
  return withHousehold(householdId, async (tx) => {
    await ownFood(tx, householdId, fromId);
    const into = await ownFood(tx, householdId, intoId);
    await tx
      .update(recipeIngredient)
      .set({ foodId: intoId })
      .where(
        and(eq(recipeIngredient.householdId, householdId), eq(recipeIngredient.foodId, fromId)),
      );
    await tx
      .update(shoppingListItem)
      .set({ foodId: intoId, name: into.name, department: into.department })
      .where(
        and(eq(shoppingListItem.householdId, householdId), eq(shoppingListItem.foodId, fromId)),
      );
    await tx.delete(food).where(and(eq(food.householdId, householdId), eq(food.id, fromId)));
  });
}

// Delete a food no recipe uses, such as one a since-edited recipe left behind. Refused while a
// recipe line points at it (the foreign key would refuse it too). A list item that named it
// keeps its text and loses only the link.
export async function deleteUnusedFood(householdId: string, id: string): Promise<boolean> {
  return withHousehold(householdId, async (tx) => {
    await ownFood(tx, householdId, id);
    const [used] = await tx
      .select({ n: count() })
      .from(recipeIngredient)
      .where(and(eq(recipeIngredient.householdId, householdId), eq(recipeIngredient.foodId, id)));
    if (Number(used?.n ?? 0) > 0) {
      throw new TRPCError({ code: 'CONFLICT', message: 'Recipes still use this food' });
    }
    const deleted = await tx
      .delete(food)
      .where(and(eq(food.householdId, householdId), eq(food.id, id)))
      .returning({ id: food.id });
    return deleted.length > 0;
  });
}

// Every food no recipe line uses, in one go: what re-parsing or editing recipes leaves behind.
// List items that named one keep their text and lose only the link. Returns how many went.
export async function deleteAllUnusedFoods(householdId: string): Promise<number> {
  return withHousehold(householdId, async (tx) => {
    const deleted = await tx
      .delete(food)
      .where(
        and(
          eq(food.householdId, householdId),
          sql`not exists (select 1 from ${recipeIngredient} where ${recipeIngredient.foodId} = ${food.id})`,
        ),
      )
      .returning({ id: food.id });
    return deleted.length;
  });
}
