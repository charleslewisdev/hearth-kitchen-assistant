import { useMemo, useState, type FormEvent } from 'react';
import { Link } from 'react-router-dom';
import { normalizeFoodName, TAG_COLORS, tagColor, type TagColor } from '@hearth/shared';
import { TAG_NAME_TAKEN_MESSAGE } from '@hearth/server/src/messages';
import { trpc } from '../lib/trpc';
import { tagStyle } from '../lib/tags';
import { RecipesSubnav } from '../app/RecipesSubnav';
import styles from './Tags.module.css';
import { useDocumentTitle } from '../lib/useDocumentTitle';

// One tag as `tag.all` returns it (repo/tags.ts `TagRow`).
type Tag = {
  id: string;
  name: string;
  normalizedName: string;
  color: TagColor | null;
  uses: number;
};

/**
 * Recipes → Tags: every tag in the household with how many recipes carry it, and the ways to
 * tidy them. Imports bring in a site's own keywords ("baked pork tenderloin recipe"), so the
 * common jobs are merging those into the tag that was meant and deleting the rest.
 */
export function Tags() {
  useDocumentTitle('Tags');
  const utils = trpc.useUtils();
  const tags = trpc.tag.all.useQuery();
  const [filter, setFilter] = useState('');
  const [editing, setEditing] = useState<string | null>(null);

  // A tag change shows on every card and recipe, so those caches go too.
  const refresh = () => {
    void utils.tag.all.invalidate();
    void utils.recipe.invalidate();
  };
  const removeUnused = trpc.tag.removeUnused.useMutation({ onSuccess: refresh });

  const shown = useMemo(() => {
    const needle = filter.trim().toLowerCase();
    const all: Tag[] = tags.data ?? [];
    return needle ? all.filter((t) => t.name.toLowerCase().includes(needle)) : all;
  }, [tags.data, filter]);

  const header = (
    <>
      <RecipesSubnav />
      <h1 className={styles.title}>Tags</h1>
    </>
  );

  if (tags.isLoading) {
    return (
      <section className={styles.screen}>
        {header}
        <p className={styles.status}>Loading…</p>
      </section>
    );
  }
  if (tags.isError) {
    return (
      <section className={styles.screen}>
        {header}
        <p className={styles.error} role="alert">
          Couldn’t load your tags. Please try again.
        </p>
      </section>
    );
  }

  const all: Tag[] = tags.data ?? [];
  const unused = all.filter((t) => t.uses === 0).length;

  return (
    <section className={styles.screen}>
      {header}
      {all.length === 0 ? (
        <p className={styles.status}>
          No tags yet. Add some on a recipe’s edit screen, and they’ll show up here.
        </p>
      ) : (
        <>
          <p className={styles.lead}>
            Merge two names for the same idea, give a tag its own colour, and delete the ones an
            import brought in that you don’t use.
          </p>
          {unused > 0 && (
            <button
              type="button"
              className={styles.textButton}
              disabled={removeUnused.isPending}
              onClick={() => removeUnused.mutate()}
            >
              Remove {unused} unused {unused === 1 ? 'tag' : 'tags'}
            </button>
          )}
          <input
            className={styles.search}
            type="search"
            value={filter}
            onChange={(e) => setFilter(e.target.value)}
            placeholder="Find a tag"
            aria-label="Find a tag"
          />
          <ul className={styles.list}>
            {shown.map((t) => (
              <li key={t.id} className={styles.row}>
                <div className={styles.rowMain}>
                  <span className={styles.chip} style={tagStyle(t.name, t.color)}>
                    {t.name}
                  </span>
                  {t.uses === 0 ? (
                    <span className={styles.uses}>unused</span>
                  ) : (
                    <Link to={`/recipes?tag=${encodeURIComponent(t.name)}`} className={styles.uses}>
                      {t.uses} {t.uses === 1 ? 'recipe' : 'recipes'}
                    </Link>
                  )}
                </div>
                <div className={styles.rowControls}>
                  <button
                    type="button"
                    className={styles.textButton}
                    onClick={() => setEditing(editing === t.id ? null : t.id)}
                    aria-expanded={editing === t.id}
                    aria-label={`Edit ${t.name}`}
                  >
                    Edit
                  </button>
                </div>
                {editing === t.id && (
                  <TagEditor
                    tag={t}
                    others={all}
                    onDone={() => setEditing(null)}
                    onChange={refresh}
                  />
                )}
              </li>
            ))}
          </ul>
          {shown.length === 0 && <p className={styles.status}>No tags match.</p>}
        </>
      )}
    </section>
  );
}

