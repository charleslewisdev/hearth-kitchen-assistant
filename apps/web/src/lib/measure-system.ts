import { useState } from 'react';
import {
  formatQuantity,
  pickMeasure,
  scale,
  unitLabel,
  type MeasureSystem,
  type ScalingMode,
} from '@hearth/shared';

/**
 * Which system a cook reads amounts in, remembered on this device: a baker who weighs flour
 * picks metric once and keeps it. A per-device convenience, like the cook session, so it lives
 * in `localStorage`; a private window or blocked storage just starts at US each time.
 */
const KEY = 'hearth.measureSystem';

function stored(): MeasureSystem {
  try {
    return localStorage.getItem(KEY) === 'metric' ? 'metric' : 'us';
  } catch {
    return 'us';
  }
}

export function useMeasureSystem(): [MeasureSystem, (system: MeasureSystem) => void] {
  const [system, setSystem] = useState<MeasureSystem>(stored);
  const choose = (next: MeasureSystem) => {
    setSystem(next);
    try {
      localStorage.setItem(KEY, next);
    } catch {
      // Not remembered, but still switched for this visit.
    }
  };
  return [system, choose];
}

/** An ingredient as the recipe screen and cook mode both have it. */
export interface MeasuredIngredient {
  quantity: number | null;
  unit: string | null;
  altQuantity?: number | null;
  altUnit?: string | null;
  scalingMode: string;
}

/**
 * The amount to show, in the system picked and scaled to the servings chosen: "360 g", "3
 * cups", or null for a line with no amount. The second measure scales with the first, since
 * both are the same amount.
 */
export function amountText(
  ingredient: MeasuredIngredient,
  system: MeasureSystem,
  servings: { from: number; to: number },
): string | null {
  const picked = pickMeasure(
    {
      quantity: ingredient.quantity,
      unit: ingredient.unit,
      altQuantity: ingredient.altQuantity ?? null,
      altUnit: ingredient.altUnit ?? null,
    },
    system,
  );
  const scaled = scale(
    { quantity: picked.quantity, mode: ingredient.scalingMode as ScalingMode },
    servings,
  );
  if (scaled === null) return null;
  return `${formatQuantity(scaled, picked.unit)}${picked.unit ? ` ${unitLabel(picked.unit, scaled)}` : ''}`;
}

/** Whether any line of a recipe has a second measure, which is when the switch is worth showing. */
export function hasSecondMeasure(ingredients: MeasuredIngredient[]): boolean {
  return ingredients.some((ingredient) => ingredient.altQuantity != null);
}
