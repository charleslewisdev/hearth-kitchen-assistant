import { useId, useMemo, useRef, useState, type KeyboardEvent } from 'react';
import { normalizeFoodName } from '@hearth/shared';
import { tagStyle } from '../lib/tags';
import styles from './TagInput.module.css';

/** One of the household's tags, as `tag.all` returns it. */
export interface KnownTag {
  name: string;
  normalizedName: string;
  color: string | null;
  uses: number;
}

/** How many existing tags the dropdown lists at once. */
const MAX_OPTIONS = 8;

type Option = { kind: 'existing'; tag: KnownTag } | { kind: 'create'; name: string };

/**
 * The tags on a recipe, as chips, with autocomplete from the household's own tags.
 *
 * Its job is to make "is this a tag I already have?" answer itself. A tag the household uses is
 * a solid chip in its colour; one that does not exist yet is a dashed chip marked "new", and the
 * dropdown says "Create" before it makes one. What is typed is matched the way the server folds
 * tag names (`normalizeFoodName`), so "chickens" picks the existing "Chicken" rather than making
 * a near-twin.
 *
 * Keyboard: type to filter; Up and Down move through the list; Enter takes the highlighted
 * option and a comma takes the text as typed; Backspace in an empty box removes the last chip;
 * Escape closes the list. Leaving the box keeps what was typed as a tag, so nothing typed is
 * lost on Save. Phone keyboards that report every key as "Unidentified" still work: a comma
 * that reaches `onChange` is split there.
 */
