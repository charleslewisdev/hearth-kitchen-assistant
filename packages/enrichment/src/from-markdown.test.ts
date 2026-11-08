import { describe, it, expect } from 'vitest';
import { recipeToMarkdown, type MarkdownRecipe } from '@hearth/shared';
import { draftFromMarkdown } from './from-markdown';
import { draftToCreateInput } from './draft';

const recipe: MarkdownRecipe = {
  title: 'Barley Pilaf',
  servings: 4,
  servingsHigh: 6,
  prepMinutes: 5,
  cookMinutes: 35,
  types: ['side'],
  tags: ['grains'],
  rating: 3,
  sourceName: 'Invented for this test',
  sourceUrl: 'https://example.com/pilaf',
  description: 'Nutty and plain.',
  ingredientLines: ['1 cup pearl barley', '2 cups Stock [[Stock]]'],
  steps: ['Toast the barley.', 'Simmer in the stock.'],
};

describe('draftFromMarkdown', () => {
  it('is a draft that states every field outright', () => {
    const draft = draftFromMarkdown(recipeToMarkdown(recipe));
    expect(draft).not.toBeNull();
    expect(draft!.source).toEqual({
      kind: 'markdown',
      sourceName: 'Invented for this test',
      sourceUrl: 'https://example.com/pilaf',
      rating: 3,
    });
    for (const f of [
      draft!.title,
      draft!.servings,
      draft!.mealTypes,
      draft!.tags,
      draft!.ingredientLines,
      draft!.steps,
    ]) {
      expect(f.confidence).toBe('high');
    }
    expect(draft!.details).toEqual({
      description: 'Nutty and plain.',
      prepMinutes: 5,
      cookMinutes: 35,
    });
    expect(draft!.servings.value).toBe(4);
    expect(draft!.servingsHigh).toBe(6);
  });

  it('flattens to the create input with nothing dropped', () => {
    expect(draftToCreateInput(draftFromMarkdown(recipeToMarkdown(recipe))!)).toEqual({
      title: 'Barley Pilaf',
      servings: 4,
      servingsHigh: 6,
      mealTypes: ['side'],
      tags: ['grains'],
      ingredientLines: ['1 cup pearl barley', '2 cups Stock [[Stock]]'],
      steps: ['Toast the barley.', 'Simmer in the stock.'],
      sourceUrl: 'https://example.com/pilaf',
      sourceName: 'Invented for this test',
      rating: 3,
      description: 'Nutty and plain.',
      prepMinutes: 5,
      cookMinutes: 35,
    });
  });

  it('is null without front matter, so the paste goes to the text importer', () => {
    expect(draftFromMarkdown('Barley Pilaf\n\n1 cup pearl barley\n\nSimmer it.')).toBeNull();
  });

  it('flags a title it could not find, rather than inventing one', () => {
    const draft = draftFromMarkdown('---\nservings: 2\n---\n## Ingredients\n- 1 egg\n');
    expect(draft!.title).toEqual({ value: '', confidence: 'low', raw: null });
    expect(draft!.servings.value).toBe(2);
  });

  it('flags servings the file did not state', () => {
    const draft = draftFromMarkdown('---\ntitle: Egg\n---\n');
    expect(draft!.servings).toEqual({ value: 1, confidence: 'low', raw: null });
  });

  it('has no servings range when the file states none, or one Hearth would not keep', () => {
    expect(
      draftFromMarkdown(recipeToMarkdown({ ...recipe, servingsHigh: null }))!.servingsHigh,
    ).toBeNull();
    expect(draftFromMarkdown('---\nservings: 4\nservings_high: 4\n---\n')!.servingsHigh).toBeNull();
  });

  it('reads a hand-written range, but no Up to beside servings it had to guess', () => {
    const draft = draftFromMarkdown('---\nservings: 4\nservings_high: 6\n---\n')!;
    expect([draft.servings.value, draft.servingsHigh]).toEqual([4, 6]);
    const guessed = draftFromMarkdown('---\ntitle: Egg\nservings_high: 6\n---\n')!;
    expect(guessed.servings).toEqual({ value: 1, confidence: 'low', raw: null });
    expect(guessed.servingsHigh).toBeNull();
  });
});
