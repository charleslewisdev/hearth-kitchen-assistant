import { describe, it, expect } from 'vitest';
import { lineIndexAt, setLineLink, openedLinkAt, matchRecipes } from './ingredient-links';

describe('lineIndexAt', () => {
  it('counts blank lines too', () => {
    const text = 'a\n\nb';
    expect(lineIndexAt(text, 0)).toBe(0);
    expect(lineIndexAt(text, 2)).toBe(1);
    expect(lineIndexAt(text, text.length)).toBe(2);
  });
});

describe('setLineLink', () => {
  it('appends a token to the line and puts the caret at its end', () => {
    const result = setLineLink('1 pizza dough\n200 g mozzarella', 0, 'Pizza Dough');
    expect(result.text).toBe('1 pizza dough [[Pizza Dough]]\n200 g mozzarella');
    expect(result.caret).toBe('1 pizza dough [[Pizza Dough]]'.length);
  });

  it('replaces an existing token, on the right line', () => {
    expect(setLineLink('1 dough [[Old]]', 0, 'New').text).toBe('1 dough [[New]]');
    expect(setLineLink('salt\n1 dough', 1, 'New').text).toBe('salt\n1 dough [[New]]');
  });

  it('removes the link when the title is null', () => {
    expect(setLineLink('1 dough [[Old]]', 0, null).text).toBe('1 dough');
  });
});

describe('openedLinkAt', () => {
  it('sees a [[ just before the caret', () => {
    expect(openedLinkAt('1 dough [[', 10)).toBe(true);
    expect(openedLinkAt('1 dough [', 9)).toBe(false);
  });
});

describe('matchRecipes', () => {
  const recipes = [
    { id: '1', title: 'Neapolitan Pizza Dough' },
    { id: '2', title: 'Pizza Sauce' },
    { id: '3', title: 'Binulati' },
  ];

  it('puts titles that start with the query first and skips the recipe being edited', () => {
    expect(matchRecipes(recipes, 'pizza', null).map((r) => r.id)).toEqual(['2', '1']);
    expect(matchRecipes(recipes, 'pizza', '2').map((r) => r.id)).toEqual(['1']);
  });

  it('offers everything, alphabetically, for an empty query', () => {
    expect(matchRecipes(recipes, '', null).map((r) => r.id)).toEqual(['3', '1', '2']);
  });
});
