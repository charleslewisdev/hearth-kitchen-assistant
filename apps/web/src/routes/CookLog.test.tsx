import { describe, it, expect, vi, beforeEach, type Mock } from 'vitest';
import { render, screen, fireEvent, within, waitFor } from '@testing-library/react';
import { CookLog } from './CookLog';
import { trpc } from '../lib/trpc';
import { localToday } from '../lib/dates';

vi.mock('../lib/trpc', () => ({
  trpc: {
    useUtils: vi.fn(),
    cookLog: {
      list: { useQuery: vi.fn() },
      add: { useMutation: vi.fn() },
      update: { useMutation: vi.fn() },
      remove: { useMutation: vi.fn() },
    },
    recipeFile: { upload: { useMutation: vi.fn() } },
  },
}));

const ENTRIES = [
  {
    id: 'e2',
    cookedOn: '2026-09-20',
    loggedBy: 'Charles',
    servings: 4,
    rating: 5,
    notes: 'More gremolata.',
    photoIds: ['p9'],
  },
  {
    id: 'e1',
    cookedOn: '2026-08-01',
    loggedBy: null,
    servings: null,
    rating: null,
    notes: null,
    photoIds: [],
  },
];

let add: Mock;
let update: Mock;
let remove: Mock;
beforeEach(() => {
  add = vi.fn().mockResolvedValue({ id: 'e3' });
  update = vi.fn().mockResolvedValue(true);
  remove = vi.fn();
  (trpc.cookLog.list.useQuery as unknown as Mock).mockReturnValue({ data: ENTRIES });
  (trpc.cookLog.add.useMutation as unknown as Mock).mockReturnValue({
    mutateAsync: add,
    isPending: false,
  });
  (trpc.cookLog.update.useMutation as unknown as Mock).mockReturnValue({
    mutateAsync: update,
    isPending: false,
  });
  (trpc.cookLog.remove.useMutation as unknown as Mock).mockReturnValue({ mutate: remove });
  (trpc.recipeFile.upload.useMutation as unknown as Mock).mockReturnValue({ mutateAsync: vi.fn() });
  (trpc.useUtils as unknown as Mock).mockReturnValue({
    cookLog: { list: { invalidate: vi.fn() } },
    recipe: { list: { invalidate: vi.fn() }, get: { invalidate: vi.fn() } },
  });
});

describe('CookLog', () => {
  it('shows how often and the history, newest first, with who logged it', () => {
    render(<CookLog recipeId="r1" servings={6} />);
    expect(screen.getByText(/^2 times · last/)).toBeInTheDocument();
    const items = screen.getAllByRole('listitem').filter((li) => li.querySelector('time, span'));
    expect(items[0]).toHaveTextContent('Logged by Charles · served 4');
    expect(items[0]).toHaveTextContent('More gremolata.');
    expect(within(items[0]!).getByRole('img', { name: '5 out of 5 stars' })).toBeInTheDocument();
  });

  it('logs a cook for today at the scaled servings by default, with a rating and notes', async () => {
    render(<CookLog recipeId="r1" servings={6} />);
    fireEvent.click(screen.getByRole('button', { name: 'Log a cook' }));
    expect(screen.getByLabelText('Cooked on')).toHaveValue(localToday());
    expect(screen.getByLabelText('Servings')).toHaveValue(6);
    fireEvent.click(screen.getByRole('button', { name: '4 stars' }));
    fireEvent.change(screen.getByLabelText('Notes'), { target: { value: ' Less salt ' } });
    fireEvent.click(screen.getByRole('button', { name: 'Log it' }));
    await waitFor(() =>
      expect(add).toHaveBeenCalledWith({
        recipeId: 'r1',
        cookedOn: localToday(),
        servings: 6,
        rating: 4,
        notes: 'Less salt',
      }),
    );
    await waitFor(() => expect(screen.queryByRole('button', { name: 'Log it' })).toBeNull());
  });

  it('edits an entry in place and deletes one after confirming', async () => {
    render(<CookLog recipeId="r1" servings={6} />);
    fireEvent.click(screen.getAllByRole('button', { name: 'Edit' })[0]!);
    expect(screen.getByLabelText('Notes')).toHaveValue('More gremolata.');
    fireEvent.click(screen.getByRole('button', { name: 'Save changes' }));
    await waitFor(() =>
      expect(update).toHaveBeenCalledWith(expect.objectContaining({ id: 'e2', rating: 5 })),
    );

    fireEvent.click(screen.getAllByRole('button', { name: 'Delete' })[1]!);
    expect(remove).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: 'Yes, delete' }));
    expect(remove).toHaveBeenCalledWith({ id: 'e1' });
  });
});
