import { describe, it, expect, vi, beforeEach, afterEach, type Mock } from 'vitest';
import { render, screen, cleanup } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { ShoppingList } from './ShoppingList';
import { trpc } from '../lib/trpc';
import { KeptSessionContext } from '../lib/offline-context';
import { keptListTime } from '../lib/kept-list-time';

// The Shop tab opened from this phone's copy of the list (D56). Kept apart from
// ShoppingList.test.tsx, which covers the list itself.
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

const useGetQuery = trpc.shoppingList.get.useQuery as unknown as Mock;
const FETCHED_AT = new Date(2026, 10, 8, 14, 41).getTime();
const MILK = {
  id: 'i1',
  foodId: null,
  name: 'Milk',
  quantity: null,
  unit: null,
  note: null,
  department: 'Dairy',
  checked: false,
  source: 'manual',
  sourceRecipeId: null,
  position: 0,
};

beforeEach(() => {
  for (const hook of Object.values(trpc.shoppingList)) {
    if ('useMutation' in hook) (hook.useMutation as Mock).mockReturnValue({ mutate: vi.fn() });
  }
  (trpc.useUtils as Mock).mockReturnValue({ shoppingList: { get: { invalidate: vi.fn() } } });
});

afterEach(cleanup);

function renderList({ kept = false } = {}) {
  return render(
    <KeptSessionContext.Provider value={kept}>
      <MemoryRouter>
        <ShoppingList />
      </MemoryRouter>
    </KeptSessionContext.Provider>,
  );
}

describe('ShoppingList from the copy on this phone', () => {
  it('says when the list on screen is from, while offline', () => {
    useGetQuery.mockReturnValue({ data: { items: [MILK] }, dataUpdatedAt: FETCHED_AT });
    const onLine = vi.spyOn(navigator, 'onLine', 'get').mockReturnValue(false);
    try {
      renderList();
      expect(screen.getByRole('status')).toHaveTextContent(
        `Showing your list from ${keptListTime(FETCHED_AT).replaceAll('\u00a0', ' ')}`,
      );
    } finally {
      onLine.mockRestore();
    }
  });

  it('says so too when the browser thinks it is online but the server could not be reached', () => {
    useGetQuery.mockReturnValue({ data: { items: [MILK] }, dataUpdatedAt: FETCHED_AT });
    renderList({ kept: true });
    expect(screen.getByRole('status')).toHaveTextContent('You’re offline');
  });

  it('keeps the list it has when a refresh fails', () => {
    useGetQuery.mockReturnValue({
      data: { items: [MILK] },
      dataUpdatedAt: FETCHED_AT,
      isError: true,
      error: { data: { code: 'INTERNAL_SERVER_ERROR' } },
    });
    renderList();
    expect(screen.getByRole('checkbox', { name: 'Check Milk' })).toBeInTheDocument();
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
    // Said, though the phone is online: the list on screen may be behind. No promise to save.
    expect(screen.getByRole('status')).toHaveTextContent('Can’t reach Hearth right now');
    expect(screen.getByRole('status')).not.toHaveTextContent('will be saved');
  });

  it('does not keep showing a list the server refused', () => {
    useGetQuery.mockReturnValue({
      data: { items: [MILK] },
      dataUpdatedAt: FETCHED_AT,
      isError: true,
      error: { data: { code: 'FORBIDDEN' } },
    });
    renderList();
    expect(screen.queryByRole('checkbox', { name: 'Check Milk' })).not.toBeInTheDocument();
    expect(screen.getByRole('alert')).toBeInTheDocument();
  });

  it('does not keep showing a list once signed out on the server', () => {
    useGetQuery.mockReturnValue({
      data: { items: [MILK] },
      isError: true,
      error: { data: { code: 'UNAUTHORIZED' } },
    });
    renderList();
    expect(screen.queryByRole('checkbox', { name: 'Check Milk' })).not.toBeInTheDocument();
  });

  it('says there is no copy yet rather than showing an empty list', () => {
    useGetQuery.mockReturnValue({ data: undefined, isPending: true, fetchStatus: 'paused' });
    renderList({ kept: true });
    expect(screen.getByRole('status')).toHaveTextContent('no copy of your list yet');
    expect(screen.queryByText(/Your list is empty/)).not.toBeInTheDocument();
  });
});
