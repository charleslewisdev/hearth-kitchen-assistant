import {
  useEffect,
  useId,
  useRef,
  useState,
  useSyncExternalStore,
  type FormEvent,
  type KeyboardEvent,
} from 'react';
import { Link } from 'react-router-dom';
import {
  listAmountText,
  MAX_LIST_AMOUNT_LENGTH,
  parseListAmount,
  shoppingQuantity,
} from '@hearth/shared';
import { trpc } from '../lib/trpc';
import { departmentStyle } from '../lib/departments';
import { useOnKeptSession } from '../lib/offline-context';
import { keptListTime } from '../lib/kept-list-time';
import styles from './ShoppingList.module.css';
import { useDocumentTitle } from '../lib/useDocumentTitle';
import { ShoppingListPrint } from './ShoppingListPrint';

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
  return listAmountText(shoppingQuantity(stored, unit), unit);
}

/** What an amount edit sends: the text typed, and the amount the item had when the edit began. */
type AmountEdit = {
  itemId: string;
  text: string;
  seen: { quantity: number | null; unit: string | null };
};

/**
 * Why an amount edit did not go through, in words for the cook, or null when the list says it
 * already. NOT_FOUND means the item is gone: removed on another phone, or merged into another line
 * by this same edit sent twice. Either way the refetch shows the truth, and a "removed" notice
 * would be wrong for the second.
 */
