import { and, asc, eq, gte, isNull, lt, sql } from 'drizzle-orm';
import { TRPCError } from '@trpc/server';
import { addDays, DAYS_PER_WEEK, weekStartFor } from '@hearth/shared';
import { householdSettings, mealPlanEntry, recipe, type mealType } from '../db/schema';
import { withHousehold, type Tx } from './tenant';

// A plan entry's meal slot: the `meal_type` enum, narrower than a recipe's types.
type MealType = (typeof mealType.enumValues)[number];
import {
  addCandidatesTx,
  addRecipeToListTx,
  recipeListCandidates,
  subtractFromListTx,
  type Candidate,
} from './shopping';

// One planned meal as the Plan screen needs it: the entry, plus enough of its recipe to name it,
// link to it and show the serving count it was written for.
export interface PlanEntry {
  id: string;
  date: string;
  meal: MealType;
  servings: number;
  onList: boolean;
  // The servings the shopping list holds amounts for; null until Build shopping list adds it.
  listServings: number | null;
  recipe: { id: string; slug: string; title: string; servings: number };
}

export interface PlanWeek {
  start: string;
  weekStart: number;
  entries: PlanEntry[];
}

export interface NewEntry {
  date: string;
  meal: MealType;
  recipeId: string;
  servings: number;
}

export interface EntryPatch {
  date?: string;
  meal?: MealType;
  servings?: number;
}

// Defaults for a household with no settings row (D45).
const DEFAULT_WEEK_START = 0;

async function weekStartTx(tx: Tx, householdId: string): Promise<number> {
  const [row] = await tx
    .select({ weekStart: householdSettings.weekStart })
    .from(householdSettings)
    .where(eq(householdSettings.householdId, householdId));
  return row?.weekStart ?? DEFAULT_WEEK_START;
}

// The entries whose day falls in [start, start + 7), joined to their recipes, in the order the
// screen lays them out: by day, then by when they were added, so a slot keeps its order.
async function entriesTx(tx: Tx, householdId: string, start: string, id?: string) {
  const rows = await tx
    .select({
      id: mealPlanEntry.id,
      date: mealPlanEntry.planDate,
      meal: mealPlanEntry.meal,
      servings: mealPlanEntry.servings,
      addedToListAt: mealPlanEntry.addedToListAt,
      listServings: mealPlanEntry.listServings,
      recipeId: recipe.id,
      slug: recipe.slug,
      title: recipe.title,
      recipeServings: recipe.servings,
    })
    .from(mealPlanEntry)
    .innerJoin(recipe, eq(mealPlanEntry.recipeId, recipe.id))
    .where(
      and(
        eq(mealPlanEntry.householdId, householdId),
        id === undefined
          ? and(
              gte(mealPlanEntry.planDate, start),
              lt(mealPlanEntry.planDate, addDays(start, DAYS_PER_WEEK)),
            )
          : eq(mealPlanEntry.id, id),
      ),
    )
    .orderBy(asc(mealPlanEntry.planDate), asc(mealPlanEntry.createdAt), asc(mealPlanEntry.id));

  return rows.map(
    (r): PlanEntry => ({
      id: r.id,
      date: r.date,
      meal: r.meal,
      servings: r.servings,
      onList: r.addedToListAt !== null,
      listServings: r.listServings,
      recipe: { id: r.recipeId, slug: r.slug, title: r.title, servings: r.recipeServings },
    }),
  );
}

async function oneEntryTx(tx: Tx, householdId: string, id: string): Promise<PlanEntry | null> {
  const [entry] = await entriesTx(tx, householdId, '', id);
  return entry ?? null;
}

// ── Public API ──────────────────────────────────────────────────────────────

export async function getWeekStart(householdId: string): Promise<number> {
  return withHousehold(householdId, (tx) => weekStartTx(tx, householdId));
}

export async function setWeekStart(householdId: string, weekStart: number): Promise<number> {
  return withHousehold(householdId, async (tx) => {
    await tx
      .insert(householdSettings)
      .values({ householdId, weekStart })
      .onConflictDoUpdate({ target: householdSettings.householdId, set: { weekStart } });
    return weekStart;
  });
}

// The household's week containing `date`, the client's idea of a day (see plan-week.ts).
export async function getWeek(householdId: string, date: string): Promise<PlanWeek> {
  return withHousehold(householdId, async (tx) => {
    const weekStart = await weekStartTx(tx, householdId);
    const start = weekStartFor(date, weekStart);
    return { start, weekStart, entries: await entriesTx(tx, householdId, start) };
  });
}

// Plan a recipe. An unknown recipe, or one belonging to another household, is not visible here
// (household filter plus RLS), and is refused as NOT_FOUND rather than left to the foreign key.
export async function addEntry(householdId: string, input: NewEntry): Promise<PlanEntry> {
  return withHousehold(householdId, async (tx) => {
    const [found] = await tx
      .select({ id: recipe.id })
      .from(recipe)
      .where(and(eq(recipe.householdId, householdId), eq(recipe.id, input.recipeId)));
    if (!found) throw new TRPCError({ code: 'NOT_FOUND', message: 'Recipe not found' });

    const [created] = await tx
      .insert(mealPlanEntry)
      .values({
        householdId,
        planDate: input.date,
        meal: input.meal,
        recipeId: input.recipeId,
        servings: input.servings,
      })
      .returning({ id: mealPlanEntry.id });
    return (await oneEntryTx(tx, householdId, created!.id))!;
  });
}

