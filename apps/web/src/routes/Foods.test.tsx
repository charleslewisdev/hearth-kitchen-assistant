import { describe, it, expect, vi, beforeEach, afterEach, type Mock } from 'vitest';
import { render, screen, fireEvent, cleanup, within, waitFor } from '@testing-library/react';
import { FOOD_NAME_TAKEN_MESSAGE } from '@hearth/server/src/messages';
import { Foods } from './Foods';
import { trpc } from '../lib/trpc';

vi.mock('../lib/trpc', () => ({
  trpc: {
    useUtils: vi.fn(),
    food: {
      all: { useQuery: vi.fn() },
      setDepartment: { useMutation: vi.fn() },
      rename: { useMutation: vi.fn() },
      merge: { useMutation: vi.fn() },
      remove: { useMutation: vi.fn() },
      removeUnused: { useMutation: vi.fn() },
    },
  },
}));

const FOODS = [
  { id: 'f1', name: 'green onions', normalizedName: 'green onion', department: 'Produce', uses: 3 },
  { id: 'f2', name: 'scallions', normalizedName: 'scallion', department: null, uses: 2 },
  { id: 'f3', name: 'old thing', normalizedName: 'old thing', department: null, uses: 0 },
];

let setDepartment: Mock;
let rename: Mock;
let merge: Mock;
let remove: Mock;
let removeUnused: Mock;

beforeEach(() => {
  (trpc.food.all.useQuery as unknown as Mock).mockReturnValue({
    data: FOODS,
    isLoading: false,
    isError: false,
  });
  setDepartment = vi.fn();
  rename = vi.fn().mockResolvedValue(undefined);
  merge = vi.fn().mockResolvedValue(undefined);
  remove = vi.fn().mockResolvedValue(true);
  (trpc.food.setDepartment.useMutation as unknown as Mock).mockReturnValue({
    mutate: setDepartment,
  });
  (trpc.food.rename.useMutation as unknown as Mock).mockReturnValue({
    mutateAsync: rename,
    isPending: false,
  });
  (trpc.food.merge.useMutation as unknown as Mock).mockReturnValue({
    mutateAsync: merge,
    isPending: false,
  });
  (trpc.food.remove.useMutation as unknown as Mock).mockReturnValue({
    mutateAsync: remove,
    isPending: false,
  });
  removeUnused = vi.fn();
  (trpc.food.removeUnused.useMutation as unknown as Mock).mockReturnValue({
    mutate: removeUnused,
    isPending: false,
  });
  (trpc.useUtils as unknown as Mock).mockReturnValue({
    food: { all: { invalidate: vi.fn() } },
    shoppingList: { get: { invalidate: vi.fn() } },
  });
});
afterEach(cleanup);

function rowOf(name: string) {
  // The name label, not the same words as an option in an open editor's merge list.
  const label = screen.getAllByText(name).find((el) => el.tagName === 'SPAN');
  return label!.closest('li')!;
}

describe('Foods', () => {
  it('lists every food with its uses and says how many have no department', () => {
    render(<Foods />);
    expect(within(rowOf('green onions')).getByText('3 recipe lines')).toBeInTheDocument();
    expect(within(rowOf('old thing')).getByText('unused')).toBeInTheDocument();
    expect(screen.getByText(/2 foods have no department/)).toBeInTheDocument();
  });

  it('files a food under a department, or back under Other', () => {
    render(<Foods />);
    fireEvent.change(screen.getByLabelText('Department for scallions'), {
      target: { value: 'Produce' },
    });
    expect(setDepartment).toHaveBeenCalledWith({ id: 'f2', department: 'Produce' });
    fireEvent.change(screen.getByLabelText('Department for green onions'), {
      target: { value: '' },
    });
    expect(setDepartment).toHaveBeenCalledWith({ id: 'f1', department: null });
  });

  it('filters by name', () => {
    render(<Foods />);
    fireEvent.change(screen.getByLabelText('Find a food'), { target: { value: 'scal' } });
    expect(screen.queryByText('green onions')).not.toBeInTheDocument();
    expect(screen.getByText('scallions')).toBeInTheDocument();
  });

  it('merges one food into another', async () => {
    render(<Foods />);
    fireEvent.click(within(rowOf('scallions')).getByRole('button', { name: 'Edit' }));
    fireEvent.change(screen.getByLabelText('Merge into'), { target: { value: 'f1' } });
    fireEvent.click(screen.getByRole('button', { name: 'Merge' }));
    await waitFor(() => expect(merge).toHaveBeenCalledWith({ fromId: 'f2', intoId: 'f1' }));
  });

  it('turns a rename onto a taken name into an offer to merge', async () => {
    rename.mockRejectedValue({ message: FOOD_NAME_TAKEN_MESSAGE });
    render(<Foods />);
    fireEvent.click(within(rowOf('scallions')).getByRole('button', { name: 'Edit' }));
    fireEvent.change(screen.getByLabelText('Name'), { target: { value: 'Green Onions' } });
    fireEvent.click(screen.getByRole('button', { name: 'Rename' }));
    expect(await screen.findByRole('status')).toHaveTextContent(FOOD_NAME_TAKEN_MESSAGE);
    expect(screen.getByLabelText('Merge into')).toHaveValue('f1');
  });

  it('offers delete only for a food nothing uses', async () => {
    render(<Foods />);
    fireEvent.click(within(rowOf('scallions')).getByRole('button', { name: 'Edit' }));
    expect(screen.queryByRole('button', { name: /Delete/ })).not.toBeInTheDocument();
    fireEvent.click(within(rowOf('old thing')).getByRole('button', { name: 'Edit' }));
    fireEvent.click(screen.getByRole('button', { name: 'Delete this unused food' }));
    await waitFor(() => expect(remove).toHaveBeenCalledWith({ id: 'f3' }));
  });

  it('clears out every unused food in one go', () => {
    render(<Foods />);
    fireEvent.click(screen.getByRole('button', { name: 'Remove 1 unused food' }));
    expect(removeUnused).toHaveBeenCalled();
  });
});
