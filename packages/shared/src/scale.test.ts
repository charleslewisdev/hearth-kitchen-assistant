import { describe, it, expect } from 'vitest';
import { scale, scaleRange } from './scale';

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

describe('scaleRange', () => {
  it('scales both ends of a range', () => {
    expect(
      scaleRange({ quantity: 2, quantityHigh: 3, mode: 'linear' }, { from: 4, to: 8 }),
    ).toEqual({ quantity: 4, quantityHigh: 6 });
    expect(
      scaleRange({ quantity: 0.25, quantityHigh: 0.5, mode: 'linear' }, { from: 4, to: 6 }),
    ).toEqual({ quantity: 0.375, quantityHigh: 0.75 });
  });
  it('leaves a single amount single, and a fixed range as it is', () => {
    expect(
      scaleRange({ quantity: 2, quantityHigh: null, mode: 'linear' }, { from: 4, to: 8 }),
    ).toEqual({ quantity: 4, quantityHigh: null });
    expect(scaleRange({ quantity: 1, quantityHigh: 2, mode: 'fixed' }, { from: 4, to: 8 })).toEqual(
      { quantity: 1, quantityHigh: 2 },
    );
  });
  it('has no high end without a low one', () => {
    expect(
      scaleRange({ quantity: null, quantityHigh: 2, mode: 'linear' }, { from: 4, to: 8 }),
    ).toEqual({ quantity: null, quantityHigh: null });
  });
});
