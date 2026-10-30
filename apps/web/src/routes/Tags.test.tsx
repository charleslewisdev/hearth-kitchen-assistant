import { describe, it, expect, vi, beforeEach, type Mock } from 'vitest';
import { render, screen, fireEvent, within, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { TAG_NAME_TAKEN_MESSAGE } from '@hearth/server/src/messages';
import { Tags } from './Tags';
import { trpc } from '../lib/trpc';

vi.mock('../lib/trpc', () => ({
  trpc: {
    useUtils: vi.fn(),
    tag: {
      all: { useQuery: vi.fn() },
      rename: { useMutation: vi.fn() },
      setColor: { useMutation: vi.fn() },
      merge: { useMutation: vi.fn() },
      remove: { useMutation: vi.fn() },
      removeUnused: { useMutation: vi.fn() },
    },
  },
}));

const TAGS = [
  { id: 't1', name: 'chicken saag', normalizedName: 'chicken saag', color: null, uses: 1 },
  { id: 't2', name: 'homemade', normalizedName: 'homemade', color: null, uses: 0 },
  { id: 't3', name: 'Indian', normalizedName: 'indian', color: 'amber', uses: 2 },
];

let rename: Mock;
let setColor: Mock;
let merge: Mock;
let remove: Mock;
let removeUnused: Mock;

beforeEach(() => {
  (trpc.tag.all.useQuery as unknown as Mock).mockReturnValue({
    data: TAGS,
    isLoading: false,
    isError: false,
  });
  rename = vi.fn().mockResolvedValue(undefined);
  setColor = vi.fn();
  merge = vi.fn().mockResolvedValue(undefined);
  remove = vi.fn().mockResolvedValue(true);
  removeUnused = vi.fn();
  const pending = { isPending: false };
  (trpc.tag.rename.useMutation as unknown as Mock).mockReturnValue({
    mutateAsync: rename,
    ...pending,
  });
  (trpc.tag.setColor.useMutation as unknown as Mock).mockReturnValue({
    mutate: setColor,
    ...pending,
  });
  (trpc.tag.merge.useMutation as unknown as Mock).mockReturnValue({
    mutateAsync: merge,
    ...pending,
  });
  (trpc.tag.remove.useMutation as unknown as Mock).mockReturnValue({
    mutateAsync: remove,
    ...pending,
  });
  (trpc.tag.removeUnused.useMutation as unknown as Mock).mockReturnValue({
    mutate: removeUnused,
    ...pending,
  });
  (trpc.useUtils as unknown as Mock).mockReturnValue({
    tag: { all: { invalidate: vi.fn() } },
    recipe: { invalidate: vi.fn() },
  });
});

function renderTags() {
  return render(
    <MemoryRouter>
      <Tags />
    </MemoryRouter>,
  );
}

function rowOf(name: string) {
  return screen.getByText(name, { selector: 'span' }).closest('li')!;
}

describe('Tags', () => {
  it('lists each tag with a link to its recipes, and offers to remove the unused', () => {
    renderTags();
    expect(within(rowOf('Indian')).getByRole('link', { name: '2 recipes' })).toHaveAttribute(
      'href',
      '/recipes?tag=Indian',
    );
    expect(within(rowOf('homemade')).getByText('unused')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Remove 1 unused tag' }));
    expect(removeUnused).toHaveBeenCalled();
  });

  it('offers the merge when a rename clashes, with the clashing tag chosen', async () => {
    rename.mockRejectedValue({ message: TAG_NAME_TAKEN_MESSAGE });
    renderTags();
    fireEvent.click(screen.getByRole('button', { name: 'Edit chicken saag' }));
    fireEvent.change(screen.getByLabelText('Name'), { target: { value: 'indian' } });
    fireEvent.click(screen.getByRole('button', { name: 'Rename' }));
    expect(await screen.findByText(TAG_NAME_TAKEN_MESSAGE)).toBeInTheDocument();
    expect(screen.getByLabelText('Merge into')).toHaveValue('t3');
    fireEvent.click(screen.getByRole('button', { name: 'Merge' }));
    await waitFor(() => expect(merge).toHaveBeenCalledWith({ fromId: 't1', intoId: 't3' }));
  });

  it('sets a colour, and Auto goes back to the default', () => {
    renderTags();
    fireEvent.click(screen.getByRole('button', { name: 'Edit Indian' }));
    expect(screen.getByRole('button', { name: 'amber' })).toHaveAttribute('aria-pressed', 'true');
    fireEvent.click(screen.getByRole('button', { name: 'plum' }));
    expect(setColor).toHaveBeenCalledWith({ id: 't3', color: 'plum' });
    fireEvent.click(screen.getByRole('button', { name: 'Auto' }));
    expect(setColor).toHaveBeenCalledWith({ id: 't3', color: null });
  });

  it('deletes only after an in-page confirmation that says what it touches', async () => {
    renderTags();
    fireEvent.click(screen.getByRole('button', { name: 'Edit Indian' }));
    fireEvent.click(screen.getByRole('button', { name: 'Delete tag' }));
    expect(remove).not.toHaveBeenCalled();
    const confirm = screen.getByRole('group', { name: 'Confirm delete' });
    expect(confirm).toHaveTextContent('It comes off 2 recipes; the recipes stay.');
    fireEvent.click(within(confirm).getByRole('button', { name: 'Yes, delete' }));
    await waitFor(() => expect(remove).toHaveBeenCalledWith({ id: 't3' }));
  });
});