export function TagInput({
  id,
  label,
  value,
  onChange,
  known,
  flagged = false,
  describedBy,
}: {
  id: string;
  label: string;
  value: string[];
  onChange: (tags: string[]) => void;
  known: KnownTag[];
  flagged?: boolean;
  describedBy?: string;
}) {
  const [text, setText] = useState('');
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(0);
  const listId = useId();
  const inputRef = useRef<HTMLInputElement>(null);

  const byNorm = useMemo(() => new Map(known.map((t) => [t.normalizedName, t])), [known]);
  const chosen = useMemo(() => new Set(value.map((v) => normalizeFoodName(v))), [value]);

  const query = text.trim();
  const queryNorm = normalizeFoodName(query);
  const options: Option[] = useMemo(() => {
    if (query === '') return [];
    const needle = query.toLowerCase();
    const matches = known
      .filter((t) => !chosen.has(t.normalizedName))
      .filter((t) => t.name.toLowerCase().includes(needle) || t.normalizedName === queryNorm)
      .sort((a, b) => {
        // Exact, then prefix, then anywhere; most-used first within each.
        const rank = (t: KnownTag) =>
          t.normalizedName === queryNorm ? 0 : t.name.toLowerCase().startsWith(needle) ? 1 : 2;
        return rank(a) - rank(b) || b.uses - a.uses || a.name.localeCompare(b.name);
      })
      .slice(0, MAX_OPTIONS)
      .map((tag): Option => ({ kind: 'existing', tag }));
    const exists = byNorm.has(queryNorm) || chosen.has(queryNorm);
    return exists || queryNorm === '' ? matches : [...matches, { kind: 'create', name: query }];
  }, [query, queryNorm, known, byNorm, chosen]);

  /** Add a tag by name, as the household's own spelling when it already has it. */
  function add(name: string) {
    const trimmed = name.trim();
    const norm = normalizeFoodName(trimmed);
    if (norm === '' || chosen.has(norm)) {
      setText('');
      return;
    }
    onChange([...value, byNorm.get(norm)?.name ?? trimmed]);
    setText('');
    setActive(0);
  }

  function take(option: Option | undefined) {
    if (option === undefined) add(text);
    else add(option.kind === 'existing' ? option.tag.name : option.name);
  }

  function remove(index: number) {
    onChange(value.filter((_, i) => i !== index));
    inputRef.current?.focus();
  }

  function onKeyDown(e: KeyboardEvent<HTMLInputElement>) {
    if (e.key === 'ArrowDown' && options.length > 0) {
      e.preventDefault();
      setOpen(true);
      setActive((a) => (a + 1) % options.length);
    } else if (e.key === 'ArrowUp' && options.length > 0) {
      e.preventDefault();
      setActive((a) => (a - 1 + options.length) % options.length);
    } else if (e.key === 'Enter') {
      if (query === '') return;
      e.preventDefault();
      take(open ? options[active] : undefined);
    } else if (e.key === ',') {
      // A comma means "this, as typed": "weeknight," is weeknight, not the "Weeknight Dinner"
      // the list happens to highlight. An exact match (after folding) still reuses the tag.
      e.preventDefault();
      if (query !== '') add(text);
    } else if (e.key === 'Backspace' && text === '' && value.length > 0) {
      remove(value.length - 1);
    } else if (e.key === 'Escape') {
      setOpen(false);
    }
  }

  const showList = open && options.length > 0;
  const activeId = showList ? `${listId}-${active}` : undefined;

  return (
    <div className={styles.wrap}>
      <div
        className={flagged ? `${styles.box} ${styles.boxFlagged}` : styles.box}
        onClick={() => inputRef.current?.focus()}
      >
        <ul className={styles.chips} aria-label={`${label} on this recipe`}>
          {value.map((tag, index) => {
            const knownTag = byNorm.get(normalizeFoodName(tag));
            return (
              <li
                key={tag}
                className={knownTag ? styles.chip : `${styles.chip} ${styles.newChip}`}
                style={tagStyle(tag, knownTag?.color)}
              >
                {tag}
                {!knownTag && <span className={styles.newBadge}>new</span>}
                <button
                  type="button"
                  className={styles.remove}
                  onClick={(e) => {
                    e.stopPropagation();
                    remove(index);
                  }}
                  aria-label={`Remove tag ${tag}`}
                >
                  ×
                </button>
              </li>
            );
          })}
        </ul>
        <input
          ref={inputRef}
          id={id}
          className={styles.input}
          value={text}
          role="combobox"
          aria-expanded={showList}
          aria-controls={listId}
          aria-autocomplete="list"
          aria-activedescendant={activeId}
          aria-describedby={describedBy}
          autoComplete="off"
          placeholder={value.length === 0 ? 'Type to add a tag' : ''}
          onChange={(e) => {
            // A pasted "a, b, c" becomes three tags, leaving the last one being typed.
            const parts = e.target.value.split(',');
            if (parts.length > 1) {
              const next = [...value];
              const seen = new Set(next.map((v) => normalizeFoodName(v)));
              for (const part of parts.slice(0, -1)) {
                const norm = normalizeFoodName(part.trim());
                if (norm === '' || seen.has(norm)) continue;
                seen.add(norm);
                next.push(byNorm.get(norm)?.name ?? part.trim());
              }
              onChange(next);
              setText(parts[parts.length - 1]!.trimStart());
            } else {
              setText(e.target.value);
            }
            setOpen(true);
            setActive(0);
          }}
          onKeyDown={onKeyDown}
          onFocus={() => setOpen(true)}
          onBlur={() => {
            setOpen(false);
            if (query !== '') add(text);
          }}
        />
      </div>
      {showList && (
        <ul id={listId} className={styles.list} role="listbox" aria-label={`Matching ${label}`}>
          {options.map((option, index) => (
            <li
              key={option.kind === 'existing' ? option.tag.normalizedName : `create-${option.name}`}
              id={`${listId}-${index}`}
              role="option"
              aria-selected={index === active}
              className={
                index === active ? `${styles.option} ${styles.optionActive}` : styles.option
              }
              // mousedown, not click: a click would blur the box first, and the blur would keep
              // the half-typed text as a tag of its own.
              onMouseDown={(e) => {
                e.preventDefault();
                take(option);
              }}
            >
              {option.kind === 'existing' ? (
                <>
                  <span
                    className={styles.optionChip}
                    style={tagStyle(option.tag.name, option.tag.color)}
                  >
                    {option.tag.name}
                  </span>
                  <span className={styles.optionCount}>
                    {option.tag.uses} {option.tag.uses === 1 ? 'recipe' : 'recipes'}
                  </span>
                </>
              ) : (
                <span className={styles.create}>+ Create new tag “{option.name}”</span>
              )}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
