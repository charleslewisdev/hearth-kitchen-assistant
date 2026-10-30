import { describe, it, expect } from 'vitest';
import { addDays, dayOfWeek, isIsoDate, weekDates, weekStartFor } from './plan-week';

describe('isIsoDate', () => {
  it('accepts a real calendar day', () => {
    expect(isIsoDate('2026-09-23')).toBe(true);
    expect(isIsoDate('2028-02-29')).toBe(true);
  });
  it('refuses days that do not exist and other shapes', () => {
    expect(isIsoDate('2026-02-29')).toBe(false);
    expect(isIsoDate('2026-13-01')).toBe(false);
    expect(isIsoDate('2026-9-23')).toBe(false);
    expect(isIsoDate('2026-09-23T00:00:00Z')).toBe(false);
    expect(isIsoDate('')).toBe(false);
  });
});

describe('addDays', () => {
  it('crosses month, year and leap-day boundaries', () => {
    expect(addDays('2026-09-30', 1)).toBe('2026-10-01');
    expect(addDays('2026-12-31', 1)).toBe('2027-01-01');
    expect(addDays('2028-02-28', 1)).toBe('2028-02-29');
    expect(addDays('2026-03-01', -1)).toBe('2026-02-28');
    expect(addDays('2026-09-23', 0)).toBe('2026-09-23');
  });
});

describe('dayOfWeek', () => {
  it('numbers days from Sunday = 0', () => {
    expect(dayOfWeek('2026-09-20')).toBe(0); // a Sunday
    expect(dayOfWeek('2026-09-23')).toBe(3); // a Wednesday
    expect(dayOfWeek('2026-09-26')).toBe(6); // a Saturday
  });
});

describe('weekStartFor', () => {
  it('finds the Sunday on or before the date when weeks start on Sunday', () => {
    expect(weekStartFor('2026-09-23', 0)).toBe('2026-09-20');
    expect(weekStartFor('2026-09-20', 0)).toBe('2026-09-20');
    expect(weekStartFor('2026-09-26', 0)).toBe('2026-09-20');
  });
  it('finds the Monday on or before the date when weeks start on Monday', () => {
    expect(weekStartFor('2026-09-23', 1)).toBe('2026-09-21');
    expect(weekStartFor('2026-09-20', 1)).toBe('2026-09-14');
  });
  it('works for every start day', () => {
    for (let start = 0; start < 7; start++) {
      const s = weekStartFor('2026-09-23', start);
      expect(dayOfWeek(s)).toBe(start);
      const gap = (Date.parse('2026-09-23') - Date.parse(s)) / 86_400_000;
      expect(gap).toBeGreaterThanOrEqual(0);
      expect(gap).toBeLessThan(7);
    }
  });
  it('crosses a year boundary', () => {
    expect(weekStartFor('2027-01-01', 0)).toBe('2026-12-27');
  });
});

describe('weekDates', () => {
  it('lists the seven days from the start', () => {
    expect(weekDates('2026-09-27')).toEqual([
      '2026-09-27',
      '2026-09-28',
      '2026-09-29',
      '2026-09-30',
      '2026-10-01',
      '2026-10-02',
      '2026-10-03',
    ]);
  });
});
