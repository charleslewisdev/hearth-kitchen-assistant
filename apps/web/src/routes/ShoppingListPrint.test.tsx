import { describe, it, expect, vi, beforeEach, afterEach, type Mock } from 'vitest';
import { render, screen, fireEvent, cleanup } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { ShoppingList } from './ShoppingList';
import { trpc } from '../lib/trpc';

// The same tRPC mock as ShoppingList.test.tsx. Every list mutation is stubbed, including ones this
// file never calls, so the screen renders whichever of them it uses.
vi.mock('../lib/trpc', () => ({
  trpc: {
    useUtils: vi.fn(),
    shoppingList: {
      get: { useQuery: vi.fn() },
      addItem: { useMutation: vi.fn() },
      toggleChecked: { useMutation: vi.fn() },
      removeItem: { useMutation: vi.fn() },
      clearChecked: { useMutation: vi.fn() },
      setAmount: { useMutation: vi.fn() },
    },
  },
}));

const list = trpc.shoppingList as unknown as Record<string, Record<string, Mock>>;

function item(overrides: Record<string, unknown>) {
  return {
    id: 'i1',
    foodId: null,
    name: 'Milk',
    quantity: null,
    unit: null,
    note: null,
    department: null,
    checked: false,
    source: 'manual',
    sourceRecipeId: null,
    position: 0,
    ...overrides,
  };
}

function showList(items: unknown[]) {
  list.get!.useQuery!.mockReturnValue({
    data: { list: { id: 'l1', householdId: 'h1' }, items },
    isLoading: false,
    isError: false,
  });
  return render(
    <MemoryRouter>
      <ShoppingList />
    </MemoryRouter>,
  );
}

function sheet(): HTMLElement | null {
  return document.body.querySelector(':scope > [data-print-sheet]');
}

beforeEach(() => {
  for (const name of ['addItem', 'toggleChecked', 'removeItem', 'clearChecked', 'setAmount']) {
    list[name]!.useMutation!.mockReturnValue({ mutate: vi.fn(), isPending: false });
  }
  (trpc.useUtils as unknown as Mock).mockReturnValue({
    shoppingList: { get: { invalidate: vi.fn() } },
  });
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.useRealTimers();
});

// In the server's order: the list's department order, with no department at the end.
const LIST = [
  item({ id: 'a', name: 'apples', department: 'Produce', quantity: 2, unit: 'lb' }),
  item({ id: 'b', name: 'lemons', department: 'Produce', quantity: 3, unit: null }),
  item({ id: 'c', name: 'butter', department: 'Dairy', checked: true }),
  item({ id: 'd', name: 'cheddar', department: 'Dairy', note: 'sharp' }),
  item({ id: 'e', name: 'garlic', department: 'Produce', quantity: 16.166, unit: 'clove' }),
  item({ id: 'f', name: 'paper towels', department: null }),
  item({ id: 'g', name: 'rice', department: 'Pantry', checked: true }),
];

describe('Print on the Shop tab', () => {
  it('opens the browser’s print dialog from a labelled button', () => {
    const print = vi.spyOn(window, 'print').mockImplementation(() => {});
    showList(LIST);
    const button = screen.getByRole('button', { name: 'Print' });
    expect(button.tagName).toBe('BUTTON');
    fireEvent.click(button);
    expect(print).toHaveBeenCalledTimes(1);
  });

  it('prints the departments in the list’s order, with Other last', () => {
    showList(LIST);
    const headings = Array.from(sheet()!.querySelectorAll('h2'), (h) => h.textContent);
    expect(headings).toEqual(['Produce', 'Dairy', 'Other']);
  });

  it('prints only what is still to buy, each with its amount as the list shows it', () => {
    showList(LIST);
    const lines = Array.from(sheet()!.querySelectorAll('li'), (li) => li.textContent);
    expect(lines).toEqual([
      'apples2 lb',
      'lemons3',
      'garlic17 cloves',
      'cheddar, sharp',
      'paper towels',
    ]);
    expect(sheet()).not.toHaveTextContent('butter');
    expect(sheet()).not.toHaveTextContent('rice');
  });

  it('gives every line a box to tick with a pen', () => {
    showList(LIST);
    for (const li of sheet()!.querySelectorAll('li')) {
      expect(li.querySelector('[data-tick-box]')).not.toBeNull();
    }
  });

  it('heads the sheet with its title, the day and how many things to buy', () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date(2026, 2, 14, 9, 30));
    showList(LIST);
    expect(sheet()!.querySelector('h1')).toHaveTextContent('Shopping list');
    const day = new Date(2026, 2, 14).toLocaleDateString(undefined, {
      weekday: 'long',
      day: 'numeric',
      month: 'long',
      year: 'numeric',
    });
    expect(sheet()).toHaveTextContent(`${day} · 5 items`);
  });

  it('says one item, not one items', () => {
    showList([item({ id: 'a', name: 'coffee' })]);
    expect(sheet()!.querySelector('p')!.textContent).toMatch(/ · 1 item$/);
  });

  it('offers no Print, and leaves printing to the screen, when nothing is left to buy', () => {
    showList([item({ id: 'c', name: 'butter', checked: true })]);
    expect(screen.queryByRole('button', { name: 'Print' })).toBeNull();
    expect(sheet()).toBeNull();
    expect(document.body).not.toHaveAttribute('data-printing');
  });

  it('offers no Print on an empty list', () => {
    showList([]);
    expect(screen.queryByRole('button', { name: 'Print' })).toBeNull();
    expect(sheet()).toBeNull();
  });
});
