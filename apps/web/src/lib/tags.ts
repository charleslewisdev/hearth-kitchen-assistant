import { useMemo, type CSSProperties } from 'react';
import { trpc } from './trpc';
import { sortRecipeTypes, tagColor } from '@hearth/shared';

/** Inline style pointing a tag chip at its colour's tint and ink (`--tag-<name>-*`). */
export function tagStyle(name: string, chosen?: string | null): CSSProperties {
  const color = tagColor(name, chosen);
  return {
    ['--chip-bg' as string]: `var(--tag-${color}-bg)`,
    ['--chip-ink' as string]: `var(--tag-${color}-ink)`,
  };
}

/** The recipe types that are part of a meal rather than a meal: drawn in a second colour. */
const BUILDING_BLOCKS: ReadonlySet<string> = new Set(['side', 'drink', 'sauce', 'base']);

export function isBuildingBlock(type: string): boolean {
  return BUILDING_BLOCKS.has(type);
}

/** A recipe's types in list order, capitalised for display. */
export function typeLabels(types: readonly string[]): { type: string; label: string }[] {
  return sortRecipeTypes(types).map((type) => ({
    type,
    label: type[0]!.toUpperCase() + type.slice(1),
  }));
}

/**
 * The colour each tag was given on the Tags screen, by name, for drawing chips. A tag with no
 * choice (or before the list loads) gets its name-derived default from `tagStyle`.
 */
export function useTagColors(): (name: string) => string | null {
  const tags = trpc.tag.all.useQuery(undefined, { staleTime: 60_000 });
  return useMemo(() => {
    const byName = new Map<string, string | null>();
    for (const t of tags.data ?? []) byName.set(t.name.toLowerCase(), t.color);
    return (name: string) => byName.get(name.toLowerCase()) ?? null;
  }, [tags.data]);
}

/** Suggestions not already on the recipe, compared regardless of case. */
export function notYetTagged(suggestions: readonly string[], tags: readonly string[]): string[] {
  const have = new Set(tags.map((t) => t.toLowerCase()));
  return suggestions.filter((s) => !have.has(s.toLowerCase()));
}
