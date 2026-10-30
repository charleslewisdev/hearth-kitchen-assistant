/**
 * Calendar arithmetic for the meal planner, over `YYYY-MM-DD` strings.
 *
 * A planned day is the household's local calendar day, with no time and no zone, so every date
 * here is a plain string and the arithmetic runs in UTC, where a day is always 24 hours long.
 * Nothing converts to local time: the client says what "today" is, and these functions only count
 * days from there.
 */

const ISO_DATE = /^(\d{4})-(\d{2})-(\d{2})$/;
const DAY_MS = 86_400_000;

/** Days a week has, and so how many a plan week shows. */
export const DAYS_PER_WEEK = 7;

/** The meal rows the planner shows (D27's defaults). The enum also has snack and dessert. */
export const PLAN_MEALS = ['breakfast', 'lunch', 'dinner'] as const;
export type PlanMeal = (typeof PLAN_MEALS)[number];

function toUtcMs(date: string): number {
  const m = ISO_DATE.exec(date);
  if (!m) throw new RangeError('not a YYYY-MM-DD date');
  return Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
}

function fromUtcMs(ms: number): string {
  return new Date(ms).toISOString().slice(0, 10);
}

/** True for a `YYYY-MM-DD` string naming a day that exists (so not 2026-02-29). */
export function isIsoDate(value: string): boolean {
  if (!ISO_DATE.test(value)) return false;
  return fromUtcMs(toUtcMs(value)) === value;
}

/** The date `days` days after `date` (before it, when negative). */
export function addDays(date: string, days: number): string {
  return fromUtcMs(toUtcMs(date) + days * DAY_MS);
}

/** 0 for Sunday through 6 for Saturday, as `Date.getUTCDay()` numbers them. */
export function dayOfWeek(date: string): number {
  return new Date(toUtcMs(date)).getUTCDay();
}

/** The first day of the week containing `date`, for weeks that begin on `weekStart` (0-6). */
export function weekStartFor(date: string, weekStart: number): string {
  const back = (dayOfWeek(date) - weekStart + DAYS_PER_WEEK) % DAYS_PER_WEEK;
  return addDays(date, -back);
}

/** The seven dates of the week beginning on `start`. */
export function weekDates(start: string): string[] {
  return Array.from({ length: DAYS_PER_WEEK }, (_, i) => addDays(start, i));
}