function amountErrorMessage(err: unknown): string | null {
  const code = (err as { data?: { code?: string } } | null)?.data?.code;
  if (code === 'CONFLICT') {
    return 'That amount was changed on another phone, so your change was not saved. Check it and try again.';
  }
  if (code === 'NOT_FOUND') return null;
  // A dropped connection mid-request lands here too, when the change may have been saved.
  return 'That amount may not have been saved. Check it and try again.';
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

/** The server said no to this session, as opposed to not being reached: the list is not theirs. */
function refusedByServer(error: unknown): boolean {
  const code = (error as { data?: { code?: string } } | null)?.data?.code;
  return code === 'UNAUTHORIZED' || code === 'FORBIDDEN';
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
  // An amount edit (D54). Queued edits run one after another on reconnect (`scope`): each says
  // which amount it started from, so a second edit to the same item must land after the first.
  const [notice, setNotice] = useState<string | null>(null);
  const amountUpdates = optimistic<AmountEdit>((items, { itemId, text }) => {
    const amount = parseListAmount(text);
    return amount ? items.map((i) => (i.id === itemId ? { ...i, ...amount } : i)) : items;
  });
  const setAmount = trpc.shoppingList.setAmount.useMutation({
    ...amountUpdates,
    scope: { id: 'shopping-list-amount' },
    onError: (err, input, context) => {
      amountUpdates.onError(err, input, context);
      setNotice(amountErrorMessage(err));
    },
  });
  const clearChecked = trpc.shoppingList.clearChecked.useMutation(
    optimistic<void>((items) => items.filter((i) => !i.checked)),
  );
  // Offline per the browser, or open from this phone's copy because the server could not be
  // reached (D56), which is also what a signal too weak to carry a request looks like.
  const browserOnline = useOnline();
  const onKeptSession = useOnKeptSession();
  const online = browserOnline && !onKeptSession;

  const [text, setText] = useState('');

  function handleAdd(e: FormEvent) {
    e.preventDefault();
    const value = text.trim();
    if (!value) return;
    // Cleared straight away: the item is already on the list, offline or not.
    addItem.mutate({ text: value });
    setText('');
  }

  // Nothing to show yet. Paused rather than loading when there is no signal and no copy here.
  if (query.isPending) {
    return (
      <section className={styles.screen}>
        <h1 className={styles.title}>Shopping list</h1>
        <p
          className={query.fetchStatus === 'paused' ? styles.offline : styles.status}
          role="status"
        >
          {query.fetchStatus === 'paused'
            ? 'You’re offline, and this phone has no copy of your list yet. It will load when the connection comes back.'
            : 'Loading your list…'}
        </p>
      </section>
    );
  }

  // A failed refresh keeps the list it already had on screen, unless the server refused it.
  if (query.isError && (!query.data || refusedByServer(query.error))) {
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
      <div className={styles.header}>
        <h1 className={styles.title}>Shopping list</h1>
        {/* What is left to buy, on paper: checked items are in the basket already. */}
        {unchecked.length > 0 && (
          <button type="button" className={styles.printButton} onClick={() => window.print()}>
            Print
          </button>
        )}
      </div>
      {unchecked.length > 0 && (
        <ShoppingListPrint
          sections={sections.map(({ department, items }) => ({
            department,
            items: items.map(({ id, name, note, quantity, unit }) => ({
              id,
              name,
              note,
              amount: amountLabel(quantity, unit),
            })),
          }))}
        />
      )}

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
          You’re offline. Showing your list from {keptListTime(query.dataUpdatedAt)}. Changes you
          make here will be saved when the connection comes back.
        </p>
      )}

      {/* Online, but the last refresh failed: the list on screen may be behind. */}
      {online && query.isError && (
        <p className={styles.offline} role="status">
          Can’t reach Hearth right now. Showing your list from {keptListTime(query.dataUpdatedAt)}.
        </p>
      )}

      {notice && (
        <div className={styles.notice} role="alert">
          <span>{notice}</span>
          <button type="button" className={styles.noticeDismiss} onClick={() => setNotice(null)}>
            Dismiss
          </button>
        </div>
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
                onSetAmount={(text, seen) => {
                  setNotice(null);
                  setAmount.mutate({ itemId: item.id, text, seen });
                }}
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
                onSetAmount={(text, seen) => {
                  setNotice(null);
                  setAmount.mutate({ itemId: item.id, text, seen });
                }}
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
  onSetAmount,
}: {
  item: Item;
  done?: boolean;
  onToggle: () => void;
  onRemove: () => void;
  onSetAmount: (text: string, seen: AmountEdit['seen']) => void;
}) {
  // Added on this phone and not yet confirmed: the server has no id for it to tick or remove.
  const pending = item.id.startsWith(PENDING_PREFIX);
  const amount = amountLabel(item.quantity, item.unit);
  // The amount the cook was looking at when they opened the box. Kept from that moment, not read
  // at Save, so a change from another phone that arrives meanwhile is caught as a clash (D54).
  const [editingFrom, setEditingFrom] = useState<AmountEdit['seen'] | null>(null);
  const editing = editingFrom !== null;
  const amountButton = useRef<HTMLButtonElement>(null);
  const wasEditing = useRef(false);

  // Back to the amount once the box closes, so a keyboard user carries on where they were.
  useEffect(() => {
    if (wasEditing.current && !editing) amountButton.current?.focus();
    wasEditing.current = editing;
  }, [editing]);

  return (
    <li className={done ? `${styles.item} ${styles.itemDone}` : styles.item}>
      <div className={styles.itemRow}>
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
        </label>
        <button
          ref={amountButton}
          type="button"
          className={amount ? styles.amount : `${styles.amount} ${styles.amountEmpty}`}
          onClick={() => setEditingFrom({ quantity: item.quantity, unit: item.unit })}
          disabled={pending}
          aria-expanded={editing}
          // Starts with the words on the button, so a voice user can say what they see.
          aria-label={
            amount ? `${amount}, change amount of ${item.name}` : `Add amount for ${item.name}`
          }
        >
          {amount ? <span>{amount}</span> : 'Add amount'}
        </button>
        <button
          type="button"
          className={styles.remove}
          onClick={onRemove}
          disabled={pending}
          aria-label={`Remove ${item.name}`}
        >
          ×
        </button>
      </div>
      {editingFrom && (
        <AmountEditor
          name={item.name}
          initial={amountLabel(editingFrom.quantity, editingFrom.unit)}
          onSave={(text) => {
            setEditingFrom(null);
            onSetAmount(text, editingFrom);
          }}
          onClose={() => setEditingFrom(null)}
        />
      )}
    </li>
  );
}

/**
 * The box an item's amount is changed in: "3", "1 ½ lb", "12 oz", or empty for none. Read with
 * the same parser as the server, so a typo is caught here rather than refused after a round trip.
 */
function AmountEditor({
  name,
  initial,
  onSave,
  onClose,
}: {
  name: string;
  initial: string;
  onSave: (text: string) => void;
  onClose: () => void;
}) {
  const [text, setText] = useState(initial);
  const [invalid, setInvalid] = useState(false);
  const id = useId();
  const hintId = `${id}-hint`;

  function handleSubmit(e: FormEvent) {
    e.preventDefault();
    const value = text.trim();
    if (value === initial) return onClose();
    if (parseListAmount(value) === null) return setInvalid(true);
    onSave(value);
  }

  function handleKeyDown(e: KeyboardEvent<HTMLInputElement>) {
    if (e.key === 'Escape') {
      e.preventDefault();
      onClose();
    }
  }

  return (
    <form className={styles.amountForm} onSubmit={handleSubmit}>
      <label className={styles.amountFieldLabel} htmlFor={id}>
        Amount of {name}
      </label>
      <div className={styles.amountFieldRow}>
        <input
          id={id}
          className={styles.amountInput}
          type="text"
          value={text}
          onChange={(e) => {
            setText(e.target.value);
            setInvalid(false);
          }}
          onKeyDown={handleKeyDown}
          onFocus={(e) => e.currentTarget.select()}
          maxLength={MAX_LIST_AMOUNT_LENGTH}
          autoComplete="off"
          enterKeyHint="done"
          aria-invalid={invalid}
          aria-describedby={hintId}
          // The box opens because the cook asked for it; typing should start at once.
          autoFocus
        />
        <button type="submit" className={styles.amountSave}>
          Save
        </button>
        <button type="button" className={styles.amountCancel} onClick={onClose}>
          Cancel
        </button>
      </div>
      <p
        id={hintId}
        className={invalid ? styles.amountError : styles.amountHint}
        aria-live="polite"
      >
        {invalid
          ? 'Type an amount and unit only, like 3, 1 ½ lb or 12 oz.'
          : 'Like 3, 1 ½ lb or 12 oz. Leave it empty for no amount.'}
      </p>
    </form>
  );
}
