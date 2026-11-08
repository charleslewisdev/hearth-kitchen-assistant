import { parseIngredientLine } from './ingredient';
import { formatQuantity } from './quantity-format';
import { unitLabel } from './unit-label';

/** The longest amount the shopping list's amount box takes: "1 ½ fl oz" needs a dozen. */
export const MAX_LIST_AMOUNT_LENGTH = 40;

/** Above this an amount is a typo, not a shop ("1000000 eggs"). */
const MAX_LIST_QUANTITY = 99_999;

/**
 * The ingredient parser reads a unit only when a food follows it ("2 cups" alone is a food called
 * "cups"), so an amount is read as the line "<amount> item", and accepted only when nothing but
 * this word is left as the food.
 */
const STAND_IN_FOOD = 'item';

/** An amount and unit for one shopping-list item; both null for an item with no amount. */
export interface ListAmount {
  quantity: number | null;
  unit: string | null;
}

/**
 * Read what the cook typed into a list item's amount box ("3", "1 1/2 lb", "12 oz") with the same
 * parser that reads ingredient lines and typed staples, so the units it knows are the same.
 * An empty box is no amount. Returns `null` for anything that is not just an amount and a unit:
 * a food ("2 cups flour"), a size or note ("3 large"), a unit alone, zero or a typo-sized number.
 *
 * Adds no pattern of its own; the length cap keeps hostile text away from the parser.
 */
export function parseListAmount(text: string): ListAmount | null {
  const trimmed = text.trim();
  if (trimmed === '') return { quantity: null, unit: null };
  if (trimmed.length > MAX_LIST_AMOUNT_LENGTH) return null;

  const parsed = parseIngredientLine(`${trimmed} ${STAND_IN_FOOD}`);
  if (parsed.foodName !== STAND_IN_FOOD || parsed.note !== null) return null;
  // A range ("2-3 lb") buys its high end, as everything else on the list does (D53). The parser
  // reports one only once quantity ranges ship (#25); until then this reads the low end.
  const { quantityHigh } = parsed as { quantityHigh?: number };
  const quantity = quantityHigh ?? parsed.quantity;
  if (quantity === null || !Number.isFinite(quantity)) return null;
  if (quantity <= 0 || quantity > MAX_LIST_QUANTITY) return null;
  return { quantity, unit: parsed.unit };
}

/**
 * An amount as the list writes it: "1 ½ lb", "2 cloves", "3". Empty when there is no amount.
 * `parseListAmount` reads it back to the same amount and unit.
 */
export function listAmountText(quantity: number | null, unit: string | null): string {
  if (quantity === null) return '';
  const amount = formatQuantity(quantity, unit);
  return unit ? `${amount} ${unitLabel(unit, quantity)}` : amount;
}
