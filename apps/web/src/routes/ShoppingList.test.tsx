import { describe, it, expect, vi, beforeEach, afterEach, type Mock } from 'vitest';
import { render, screen, fireEvent, cleanup, within, act } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { ShoppingList, LIST_REFRESH_MS } from './ShoppingList';
import { trpc } from '../lib/trpc';

// Mock the typed tRPC client: the screen touches shoppingList.get + four
// mutations, plus useUtils for query invalidation.
vi.mock('../lib/trpc', () => ({
  trpc: {
    useUtils: vi.fn(),
    shoppingList: {
      get: { useQuery: vi.fn() },
      addItem: { useMutation: vi.fn() },
      toggleChecked: { useMutation: vi.fn() },
      removeItem: { useMutation: vi.fn() },
      setAmount: { useMutation: vi.fn() },
      clearChecked: { useMutation: vi.fn() },
    },
  },
}));

const useGetQuery = trpc.shoppingList.get.useQuery as unknown as Mock;
const useAddItem = trpc.shoppingList.addItem.useMutation as unknown as Mock;
const useToggleChecked = trpc.shoppingList.toggleChecked.useMutation as unknown as Mock;
const useRemoveItem = trpc.shoppingList.removeItem.useMutation as unknown as Mock;
const useSetAmount = trpc.shoppingList.setAmount.useMutation as unknown as Mock;
const useClearChecked = trpc.shoppingList.clearChecked.useMutation as unknown as Mock;
const useUtils = trpc.useUtils as unknown as Mock;

function makeItem(overrides: Record<string, unknown> = {}) {
  return {
    id: 'i1',
    foodId: null,
    name: 'Milk',
    quantity: 1,
    unit: 'gal',
    note: null,
    department: 'Dairy',
    checked: false,
    source: 'manual',
    sourceRecipeId: null,
    position: 0,
    ...overrides,
  };
}

let addItemMutate: Mock;
let toggleCheckedMutate: Mock;
let removeItemMutate: Mock;
let clearCheckedMutate: Mock;
let setAmountMutate: Mock;

function mockQuery(items: unknown[]) {
  useGetQuery.mockReturnValue({
    data: { list: { id: 'l1' }, items },
    isLoading: false,
    isError: false,
  });
}

beforeEach(() => {
  addItemMutate = vi.fn();
  toggleCheckedMutate = vi.fn();
  removeItemMutate = vi.fn();
  clearCheckedMutate = vi.fn();
  setAmountMutate = vi.fn();

  useAddItem.mockReturnValue({ mutate: addItemMutate, isPending: false });
  useToggleChecked.mockReturnValue({ mutate: toggleCheckedMutate, isPending: false });
  useRemoveItem.mockReturnValue({ mutate: removeItemMutate, isPending: false });
  useClearChecked.mockReturnValue({ mutate: clearCheckedMutate, isPending: false });
  useSetAmount.mockReturnValue({ mutate: setAmountMutate, isPending: false });
  useUtils.mockReturnValue({
    shoppingList: { get: { invalidate: vi.fn() } },
  });
});

afterEach(cleanup);

function renderList() {
  return render(
    <MemoryRouter>
      <ShoppingList />
    </MemoryRouter>,
  );
}

