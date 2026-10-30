import { describe, it, expect } from 'vitest';
import { isNeverBought, itemMergeKey } from './shopping';

const base = { foodId: 'f1', unit: 'cup', quantity: 1 };

describe('itemMergeKey', () => {
  it('same food + same unit + real quantity share a key', () => {
    expect(itemMergeKey(base)).toBe(itemMergeKey({ ...base, quantity: 2 }));
  });
  it('different unit -> different key', () => {
    expect(itemMergeKey(base)).not.toBe(itemMergeKey({ ...base, unit: 'g' }));
  });
  it('different food -> different key', () => {
    expect(itemMergeKey(base)).not.toBe(itemMergeKey({ ...base, foodId: 'f2' }));
  });
  it('null unit is mergeable with itself but distinct from a named unit', () => {
    expect(itemMergeKey({ ...base, unit: null })).toBe(itemMergeKey({ foodId: 'f1', unit: null, quantity: 5 }));
    expect(itemMergeKey({ ...base, unit: null })).not.toBe(itemMergeKey(base));
  });
  it('null quantity ("to taste") never merges', () => {
    expect(itemMergeKey({ ...base, quantity: null })).toBeNull();
  });
  it('unmatched food (null foodId) never merges', () => {
    expect(itemMergeKey({ ...base, foodId: null })).toBeNull();
  });
});

describe('isNeverBought', () => {
  it.each(['water', 'Water', 'waters', ' water '])('keeps %j off the list', (name) => {
    expect(isNeverBought(name)).toBe(true);
  });

  it.each(['boiling water', 'warm tap water', 'ice cold water', 'hot water'])(
    'keeps a Food saved before descriptors were stripped, %j, off the list',
    (name) => {
      expect(isNeverBought(name)).toBe(true);
    },
  );

  it.each([
    'sparkling water',
    'coconut water',
    'rose water',
    'tonic water',
    'watercress',
    'watermelon',
    'salt',
    '',
  ])('buys %j', (name) => {
    expect(isNeverBought(name)).toBe(false);
  });
});
