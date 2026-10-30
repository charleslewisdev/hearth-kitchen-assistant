import { describe, expect, it } from 'vitest';
import { parseIngredientLine } from './ingredient';
import { measureIn, pickMeasure } from './measure-system';

describe('the second measure a book prints', () => {
  it.each([
    ['3 cups (360g) unbleached all-purpose flour', 3, 'cup', 360, 'g', null],
    ['1 tablespoon (14g) sugar', 1, 'tbsp', 14, 'g', null],
    ['1 cup (240 ml) extra-virgin olive oil, plus additional', 1, 'cup', 240, 'ml', 'plus additional'],
    ['7 cups (1,587 g) tomato sauce', 7, 'cup', 1587, 'g', null],
    ['½ cup (112g) water, warm', 0.5, 'cup', 112, 'g', 'warm'],
    ['250 g (2 cups) plain flour', 250, 'g', 2, 'cup', null],
    ['1 stick (113g) butter, softened', 1, 'stick', 113, 'g', 'softened'],
    ['1 cup (5 oz/158 g) all-purpose flour', 1, 'cup', 158, 'g', null],
    ['1 cup (8 fl oz/250 ml) dry white wine', 1, 'cup', 250, 'ml', null],
    ['2 2/3 cups (10 1/2 oz/330 g) shredded Gruyere cheese', 2 + 2 / 3, 'cup', 330, 'g', null],
    ['1 lb (500 g) lump crabmeat, picked over', 1, 'lb', 500, 'g', 'picked over'],
    ['2 1/2 lb (1.25 kg) yellow onions, halved', 2.5, 'lb', 1.25, 'kg', 'halved'],
  ])('%j', (line, quantity, unit, altQuantity, altUnit, note) => {
    expect(parseIngredientLine(line)).toMatchObject({ quantity, unit, altQuantity, altUnit, note });
  });

  it('reads a British three-way measure, keeping the grams and the cups', () => {
    expect(parseIngredientLine('250g/9oz/2¼ cups plain (all-purpose) flour')).toMatchObject({
      quantity: 2.25,
      unit: 'cup',
      altQuantity: 250,
      altUnit: 'g',
      foodName: 'plain flour',
    });
    expect(parseIngredientLine('90g/3oz milk chocolate')).toMatchObject({
      quantity: 3,
      unit: 'oz',
      altQuantity: 90,
      altUnit: 'g',
      foodName: 'milk chocolate',
    });
  });

  it('leaves asides that are not a measure in the other system as notes', () => {
    // A size, a second measure in the same system, a length, and two metric asides at once.
    const can = parseIngredientLine('1 (14 oz) can diced tomatoes');
    expect(can).toMatchObject({ unit: 'can', note: '14 oz' });
    expect(can.altQuantity).toBeUndefined();
    expect(parseIngredientLine('½ onion, diced (1 cup)').altQuantity).toBeUndefined();
    expect(parseIngredientLine('1 cup (8 oz) milk').altQuantity).toBeUndefined();
    const salt = parseIngredientLine('1 tablespoon (15 g) plus 2 teaspoons (10 g) sea salt');
    expect(salt.altQuantity).toBeUndefined();
    expect(salt).toMatchObject({ foodName: 'sea salt', note: '15 g; 10 g; plus 2 teaspoons' });
  });

  it('reads a measure aside, and only a measure aside', () => {
    expect(measureIn('360g')).toEqual({ quantity: 360, unit: 'g' });
    expect(measureIn('4 fl oz')).toEqual({ quantity: 4, unit: 'fl oz' });
    expect(measureIn('1 ½ cups')).toEqual({ quantity: 1.5, unit: 'cup' });
    expect(measureIn('6 mm')).toBeNull();
    expect(measureIn('spooned & leveled')).toBeNull();
    expect(measureIn('14.5-ounce')).toBeNull();
    expect(measureIn('about 8 oz/250 g')).toEqual({ quantity: 250, unit: 'g' });
    expect(measureIn('6 cups/530g')).toEqual({ quantity: 530, unit: 'g' });
    expect(measureIn('198g to 255g')).toBeNull();
    expect(measureIn('or 2 kg')).toBeNull();
  });

  it('stays linear on hostile asides and lines', () => {
    for (const input of ['1'.repeat(100_000), `${'1,'.repeat(50_000)}g`, `1 ${'fl '.repeat(30_000)}oz`]) {
      const started = performance.now();
      measureIn(input);
      parseIngredientLine(`${input}/9oz/${input}`);
      expect(performance.now() - started).toBeLessThan(300);
    }
  });
});

describe('which measure a cook sees', () => {
  const flour = { quantity: 3, unit: 'cup', altQuantity: 360, altUnit: 'g' };

  it('shows the grams to a cook reading metric, and the cups otherwise', () => {
    expect(pickMeasure(flour, 'metric')).toEqual({ quantity: 360, unit: 'g', alternate: true });
    expect(pickMeasure(flour, 'us')).toEqual({ quantity: 3, unit: 'cup', alternate: false });
  });

  it('shows the only measure there is, whichever system is picked', () => {
    const eggs = { quantity: 2, unit: null, altQuantity: null, altUnit: null };
    expect(pickMeasure(eggs, 'metric')).toEqual({ quantity: 2, unit: null, alternate: false });
    const grams = { quantity: 250, unit: 'g', altQuantity: 2, altUnit: 'cup' };
    expect(pickMeasure(grams, 'metric').unit).toBe('g');
    expect(pickMeasure(grams, 'us')).toEqual({ quantity: 2, unit: 'cup', alternate: true });
  });
});
