import { describe, it, expect } from 'vitest';
import { recipeText, type ShareableRecipe } from './recipe-text';

const line = (over: Partial<ShareableRecipe['ingredients'][number]>) => ({
  id: `i${over.position ?? 0}`,
  position: 0,
  quantity: null,
  unit: null,
  altQuantity: null,
  altUnit: null,
  scalingMode: 'linear',
  foodName: null,
  note: null,
  linkedRecipe: null,
  ...over,
});

const SOUP: ShareableRecipe = {
  id: 'soup',
  title: 'Parsnip Soup',
  servings: 4,
  prepMinutes: 10,
  cookMinutes: 30,
  description: 'A winter soup.',
  sourceName: 'Grandma',
  sourceUrl: 'https://example.com/parsnip-soup',
  ingredients: [
    line({ position: 1, foodName: 'salt', note: 'to taste' }),
    line({ position: 0, quantity: 2, unit: 'lb', foodName: 'parsnips', note: 'peeled' }),
    line({ position: 2, quantity: 1, linkedRecipe: { title: 'Chicken Stock' } }),
  ],
  steps: [
    { id: 's1', position: 1, text: 'Simmer and blend.' },
    { id: 's0', position: 0, text: 'Peel the parsnips.' },
  ],
};

describe('a recipe as text to send', () => {
  it('reads as the recipe screen does, in order, with where it came from', () => {
    expect(recipeText(SOUP, { servings: 4, system: 'us' })).toBe(
      [
        'Parsnip Soup',
        'Serves 4 · Prep 10 min · Cook 30 min',
        '',
        'A winter soup.',
        '',
        'Ingredients',
        '- 2 lb parsnips, peeled',
        '- salt, to taste',
        '- 1 Chicken Stock',
        '',
        'Steps',
        '1. Peel the parsnips.',
        '2. Simmer and blend.',
        '',
        'Source: Grandma, https://example.com/parsnip-soup',
      ].join('\n'),
    );
  });

  it('is scaled to the servings on screen', () => {
    const text = recipeText(SOUP, { servings: 8, system: 'us' });
    expect(text).toContain('Serves 8');
    expect(text).toContain('- 4 lb parsnips');
  });

  it('reads in metric when the recipe prints a second measure and metric is picked', () => {
    const bread: ShareableRecipe = {
      ...SOUP,
      ingredients: [
        line({ quantity: 3, unit: 'cup', altQuantity: 360, altUnit: 'g', foodName: 'flour' }),
      ],
    };
    expect(recipeText(bread, { servings: 4, system: 'metric' })).toContain('- 360 g flour');
  });

  it('adds the recipes its lines are made from, each at its own servings, after a rule', () => {
    const stock: ShareableRecipe = {
      ...SOUP,
      id: 'stock',
      title: 'Chicken Stock',
      servings: 8,
      prepMinutes: null,
      cookMinutes: null,
      description: null,
      sourceName: null,
      sourceUrl: null,
      ingredients: [line({ quantity: 3, unit: 'lb', foodName: 'chicken bones' })],
      steps: [{ id: 'k0', position: 0, text: 'Simmer four hours.' }],
    };
    const text = recipeText({ ...SOUP, linkedRecipes: [stock] }, { servings: 8, system: 'us' });
    const [soup, linked] = text.split('\n\n---\n\n');
    expect(soup).toContain('- 2 Chicken Stock');
    expect(linked).toBe(
      [
        'Chicken Stock',
        'Serves 8',
        '',
        'Ingredients',
        '- 3 lb chicken bones',
        '',
        'Steps',
        '1. Simmer four hours.',
      ].join('\n'),
    );
  });

  it('puts no stray comma on a line with only an amount and a note', () => {
    const odd: ShareableRecipe = {
      ...SOUP,
      ingredients: [line({ quantity: 2, unit: 'cup', note: 'optional' })],
    };
    expect(recipeText(odd, { servings: 4, system: 'us' })).toContain('- 2 cups optional');
  });

  it('leaves out what the recipe does not have, and a link that is not http', () => {
    const bare: ShareableRecipe = {
      ...SOUP,
      prepMinutes: null,
      cookMinutes: null,
      description: null,
      sourceName: null,
      sourceUrl: 'javascript:alert(1)',
      steps: [],
    };
    const text = recipeText(bare, { servings: 4, system: 'us' });
    expect(text.split('\n').slice(0, 3)).toEqual(['Parsnip Soup', 'Serves 4', '']);
    expect(text).not.toContain('Steps');
    expect(text).not.toContain('Source');
  });
});
