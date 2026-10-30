import { describe, it, expect } from 'vitest';
import { defaultTagColor, TAG_COLORS, tagColor } from './tag-colors';

describe('tag colours', () => {
  it('gives a tag the same colour every time, whatever its case', () => {
    expect(defaultTagColor('Italian')).toBe(defaultTagColor('Italian'));
    expect(defaultTagColor('Italian')).toBe(defaultTagColor('italian'));
  });

  it('spreads ordinary tags over more than a couple of colours', () => {
    const names = ['Italian', 'Vegan', 'Pizza', 'Chicken', 'Pork', 'Rice', 'Pastry', 'American'];
    expect(new Set(names.map(defaultTagColor)).size).toBeGreaterThanOrEqual(4);
  });

  it('uses a chosen colour, and ignores one that is not in the palette', () => {
    expect(tagColor('Vegan', 'plum')).toBe('plum');
    expect(tagColor('Vegan', 'chartreuse')).toBe(defaultTagColor('Vegan'));
    expect(TAG_COLORS).toContain(tagColor('Vegan', null));
  });
});
