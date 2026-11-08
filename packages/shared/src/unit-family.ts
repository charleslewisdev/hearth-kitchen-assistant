import { systemOf } from './measure-system';

/**
 * Exact conversion within a unit family, so the shopping list can merge "1 cup flour" with
 * "2 tbsp flour" (D13, #17). Volume and weight never convert into each other: that needs a
 * density per food, which Hearth does not keep.
 *
 * `stick` is left out on purpose: a stick of butter is 8 tbsp, but it is bought as a stick.
 */
export type UnitFamily = 'volume' | 'weight';

/**
 * Size of each unit in its own system's base: teaspoons and ounces for US units, millilitres and
 * grams for metric ones, so a conversion within one system is a ratio of whole numbers and stays
 * exact. Crossing systems goes through the legal US definitions below.
 */
const SIZES: Readonly<Record<string, { family: UnitFamily; size: number }>> = {
  tsp: { family: 'volume', size: 1 },
  tbsp: { family: 'volume', size: 3 },
  'fl oz': { family: 'volume', size: 6 },
  cup: { family: 'volume', size: 48 },
  pint: { family: 'volume', size: 96 },
  quart: { family: 'volume', size: 192 },
  gallon: { family: 'volume', size: 768 },
  ml: { family: 'volume', size: 1 },
  l: { family: 'volume', size: 1000 },
  oz: { family: 'weight', size: 1 },
  lb: { family: 'weight', size: 16 },
  g: { family: 'weight', size: 1 },
  kg: { family: 'weight', size: 1000 },
};

/** Metric base units in one US base unit: 1 tsp is 4.92892159375 ml, 1 oz is 28.349523125 g. */
const METRIC_PER_US: Readonly<Record<UnitFamily, number>> = {
  volume: 4.92892159375,
  weight: 28.349523125,
};

/** A unit's size in metric base units, for comparing across systems. */
function metricSize(unit: string): number {
  const { family, size } = SIZES[unit]!;
  return systemOf(unit) === 'metric' ? size : size * METRIC_PER_US[family];
}

export function unitFamily(unit: string | null): UnitFamily | null {
  if (unit === null) return null;
  return SIZES[unit]?.family ?? null;
}

/** How many `to` one `from` is, or null when the two are not in one family. */
export function unitFactor(from: string, to: string): number | null {
  const a = SIZES[from];
  const b = SIZES[to];
  if (!a || !b || a.family !== b.family) return null;
  if (systemOf(from) === systemOf(to)) return a.size / b.size;
  return metricSize(from) / metricSize(to);
}

/** `quantity` of `from` in `to`, or null when the two are not in one family. */
export function convertAmount(quantity: number, from: string, to: string): number | null {
  const factor = unitFactor(from, to);
  return factor === null ? null : quantity * factor;
}

/**
 * The unit a merged list item is kept in, given the unit already on the list and the one being
 * added, or null when they cannot merge. The larger measure within one system, so a teaspoon
 * added to a cup stays in cups; across systems the list keeps its own unit, so a cook who wrote
 * grams keeps reading grams.
 */
export function mergeUnit(onList: string, adding: string): string | null {
  const a = SIZES[onList];
  const b = SIZES[adding];
  if (!a || !b || a.family !== b.family) return null;
  if (onList === adding) return onList;
  if (systemOf(onList) !== systemOf(adding)) return onList;
  return b.size > a.size ? adding : onList;
}

/** Every unit in `family`, for finding a list item that a new amount can merge into. */
export function unitsInFamily(family: UnitFamily): string[] {
  return Object.keys(SIZES).filter((unit) => SIZES[unit]!.family === family);
}
