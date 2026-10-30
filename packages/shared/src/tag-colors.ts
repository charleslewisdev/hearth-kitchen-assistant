import { normalizeFoodName } from './food-name';

/**
 * The colours a tag chip can wear. Names, not hex: the web app maps each to a tint and ink pair
 * per theme (`--tag-<name>-bg` / `-ink`), and the server stores only the name.
 */
export const TAG_COLORS = [
  'green',
  'wheat',
  'red',
  'blue',
  'teal',
  'amber',
  'plum',
  'violet',
] as const;

export type TagColor = (typeof TAG_COLORS)[number];

/**
 * The colour a tag wears when nobody picked one: derived from its name, so "Italian" is the same
 * colour on every card, on every device, and after a reload, without storing anything. Keyed on
 * the normalized name, so "Italian" and "italian" agree.
 *
 * FNV-1a over UTF-16 code units: tiny, stable across engines, and spreads short words well
 * enough across eight buckets.
 */
export function defaultTagColor(name: string): TagColor {
  const key = normalizeFoodName(name);
  let hash = 0x811c9dc5;
  for (let i = 0; i < key.length; i++) {
    hash ^= key.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return TAG_COLORS[hash % TAG_COLORS.length]!;
}

/** The colour to draw: the one chosen for the tag if there is one, else its default. */
export function tagColor(name: string, chosen?: string | null): TagColor {
  return chosen && (TAG_COLORS as readonly string[]).includes(chosen)
    ? (chosen as TagColor)
    : defaultTagColor(name);
}
