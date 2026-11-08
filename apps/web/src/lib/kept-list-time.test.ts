import { describe, it, expect } from 'vitest';
import { keptListTime } from './kept-list-time';

describe('keptListTime', () => {
  const now = new Date(2026, 10, 8, 18, 30);
  const time = (d: Date) =>
    d
      .toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' })
      .replaceAll(' ', '\u00a0');

  it('says only the time for today, on one line', () => {
    const at = new Date(2026, 10, 8, 14, 41);
    expect(keptListTime(at.getTime(), now)).toBe(time(at));
    expect(keptListTime(at.getTime(), now)).not.toContain(' ');
  });

  it('says yesterday for yesterday', () => {
    const at = new Date(2026, 10, 7, 23, 5);
    expect(keptListTime(at.getTime(), now)).toBe(`yesterday, ${time(at)}`);
  });

  it('names the day before that', () => {
    const at = new Date(2026, 10, 3, 9, 12);
    const day = at.toLocaleDateString(undefined, {
      weekday: 'short',
      month: 'short',
      day: 'numeric',
    });
    expect(keptListTime(at.getTime(), now)).toBe(`${day}, ${time(at)}`);
  });
});
