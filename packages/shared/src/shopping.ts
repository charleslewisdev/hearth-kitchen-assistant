import { normalizeFoodName } from './food-name';
import { splitLeadingDescriptors } from './ingredient-words';

/**
 * Whether a food never goes on a shopping list. Only water: it comes out of the tap, and a
 * list that says "3 cups water" is one the cook learns to skim.
 *
 * The parser already strips "boiling", "warm tap" and friends, but Foods saved before it did are
 * still called "boiling water", so the same descriptors are stripped here too. Anything else
 * before the water makes it something you buy: sparkling water, coconut water, tonic water.
 */
export function isNeverBought(foodName: string): boolean {
  const normalized = normalizeFoodName(foodName);
  return splitLeadingDescriptors(normalized).rest === 'water';
}

/** The fields of a shopping-list item that determine whether it aggregates. */
export interface MergeableItem {
  foodId: string | null;
  unit: string | null;
  quantity: number | null;
}

/**
 * Returns a stable key for items that should aggregate together on a shopping
 * list, or `null` for items that must never merge.
 *
 * Two items merge iff they share the same food AND the same unit AND both carry
 * a real quantity (design decision 3). An unmatched food (`foodId` null) or an
 * unquantified "to taste" (`quantity` null) yields `null`, so such items always
 * stand alone.
 *
 * A `null` unit is itself a valid, mergeable value (e.g. countable items with
 * no unit), distinct from any named unit.
 */
export function itemMergeKey(item: MergeableItem): string | null {
  if (item.foodId == null || item.quantity == null) return null;
  return `${item.foodId}::${item.unit ?? ''}`;
}