function TagEditor({
  tag,
  others,
  onDone,
  onChange,
}: {
  tag: Tag;
  others: Tag[];
  onDone: () => void;
  onChange: () => void;
}) {
  const [name, setName] = useState(tag.name);
  const [into, setInto] = useState('');
  const [nameTaken, setNameTaken] = useState(false);
  const [confirmingDelete, setConfirmingDelete] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const rename = trpc.tag.rename.useMutation();
  const setColor = trpc.tag.setColor.useMutation({ onSuccess: onChange });
  const merge = trpc.tag.merge.useMutation();
  const remove = trpc.tag.remove.useMutation();

  const targets = others.filter((o) => o.id !== tag.id);
  // A rename that clashed names the tag to merge into, which is almost always what was meant.
  const clash = targets.find((o) => o.normalizedName === normalizeFoodName(name));
  const current = tagColor(tag.name, tag.color);

  async function saveName(e: FormEvent) {
    e.preventDefault();
    setError(null);
    setNameTaken(false);
    try {
      await rename.mutateAsync({ id: tag.id, name: name.trim() });
      onChange();
      onDone();
    } catch (err) {
      if ((err as { message?: string }).message === TAG_NAME_TAKEN_MESSAGE) {
        setNameTaken(true);
        if (clash) setInto(clash.id);
      } else setError('Couldn’t rename it. Please try again.');
    }
  }

  async function doMerge() {
    if (!into) return;
    setError(null);
    try {
      await merge.mutateAsync({ fromId: tag.id, intoId: into });
      onChange();
      onDone();
    } catch {
      setError('Couldn’t merge them. Please try again.');
    }
  }

  async function doRemove() {
    setError(null);
    try {
      await remove.mutateAsync({ id: tag.id });
      onChange();
      onDone();
    } catch {
      setError('Couldn’t delete it. Please try again.');
    }
  }

  return (
    <div className={styles.editor}>
      <form className={styles.editRow} onSubmit={(e) => void saveName(e)}>
        <label className={styles.editLabel}>
          Name
          <input value={name} maxLength={60} onChange={(e) => setName(e.target.value)} />
        </label>
        <button
          type="submit"
          className={styles.button}
          disabled={rename.isPending || name.trim() === ''}
        >
          Rename
        </button>
      </form>
      {nameTaken && (
        <p className={styles.notice} role="status">
          {TAG_NAME_TAKEN_MESSAGE}
        </p>
      )}

      <fieldset className={styles.swatches}>
        <legend>Colour</legend>
        <button
          type="button"
          className={`${styles.swatch} ${styles.autoSwatch}`}
          style={tagStyle(tag.name)}
          aria-pressed={tag.color === null}
          onClick={() => setColor.mutate({ id: tag.id, color: null })}
        >
          Auto
        </button>
        {TAG_COLORS.map((color) => (
          <button
            key={color}
            type="button"
            className={styles.swatch}
            style={tagStyle(tag.name, color)}
            aria-pressed={tag.color !== null && current === color}
            aria-label={color}
            onClick={() => setColor.mutate({ id: tag.id, color })}
          >
            <span aria-hidden="true">Aa</span>
          </button>
        ))}
      </fieldset>

      <div className={styles.editRow}>
        <label className={styles.editLabel}>
          Merge into
          <select value={into} onChange={(e) => setInto(e.target.value)}>
            <option value="">Choose a tag…</option>
            {targets.map((t) => (
              <option key={t.id} value={t.id}>
                {t.name}
              </option>
            ))}
          </select>
        </label>
        <button
          type="button"
          className={styles.button}
          disabled={!into || merge.isPending}
          onClick={() => void doMerge()}
        >
          Merge
        </button>
      </div>

      {confirmingDelete ? (
        <div className={styles.confirm} role="group" aria-label="Confirm delete">
          <span>
            {tag.uses === 0
              ? `Delete “${tag.name}”?`
              : `Delete “${tag.name}”? It comes off ${tag.uses} ${
                  tag.uses === 1 ? 'recipe' : 'recipes'
                }; the recipes stay.`}
          </span>
          <button
            type="button"
            className={styles.textButton}
            onClick={() => setConfirmingDelete(false)}
          >
            Cancel
          </button>
          <button
            type="button"
            className={styles.danger}
            disabled={remove.isPending}
            onClick={() => void doRemove()}
          >
            Yes, delete
          </button>
        </div>
      ) : (
        <button
          type="button"
          className={styles.textButton}
          onClick={() => setConfirmingDelete(true)}
        >
          Delete tag
        </button>
      )}
      {error && (
        <p className={styles.error} role="alert">
          {error}
        </p>
      )}
    </div>
  );
}
