import { describe, it, expect } from 'vitest';
import { scale } from './scale';

describe('scale', () => {
  it('scales linearly up', () => {
    expect(scale({ quantity: 2, mode: 'linear' }, { from: 4, to: 8 })).toBe(4);
  });
  it('scales linearly down', () => {
    expect(scale({ quantity: 2, mode: 'linear' }, { from: 4, to: 2 })).toBe(1);
  });
  it('never scales a null ("to taste") quantity', () => {
    expect(scale({ quantity: null, mode: 'linear' }, { from: 4, to: 8 })).toBeNull();
  });
  it('leaves non-linear modes unscaled in P1 (fixed)', () => {
    expect(scale({ quantity: 2, mode: 'fixed' }, { from: 4, to: 8 })).toBe(2);
  });
  it('leaves sublinear/manual unscaled in P1', () => {
    expect(scale({ quantity: 2, mode: 'sublinear' }, { from: 4, to: 8 })).toBe(2);
    expect(scale({ quantity: 2, mode: 'manual' }, { from: 4, to: 8 })).toBe(2);
  });
  it('rounds to a sensible precision', () => {
    // 1 * 3/7 = 0.42857... -> rounded to 3 decimal places
    expect(scale({ quantity: 1, mode: 'linear' }, { from: 7, to: 3 })).toBeCloseTo(0.429, 3);
  });
  it('guards against a zero "from" serving count (returns quantity unchanged)', () => {
    expect(scale({ quantity: 2, mode: 'linear' }, { from: 0, to: 8 })).toBe(2);
  });
});
