import { describe, it, expect } from 'vitest';
import { CANONICAL_UNITS, normalizeUnit } from './units';

describe('normalizeUnit', () => {
  it.each([
    ['cup', 'cup'],
    ['cups', 'cup'],
    ['c', 'cup'],
    ['tablespoon', 'tbsp'],
    ['tbsp', 'tbsp'],
    ['T', 'tbsp'],
    ['teaspoon', 'tsp'],
    ['tsp', 'tsp'],
    ['t', 'tsp'],
    ['gram', 'g'],
    ['grams', 'g'],
    ['g', 'g'],
    ['ounce', 'oz'],
    ['oz', 'oz'],
    ['pound', 'lb'],
    ['lbs', 'lb'],
    ['ml', 'ml'],
    ['milliliter', 'ml'],
    ['l', 'l'],
    ['liter', 'l'],
    ['clove', 'clove'],
    ['cloves', 'clove'],
    ['can', 'can'],
  ])('maps %s -> %s', (input, expected) => {
    expect(normalizeUnit(input)).toBe(expected);
  });

  it.each([
    // The spellings printed recipes use for a tablespoon.
    ['tbl', 'tbsp'],
    ['Tbl', 'tbsp'],
    ['tbls', 'tbsp'],
    ['tbs', 'tbsp'],
    ['Tbsp.', 'tbsp'],
    ['kg', 'kg'],
    ['kilogram', 'kg'],
    ['kilograms', 'kg'],
    ['kilo', 'kg'],
    ['kilos', 'kg'],
    ['bunch', 'bunch'],
    ['bunches', 'bunch'],
    ['sprig', 'sprig'],
    ['sprigs', 'sprig'],
    ['stalk', 'stalk'],
    ['stalks', 'stalk'],
    ['slice', 'slice'],
    ['slices', 'slice'],
    ['piece', 'piece'],
    ['pieces', 'piece'],
    ['pinch', 'pinch'],
    ['pinches', 'pinch'],
    ['Pinch', 'pinch'],
    ['dash', 'dash'],
    ['dashes', 'dash'],
    ['handful', 'handful'],
    ['handfuls', 'handful'],
    ['package', 'package'],
    ['packages', 'package'],
    ['pkg', 'package'],
    ['pkgs', 'package'],
    ['jar', 'jar'],
    ['jars', 'jar'],
    ['box', 'box'],
    ['boxes', 'box'],
    ['bag', 'bag'],
    ['bags', 'bag'],
    ['bottle', 'bottle'],
    ['bottles', 'bottle'],
    ['head', 'head'],
    ['heads', 'head'],
    ['stick', 'stick'],
    ['sticks', 'stick'],
    ['packet', 'packet'],
    ['packets', 'packet'],
  ])('maps the new unit %s -> %s', (input, expected) => {
    expect(normalizeUnit(input)).toBe(expected);
  });

  it('maps every canonical unit to itself', () => {
    for (const unit of CANONICAL_UNITS) expect(normalizeUnit(unit)).toBe(unit);
  });

  it('returns null for unknown / unitless words', () => {
    expect(normalizeUnit('large')).toBeNull();
    expect(normalizeUnit('garlic')).toBeNull();
    expect(normalizeUnit('')).toBeNull();
  });
});
