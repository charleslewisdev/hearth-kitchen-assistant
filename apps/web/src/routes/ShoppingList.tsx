import { useState, useSyncExternalStore, type FormEvent } from 'react';
import { Link } from 'react-router-dom';
import { formatQuantity, shoppingQuantity, unitLabel } from '@hearth/shared';
import { trpc } from '../lib/trpc';
import { departmentStyle } from '../lib/departments';
import styles from './ShoppingList.module.css';
import { useDocumentTitle } from '../lib/useDocumentTitle';

// One shopping-list item as returned by `shoppingList.get`.
type Item = {
  id: string;
  foodId: string | null;
  name: string;
  quantity: number | null;
  unit: string | null;
  note: string | null;
  department: string | null;
  checked: boolean;
  source: 'recipe' | 'manual';
  sourceRecipeId: string | null;
  position: number;
};

// Compose the "2 cups", "1 cup", "3" amount prefix. Empty when no quantity. A counted item
// reads as whole ones to buy ("17 cloves", not "16.17"); the stored quantity stays exact.
function amountLabel(stored: number | null, unit: string | null): string {
  const quantity = shoppingQuantity(stored, unit);
  if (quantity == null) return '';
  const amount = formatQuantity(quantity, unit);
  return unit ? `${amount} ${unitLabel(unit, quantity)}` : amount;
}

// Group unchecked items into department sections in the server's stable order,
// with the null-department ("Other") section always rendered LAST.
function groupByDepartment(items: Item[]): Array<{ department: string; items: Item[] }> {
  const sections: Array<{ department: string; items: Item[] }> = [];
  const byName = new Map<string, Item[]>();
  let other: Item[] | null = null;

  for (const item of items) {
    if (item.department == null) {
      if (!other) other = [];
      other.push(item);
      continue;
    }
    let bucket = byName.get(item.department);
    if (!bucket) {
      bucket = [];
      byName.set(item.department, bucket);
      sections.push({ department: item.department, items: bucket });
    }
    bucket.push(item);
  }

  if (other) sections.push({ department: 'Other', items: other });
  return sections;
}

/** How often an open list picks up another device's changes. */
export const LIST_REFRESH_MS = 5_000;

/** The id an added item wears until the server confirms it. */
const PENDING_PREFIX = 'pending-';

/** Whether the browser thinks it has a network, following it as it changes. */
function useOnline(): boolean {
  return useSyncExternalStore(
    (onChange) => {
      window.addEventListener('online', onChange);
      window.addEventListener('offline', onChange);
      return () => {
        window.removeEventListener('online', onChange);
        window.removeEventListener('offline', onChange);
      };
    },
    () => navigator.onLine,
    () => true,
  );
}

