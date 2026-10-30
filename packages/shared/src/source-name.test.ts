import { describe, it, expect } from 'vitest';
import { sourceBook, sourceSuggestions } from './source-name';

describe('sourceBook', () => {
  it.each([
    ['The Newlywed Cookbook, p. 54', 'The Newlywed Cookbook'],
    ['Joy of Cooking p212', 'Joy of Cooking'],
    ['Salt Fat Acid Heat - pp. 12-13', 'Salt Fat Acid Heat'],
    ['Ottolenghi Simple, page 7', 'Ottolenghi Simple'],
    ['Ottolenghi - Simple', 'Ottolenghi - Simple'],
    ['King Arthur', 'King Arthur'],
    ['Page 7', 'Page 7'],
  ])('%s is the book %s', (name, book) => {
    expect(sourceBook(name)).toBe(book);
  });

  it('reads a hostile name in linear time', () => {
    const started = performance.now();
    sourceBook(`${'a'.repeat(50)}${' '.repeat(100_000)}p${'1'.repeat(100_000)}x`);
    sourceBook(`${', '.repeat(100_000)}p`);
    expect(performance.now() - started).toBeLessThan(100);
  });
});

describe('sourceSuggestions', () => {
  it('suggests each book once, most used first, in its most used spelling', () => {
    expect(
      sourceSuggestions([
        { name: 'King Arthur', count: 4 },
        { name: 'The Newlywed Cookbook, p. 12', count: 1 },
        { name: 'The Newlywed Cookbook', count: 8 },
        { name: 'the newlywed cookbook', count: 1 },
        { name: 'Leite’s Culinaria', count: 1 },
      ]),
    ).toEqual(['The Newlywed Cookbook', 'King Arthur', 'Leite’s Culinaria']);
  });
});
