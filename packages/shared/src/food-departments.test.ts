import { describe, it, expect } from 'vitest';
import { departmentFor } from './food-departments';

describe('departmentFor', () => {
  it.each([
    // Produce
    ['tomato', 'Produce'],
    ['Tomatoes', 'Produce'], // normalizes before lookup
    ['lettuce', 'Produce'],
    ['onion', 'Produce'],
    ['apple', 'Produce'],
    ['banana', 'Produce'],
    // Dairy
    ['milk', 'Dairy'],
    ['butter', 'Dairy'],
    ['cheddar cheese', 'Dairy'],
    ['egg', 'Dairy'],
    ['eggs', 'Dairy'], // normalizes plural -> egg
    // Meat & Seafood
    ['chicken breast', 'Meat & Seafood'],
    ['chicken', 'Meat & Seafood'],
    ['boneless chicken', 'Meat & Seafood'], // last-word fallback -> chicken
    ['salmon', 'Meat & Seafood'],
    // Bakery
    ['bread', 'Bakery'],
    ['bagel', 'Bakery'],
    // Baking
    ['flour', 'Baking'],
    ['sugar', 'Baking'],
    ['baking soda', 'Baking'],
    // Pantry
    ['rice', 'Pantry'],
    ['olive oil', 'Pantry'],
    // Frozen
    ['ice cream', 'Frozen'],
    // Beverages
    ['coffee', 'Beverages'],
    // Unknown
    ['unknownthing', null],
    ['', null],
  ])('maps %j -> %j', (input, expected) => {
    expect(departmentFor(input)).toBe(expected);
  });
});

describe('departmentFor on the food names real recipes produce', () => {
  it.each([
    ['extra-virgin olive oil', 'Pantry'],
    ['low-sodium chicken broth', 'Pantry'],
    ['medium-large leek', 'Produce'],
    ['ground cumin', 'Pantry'],
    ['smoked paprika', 'Pantry'],
    ['crumbled feta cheese', 'Dairy'],
    ['coconut milk', 'Pantry'],
    ['torn kale or spinach', 'Produce'],
    ['dried oregano', 'Pantry'],
    ['dry red wine', 'Beverages'],
  ] as const)('puts %s in %s', (food, department) => {
    expect(departmentFor(food)).toBe(department);
  });

  it('looks at a bounded number of trailing words however long the name is', () => {
    const started = Date.now();
    expect(departmentFor(`${'word '.repeat(50_000)}olive oil`)).toBe('Pantry');
    expect(Date.now() - started).toBeLessThan(500);
  });
});
