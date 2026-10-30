/**
 * Minutes out of a schema.org duration, which is ISO 8601: `PT20M`, `PT1H30M`, `P0DT0H45M`,
 * `PT90M`, `PT1H`. Recipe pages state `prepTime`, `cookTime` and `totalTime` this way.
 *
 * Anchored at both ends with every run bounded, so a hostile page cannot make it backtrack.
 * Seconds are rounded into minutes; a duration of a day or more is not a recipe time and reads
 * as unknown, as does anything that is not a duration at all.
 */
const ISO_DURATION =
  /^P(?:(\d{1,3})D)?(?:T(?:(\d{1,4})H)?(?:(\d{1,5})M)?(?:(\d{1,6}(?:\.\d{1,3})?)S)?)?$/i;

/** The longest time a recipe step plausibly states, in minutes: two days of brining. */
const MAX_MINUTES = 48 * 60;

export function durationMinutes(value: unknown): number | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  if (trimmed.length > 40) return null;
  const match = ISO_DURATION.exec(trimmed);
  if (!match || trimmed === 'P' || trimmed.toUpperCase() === 'PT') return null;
  const [, days, hours, minutes, seconds] = match;
  const total =
    Number(days ?? 0) * 1440 +
    Number(hours ?? 0) * 60 +
    Number(minutes ?? 0) +
    Math.round(Number(seconds ?? 0) / 60);
  if (!Number.isFinite(total) || total <= 0 || total > MAX_MINUTES) return null;
  return total;
}
