import type { CookTimer } from './TimerTray';

/**
 * Cook mode's progress, kept on THIS device so a reload, an evicted tab or a trip back to the
 * recipe does not cancel a timer while something is in the oven.
 *
 * `localStorage`, not the server: it is a per-device convenience (D26 keeps cooking progress
 * off the database), and a phone propped against a bowl is the device doing the cooking.
 * Storage can be blocked, full or absent, so every access is wrapped and a failure means cook
 * mode behaves as it did before this existed: it starts over.
 *
 * Timers are stored as absolute end times, which is what `CookTimer` already carries, so time
 * keeps passing while the page is gone and a restored timer shows what is really left.
 */
export const COOK_SESSION_PREFIX = 'hearth.cook.v1.';

/**
 * A session untouched for this long is a meal that was eaten, not one still being cooked.
 * "Untouched" is measured from the later of the last save and the last timer's end, so a
 * timer set to run longer than this is not thrown away while it is still going.
 */
export const STALE_SESSION_MS = 24 * 60 * 60 * 1000;

/** Caps on what is read back, since anything in storage can have been edited by hand. */
const MAX_STEPS = 500;
const MAX_TIMERS = 50;
const MAX_LABEL = 500;

export interface CookSessionState {
  doneStepIds: string[];
  timers: CookTimer[];
}

interface StoredSession extends CookSessionState {
  savedAt: number;
}

function keyFor(recipeId: string): string {
  return `${COOK_SESSION_PREFIX}${recipeId}`;
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}

function parseTimer(value: unknown): CookTimer | null {
  if (typeof value !== 'object' || value === null) return null;
  const { id, label, totalSeconds, endsAt } = value as Record<string, unknown>;
  if (typeof id !== 'string' || typeof label !== 'string' || label.length > MAX_LABEL) return null;
  if (!isFiniteNumber(totalSeconds) || totalSeconds <= 0) return null;
  if (!isFiniteNumber(endsAt)) return null;
  return { id, label, totalSeconds, endsAt };
}

/** The stored shape, or null when it is not one. Malformed items inside are dropped. */
function parse(raw: string): StoredSession | null {
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    return null;
  }
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return null;
  const { savedAt, doneStepIds, timers } = value as Record<string, unknown>;
  if (!isFiniteNumber(savedAt) || !Array.isArray(doneStepIds) || !Array.isArray(timers)) {
    return null;
  }
  return {
    savedAt,
    doneStepIds: doneStepIds
      .slice(0, MAX_STEPS)
      .filter((id): id is string => typeof id === 'string'),
    timers: timers
      .slice(0, MAX_TIMERS)
      .map(parseTimer)
      .filter((timer): timer is CookTimer => timer !== null),
  };
}

function isStale(session: StoredSession, now: number): boolean {
  const lastActivity = Math.max(session.savedAt, ...session.timers.map((timer) => timer.endsAt));
  return now - lastActivity > STALE_SESSION_MS;
}

function remove(key: string): void {
  try {
    localStorage.removeItem(key);
  } catch {
    // Blocked storage: there is nothing stored to remove either.
  }
}

/** What cook mode last saved for this recipe, or null for a fresh start. */
export function loadCookSession(recipeId: string, now: number): CookSessionState | null {
  const key = keyFor(recipeId);
  let raw: string | null;
  try {
    raw = localStorage.getItem(key);
  } catch {
    return null;
  }
  if (raw === null) return null;
  const session = parse(raw);
  if (session === null || isStale(session, now)) {
    remove(key);
    return null;
  }
  return { doneStepIds: session.doneStepIds, timers: session.timers };
}

export function saveCookSession(recipeId: string, state: CookSessionState, now: number): void {
  const stored: StoredSession = { savedAt: now, ...state };
  try {
    localStorage.setItem(keyFor(recipeId), JSON.stringify(stored));
  } catch {
    // Full or blocked. Cook mode keeps working; it just will not survive a reload.
  }
}

export function clearCookSession(recipeId: string): void {
  remove(keyFor(recipeId));
}

/** Remove every cook session that is stale or unreadable, so abandoned ones do not pile up. */
export function sweepStaleCookSessions(now: number): void {
  const doomed: string[] = [];
  try {
    for (let index = 0; index < localStorage.length; index += 1) {
      const key = localStorage.key(index);
      if (key === null || !key.startsWith(COOK_SESSION_PREFIX)) continue;
      const raw = localStorage.getItem(key);
      const session = raw === null ? null : parse(raw);
      if (session === null || isStale(session, now)) doomed.push(key);
    }
  } catch {
    return;
  }
  // Removed after the walk, because removing during it shifts the indexes being walked.
  doomed.forEach(remove);
}
