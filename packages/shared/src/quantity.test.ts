import { describe, it, expect } from 'vitest';
import { parseQuantity, parseQuantityRange } from './quantity';

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

  it('is the low end of a range', () => {
    expect(parseQuantity('1-2')).toBe(1);
    expect(parseQuantity('4 to 5')).toBe(4);
    expect(parseQuantity('1 1/2 to 2')).toBe(1.5);
  });
  it('splits a word range in linear time over a long run of whitespace', () => {
    const started = Date.now();
    parseQuantity(`1${' '.repeat(100_000)}x`);
    parseQuantity(`1${' '.repeat(50_000)}to${' '.repeat(50_000)}x`);
    expect(Date.now() - started).toBeLessThan(200);
  });
});

describe('parseQuantityRange', () => {
  it.each([
    ['1-2', 1, 2],
    ['1–2', 1, 2], // en-dash
    ['2 - 3', 2, 3],
    ['4 to 5', 4, 5],
    ['2 or 3', 2, 3],
    ['1 1/2 to 2', 1.5, 2],
    ['¾ to 1', 0.75, 1],
    ['1/4-1/2', 0.25, 0.5],
    ['1½–2½', 1.5, 2.5],
  ])('reads %s as %s to %s', (input, low, high) => {
    expect(parseQuantityRange(input)).toEqual({ low, high });
  });

  it('has no high end for a single amount', () => {
    expect(parseQuantityRange('2')).toEqual({ low: 2, high: null });
    expect(parseQuantityRange('1 1/2')).toEqual({ low: 1.5, high: null });
  });

  it('reads a range that does not rise as its low end', () => {
    expect(parseQuantityRange('2-2')).toEqual({ low: 2, high: null });
    expect(parseQuantityRange('3-2')).toEqual({ low: 3, high: null });
  });

  it('keeps the low end when the high end is not a number', () => {
    expect(parseQuantityRange('2 to taste')).toEqual({ low: 2, high: null });
    expect(parseQuantityRange('2-')).toEqual({ low: 2, high: null });
  });

  it('reads an amount that divides by zero as no amount, at either end', () => {
    expect(parseQuantityRange('1-1/0')).toEqual({ low: 1, high: null });
    expect(parseQuantityRange('1/0')).toBeNull();
  });

  it('is null without a leading amount', () => {
    expect(parseQuantityRange('')).toBeNull();
    expect(parseQuantityRange('a few')).toBeNull();
    expect(parseQuantityRange('-2')).toBeNull();
  });

  it('splits in linear time over long hostile runs', () => {
    const started = Date.now();
    parseQuantityRange(`1${' '.repeat(100_000)}to${' '.repeat(100_000)}2`);
    parseQuantityRange(`${'1-'.repeat(50_000)}x`);
    parseQuantityRange(`1 - ${'9'.repeat(100_000)}`);
    expect(Date.now() - started).toBeLessThan(200);
  });
});
