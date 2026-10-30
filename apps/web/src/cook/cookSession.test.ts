import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  COOK_SESSION_PREFIX,
  STALE_SESSION_MS,
  clearCookSession,
  loadCookSession,
  saveCookSession,
  sweepStaleCookSessions,
} from './cookSession';

const NOW = Date.parse('2026-09-10T10:00:00Z');
const KEY = `${COOK_SESSION_PREFIX}r1`;

const timer = {
  id: 'timer-1',
  label: 'Step 1 · 20 minutes',
  totalSeconds: 1200,
  endsAt: NOW + 600_000,
};

beforeEach(() => localStorage.clear());
afterEach(() => vi.restoreAllMocks());

describe('the saved cook session', () => {
  it('round-trips ticked steps and timers under a versioned key per recipe', () => {
    saveCookSession('r1', { doneStepIds: ['s1'], timers: [timer] }, NOW);
    expect(localStorage.getItem(KEY)).not.toBeNull();
    expect(KEY).toBe('hearth.cook.v1.r1');

    expect(loadCookSession('r1', NOW + 1000)).toEqual({ doneStepIds: ['s1'], timers: [timer] });
    expect(loadCookSession('r2', NOW + 1000)).toBeNull();
  });

  it('forgets a recipe on clear', () => {
    saveCookSession('r1', { doneStepIds: ['s1'], timers: [] }, NOW);
    clearCookSession('r1');
    expect(localStorage.getItem(KEY)).toBeNull();
    expect(loadCookSession('r1', NOW)).toBeNull();
  });

  it('ignores and removes a session untouched for more than a day', () => {
    saveCookSession('r1', { doneStepIds: ['s1'], timers: [] }, NOW);
    expect(loadCookSession('r1', NOW + STALE_SESSION_MS + 1)).toBeNull();
    expect(localStorage.getItem(KEY)).toBeNull();
  });

  it('counts a timer still due later as activity, so a long one is not dropped as stale', () => {
    const long = { ...timer, totalSeconds: 30 * 3600, endsAt: NOW + 30 * 3600_000 };
    saveCookSession('r1', { doneStepIds: [], timers: [long] }, NOW);
    expect(loadCookSession('r1', NOW + 25 * 3600_000)?.timers).toEqual([long]);
  });

  it('sweeps every stale cook session, and nothing else', () => {
    saveCookSession('old', { doneStepIds: ['s1'], timers: [] }, NOW - STALE_SESSION_MS - 1);
    saveCookSession('fresh', { doneStepIds: ['s1'], timers: [] }, NOW);
    localStorage.setItem(`${COOK_SESSION_PREFIX}junk`, '{not json');
    localStorage.setItem('hearth.import.lastSource', 'Joy of Cooking');

    sweepStaleCookSessions(NOW);

    expect(localStorage.getItem(`${COOK_SESSION_PREFIX}old`)).toBeNull();
    expect(localStorage.getItem(`${COOK_SESSION_PREFIX}junk`)).toBeNull();
    expect(localStorage.getItem(`${COOK_SESSION_PREFIX}fresh`)).not.toBeNull();
    expect(localStorage.getItem('hearth.import.lastSource')).toBe('Joy of Cooking');
  });

  it('treats anything malformed as no session at all', () => {
    const bad = [
      'not json',
      'null',
      '[]',
      JSON.stringify({ savedAt: 'yesterday', doneStepIds: [], timers: [] }),
      JSON.stringify({ savedAt: NOW, doneStepIds: 'all', timers: [] }),
      JSON.stringify({ savedAt: NOW, doneStepIds: [], timers: {} }),
    ];
    for (const raw of bad) {
      localStorage.setItem(KEY, raw);
      expect(loadCookSession('r1', NOW)).toBeNull();
    }
  });

  it('drops the malformed parts of an otherwise good session', () => {
    localStorage.setItem(
      KEY,
      JSON.stringify({
        savedAt: NOW,
        doneStepIds: ['s1', 7, null],
        timers: [
          timer,
          { label: 'no numbers' },
          { ...timer, totalSeconds: -5 },
          { ...timer, endsAt: 'soon' },
          { ...timer, label: 42 },
        ],
      }),
    );
    expect(loadCookSession('r1', NOW)).toEqual({ doneStepIds: ['s1'], timers: [timer] });
  });

  it('never throws when storage does', () => {
    vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => {
      throw new DOMException('blocked', 'SecurityError');
    });
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new DOMException('full', 'QuotaExceededError');
    });
    vi.spyOn(Storage.prototype, 'removeItem').mockImplementation(() => {
      throw new DOMException('blocked', 'SecurityError');
    });
    vi.spyOn(Storage.prototype, 'key').mockImplementation(() => {
      throw new DOMException('blocked', 'SecurityError');
    });

    expect(loadCookSession('r1', NOW)).toBeNull();
    expect(() => saveCookSession('r1', { doneStepIds: ['s1'], timers: [] }, NOW)).not.toThrow();
    expect(() => clearCookSession('r1')).not.toThrow();
    expect(() => sweepStaleCookSessions(NOW)).not.toThrow();
  });
});
