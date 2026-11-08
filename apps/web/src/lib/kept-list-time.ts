/**
 * When the list on screen was last fetched, as the offline notice says it: "2:41 PM" today,
 * "yesterday, 6:05 PM", or "Mon, Nov 3, 9:12 AM" before that. Locale-formatted, in device time, with no break inside the time.
 */
export function keptListTime(fetchedAt: number, now: Date = new Date()): string {
  const at = new Date(fetchedAt);
  // Kept on one line: "8:51" at the end of one line and "AM" at the start of the next reads badly.
  const time = at
    .toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' })
    .replaceAll(' ', '\u00a0');
  const dayOf = (d: Date) => new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
  const days = Math.round((dayOf(now) - dayOf(at)) / 86_400_000);
  if (days <= 0) return time;
  if (days === 1) return `yesterday, ${time}`;
  const day = at.toLocaleDateString(undefined, {
    weekday: 'short',
    month: 'short',
    day: 'numeric',
  });
  return `${day}, ${time}`;
}