// Change servings, or move the entry to another day or meal. Null when the household has no
// such entry. Whether it is already on the list does not change: moving a meal does not buy
// its groceries twice.
export async function updateEntry(
  householdId: string,
  id: string,
  patch: EntryPatch,
): Promise<PlanEntry | null> {
  return withHousehold(householdId, async (tx) => {
    const set: Partial<typeof mealPlanEntry.$inferInsert> = {};
    if (patch.date !== undefined) set.planDate = patch.date;
    if (patch.meal !== undefined) set.meal = patch.meal;
    if (patch.servings !== undefined) set.servings = patch.servings;
    if (Object.keys(set).length > 0) {
      await tx
        .update(mealPlanEntry)
        .set(set)
        .where(and(eq(mealPlanEntry.householdId, householdId), eq(mealPlanEntry.id, id)));
    }
    return oneEntryTx(tx, householdId, id);
  });
}

export async function removeEntry(householdId: string, id: string): Promise<boolean> {
  return withHousehold(householdId, async (tx) => {
    const deleted = await tx
      .delete(mealPlanEntry)
      .where(and(eq(mealPlanEntry.householdId, householdId), eq(mealPlanEntry.id, id)))
      .returning({ id: mealPlanEntry.id });
    return deleted.length > 0;
  });
}

// Build shopping list (D44): add every entry of the week that is not on the list yet, and mark
// it, in one transaction, so a second build adds only what is new. Entries lock with FOR UPDATE
// SKIP LOCKED so two people tapping at once cannot both add the same meal.
export async function buildListForWeek(
  householdId: string,
  start: string,
): Promise<{ added: number }> {
  return withHousehold(householdId, async (tx) => {
    const pending = await tx
      .select({
        id: mealPlanEntry.id,
        recipeId: mealPlanEntry.recipeId,
        servings: mealPlanEntry.servings,
      })
      .from(mealPlanEntry)
      .where(
        and(
          eq(mealPlanEntry.householdId, householdId),
          gte(mealPlanEntry.planDate, start),
          lt(mealPlanEntry.planDate, addDays(start, DAYS_PER_WEEK)),
          isNull(mealPlanEntry.addedToListAt),
        ),
      )
      .orderBy(asc(mealPlanEntry.planDate), asc(mealPlanEntry.createdAt), asc(mealPlanEntry.id))
      .for('update', { skipLocked: true });

    for (const entry of pending) {
      await addRecipeToListTx(tx, householdId, entry.recipeId, entry.servings);
      await tx
        .update(mealPlanEntry)
        .set({ addedToListAt: sql`now()`, listServings: entry.servings })
        .where(and(eq(mealPlanEntry.householdId, householdId), eq(mealPlanEntry.id, entry.id)));
    }
    return { added: pending.length };
  });
}

// The total each food and unit comes to across candidates, for the ones that can be summed (a
// Food and an amount); "to taste" and unmatched lines have nothing to take a difference of.
function totals(candidates: Candidate[]): Map<string, { candidate: Candidate; quantity: number }> {
  const byKey = new Map<string, { candidate: Candidate; quantity: number }>();
  for (const c of candidates) {
    if (c.foodId === null || c.quantity === null) continue;
    const key = `${c.foodId}::${c.unit ?? ''}`;
    const seen = byKey.get(key);
    if (seen) seen.quantity += c.quantity;
    else byKey.set(key, { candidate: c, quantity: c.quantity });
  }
  return byKey;
}

// After a planned meal's servings change, bring the list in step (#12, D61). On 'update', the
// difference between the recipe at the servings on the list and at the planned servings is added
// to the list, or taken off its unchecked items; on 'leave', the list is kept as it is. Either
// way the list now counts as holding the planned servings, so the planner stops asking. A meal
// not on the list, or already in step, is returned unchanged. Null when there is no such entry.
export async function syncListServings(
  householdId: string,
  id: string,
  choice: 'update' | 'leave',
): Promise<PlanEntry | null> {
  return withHousehold(householdId, async (tx) => {
    const [entry] = await tx
      .select({
        recipeId: mealPlanEntry.recipeId,
        servings: mealPlanEntry.servings,
        listServings: mealPlanEntry.listServings,
      })
      .from(mealPlanEntry)
      .where(and(eq(mealPlanEntry.householdId, householdId), eq(mealPlanEntry.id, id)))
      .for('update');
    if (!entry) return null;
    if (entry.listServings === null || entry.listServings === entry.servings) {
      return oneEntryTx(tx, householdId, id);
    }

    if (choice === 'update') {
      const before = await recipeListCandidates(tx, householdId, entry.recipeId, entry.listServings);
      const after = await recipeListCandidates(tx, householdId, entry.recipeId, entry.servings);
      const was = totals(before ?? []);
      const now = totals(after ?? []);
      const adds: Candidate[] = [];
      for (const key of new Set([...was.keys(), ...now.keys()])) {
        const had = was.get(key);
        const has = now.get(key);
        const diff = Math.round(((has?.quantity ?? 0) - (had?.quantity ?? 0)) * 1000) / 1000;
        const { candidate } = (has ?? had)!;
        if (diff > 0) adds.push({ ...candidate, quantity: diff });
        else if (diff < 0) {
          await subtractFromListTx(tx, householdId, {
            foodId: candidate.foodId!,
            quantity: -diff,
            unit: candidate.unit,
          });
        }
      }
      await addCandidatesTx(tx, householdId, adds);
    }

    await tx
      .update(mealPlanEntry)
      .set({ listServings: entry.servings })
      .where(and(eq(mealPlanEntry.householdId, householdId), eq(mealPlanEntry.id, id)));
    return oneEntryTx(tx, householdId, id);
  });
}
