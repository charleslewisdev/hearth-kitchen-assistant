/**
 * A source's book, without the page: "The Newlywed Cookbook, p. 54" is "The Newlywed Cookbook".
 *
 * The Source box holds whatever the cook typed, and a page number makes every entry from one
 * book different; suggestions are about the book. A trailing page reference is recognised as
 * ", p. 54", "p54", "pp. 12-13", "page 7" or "pg 7", after a comma, a dash or a space.
 *
 * Linear: the input is capped, and the pattern is anchored at the end with bounded repeats, so
 * a long run of spaces or digits cannot make it backtrack.
 */
const PAGE =
  /[\s,;:–-]{1,5}(?:pp?\.?|pages?|pg\.?)\s{0,3}\d{1,5}(?:\s{0,3}[–-]\s{0,3}\d{1,5})?\.?$/i;

export function sourceBook(name: string): string {
  const trimmed = name.slice(0, 300).trim();
  const book = trimmed.replace(PAGE, '').trim();
  return book === '' ? trimmed : book;
}

/**
 * The household's sources as suggestions: one per book, most used first, then by name. Books
 * that differ only in case are one suggestion, spelled the way they were used most.
 */
export function sourceSuggestions(sources: readonly { name: string; count: number }[]): string[] {
  const byKey = new Map<string, { spellings: Map<string, number>; total: number }>();
  for (const { name, count } of sources) {
    const book = sourceBook(name);
    if (book === '') continue;
    const key = book.toLowerCase();
    const entry = byKey.get(key) ?? { spellings: new Map<string, number>(), total: 0 };
    entry.spellings.set(book, (entry.spellings.get(book) ?? 0) + count);
    entry.total += count;
    byKey.set(key, entry);
  }
  return [...byKey.values()]
    .map((e) => ({
      name: [...e.spellings.entries()].sort(
        (a, b) => b[1] - a[1] || a[0].localeCompare(b[0]),
      )[0]![0],
      total: e.total,
    }))
    .sort((a, b) => b.total - a.total || a.name.localeCompare(b.name))
    .map((e) => e.name);
}
