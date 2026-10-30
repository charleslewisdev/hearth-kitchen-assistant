import { describe, it, expect } from 'vitest';
import { formatQuantity } from './quantity-format';
import { scale } from './scale';

describe('formatQuantity', () => {
  it('shows whole numbers as they are', () => {
    expect(formatQuantity(2)).toBe('2');
    expect(formatQuantity(12, 'cup')).toBe('12');
  });

  it('shows the kitchen fractions as fractions', () => {
    expect(formatQuantity(0.5)).toBe('½');
    expect(formatQuantity(0.125, 'tsp')).toBe('⅛');
    expect(formatQuantity(1.75, 'cup')).toBe('1 ¾');
    expect(formatQuantity(2.25)).toBe('2 ¼');
  });

  it('reads the rounded thirds that parsing and scaling leave behind', () => {
    expect(formatQuantity(0.333)).toBe('⅓');
    expect(formatQuantity(1.667, 'cup')).toBe('1 ⅔');
  });

  it('snaps a scaled amount that lands a hair off a measure', () => {
    // 1/3 cup is stored as 0.333; for 4, cooked for 9, `scale` gives 0.749.
    const scaled = scale({ quantity: 0.333, mode: 'linear' }, { from: 4, to: 9 });
    expect(scaled).toBe(0.749);
    expect(formatQuantity(scaled!, 'cup')).toBe('¾');
    expect(formatQuantity(2.99)).toBe('3');
  });

  it('keeps a value that is no kitchen measure as a short decimal', () => {
    expect(formatQuantity(0.43)).toBe('0.43');
    // 1/4 tsp for 4, cooked for 3, is 3/16: no spoon measures that, and ⅛ would be a lie.
    expect(formatQuantity(0.188, 'tsp')).toBe('0.19');
    expect(formatQuantity(1.428571)).toBe('1.43');
  });

  it('keeps metric amounts in decimals', () => {
    expect(formatQuantity(0.5, 'g')).toBe('0.5');
    expect(formatQuantity(187.5, 'g')).toBe('187.5');
    expect(formatQuantity(1.25, 'l')).toBe('1.25');
  });
});
