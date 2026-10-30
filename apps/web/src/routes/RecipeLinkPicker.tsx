import { useEffect, useId, useRef, useState } from 'react';
import { matchRecipes, type RecipeOption } from '../lib/ingredient-links';
import styles from './RecipeLinkPicker.module.css';

/**
 * Search the household's recipes and pick one for an ingredient line to link to.
 *
 * Opened from the editor's "Link a recipe" button or by typing `[[` in the ingredients box.
 * The search box is a combobox: arrow keys move through the matches, Enter picks, Escape closes
 * and hands focus back to the ingredients box.
 */
export function RecipeLinkPicker({
  recipes,
  excludeId,
  lineLabel,
  linkedTitle,
  onPick,
  onRemove,
  onClose,
}: {
  recipes: readonly RecipeOption[];
  /** The recipe being edited, which cannot link to itself. */
  excludeId: string | null;
  /** The line being linked, as the cook typed it, so they can see which one this is. */
  lineLabel: string;
  /** The title the line already links to, which offers "Remove link". */
  linkedTitle: string | null;
  onPick: (recipe: RecipeOption) => void;
  onRemove: () => void;
  onClose: () => void;
}) {
  const [query, setQuery] = useState('');
  const [active, setActive] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);
  const listId = useId();
  const matches = matchRecipes(recipes, query, excludeId);

  useEffect(() => {
    inputRef.current?.focus();
  }, []);

  function handleKeyDown(event: React.KeyboardEvent<HTMLInputElement>) {
    if (event.key === 'ArrowDown') {
      event.preventDefault();
      setActive((i) => Math.min(i + 1, matches.length - 1));
    } else if (event.key === 'ArrowUp') {
      event.preventDefault();
      setActive((i) => Math.max(i - 1, 0));
    } else if (event.key === 'Enter') {
      event.preventDefault();
      const pick = matches[active];
      if (pick) onPick(pick);
    } else if (event.key === 'Escape') {
      event.preventDefault();
      onClose();
    }
  }

  return (
    <div className={styles.picker} role="group" aria-label="Link a recipe">
      <div className={styles.head}>
        <span className={styles.heading}>
          Link <span className={styles.line}>{lineLabel || 'this line'}</span> to a recipe
        </span>
        <button type="button" className={styles.close} onClick={onClose}>
          Cancel
        </button>
      </div>
      <input
        ref={inputRef}
        type="search"
        className={styles.search}
        value={query}
        onChange={(e) => {
          setQuery(e.target.value);
          setActive(0);
        }}
        onKeyDown={handleKeyDown}
        placeholder="Search your recipes"
        role="combobox"
        aria-expanded="true"
        aria-controls={listId}
        aria-activedescendant={matches[active] ? `${listId}-${matches[active].id}` : undefined}
        aria-label="Search your recipes"
      />
      {matches.length === 0 ? (
        <p className={styles.empty}>
          {recipes.length === 0 ? 'No other recipes yet.' : 'No recipe matches that.'}
        </p>
      ) : (
        <ul id={listId} role="listbox" className={styles.list} aria-label="Recipes">
          {matches.map((recipe, i) => (
            <li
              key={recipe.id}
              id={`${listId}-${recipe.id}`}
              role="option"
              aria-selected={i === active}
              className={i === active ? styles.optionActive : styles.option}
              // mousedown, not click: picking must not blur the search box first.
              onMouseDown={(e) => {
                e.preventDefault();
                onPick(recipe);
              }}
              onMouseEnter={() => setActive(i)}
            >
              {recipe.title}
            </li>
          ))}
        </ul>
      )}
      {linkedTitle !== null && (
        <button type="button" className={styles.remove} onClick={onRemove}>
          Remove link to {linkedTitle}
        </button>
      )}
    </div>
  );
}
