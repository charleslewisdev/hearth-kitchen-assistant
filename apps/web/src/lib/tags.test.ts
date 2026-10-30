import { describe, it, expect } from 'vitest';
import { notYetTagged } from './tags';

describe('notYetTagged', () => {
  it('offers only suggestions not already on the recipe, regardless of case', () => {
    expect(notYetTagged(['Vegan', 'Italian'], ['vegan'])).toEqual(['Italian']);
  });
});
