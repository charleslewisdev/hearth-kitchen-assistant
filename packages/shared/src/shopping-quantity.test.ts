import { describe, it, expect } from 'vitest';
import { COUNT_UNITS, shoppingQuantity } from './shopping-quantity';

describe('shoppingQuantity', () => {
  it.each([...COUNT_UNITS])('rounds a fractional %s up to a whole one', (unit) => {
    expect(shoppingQuantity(2.333, unit)).toBe(3);
    expect(shoppingQuantity(0.17, unit)).toBe(1);
  });

  it('covers every count unit the list shows', () => {
    expect([...COUNT_UNITS].sort()).toEqual(
      [
        'clove',
        'piece',
        'slice',
        'stalk',
        'sprig',
        'head',
        'stick',
        'bunch',
        'can',
        'jar',
        'package',
        'box',
        'bag',
        'bottle',
        'packet',
        'handful',
        'pinch',
        'dash',
      ].sort(),
    );
  });

  it('rounds a bare count (no unit) up: 1.17 bay leaves is 2', () => {
    expect(shoppingQuantity(1.17, null)).toBe(2);
    expect(shoppingQuantity(3.5, null)).toBe(4);
  });

  it('rounds 16.17 cloves up to 17', () => {
    expect(shoppingQuantity(16.166, 'clove')).toBe(17);
  });

  it('leaves whole counts alone', () => {
    expect(shoppingQuantity(3, 'clove')).toBe(3);
    expect(shoppingQuantity(1, null)).toBe(1);
  });

  it('does not round float noise up to the next whole', () => {
    expect(shoppingQuantity(3.0000001, 'clove')).toBe(3);
    expect(shoppingQuantity(0.1 + 0.2 + 2.7, null)).toBe(3);
  });

  it('rounds a kitchen measure up to the next quarter or third', () => {
    // The amounts a real list showed: "0.29 cup", "1.17 cups", "3.83 tbsp".
    expect(shoppingQuantity(0.29, 'cup')).toBeCloseTo(1 / 3);
    expect(shoppingQuantity(1.17, 'cup')).toBe(1.25);
    expect(shoppingQuantity(3.83, 'tbsp')).toBe(4);
    expect(shoppingQuantity(0.6, 'lb')).toBeCloseTo(2 / 3);
    expect(shoppingQuantity(0.1, 'tsp')).toBe(0.25);
    for (const unit of ['cup', 'tbsp', 'tsp', 'oz', 'lb', 'pint', 'quart', 'gallon', 'fl oz']) {
      expect(shoppingQuantity(1.17, unit)).toBe(1.25);
    }
  });

  it('leaves a measure already on a quarter or third alone, float noise included', () => {
    expect(shoppingQuantity(1.5, 'cup')).toBe(1.5);
    expect(shoppingQuantity(2, 'tbsp')).toBe(2);
    expect(shoppingQuantity(0.1 + 0.2 + 0.2, 'cup')).toBe(0.5);
    expect(shoppingQuantity(0.333, 'cup')).toBeCloseTo(1 / 3);
  });

  it('rounds grams and millilitres up to a whole one, and leaves kg and litres', () => {
    expect(shoppingQuantity(187.5, 'g')).toBe(188);
    expect(shoppingQuantity(333.33, 'ml')).toBe(334);
    expect(shoppingQuantity(1.17, 'kg')).toBe(1.17);
    expect(shoppingQuantity(1.17, 'l')).toBe(1.17);
  });

  it('keeps dozen as a measured amount', () => {
    expect(shoppingQuantity(1.5, 'dozen')).toBe(1.5);
  });

  it('leaves a hand-typed unit it does not know exact', () => {
    expect(shoppingQuantity(1.5, 'gal')).toBe(1.5);
  });

  it('passes a missing or zero quantity through', () => {
    expect(shoppingQuantity(null, 'clove')).toBeNull();
    expect(shoppingQuantity(null, null)).toBeNull();
    expect(shoppingQuantity(0, 'clove')).toBe(0);
    expect(shoppingQuantity(0, null)).toBe(0);
  });
});
