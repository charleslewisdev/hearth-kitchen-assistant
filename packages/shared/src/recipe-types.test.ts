import { describe, it, expect } from 'vitest';
import { RECIPE_TYPES, sortRecipeTypes } from './recipe-types';

describe('recipe types', () => {
  it('keeps the meals first and the building blocks after', () => {
    expect(RECIPE_TYPES.slice(0, 3)).toEqual(['breakfast', 'lunch', 'dinner']);
    expect(RECIPE_TYPES).toContain('sauce');
    expect(RECIPE_TYPES).toContain('base');
    expect(RECIPE_TYPES).toContain('side');
  });

  it('sorts a recipe’s types into list order', () => {
    expect(sortRecipeTypes(['sauce', 'dinner', 'breakfast'])).toEqual([
      'breakfast',
      'dinner',
      'sauce',
    ]);
  });
});
