import { useId, useMemo } from 'react';
import { sourceBook, sourceSuggestions } from '@hearth/shared';
import { trpc } from '../lib/trpc';
import styles from './SourceField.module.css';

/** Case, a leading "The", and punctuation don't make a different book. */
function bookKey(book: string): string {
  return book
    .toLowerCase()
    .replace(/^the\s+/, '')
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim();
}

/**
 * The existing book this looks like a different spelling of, or null. "Newlywed Cookbook" and
 * "the newlywed cookbook" both mean "The Newlywed Cookbook"; so does a shortened "Newlywed",
 * once it is long enough not to match everything.
 */
export function similarSource(typed: string, known: readonly string[]): string | null {
  const book = sourceBook(typed);
  if (book.length < 4 || known.includes(book)) return null;
  const key = bookKey(book);
  if (key.length < 4) return null;
  return (
    known.find((k) => bookKey(k) === key) ?? known.find((k) => bookKey(k).includes(key)) ?? null
  );
}

/**
 * The Source box, with the household's own sources offered as you type (a native datalist, so
 * the phone's keyboard shows them), and a one-tap fix when what is typed looks like a source
 * already in use under another spelling. The page part (", p. 54") is kept when fixing.
 */
export function SourceField({
  value,
  onChange,
  inputClassName,
  labelClassName,
  fieldClassName,
}: {
  value: string;
  onChange: (value: string) => void;
  inputClassName: string | undefined;
  labelClassName: string | undefined;
  fieldClassName: string | undefined;
}) {
  const listId = useId();
  const sources = trpc.recipe.sourceNames.useQuery(undefined, { staleTime: 60_000 });
  const known = useMemo(() => sourceSuggestions(sources.data ?? []), [sources.data]);
  const similar = similarSource(value, known);
  const book = sourceBook(value);

  return (
    <label className={fieldClassName}>
      <span className={labelClassName}>Source</span>
      <input
        type="text"
        className={inputClassName}
        value={value}
        maxLength={200}
        list={listId}
        autoComplete="off"
        onChange={(e) => onChange(e.target.value)}
        placeholder="e.g. Joy of Cooking, p. 212"
      />
      <datalist id={listId}>
        {known.map((name) => (
          <option key={name} value={name} />
        ))}
      </datalist>
      {similar && (
        <button
          type="button"
          className={styles.similar}
          onClick={() => onChange(similar + value.trim().slice(book.length))}
        >
          Use “{similar}”, which you’ve used before
        </button>
      )}
    </label>
  );
}
