import { tagStyle } from '../lib/tags';
import styles from './TagSuggestionChips.module.css';

/**
 * Tags worth one tap: the household's own tags this recipe mentions, and an import's keywords
 * that passed the filter (`suggestTags` in @hearth/shared). Nothing is added until tapped.
 */
export function TagSuggestionChips({
  names,
  colorOf,
  onAdd,
}: {
  names: string[];
  colorOf: (name: string) => string | null;
  onAdd: (name: string) => void;
}) {
  if (names.length === 0) return null;
  return (
    <div className={styles.row} role="group" aria-label="Suggested tags">
      <span className={styles.label}>Suggested</span>
      {names.map((name) => (
        <button
          key={name}
          type="button"
          className={styles.chip}
          style={tagStyle(name, colorOf(name))}
          onClick={() => onAdd(name)}
          aria-label={`Add tag ${name}`}
        >
          + {name}
        </button>
      ))}
    </div>
  );
}
