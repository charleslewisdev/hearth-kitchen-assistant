import { describe, it, expect } from 'vitest';
import { slugify } from './slug';

describe('slugify', () => {
  it('lowercases and hyphenates words', () => {
    expect(slugify('Tuscan White Bean Soup')).toBe('tuscan-white-bean-soup');
  });
  it('collapses runs of non-alphanumerics to one hyphen', () => {
    expect(slugify('Mac  &  Cheese!!')).toBe('mac-cheese');
  });
  it('trims leading and trailing separators', () => {
    expect(slugify('  --Hello--  ')).toBe('hello');
  });
  it('returns empty string for input with no alphanumerics', () => {
    expect(slugify('!!!')).toBe('');
  });
});
