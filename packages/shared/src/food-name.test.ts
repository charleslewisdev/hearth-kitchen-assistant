import { describe, it, expect } from 'vitest';
import { normalizeFoodName } from './food-name';

describe('normalizeFoodName', () => {
  it.each([
    ['Tomatoes', 'tomato'],
    ['  Olive Oil ', 'olive oil'],
    ['eggs', 'egg'],
    ['flour', 'flour'],
    ['Berries', 'berry'],
    ['Potatoes', 'potato'],
    ['CHICKEN BREAST', 'chicken breast'],
    ['onions', 'onion'],
    // collapse internal whitespace runs
    ['red   bell   pepper', 'red bell pepper'],
    ['Green\tBeans', 'green bean'],
    // guard against over-stripping short words
    ['as', 'as'],
    ['gas', 'gas'],
    ['is', 'is'],
    // already-normalized / non-plural
    ['salt', 'salt'],
    // -es where dropping just -s would be wrong-ish but drop -es is right
    ['tomatoes', 'tomato'],
    ['dishes', 'dish'],
    // empty input
    ['', ''],
    ['   ', ''],
  ])('normalizes %j -> %j', (input, expected) => {
    expect(normalizeFoodName(input)).toBe(expected);
  });
});

describe('normalizeFoodName on the irregular plurals recipes use', () => {
  it.each([
    ['bay leaves', 'bay leaf'],
    ['chicken breast halves', 'chicken breast half'],
    ['green chilies', 'green chili'],
    ['garlic cloves', 'garlic clove'],
    ['kalamata olives', 'kalamata olive'],
  ])('%s -> %s', (input, expected) => {
    expect(normalizeFoodName(input)).toBe(expected);
  });
});
