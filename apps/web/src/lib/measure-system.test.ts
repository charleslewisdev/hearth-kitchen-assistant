import { describe, it, expect } from 'vitest';
import { amountText } from './measure-system';

const garlic = { quantity: 2, quantityHigh: 3, unit: 'clove', scalingMode: 'linear' };

describe('amountText with a range (D53)', () => {
  it('shows both ends', () => {
    expect(amountText(garlic, 'us', { from: 4, to: 4 })).toBe('2–3 cloves');
    expect(
      amountText({ ...garlic, quantity: 0.5, quantityHigh: 1, unit: 'cup' }, 'us', {
        from: 4,
        to: 4,
      }),
    ).toBe('½–1 cup');
  });

  it('scales both ends', () => {
    expect(amountText(garlic, 'us', { from: 4, to: 8 })).toBe('4–6 cloves');
    expect(
      amountText({ ...garlic, quantity: 1, quantityHigh: 2, unit: 'cup' }, 'us', {
        from: 4,
        to: 2,
      }),
    ).toBe('½–1 cup');
  });

  it('shows the one number of a second measure, which has no range', () => {
    const flour = {
      quantity: 2,
      quantityHigh: 3,
      unit: 'cup',
      altQuantity: 240,
      altUnit: 'g',
      scalingMode: 'linear',
    };
    expect(amountText(flour, 'us', { from: 4, to: 4 })).toBe('2–3 cups');
    expect(amountText(flour, 'metric', { from: 4, to: 4 })).toBe('240 g');
  });

  it('shows a single amount as before', () => {
    expect(
      amountText({ quantity: 2, unit: 'cup', scalingMode: 'linear' }, 'us', { from: 4, to: 4 }),
    ).toBe('2 cups');
  });
});
