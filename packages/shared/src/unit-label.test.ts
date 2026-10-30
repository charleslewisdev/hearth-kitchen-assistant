import { describe, it, expect } from 'vitest';
import { unitLabel } from './unit-label';
import { CANONICAL_UNITS } from './units';

describe('unitLabel', () => {
  it.each([
    ['cup', 3, 'cups'],
    ['cup', 1, 'cup'],
    ['cup', 0.5, 'cup'],
    ['cup', 1.5, 'cups'],
    ['clove', 2, 'cloves'],
    ['can', 2, 'cans'],
    ['bunch', 2, 'bunches'],
    ['box', 2, 'boxes'],
    ['pinch', 2, 'pinches'],
    ['dash', 3, 'dashes'],
    ['handful', 2, 'handfuls'],
    ['piece', 4, 'pieces'],
    ['package', 2, 'packages'],
  ])('%s x %d -> %s', (unit, quantity, expected) => {
    expect(unitLabel(unit, quantity)).toBe(expected);
  });

  it('leaves abbreviations alone', () => {
    for (const unit of ['tbsp', 'tsp', 'g', 'oz', 'lb', 'ml', 'l', 'kg']) {
      expect(unitLabel(unit, 3)).toBe(unit);
    }
  });

  it('reads an amount that displays as 1 as one', () => {
    // A scaled 1.001 is shown as "1", and "1 cups" is wrong.
    expect(unitLabel('cup', 1.001)).toBe('cup');
  });

  it('leaves a unit it does not know as it was given', () => {
    expect(unitLabel('dozen', 2)).toBe('dozen');
    expect(unitLabel('Cups', 2)).toBe('Cups');
  });

  it('has a label for every canonical unit', () => {
    for (const unit of CANONICAL_UNITS) expect(unitLabel(unit, 2)).not.toBe('');
  });

  it('leaves a missing quantity singular', () => {
    expect(unitLabel('cup', null)).toBe('cup');
  });
});

describe('unitLabel for dozen', () => {
  it('never says dozens', () => {
    expect(unitLabel('dozen', 2)).toBe('dozen');
  });
});

describe('unitLabel for liquid volumes', () => {
  it('pluralises pints, quarts and gallons, and leaves fl oz alone', () => {
    expect(unitLabel('pint', 2)).toBe('pints');
    expect(unitLabel('quart', 1)).toBe('quart');
    expect(unitLabel('gallon', 3)).toBe('gallons');
    expect(unitLabel('fl oz', 8)).toBe('fl oz');
  });
});
