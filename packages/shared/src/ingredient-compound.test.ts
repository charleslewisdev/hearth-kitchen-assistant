import { describe, expect, it } from 'vitest';
import { parseIngredientLine } from './ingredient';

/**
 * Lines from the owner's recipe book (2026-09-28) that made Foods out of amounts: "cup/50g
 * all-purpose flour", "plus 2 tablespoons dry white wine", "thyme or 1 tsp dried thyme". Each
 * of those became a Food row and a line on the shopping list.
 */
describe('a metric amount after a slash, as Ottolenghi prints it', () => {
  it.each([
    ['1/3 cup/50g all-purpose flour', 1 / 3, 'cup', 50, 'g', 'all-purpose flour'],
    ['1 1/4 cups/300ml vegetable stock', 1.25, 'cup', 300, 'ml', 'vegetable stock'],
    ['6 tbsp/60g white sesame seeds', 6, 'tbsp', 60, 'g', 'white sesame seeds'],
    ['3 1/4 oz / 90g feta, broken into pieces', 3.25, 'oz', 90, 'g', 'feta'],
    ['7 0z/200g baby spinach leaves', 7, 'oz', 200, 'g', 'spinach leaves'],
  ])('%j', (line, quantity, unit, altQuantity, altUnit, foodName) => {
    expect(parseIngredientLine(line)).toMatchObject({
      quantity,
      unit,
      altQuantity,
      altUnit,
      foodName,
    });
  });

  it('keeps "about" as a note rather than losing the amount', () => {
    expect(parseIngredientLine('about 7 tbsp/100ml sunflower oil, for frying')).toMatchObject({
      quantity: 7,
      unit: 'tbsp',
      altQuantity: 100,
      altUnit: 'ml',
      foodName: 'sunflower oil',
      note: 'about; for frying',
    });
  });
});

describe('a second amount added or taken away', () => {
  it.each([
    ['1/4 cup plus 2 tablespoons dry white wine', 'dry white wine', 'plus 2 tablespoons'],
    ['3/4 cup plus 2 tablespoons cold water', 'water', 'cold; plus 2 tablespoons'],
    [
      '1 1/2 cups plus 2 Tbsp all-purpose flour, plus more for dusting',
      'all-purpose flour',
      'plus 2 Tbsp; plus more for dusting',
    ],
    ['2 cups minus 2 tablespoons all-purpose flour', 'all-purpose flour', 'minus 2 tablespoons'],
    ['3/4 cup (3 oz/95 g) plus 2 Tbsp confectioners’ sugar', 'confectioners’ sugar', 'plus 2 Tbsp'],
  ])('%j', (line, foodName, note) => {
    expect(parseIngredientLine(line)).toMatchObject({ foodName, note });
  });
});

describe('an alternative with its own amount', () => {
  it.each([
    [
      '2 tsp minced fresh thyme or 1 tsp dried thyme',
      'thyme',
      'minced fresh; or 1 tsp dried thyme',
    ],
    [
      '1 teaspoon smoked paprika or 1/2 teaspoon cayenne pepper',
      'smoked paprika',
      'or 1/2 teaspoon cayenne pepper',
    ],
    [
      '1½ teaspoons Aleppo pepper or 1 teaspoon hot paprika plus ¼ teaspoon cayenne pepper',
      'Aleppo pepper',
      'or 1 teaspoon hot paprika plus ¼ teaspoon cayenne pepper',
    ],
  ])('%j', (line, foodName, note) => {
    expect(parseIngredientLine(line)).toMatchObject({ foodName, note });
  });

  it('leaves an alternative with no amount in the food, where it names one thing', () => {
    expect(parseIngredientLine('1 cup dry red or white wine').foodName).toBe(
      'dry red or white wine',
    );
  });
});

describe('a can size with no hyphen', () => {
  it('reads "2 14oz cans" as two cans', () => {
    expect(parseIngredientLine('2 14oz cans sweetened condensed milk')).toMatchObject({
      quantity: 2,
      unit: 'can',
      foodName: 'sweetened condensed milk',
      note: '14oz',
    });
  });

  it('still reads "250g flour" as 250 grams', () => {
    expect(parseIngredientLine('250g flour')).toMatchObject({
      quantity: 250,
      unit: 'g',
      foodName: 'flour',
    });
  });
});

describe('the new patterns, on hostile lines', () => {
  it('stay linear', () => {
    const lines = [
      `1 cup/${'9'.repeat(90_000)}`,
      `1 cup ${'plus '.repeat(20_000)}`,
      `1 cup a${' or'.repeat(30_000)} 1`,
      `about ${'about '.repeat(15_000)}1 cup`,
      `2 ${'1'.repeat(90_000)}oz cans`,
    ];
    for (const line of lines) {
      const started = performance.now();
      parseIngredientLine(line);
      expect(performance.now() - started).toBeLessThan(300);
    }
  });
});
