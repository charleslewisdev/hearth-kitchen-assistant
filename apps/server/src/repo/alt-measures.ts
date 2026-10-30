import { and, eq, isNull, sql } from 'drizzle-orm';
import { measureIn, parseIngredientLine } from '@hearth/shared';
import { db } from '../db/client';
import { organization } from '../db/auth-schema';
import { recipeIngredient } from '../db/schema';
import { withHousehold } from './tenant';

/**
 * A metric amount at the start of a note part: what "3 cups (360g) flour" left in the note
 * before the second measure had a column of its own (migration 0014).
 */
const METRIC_IN_NOTE = sql`${recipeIngredient.note} ~* '[0-9] ?(g|kg|ml|l)([^a-z]|$)'`;

/**
 * Give the ingredients saved before migration 0014 their second measure, by reading each line
 * again with the parser that fills it on save.
 *
 * Only the second measure and the note change, and the note only by losing the one part that
 * is the measure. The rest of the note, and the amount, unit and food, stay exactly as saved,
 * even where today's parser would read the line a little differently.
 *
 * Runs at every start, as one scan of each household's ingredients. After the first run only
 * lines whose note keeps a metric amount the parser does not take (two of them, or a range)
 * still match, and those are left as they are each time. D38: it reports a count, never a line.
 */
export async function backfillAltMeasures(): Promise<number> {
  const households = await db.select({ id: organization.id }).from(organization);
  let filled = 0;
  for (const household of households) {
    filled += await withHousehold(household.id, async (tx) => {
      const rows = await tx
        .select({
          id: recipeIngredient.id,
          rawText: recipeIngredient.rawText,
          note: recipeIngredient.note,
        })
        .from(recipeIngredient)
        .where(and(isNull(recipeIngredient.altQuantity), METRIC_IN_NOTE));
      let count = 0;
      for (const row of rows) {
        const parsed = parseIngredientLine(row.rawText);
        if (parsed.altQuantity === undefined) continue;
        const parts = (row.note ?? '').split('; ');
        const at = parts.findIndex((part) => {
          const measure = measureIn(part);
          return measure?.quantity === parsed.altQuantity && measure?.unit === parsed.altUnit;
        });
        // The line's note no longer holds the measure where the parser would find it: leave it.
        if (at === -1) continue;
        parts.splice(at, 1);
        await tx
          .update(recipeIngredient)
          .set({
            altQuantity: String(parsed.altQuantity),
            altUnit: parsed.altUnit ?? null,
            note: parts.length > 0 ? parts.join('; ') : null,
          })
          .where(eq(recipeIngredient.id, row.id));
        count += 1;
      }
      return count;
    });
  }
  return filled;
}
