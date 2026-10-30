import { describe, it, expect } from 'vitest';
import { durationMinutes } from './duration';

describe('durationMinutes', () => {
  it.each([
    ['PT20M', 20],
    ['PT1H30M', 90],
    ['PT90M', 90],
    ['PT1H', 60],
    ['P0DT0H45M', 45],
    ['P1DT2H', 1560],
    ['PT30S', 1],
    ['pt15m', 15],
    [' PT10M ', 10],
  ])('reads %j as %d minutes', (value, minutes) => {
    expect(durationMinutes(value)).toBe(minutes);
  });

  it.each([['P'], ['PT'], ['PT0M'], ['20 minutes'], ['P3D'], [''], ['PT1H30'], ['P1Y']])(
    'reads %j as unknown',
    (value) => {
      expect(durationMinutes(value)).toBeNull();
    },
  );

  it('reads anything but a string as unknown', () => {
    expect(durationMinutes(20)).toBeNull();
    expect(durationMinutes(null)).toBeNull();
    expect(durationMinutes(['PT5M'])).toBeNull();
  });

  it('costs linear time on hostile input', () => {
    const started = performance.now();
    for (const hostile of [
      'P' + '1'.repeat(100_000),
      'PT' + '9'.repeat(100_000) + 'X',
      'PT1H'.repeat(20_000),
    ]) {
      expect(durationMinutes(hostile)).toBeNull();
    }
    expect(performance.now() - started).toBeLessThan(100);
  });
});
