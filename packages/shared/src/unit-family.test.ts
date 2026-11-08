import { describe, expect, it } from 'vitest';
import { convertAmount, mergeUnit, unitFamily } from './unit-family';

describe('unitFamily', () => {
  it('puts US and metric volume in one family, and weight in another', () => {
    for (const u of ['tsp', 'tbsp', 'cup', 'fl oz', 'pint', 'quart', 'gallon', 'ml', 'l']) {
      expect(unitFamily(u)).toBe('volume');
    }
    for (const u of ['g', 'kg', 'oz', 'lb']) expect(unitFamily(u)).toBe('weight');
  });

  it('leaves counts, sticks and no unit out of every family', () => {
    for (const u of ['clove', 'stick', 'can', 'dozen', 'pinch', null]) {
      expect(unitFamily(u)).toBeNull();
    }
  });
});

describe('convertAmount', () => {
  it('converts exactly within the US kitchen measures', () => {
    expect(convertAmount(3, 'tsp', 'tbsp')).toBe(1);
    expect(convertAmount(16, 'tbsp', 'cup')).toBe(1);
    expect(convertAmount(2, 'cup', 'pint')).toBe(1);
    expect(convertAmount(4, 'quart', 'gallon')).toBe(1);
    expect(convertAmount(8, 'fl oz', 'cup')).toBe(1);
    expect(convertAmount(16, 'oz', 'lb')).toBe(1);
  });

  it('converts across systems within a family', () => {
    expect(convertAmount(1, 'kg', 'g')).toBe(1000);
    expect(convertAmount(1, 'l', 'ml')).toBe(1000);
    expect(convertAmount(1, 'lb', 'g')).toBeCloseTo(453.592, 3);
    expect(convertAmount(1, 'cup', 'ml')).toBeCloseTo(236.588, 3);
  });

  it('refuses volume to weight, and units outside a family', () => {
    expect(convertAmount(1, 'cup', 'g')).toBeNull();
    expect(convertAmount(1, 'clove', 'head')).toBeNull();
    expect(convertAmount(1, 'stick', 'tbsp')).toBeNull();
  });
});

describe('mergeUnit', () => {
  it('keeps a same unit', () => {
    expect(mergeUnit('cup', 'cup')).toBe('cup');
  });

  it('takes the larger measure within one system', () => {
    expect(mergeUnit('tsp', 'cup')).toBe('cup');
    expect(mergeUnit('cup', 'tbsp')).toBe('cup');
    expect(mergeUnit('lb', 'oz')).toBe('lb');
    expect(mergeUnit('g', 'kg')).toBe('kg');
  });

  it('keeps the unit already on the list when the systems differ', () => {
    expect(mergeUnit('g', 'oz')).toBe('g');
    expect(mergeUnit('cup', 'ml')).toBe('cup');
  });

  it('refuses units from different families', () => {
    expect(mergeUnit('cup', 'g')).toBeNull();
    expect(mergeUnit('clove', 'clove')).toBeNull();
  });
});
