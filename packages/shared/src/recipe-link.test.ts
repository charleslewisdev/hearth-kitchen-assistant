import { describe, it, expect } from 'vitest';
import { splitRecipeLink, recipeTitleKey, recipeLinkToken, withRecipeLink } from './recipe-link';

describe('splitRecipeLink', () => {
  it('reads the title and leaves the ingredient text for the parser', () => {
    expect(splitRecipeLink('1 pizza dough [[Neapolitan Pizza Dough]]')).toEqual({
      text: '1 pizza dough',
      linkTitle: 'Neapolitan Pizza Dough',
    });
  });

  it('finds a token anywhere in the line', () => {
    expect(splitRecipeLink('1 [[Dough]] pizza dough')).toEqual({
      text: '1 pizza dough',
      linkTitle: 'Dough',
    });
  });

  it('links nothing when there is no token, and trims the line', () => {
    expect(splitRecipeLink('  2 cups flour ')).toEqual({ text: '2 cups flour', linkTitle: null });
  });

  it('ignores an empty token and a half-typed one', () => {
    expect(splitRecipeLink('1 dough [[  ]]').linkTitle).toBeNull();
    expect(splitRecipeLink('1 dough [[Pizza').linkTitle).toBeNull();
    expect(splitRecipeLink('1 dough [[Pizza').text).toBe('1 dough [[Pizza');
  });

  it('keeps the first of two tokens and strips both', () => {
    expect(splitRecipeLink('1 dough [[A]] [[B]]')).toEqual({ text: '1 dough', linkTitle: 'A' });
  });

  it('stays linear on a hostile run of brackets', () => {
    const hostile = '[['.repeat(100_000) + 'a'.repeat(100_000);
    const started = Date.now();
    splitRecipeLink(hostile);
    splitRecipeLink(`[[${'a'.repeat(199)}`.repeat(1000));
    splitRecipeLink(' '.repeat(100_000) + '[[x');
    expect(Date.now() - started).toBeLessThan(500);
  });
});

describe('recipe titles in tokens', () => {
  it('compares titles ignoring case, spacing and brackets', () => {
    expect(recipeTitleKey('  Pizza   DOUGH ')).toBe(recipeTitleKey('pizza dough'));
    expect(recipeTitleKey('Dough [sourdough]')).toBe(recipeTitleKey('Dough sourdough'));
  });

  it('writes a token that reads back to the same title key', () => {
    const title = 'Dough [sourdough]';
    const { linkTitle } = splitRecipeLink(`1 dough ${recipeLinkToken(title)}`);
    expect(recipeTitleKey(linkTitle!)).toBe(recipeTitleKey(title));
  });

  it('puts the token after the ingredient text', () => {
    expect(withRecipeLink('1 pizza dough', 'Dough')).toBe('1 pizza dough [[Dough]]');
    expect(withRecipeLink('1 pizza dough', null)).toBe('1 pizza dough');
  });
});
