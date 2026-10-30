import { useMemo, useState, type FormEvent } from 'react';
import { DEPARTMENTS, normalizeFoodName } from '@hearth/shared';
import { FOOD_NAME_TAKEN_MESSAGE } from '@hearth/server/src/messages';
import { trpc } from '../lib/trpc';
import styles from './Foods.module.css';
import { useDocumentTitle } from '../lib/useDocumentTitle';

// One food as `food.all` returns it (repo/foods.ts `FoodRow`).
type Food = {
  id: string;
  name: string;
  normalizedName: string;
  department: string | null;
  uses: number;
};

/** The select's value for "no department", which the list shows as Other. */
const OTHER = '';

/**
 * Tidy what the parser made (D48): one name per food, and a department for each, because the
 * shopping list adds up and groups by food. Reached from More.
 */
export function Foods() {
  useDocumentTitle('Foods');
  const utils = trpc.useUtils();
  const foods = trpc.food.all.useQuery();
  const [filter, setFilter] = useState('');
  const [editing, setEditing] = useState<string | null>(null);

  const refresh = () => {
    void utils.food.all.invalidate();
    void utils.shoppingList.get.invalidate();
  };
  const setDepartment = trpc.food.setDepartment.useMutation({ onSuccess: refresh });
  const removeUnused = trpc.food.removeUnused.useMutation({ onSuccess: refresh });

  const shown = useMemo(() => {
    const needle = filter.trim().toLowerCase();
    const all: Food[] = foods.data ?? [];
    return needle ? all.filter((f) => f.name.toLowerCase().includes(needle)) : all;
  }, [foods.data, filter]);

  if (foods.isLoading) {
    return (
      <section className={styles.screen}>
        <h1 className={styles.title}>Foods</h1>
        <p className={styles.status}>Loading…</p>
      </section>
    );
  }
  if (foods.isError) {
    return (
      <section className={styles.screen}>
        <h1 className={styles.title}>Foods</h1>
        <p className={styles.error} role="alert">
          Couldn’t load your foods. Please try again.
        </p>
      </section>
    );
  }

  const all: Food[] = foods.data ?? [];
  const unfiled = all.filter((f) => f.department === null).length;
  const unused = all.filter((f) => f.uses === 0).length;

  return (
    <section className={styles.screen}>
      <h1 className={styles.title}>Foods</h1>
      <p className={styles.lead}>
        The shopping list adds amounts up by food and groups them by department. Merge two names for
        the same thing, and file anything under Other where you shop for it.
        {unfiled > 0 && ` ${unfiled} ${unfiled === 1 ? 'food has' : 'foods have'} no department.`}
      </p>
      {unused > 0 && (
        <button
          type="button"
          className={styles.textButton}
          disabled={removeUnused.isPending}
          onClick={() => removeUnused.mutate()}
        >
          Remove {unused} unused {unused === 1 ? 'food' : 'foods'}
        </button>
      )}
      <input
        className={styles.search}
        type="search"
        value={filter}
        onChange={(e) => setFilter(e.target.value)}
        placeholder="Find a food"
        aria-label="Find a food"
      />
      <ul className={styles.list}>
        {shown.map((f) => (
          <li key={f.id} className={styles.row}>
            <div className={styles.rowMain}>
              <span className={styles.name}>{f.name}</span>
              <span className={styles.uses}>
                {f.uses === 0
                  ? 'unused'
                  : `${f.uses} ${f.uses === 1 ? 'recipe line' : 'recipe lines'}`}
              </span>
            </div>
            <div className={styles.rowControls}>
              <select
                aria-label={`Department for ${f.name}`}
                value={f.department ?? OTHER}
                onChange={(e) =>
                  setDepartment.mutate({ id: f.id, department: e.target.value || null })
                }
              >
                <option value={OTHER}>Other</option>
                {DEPARTMENTS.map((d) => (
                  <option key={d} value={d}>
                    {d}
                  </option>
                ))}
              </select>
              <button
                type="button"
                className={styles.textButton}
                onClick={() => setEditing(editing === f.id ? null : f.id)}
                aria-expanded={editing === f.id}
              >
                Edit
              </button>
            </div>
            {editing === f.id && (
              <FoodEditor
                food={f}
                others={all}
                onDone={() => setEditing(null)}
                onChange={refresh}
              />
            )}
          </li>
        ))}
      </ul>
      {shown.length === 0 && <p className={styles.status}>No foods match.</p>}
    </section>
  );
}

function FoodEditor({
  food,
  others,
  onDone,
  onChange,
}: {
  food: Food;
  others: Food[];
  onDone: () => void;
  onChange: () => void;
}) {
  const [name, setName] = useState(food.name);
  const [into, setInto] = useState('');
  const [nameTaken, setNameTaken] = useState(false);
  const rename = trpc.food.rename.useMutation();
  const merge = trpc.food.merge.useMutation();
  const remove = trpc.food.remove.useMutation();
  const [error, setError] = useState<string | null>(null);

  const targets = others.filter((o) => o.id !== food.id);
  // A rename that clashed names the food to merge into, which is almost always what was meant.
  const clash = targets.find((o) => o.normalizedName === normalizeFoodName(name));

  async function saveName(e: FormEvent) {
    e.preventDefault();
    setError(null);
    setNameTaken(false);
    try {
      await rename.mutateAsync({ id: food.id, name: name.trim() });
      onChange();
      onDone();
    } catch (err) {
      if ((err as { message?: string }).message === FOOD_NAME_TAKEN_MESSAGE) {
        setNameTaken(true);
        if (clash) setInto(clash.id);
      } else setError('Couldn’t rename it. Please try again.');
    }
  }

  async function doMerge() {
    if (!into) return;
    setError(null);
    try {
      await merge.mutateAsync({ fromId: food.id, intoId: into });
      onChange();
      onDone();
    } catch {
      setError('Couldn’t merge them. Please try again.');
    }
  }

  async function doRemove() {
    setError(null);
    try {
      await remove.mutateAsync({ id: food.id });
      onChange();
      onDone();
    } catch {
      setError('Recipes still use this food, so it can’t be deleted. Merge it instead.');
    }
  }

  return (
    <div className={styles.editor}>
      <form className={styles.editRow} onSubmit={(e) => void saveName(e)}>
        <label className={styles.editLabel}>
          Name
          <input value={name} maxLength={100} onChange={(e) => setName(e.target.value)} />
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
          {FOOD_NAME_TAKEN_MESSAGE}
        </p>
      )}
      <div className={styles.editRow}>
        <label className={styles.editLabel}>
          Merge into
          <select value={into} onChange={(e) => setInto(e.target.value)}>
            <option value="">Choose a food…</option>
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
      {food.uses === 0 && (
        <button type="button" className={styles.textButton} onClick={() => void doRemove()}>
          Delete this unused food
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
