import { and, asc, count, eq, ne, sql } from 'drizzle-orm';
import { TRPCError } from '@trpc/server';
import { normalizeFoodName, type TagColor } from '@hearth/shared';
import { recipeTags, tag } from '../db/schema';
import { TAG_NAME_TAKEN_MESSAGE } from '../messages';
import { withHousehold, type Tx } from './tenant';

// The Tags screen: every tag in the household with how many recipes carry it, and the ways to
// tidy them (rename, colour, merge, delete). Tags are made by saving a recipe, so there is no
// create here. Names normalize the way `findOrCreateTag` does, so "Italian" and "italian" are one.

export interface TagRow {
  id: string;
  name: string;
  normalizedName: string;
  color: TagColor | null;
  /** How many recipes carry it. Zero is a tag an edit or import left behind. */
  uses: number;
}

export async function listTags(householdId: string): Promise<TagRow[]> {
  return withHousehold(householdId, async (tx) => {
    const rows = await tx
      .select({
        id: tag.id,
        name: tag.name,
        normalizedName: tag.normalizedName,
        color: tag.color,
        uses: count(recipeTags.recipeId),
      })
      .from(tag)
      .leftJoin(recipeTags, eq(recipeTags.tagId, tag.id))
      .where(eq(tag.householdId, householdId))
      .groupBy(tag.id)
      .orderBy(asc(tag.normalizedName), asc(tag.id));
    return rows.map((r) => ({ ...r, uses: Number(r.uses) }));
  });
}

async function ownTag(tx: Tx, householdId: string, id: string) {
  const [row] = await tx
    .select()
    .from(tag)
    .where(and(eq(tag.householdId, householdId), eq(tag.id, id)));
  if (!row) throw new TRPCError({ code: 'NOT_FOUND', message: 'Tag not found' });
  return row;
}

// A new display name. A change of case or spacing on the same tag is allowed; a name another
// tag already normalizes to is refused, and the screen offers a merge instead.
export async function renameTag(householdId: string, id: string, name: string): Promise<void> {
  return withHousehold(householdId, async (tx) => {
    await ownTag(tx, householdId, id);
    const trimmed = name.trim();
    const normalizedName = normalizeFoodName(trimmed);
    if (normalizedName === '') throw new TRPCError({ code: 'BAD_REQUEST', message: 'Name a tag' });
    const [clash] = await tx
      .select({ id: tag.id })
      .from(tag)
      .where(
        and(
          eq(tag.householdId, householdId),
          eq(tag.normalizedName, normalizedName),
          ne(tag.id, id),
        ),
      )
      .limit(1);
    if (clash) throw new TRPCError({ code: 'CONFLICT', message: TAG_NAME_TAKEN_MESSAGE });
    await tx
      .update(tag)
      .set({ name: trimmed, normalizedName })
      .where(and(eq(tag.householdId, householdId), eq(tag.id, id)));
  });
}

// Pick a chip colour, or `null` to go back to the one derived from the name.
export async function setTagColor(
  householdId: string,
  id: string,
  color: TagColor | null,
): Promise<void> {
  return withHousehold(householdId, async (tx) => {
    await ownTag(tx, householdId, id);
    await tx
      .update(tag)
      .set({ color })
      .where(and(eq(tag.householdId, householdId), eq(tag.id, id)));
  });
}

// Fold `fromId` into `intoId`: every recipe carrying the first carries the second instead, and
// the first is deleted. A recipe that already had both keeps one link (the primary key would
// refuse a second), which is why this inserts-and-ignores rather than updating in place.
export async function mergeTags(
  householdId: string,
  fromId: string,
  intoId: string,
): Promise<void> {
  if (fromId === intoId) {
    throw new TRPCError({ code: 'BAD_REQUEST', message: 'A tag cannot merge into itself' });
  }
  return withHousehold(householdId, async (tx) => {
    await ownTag(tx, householdId, fromId);
    await ownTag(tx, householdId, intoId);
    await tx.execute(sql`
      insert into ${recipeTags} (household_id, recipe_id, tag_id)
      select household_id, recipe_id, ${intoId}::uuid
      from ${recipeTags}
      where household_id = ${householdId} and tag_id = ${fromId}::uuid
      on conflict do nothing
    `);
    // The source's links go with it: `recipe_tags.tag_id` cascades.
    await tx.delete(tag).where(and(eq(tag.householdId, householdId), eq(tag.id, fromId)));
  });
}

// Delete a tag. It comes off every recipe that carried it (the link cascades); the recipes
// themselves are untouched.
export async function deleteTag(householdId: string, id: string): Promise<boolean> {
  return withHousehold(householdId, async (tx) => {
    const deleted = await tx
      .delete(tag)
      .where(and(eq(tag.householdId, householdId), eq(tag.id, id)))
      .returning({ id: tag.id });
    return deleted.length > 0;
  });
}

// Every tag no recipe carries, in one go: what editing and importing leave behind. Returns how
// many went.
export async function deleteUnusedTags(householdId: string): Promise<number> {
  return withHousehold(householdId, async (tx) => {
    const deleted = await tx
      .delete(tag)
      .where(
        and(
          eq(tag.householdId, householdId),
          sql`not exists (select 1 from ${recipeTags} where ${recipeTags.tagId} = ${tag.id})`,
        ),
      )
      .returning({ id: tag.id });
    return deleted.length;
  });
}
