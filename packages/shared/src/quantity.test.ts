import { describe, it, expect } from 'vitest';
import { parseQuantity } from './quantity';

describe('parseQuantity', () => {
  it.each([
    ['2', 2],
    ['1/2', 0.5],
    ['1 1/2', 1.5],
    ['½', 0.5],
    ['1½', 1.5],
    ['1.5', 1.5],
    ['3', 3],
    ['¼', 0.25],
    ['¾', 0.75],
    ['⅓', 1 / 3],
    ['⅔', 2 / 3],
    ['⅛', 0.125],
    ['1 ½', 1.5], // whole + space + unicode fraction
    ['0.25', 0.25],
    ['  2  ', 2], // leading/trailing whitespace
  ])('parses %s -> %s', (input, expected) => {
    expect(parseQuantity(input as string)).toBeCloseTo(expected as number, 5);
  });

  it.each([['', null], ['a', null], ['abc', null]])('returns null for %s', (input, expected) => {
    expect(parseQuantity(input)).toBe(expected);
  });

  it('takes the low end of a range (P1 does not model ranges)', () => {
    expect(parseQuantity('1-2')).toBe(1);
    expect(parseQuantity('1–2')).toBe(1); // en-dash
  });

  it('takes the low end of a range written with a word', () => {
    expect(parseQuantity('4 to 5')).toBe(4);
    expect(parseQuantity('2 or 3')).toBe(2);
    expect(parseQuantity('1 1/2 to 2')).toBe(1.5);
  });

  it('splits a word range in linear time over a long run of whitespace', () => {
    const started = Date.now();
    parseQuantity(`1${' '.repeat(100_000)}x`);
    parseQuantity(`1${' '.repeat(50_000)}to${' '.repeat(50_000)}x`);
    expect(Date.now() - started).toBeLessThan(200);
  });
});
