/**
 * The token suffix a store department is coloured with (`--dept-<key>-bg`, `--dept-<key>-ink` in
 * tokens.css, D49). Anything unknown, including no department, is "other".
 */
const KEYS: Record<string, string> = {
  Produce: 'produce',
  Bakery: 'bakery',
  'Meat & Seafood': 'meat',
  Dairy: 'dairy',
  Frozen: 'frozen',
  Pantry: 'pantry',
  Baking: 'baking',
  Beverages: 'beverages',
};

export function departmentKey(department: string | null | undefined): string {
  return (department && KEYS[department]) || 'other';
}

/** Inline style that points a dot or header at its department's colours. */
export function departmentStyle(department: string | null | undefined): React.CSSProperties {
  const key = departmentKey(department);
  return {
    ['--dept-bg' as string]: `var(--dept-${key}-bg)`,
    ['--dept-ink' as string]: `var(--dept-${key}-ink)`,
  };
}
