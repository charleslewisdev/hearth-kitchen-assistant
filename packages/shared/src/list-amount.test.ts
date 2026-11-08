import { describe, it, expect } from 'vitest';
import { parseListAmount, listAmountText, MAX_LIST_AMOUNT_LENGTH } from './list-amount';
import { CANONICAL_UNITS } from './units';

describe('parseListAmount', () => {
  it.each([
    ['3', 3, null],
    ['1 1/2 lb', 1.5, 'lb'],
    ['1 ½ lb', 1.5, 'lb'],
    ['1½ lb', 1.5, 'lb'],
    ['2 cups', 2, 'cup'],
    ['12 fl oz', 12, 'fl oz'],
    ['1.5 kg', 1.5, 'kg'],
    ['2 cloves', 2, 'clove'],
    ['2 dozen', 2, 'dozen'],
    ['pinch', 1, 'pinch'],
    ['  3 cans  ', 3, 'can'],
  ])('reads %j as %d %s', (text, quantity, unit) => {
    expect(parseListAmount(text)).toEqual({ quantity, unit });
  });

  it('reads an empty box as no amount at all', () => {
    expect(parseListAmount('')).toEqual({ quantity: null, unit: null });
    expect(parseListAmount('   ')).toEqual({ quantity: null, unit: null });
  });

  it.each([
    ['a food after the amount', '2 cups flour'],
    ['a unit with no amount', 'lb'],
    ['words', 'some'],
    ['a size word', '3 large'],
    ['a packaging aside', '2 (14 oz) cans'],
    ['a comma note', '2 tbsp, minced'],
    ['zero', '0'],
    ['a negative', '-1'],
    ['a division by zero', '1/0'],
    ['an absurd amount', '1000000'],
  ])('refuses %s', (_why, text) => {
    expect(parseListAmount(text)).toBeNull();
  });

  it('refuses text longer than the box allows', () => {
    expect(parseListAmount('1'.padEnd(MAX_LIST_AMOUNT_LENGTH + 1, ' '))).toEqual({
      quantity: 1,
      unit: null,
    });
    expect(parseListAmount(`1 ${'x'.repeat(MAX_LIST_AMOUNT_LENGTH)}`)).toBeNull();
  });

  it('reads back what the list shows, for every unit', () => {
    for (const unit of CANONICAL_UNITS) {
      for (const quantity of [1, 2, 1.5, 0.25]) {
        expect(parseListAmount(listAmountText(quantity, unit)), `${quantity} ${unit}`).toEqual({
          quantity,
          unit,
        });
      }
    }
    expect(parseListAmount(listAmountText(3, null))).toEqual({ quantity: 3, unit: null });
  });

  it('stays fast on hostile input', () => {
    const hostile = [
      '1'.repeat(100_000),
      ' '.repeat(100_000) + 'x',
      '1 '.repeat(50_000),
      '1/'.repeat(50_000),
      '('.repeat(50_000),
      '½'.repeat(100_000),
    ];
    const start = performance.now();
    for (const text of hostile) parseListAmount(text);
    expect(performance.now() - start).toBeLessThan(500);
  });
});

describe('listAmountText', () => {
  it('writes an amount the way the list shows it', () => {
    expect(listAmountText(1.5, 'lb')).toBe('1 ½ lb');
    expect(listAmountText(2, 'clove')).toBe('2 cloves');
    expect(listAmountText(3, null)).toBe('3');
  });

  it('writes nothing for no amount', () => {
    expect(listAmountText(null, null)).toBe('');
    expect(listAmountText(null, 'cup')).toBe('');
  });
});
