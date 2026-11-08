import { describe, it, expect } from 'vitest';
import { servingsHighFrom, servingsText } from './servings';

describe('servingsText', () => {
  it('shows the range at the recipe’s own servings', () => {
    expect(servingsText(4, { servings: 4, servingsHigh: 6 })).toBe('4–6');
  });
  it('shows the number picked once the recipe is scaled', () => {
    expect(servingsText(5, { servings: 4, servingsHigh: 6 })).toBe('5');
    expect(servingsText(8, { servings: 4, servingsHigh: 6 })).toBe('8');
  });
  it('shows one number for a recipe that serves one number', () => {
    expect(servingsText(4, { servings: 4, servingsHigh: null })).toBe('4');
    expect(servingsText(4, { servings: 4 })).toBe('4');
  });
});

describe('servingsHighFrom', () => {
  it('is the number when it is above the servings', () => {
    expect(servingsHighFrom('6', 4)).toBe(6);
  });
  it('is null for an empty box, or one that makes no range', () => {
    expect(servingsHighFrom('', 4)).toBeNull();
    expect(servingsHighFrom('4', 4)).toBeNull();
    expect(servingsHighFrom('3', 4)).toBeNull();
    expect(servingsHighFrom('many', 4)).toBeNull();
  });
});
