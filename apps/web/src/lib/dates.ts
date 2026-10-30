/** The device's own calendar day. The server never guesses it (see plan-week.ts). */
export function localToday(now = new Date()): string {
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
}

// Dates are zone-free strings, so format them as UTC midnight to keep the day from shifting.
export function formatDay(date: string, options: Intl.DateTimeFormatOptions): string {
  return new Date(`${date}T00:00:00Z`).toLocaleDateString(undefined, {
    ...options,
    timeZone: 'UTC',
  });
}

/**
 * How long ago a calendar day was, as a cook says it: "today", "yesterday", "5 days ago",
 * "3 weeks ago", "4 months ago", "2 years ago". Whole days between the two dates, no clock.
 */
export function daysAgo(date: string, today: string = localToday()): string {
  const days = Math.round(
    (Date.parse(`${today}T00:00:00Z`) - Date.parse(`${date}T00:00:00Z`)) / 86_400_000,
  );
  if (days <= 0) return 'today';
  if (days === 1) return 'yesterday';
  if (days < 14) return `${days} days ago`;
  if (days < 60) return `${Math.round(days / 7)} weeks ago`;
  if (days < 730) return `${Math.round(days / 30)} months ago`;
  return `${Math.round(days / 365)} years ago`;
}
