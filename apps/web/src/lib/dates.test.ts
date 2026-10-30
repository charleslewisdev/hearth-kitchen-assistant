import { describe, it, expect } from 'vitest';
import { daysAgo } from './dates';

describe('daysAgo', () => {
  it.each([
    ['2026-09-27', 'today'],
    ['2026-09-26', 'yesterday'],
    ['2026-09-22', '5 days ago'],
    ['2026-09-06', '3 weeks ago'],
    ['2026-06-01', '4 months ago'],
    ['2023-09-27', '3 years ago'],
  ])('%s is %s', (date, said) => {
    expect(daysAgo(date, '2026-09-27')).toBe(said);
  });
});