export function ShoppingList() {
  useDocumentTitle('Shopping list');
  const utils = trpc.useUtils();
  const invalidate = () => utils.shoppingList.get.invalidate();

  // Two people shopping together each check items off, so the list asks again every few seconds
  // while it is on screen. React Query stops polling in a background tab by default.
  const query = trpc.shoppingList.get.useQuery(undefined, {
    refetchInterval: LIST_REFRESH_MS,
  });

  /*
    Every change shows at once and is sent when it can be (optimistic). In a store with patchy
    signal a tap made offline is paused by React Query and sent when the phone reconnects; before
    this, the checkbox followed the server and a tap simply did nothing. A change the server then
    refuses rolls back, and every one ends with a refetch so the list converges on the truth.
  */
  type ListData = NonNullable<typeof query.data>;
  type ServerItem = ListData['items'][number];
  const optimistic = <T,>(
    apply: (items: ServerItem[], input: T, list: ListData['list']) => ServerItem[],
  ) => ({
    onMutate: async (input: T) => {
      await utils.shoppingList.get.cancel();
      const previous = utils.shoppingList.get.getData();
      utils.shoppingList.get.setData(undefined, (old: ListData | undefined) =>
        old ? { ...old, items: apply(old.items, input, old.list) } : old,
      );
      return { previous };
    },
    onError: (_err: unknown, _input: T, context?: { previous?: ListData }) => {
      if (context?.previous) utils.shoppingList.get.setData(undefined, context.previous);
    },
    onSettled: invalidate,
  });

  const addItem = trpc.shoppingList.addItem.useMutation(
    optimistic<{ text: string }>((items, { text }, list) => [
      ...items,
      {
        id: `${PENDING_PREFIX}${text}`,
        householdId: list.householdId,
        listId: list.id,
        foodId: null,
        name: text,
        quantity: null,
        unit: null,
        note: null,
        department: null,
        checked: false,
        source: 'manual',
        sourceRecipeId: null,
        position: Number.MAX_SAFE_INTEGER,
      },
    ]),
  );
  const toggleChecked = trpc.shoppingList.toggleChecked.useMutation(
    optimistic<{ itemId: string; checked: boolean }>((items, { itemId, checked }) =>
      items.map((i) => (i.id === itemId ? { ...i, checked } : i)),
    ),
  );
  const removeItem = trpc.shoppingList.removeItem.useMutation(
    optimistic<{ itemId: string }>((items, { itemId }) => items.filter((i) => i.id !== itemId)),
  );
  const clearChecked = trpc.shoppingList.clearChecked.useMutation(
    optimistic<void>((items) => items.filter((i) => !i.checked)),
  );
  const online = useOnline();

  const [text, setText] = useState('');

  function handleAdd(e: FormEvent) {
    e.preventDefault();
    const value = text.trim();
    if (!value) return;
    // Cleared straight away: the item is already on the list, offline or not.
    addItem.mutate({ text: value });
    setText('');
  }

  if (query.isLoading) {
    return (
      <section className={styles.screen}>
        <h1 className={styles.title}>Shopping list</h1>
        <p className={styles.status}>Loading your list…</p>
      </section>
    );
  }

  if (query.isError) {
    return (
      <section className={styles.screen}>
        <h1 className={styles.title}>Shopping list</h1>
        <p className={styles.error} role="alert">
          Couldn’t load your shopping list. Please try again.
        </p>
      </section>
    );
  }

  const items: Item[] = query.data?.items ?? [];
  const unchecked = items.filter((i) => !i.checked);
  const checked = items.filter((i) => i.checked);
  const sections = groupByDepartment(unchecked);

  return (
    <section className={styles.screen}>
      <h1 className={styles.title}>Shopping list</h1>

      {items.length > 0 && (
        <div className={styles.progress}>
          <div
            className={styles.progressTrack}
            role="progressbar"
            aria-label="Items in the basket"
            aria-valuemin={0}
            aria-valuemax={items.length}
            aria-valuenow={checked.length}
          >
            <div
              className={styles.progressFill}
              style={{ width: `${(checked.length / items.length) * 100}%` }}
            />
          </div>
          <span className={styles.progressText}>
            {checked.length} of {items.length} in the basket
          </span>
        </div>
      )}

      {!online && (
        <p className={styles.offline} role="status">
          You’re offline. Changes you make here will be saved when the connection comes back.
        </p>
      )}

      <form className={styles.addBar} onSubmit={handleAdd}>
        <input
          className={styles.addInput}
          type="text"
          value={text}
          onChange={(e) => setText(e.target.value)}
          placeholder={'Add a staple — e.g. "2 dozen eggs"'}
          aria-label="Add a staple"
        />
        <button className={styles.addButton} type="submit" disabled={text.trim() === ''}>
          Add
        </button>
      </form>

      {checked.length > 0 && (
        <div className={styles.clearBar}>
          <button
            className={styles.clearButton}
            type="button"
            onClick={() => clearChecked.mutate()}
          >
            Clear checked
          </button>
        </div>
      )}

      {items.length === 0 && (
        <div className={styles.empty}>
          <p className={styles.emptyBody}>
            Your list is empty. Add recipes from the{' '}
            <Link to="/recipes" className={styles.emptyLink}>
              Library
            </Link>
            , or add a staple above.
          </p>
        </div>
      )}

      {sections.map((section) => (
        <div
          key={section.department}
          className={styles.section}
          style={departmentStyle(section.department)}
        >
          <div className={styles.sectionHead}>
            <h2 className={styles.sectionTitle}>{section.department}</h2>
            <span className={styles.sectionCount}>
              {section.items.length}
              <span className={styles.srOnly}> items</span>
            </span>
          </div>
          <ul className={styles.items}>
            {section.items.map((item) => (
              <ItemRow
                key={item.id}
                item={item}
                onToggle={() => toggleChecked.mutate({ itemId: item.id, checked: !item.checked })}
                onRemove={() => removeItem.mutate({ itemId: item.id })}
              />
            ))}
          </ul>
        </div>
      ))}

      {checked.length > 0 && (
        <details className={styles.done} open>
          <summary className={styles.doneSummary}>Done ({checked.length})</summary>
          <ul className={styles.items}>
            {checked.map((item) => (
              <ItemRow
                key={item.id}
                item={item}
                done
                onToggle={() => toggleChecked.mutate({ itemId: item.id, checked: !item.checked })}
                onRemove={() => removeItem.mutate({ itemId: item.id })}
              />
            ))}
          </ul>
        </details>
      )}
    </section>
  );
}

function ItemRow({
  item,
  done = false,
  onToggle,
  onRemove,
}: {
  item: Item;
  done?: boolean;
  onToggle: () => void;
  onRemove: () => void;
}) {
  // Added on this phone and not yet confirmed: the server has no id for it to tick or remove.
  const pending = item.id.startsWith(PENDING_PREFIX);
  const amount = amountLabel(item.quantity, item.unit);
  return (
    <li className={done ? `${styles.item} ${styles.itemDone}` : styles.item}>
      <label className={styles.itemLabel}>
        <input
          type="checkbox"
          className={styles.check}
          checked={item.checked}
          onChange={onToggle}
          disabled={pending}
          aria-label={item.checked ? `Uncheck ${item.name}` : `Check ${item.name}`}
        />
        <span className={styles.itemText}>
          <span className={styles.name}>{item.name}</span>
          {item.note && <span className={styles.note}>{item.note}</span>}
        </span>
        {amount && <span className={styles.amount}>{amount}</span>}
      </label>
      <button
        type="button"
        className={styles.remove}
        onClick={onRemove}
        disabled={pending}
        aria-label={`Remove ${item.name}`}
      >
        ×
      </button>
    </li>
  );
}
