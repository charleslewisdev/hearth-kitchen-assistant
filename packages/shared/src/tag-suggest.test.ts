import { describe, it, expect } from 'vitest';
import { suggestTags, tagWords } from './tag-suggest';

const EXISTING = ['Chicken', 'Indian', 'Italian', 'Pork', 'Quick & easy', 'Vegan', 'Olive oil'];

describe('suggestTags', () => {
  it('fills in the household’s own tags that the title or the site names', () => {
    const { chosen } = suggestTags(
      {
        title: 'Palak Chicken (Chicken Saag)',
        ingredientLines: [],
        siteTags: ['chicken saag', 'palak chicken', 'Indian'],
      },
      EXISTING,
    );
    expect(chosen).toEqual(['Chicken', 'Indian']);
  });

  it('never fills in a site keyword the household does not use, and drops the junk', () => {
    const { chosen, offered } = suggestTags(
      {
        title: 'Easy Baked Pork Tenderloin',
        ingredientLines: ['1 pork tenderloin', '2 tbsp olive oil'],
        siteTags: [
          'baked pork tenderloin recipe',
          'roasted pork tenderloin recipe',
          'pork tenderloin',
          'weeknight dinner',
          'how to make the very best pork tenderloin ever',
          'American',
        ],
      },
      EXISTING,
    );
    expect(chosen).toEqual(['Pork']);
    // Ingredient matches among existing tags first, then the keywords worth a tap.
    expect(offered).toEqual(['Olive oil', 'weeknight dinner', 'American']);
  });

  it('matches by words with plurals folded, not by substring', () => {
    const { chosen } = suggestTags(
      { title: 'Chickpea Curry with Chickens', ingredientLines: [], siteTags: [] },
      ['Chickpea', 'Chicken', 'Curries', 'Pea'],
    );
    expect(chosen).toEqual(['Chickpea', 'Chicken', 'Curries']);
  });

  it('keeps multi-word tags whole and never suggests one twice', () => {
    const { chosen, offered } = suggestTags(
      {
        title: 'Quick & Easy Pesto',
        ingredientLines: ['olive oil'],
        siteTags: ['Quick & Easy', 'Olive Oil'],
      },
      EXISTING,
    );
    expect(chosen).toEqual(['Quick & easy', 'Olive oil']);
    expect(offered).toEqual([]);
  });

  it('suggests nothing for a household with no tags and a photo with no keywords', () => {
    expect(
      suggestTags({ title: 'Osso Buco', ingredientLines: ['4 veal shanks'], siteTags: [] }, []),
    ).toEqual({ chosen: [], offered: [] });
  });

  it('reads a hostile field in linear time', () => {
    const hostile = `${'a&'.repeat(50_000)}!`;
    const started = performance.now();
    tagWords(hostile);
    suggestTags({ title: hostile, ingredientLines: [hostile], siteTags: [hostile] }, [hostile]);
    expect(performance.now() - started).toBeLessThan(200);
  });
});
