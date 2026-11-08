import { and, eq, isNotNull, isNull, sql } from 'drizzle-orm';
import { parseIngredientLine } from '@hearth/shared';
import { db } from '../db/client';
import { organization } from '../db/auth-schema';
import { recipeIngredient } from '../db/schema';
import { withHousehold } from './tenant';

/**
 * A line that might hold a range: a dash, or the word "to" or "or", anywhere in it. Only a coarse
 * filter so the scan reads few rows; the parser decides. Postgres's regex engine does not
 * backtrack the way JavaScript's does, and this pattern has no repetition in it anyway.
 */
const MIGHT_BE_RANGE = sql`${recipeIngredient.rawText} ~* '[-–]| to | or '`;

/**
 * Give the ingredients saved before migration 0016 the high end of their range, by reading each
 * line again with the parser that fills it on save (D53). "2-3 cloves garlic" was saved as 2.
 *
 * Only `quantity_high` is ever written, and only where today's parser reads the same low end and
 * unit that were saved: a line the parser now reads differently is left exactly as it is, since
 * filling half of a different reading would make an amount nobody wrote. The CHECK on the column
 * holds because the parser only gives a high end above the low one.
 *
 * Runs at every start, as one scan of each household's ingredients with a single amount. A line
 * it fills drops out of the scan; a line with a dash that is not a range ("1 14-ounce can") is
 * read and left each time, which costs one parse per such line. D38: it reports a count, never a
 * line.
 */
export async function backfillQuantityRanges(): Promise<number> {
  const households = await db.select({ id: organization.id }).from(organization);
  let filled = 0;
  for (const household of households) {
    filled += await withHousehold(household.id, async (tx) => {
      const rows = await tx
        .select({
          id: recipeIngredient.id,
          rawText: recipeIngredient.rawText,
          quantity: recipeIngredient.quantity,
          unit: recipeIngredient.unit,
        })
        .from(recipeIngredient)
        .where(
          and(
            eq(recipeIngredient.householdId, household.id),
            isNull(recipeIngredient.quantityHigh),
            isNotNull(recipeIngredient.quantity),
            MIGHT_BE_RANGE,
          ),
        );
      let count = 0;
      for (const row of rows) {
        const parsed = parseIngredientLine(row.rawText);
        if (parsed.quantityHigh === undefined) continue;
        // Saved under another reading of the line: leave it.
        if (parsed.quantity !== Number(row.quantity) || parsed.unit !== row.unit) continue;
        await tx
          .update(recipeIngredient)
          .set({ quantityHigh: String(parsed.quantityHigh) })
          .where(and(eq(recipeIngredient.id, row.id), isNull(recipeIngredient.quantityHigh)));
        count += 1;
      }
      return count;
    });
  }
  return filled;
}