describe('ShoppingList', () => {
  it('groups items by department, with null-department items under "Other"', () => {
    mockQuery([
      makeItem({ id: 'i1', name: 'Milk', department: 'Dairy' }),
      makeItem({ id: 'i2', name: 'Mystery item', department: null, quantity: null, unit: null }),
    ]);
    renderList();

    expect(screen.getByRole('heading', { name: 'Dairy' })).toBeInTheDocument();
    expect(screen.getByText('Milk')).toBeInTheDocument();

    const other = screen.getByRole('heading', { name: 'Other' });
    expect(other).toBeInTheDocument();
    expect(screen.getByText('Mystery item')).toBeInTheDocument();
  });

  it('reads a unit in the plural after more than one, and leaves abbreviations alone', () => {
    mockQuery([
      makeItem({ id: 'i1', name: 'flour', quantity: 3, unit: 'cup' }),
      makeItem({ id: 'i2', name: 'garlic', quantity: 1, unit: 'clove' }),
      makeItem({ id: 'i3', name: 'olive oil', quantity: 2, unit: 'tbsp' }),
    ]);
    renderList();

    expect(screen.getByText('3 cups')).toBeInTheDocument();
    expect(screen.getByText('1 clove')).toBeInTheDocument();
    expect(screen.getByText('2 tbsp')).toBeInTheDocument();
  });

  it('rounds counted items to whole ones and measures up to a quarter or third', () => {
    mockQuery([
      makeItem({ id: 'i1', name: 'garlic', quantity: 16.166, unit: 'clove' }),
      makeItem({ id: 'i2', name: 'bay leaf', quantity: 1.17, unit: null }),
      makeItem({ id: 'i3', name: 'rice', quantity: 1.17, unit: 'cup' }),
      makeItem({ id: 'i4', name: 'flour', quantity: 0.29, unit: 'cup' }),
      makeItem({ id: 'i5', name: 'tomato paste', quantity: 3.83, unit: 'tbsp' }),
    ]);
    renderList();

    expect(screen.getByText('17 cloves')).toBeInTheDocument();
    expect(screen.getByText('2')).toBeInTheDocument();
    expect(screen.getByText('1 ¼ cups')).toBeInTheDocument();
    expect(screen.getByText('⅓ cup')).toBeInTheDocument();
    expect(screen.getByText('4 tbsp')).toBeInTheDocument();
  });

  it('reads a counted item rounded up to one in the plural only when it is more', () => {
    mockQuery([makeItem({ id: 'i1', name: 'celery', quantity: 0.5, unit: 'stalk' })]);
    renderList();

    expect(screen.getByText('1 stalk')).toBeInTheDocument();
  });

  it('toggles an item checked when its checkbox is clicked', () => {
    mockQuery([makeItem({ id: 'i1', name: 'Milk', checked: false })]);
    renderList();

    fireEvent.click(screen.getByRole('checkbox', { name: 'Check Milk' }));

    expect(toggleCheckedMutate).toHaveBeenCalledTimes(1);
    expect(toggleCheckedMutate).toHaveBeenCalledWith({ itemId: 'i1', checked: true });
  });

  it('adds a staple with the typed text on submit', () => {
    mockQuery([]);
    renderList();

    fireEvent.change(screen.getByLabelText('Add a staple'), {
      target: { value: '2 dozen eggs' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Add' }));

    expect(addItemMutate).toHaveBeenCalledTimes(1);
    expect(addItemMutate).toHaveBeenCalledWith({ text: '2 dozen eggs' });
    // Cleared at once: the item is on the list already, even while offline.
    expect(screen.getByLabelText('Add a staple')).toHaveValue('');
  });

  it('sinks a checked item into the Done group, not its department section', () => {
    mockQuery([
      makeItem({ id: 'i1', name: 'Milk', department: 'Dairy', checked: false }),
      makeItem({ id: 'i2', name: 'Bread', department: 'Bakery', checked: true }),
    ]);
    renderList();

    // Bread lives inside the Done group.
    const done = screen.getByText(/Done \(1\)/).closest('details') as HTMLElement;
    expect(within(done).getByText('Bread')).toBeInTheDocument();

    // Its department section is not rendered (no active Bakery items).
    expect(screen.queryByRole('heading', { name: 'Bakery' })).not.toBeInTheDocument();
  });
});

describe('keeping two phones in step', () => {
  it('polls the list while it is open', () => {
    mockQuery([]);
    renderList();
    expect(useGetQuery).toHaveBeenCalledWith(undefined, { refetchInterval: LIST_REFRESH_MS });
  });
});

describe('changes show at once, and survive a dropped signal', () => {
  function withCache(items: unknown[]) {
    let data: { list: { id: string; householdId: string }; items: unknown[] } | undefined = {
      list: { id: 'l1', householdId: 'h1' },
      items,
    };
    const get = {
      invalidate: vi.fn(),
      cancel: vi.fn().mockResolvedValue(undefined),
      getData: vi.fn(() => data),
      setData: vi.fn((_input: unknown, updater: unknown) => {
        data =
          typeof updater === 'function'
            ? (updater as (d: typeof data) => typeof data)(data)
            : (updater as typeof data);
      }),
    };
    useUtils.mockReturnValue({ shoppingList: { get } });
    return { get, current: () => data };
  }

  it('ticks an item in the cache before the server answers, and rolls back if it refuses', async () => {
    const cache = withCache([makeItem({ id: 'i1', checked: false })]);
    mockQuery([makeItem({ id: 'i1', checked: false })]);
    renderList();
    const options = useToggleChecked.mock.calls.at(-1)?.[0] as {
      onMutate: (input: unknown) => Promise<{ previous: unknown }>;
      onError: (err: unknown, input: unknown, context: unknown) => void;
    };
    const context = await options.onMutate({ itemId: 'i1', checked: true });
    expect((cache.current()?.items[0] as { checked: boolean }).checked).toBe(true);
    options.onError(new Error('refused'), { itemId: 'i1', checked: true }, context);
    expect((cache.current()?.items[0] as { checked: boolean }).checked).toBe(false);
  });

  it('puts a typed staple on the list straight away', async () => {
    const cache = withCache([]);
    mockQuery([]);
    renderList();
    const options = useAddItem.mock.calls.at(-1)?.[0] as {
      onMutate: (input: unknown) => Promise<unknown>;
    };
    await options.onMutate({ text: 'paper towels' });
    expect(cache.current()?.items).toEqual([
      expect.objectContaining({ name: 'paper towels', checked: false, listId: 'l1' }),
    ]);
  });

  it('says so while the phone is offline', () => {
    mockQuery([]);
    const onLine = vi.spyOn(navigator, 'onLine', 'get').mockReturnValue(false);
    renderList();
    expect(screen.getByRole('status')).toHaveTextContent('You’re offline');
    onLine.mockRestore();
  });

  it('will not tick or remove an item the server has not confirmed yet', () => {
    mockQuery([makeItem({ id: 'pending-coffee', name: 'coffee' })]);
    renderList();
    expect(screen.getByRole('checkbox', { name: 'Check coffee' })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Remove coffee' })).toBeDisabled();
  });
});

describe('editing an amount in place', () => {
  it('opens a labelled box with the amount as the list shows it', () => {
    mockQuery([makeItem({ id: 'i1', name: 'garlic', quantity: 16.166, unit: 'clove' })]);
    renderList();

    fireEvent.click(screen.getByRole('button', { name: '17 cloves, change amount of garlic' }));

    const box = screen.getByRole('textbox', { name: 'Amount of garlic' });
    expect(box).toHaveValue('17 cloves');
    expect(box).toHaveFocus();
  });

  it('saves the typed amount with the amount it started from', () => {
    mockQuery([makeItem({ id: 'i1', name: 'eggs', quantity: 6, unit: null })]);
    renderList();

    fireEvent.click(screen.getByRole('button', { name: '6, change amount of eggs' }));
    fireEvent.change(screen.getByRole('textbox', { name: 'Amount of eggs' }), {
      target: { value: '1 1/2 dozen' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));

    expect(setAmountMutate).toHaveBeenCalledWith({
      itemId: 'i1',
      text: '1 1/2 dozen',
      seen: { quantity: 6, unit: null },
    });
    expect(screen.queryByRole('textbox', { name: 'Amount of eggs' })).not.toBeInTheDocument();
  });

  it('sends the amount seen when the box opened, even if another phone changed it since', () => {
    mockQuery([makeItem({ id: 'i1', name: 'eggs', quantity: 6, unit: null })]);
    const { rerender } = renderList();

    fireEvent.click(screen.getByRole('button', { name: '6, change amount of eggs' }));
    // The list refreshes while the box is open: another phone made it 12.
    mockQuery([makeItem({ id: 'i1', name: 'eggs', quantity: 12, unit: null })]);
    rerender(
      <MemoryRouter>
        <ShoppingList />
      </MemoryRouter>,
    );
    const box = screen.getByRole('textbox', { name: 'Amount of eggs' });
    expect(box).toHaveValue('6');
    fireEvent.change(box, { target: { value: '8' } });
    fireEvent.submit(box);

    expect(setAmountMutate).toHaveBeenCalledWith({
      itemId: 'i1',
      text: '8',
      seen: { quantity: 6, unit: null },
    });
  });

  it('offers an amount for an item that has none, and saves on Enter', () => {
    mockQuery([makeItem({ id: 'i1', name: 'paper towels', quantity: null, unit: null })]);
    renderList();

    fireEvent.click(screen.getByRole('button', { name: 'Add amount for paper towels' }));
    const box = screen.getByRole('textbox', { name: 'Amount of paper towels' });
    expect(box).toHaveValue('');
    fireEvent.change(box, { target: { value: '2 packages' } });
    fireEvent.submit(box);

    expect(setAmountMutate).toHaveBeenCalledWith({
      itemId: 'i1',
      text: '2 packages',
      seen: { quantity: null, unit: null },
    });
  });

  it('keeps the box open and says why when the text is not an amount', () => {
    mockQuery([makeItem({ id: 'i1', name: 'eggs', quantity: 6, unit: null })]);
    renderList();

    fireEvent.click(screen.getByRole('button', { name: '6, change amount of eggs' }));
    const box = screen.getByRole('textbox', { name: 'Amount of eggs' });
    fireEvent.change(box, { target: { value: 'a few' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));

    expect(setAmountMutate).not.toHaveBeenCalled();
    expect(box).toHaveAttribute('aria-invalid', 'true');
    expect(box).toHaveAccessibleDescription(/Type an amount/);
  });

  it('closes without saving on Escape, on Cancel, or when nothing changed', () => {
    mockQuery([makeItem({ id: 'i1', name: 'eggs', quantity: 6, unit: null })]);
    renderList();
    const open = () => {
      fireEvent.click(screen.getByRole('button', { name: '6, change amount of eggs' }));
      return screen.getByRole('textbox', { name: 'Amount of eggs' });
    };

    fireEvent.keyDown(open(), { key: 'Escape' });
    expect(screen.queryByRole('textbox', { name: 'Amount of eggs' })).toBeNull();
    expect(screen.getByRole('button', { name: '6, change amount of eggs' })).toHaveFocus();

    open();
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(screen.queryByRole('textbox', { name: 'Amount of eggs' })).toBeNull();

    open();
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    expect(screen.queryByRole('textbox', { name: 'Amount of eggs' })).toBeNull();
    expect(setAmountMutate).not.toHaveBeenCalled();
  });

  it('will not edit the amount of an item the server has not confirmed yet', () => {
    mockQuery([makeItem({ id: 'pending-coffee', name: 'coffee', quantity: null, unit: null })]);
    renderList();
    expect(screen.getByRole('button', { name: 'Add amount for coffee' })).toBeDisabled();
  });
});

describe('an amount edit shows at once, and says when another phone got there first', () => {
  function withCache(items: unknown[]) {
    let data: { list: { id: string; householdId: string }; items: unknown[] } | undefined = {
      list: { id: 'l1', householdId: 'h1' },
      items,
    };
    const get = {
      invalidate: vi.fn(),
      cancel: vi.fn().mockResolvedValue(undefined),
      getData: vi.fn(() => data),
      setData: vi.fn((_input: unknown, updater: unknown) => {
        data =
          typeof updater === 'function'
            ? (updater as (d: typeof data) => typeof data)(data)
            : (updater as typeof data);
      }),
    };
    useUtils.mockReturnValue({ shoppingList: { get } });
    return { current: () => data };
  }

  type Options = {
    onMutate: (input: unknown) => Promise<unknown>;
    onError: (err: unknown, input: unknown, context: unknown) => void;
    scope?: { id: string };
  };
  const options = () => useSetAmount.mock.calls.at(-1)?.[0] as Options;
  const input = { itemId: 'i1', text: '1 dozen', seen: { quantity: 6, unit: null } };

  it('changes the amount in the cache before the server answers', async () => {
    const cache = withCache([makeItem({ id: 'i1', name: 'eggs', quantity: 6, unit: null })]);
    mockQuery([makeItem({ id: 'i1', name: 'eggs', quantity: 6, unit: null })]);
    renderList();

    await act(() => options().onMutate(input));

    expect(cache.current()?.items[0]).toMatchObject({ quantity: 1, unit: 'dozen' });
  });

  it('sends queued edits one at a time, so a second edit lands after the first', () => {
    mockQuery([]);
    renderList();
    expect(options().scope).toEqual({ id: expect.any(String) });
  });

  it('rolls back and says so when another phone changed the amount first', async () => {
    const cache = withCache([makeItem({ id: 'i1', name: 'eggs', quantity: 6, unit: null })]);
    mockQuery([makeItem({ id: 'i1', name: 'eggs', quantity: 6, unit: null })]);
    renderList();

    const context = await act(() => options().onMutate(input));
    act(() => options().onError({ data: { code: 'CONFLICT' } }, input, context));

    expect(cache.current()?.items[0]).toMatchObject({ quantity: 6, unit: null });
    expect(screen.getByRole('alert')).toHaveTextContent('changed on another phone');
    fireEvent.click(screen.getByRole('button', { name: 'Dismiss' }));
    expect(screen.queryByRole('alert')).toBeNull();
  });
});
