import { describe, it, expect } from 'vitest';
import { draftToCreateInput, emptyDraft, field, MEAL_TYPES } from './draft';
import type { RecipeDraft } from './draft';

const source = { kind: 'url', url: 'https://example.com/r' } as const;

function aDraft(over: Partial<RecipeDraft> = {}): RecipeDraft {
  return {
    ...emptyDraft(source),
    title: field('Banana bread', 'high', 'Banana bread'),
    ...over,
  };
}

describe('the draft envelope', () => {
  it('carries a value, a binary confidence and the source words per field', () => {
    const f = field('Banana bread', 'high', 'Banana Bread ');
    expect(f).toEqual({ value: 'Banana bread', confidence: 'high', raw: 'Banana Bread ' });
  });

  it('defaults every field to low confidence with no source words', () => {
    const draft = emptyDraft(source);
    expect(draft.title).toEqual({ value: '', confidence: 'low', raw: null });
    expect(draft.servings).toEqual({ value: 1, confidence: 'low', raw: null });
    expect(draft.ingredientLines.value).toEqual([]);
    expect(draft.steps.value).toEqual([]);
    expect(draft.mealTypes.value).toEqual([]);
    expect(draft.tags.value).toEqual([]);
  });

  it('remembers where it came from, for the review screen to show', () => {
    expect(emptyDraft(source).source).toEqual({ kind: 'url', url: 'https://example.com/r' });
  });
});

describe('draftToCreateInput', () => {
  it('flattens to exactly the fields recipe.create takes, dropping confidence and raw', () => {
    const draft = aDraft({
      servings: field(4, 'high', '4 servings'),
      mealTypes: field(['dinner'], 'low', 'Main Course'),
      tags: field(['italian'], 'low', 'Italian'),
      ingredientLines: field(['2 cups flour'], 'high', null),
      steps: field(['Mix it.'], 'high', null),
    });
    expect(draftToCreateInput(draft)).toEqual({
      title: 'Banana bread',
      servings: 4,
      mealTypes: ['dinner'],
      tags: ['italian'],
      ingredientLines: ['2 cups flour'],
      steps: ['Mix it.'],
      sourceUrl: 'https://example.com/r',
    });
  });

  it('keeps the source URL, because that is provenance a cook can act on', () => {
    // Phase J dropped it, on the grounds that `recipe.create` took no such field. That was the
    // wrong way round: the column existed, the field did not, and an imported recipe displayed
    // where it came from and then lost it on save - which is how a cook gets back to the
    // headnote, the comments and the photograph.
    expect(draftToCreateInput(aDraft()).sourceUrl).toBe('https://example.com/r');
  });

  it('offers no source URL for a draft that came from a file', () => {
    // A file name is not somewhere anybody can go back to, so these look exactly like a recipe
    // typed by hand - which is the point of not special-casing imports downstream.
    for (const kind of ['text', 'pdf', 'image'] as const) {
      const flattened = draftToCreateInput({
        ...emptyDraft({ kind }),
        title: field('x', 'low', null),
      });
      expect(flattened).not.toHaveProperty('sourceUrl');
      expect(Object.keys(flattened).sort()).toEqual([
        'ingredientLines',
        'mealTypes',
        'servings',
        'steps',
        'tags',
        'title',
      ]);
    }
  });
});

describe('MEAL_TYPES', () => {
  it('is the vocabulary the recipe router accepts, in its order', () => {
    expect(MEAL_TYPES).toEqual([
      'breakfast',
      'lunch',
      'dinner',
      'snack',
      'dessert',
      'side',
      'drink',
      'sauce',
      'base',
    ]);
  });
});
