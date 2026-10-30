import { describe, it, expect, vi, beforeEach, type Mock } from 'vitest';
import { render, screen, fireEvent, within, waitFor } from '@testing-library/react';
import { RecipePhotos, type RecipeFileRef } from './RecipePhotos';
import { trpc } from '../lib/trpc';

vi.mock('../lib/trpc', () => ({
  trpc: {
    useUtils: vi.fn(),
    recipeFile: {
      upload: { useMutation: vi.fn() },
      remove: { useMutation: vi.fn() },
      setCover: { useMutation: vi.fn() },
    },
  },
}));

// The resize itself is photo-upload.test.ts's; here a photo is simply ready.
vi.mock('../lib/photo-upload', async () => {
  const actual = await vi.importActual<typeof import('../lib/photo-upload')>('../lib/photo-upload');
  return {
    ...actual,
    prepareImage: vi.fn(async () => ({
      full: new Blob(['f']),
      thumb: new Blob(['t']),
      width: 1600,
      height: 1200,
    })),
  };
});

const FILES: RecipeFileRef[] = [
  { id: 'p1', kind: 'photo', width: 1600, height: 1200, position: 0 },
  { id: 'p2', kind: 'photo', width: 1600, height: 1200, position: 1 },
  { id: 's1', kind: 'source_page', width: 1700, height: 2200, position: 0 },
  { id: 'd1', kind: 'source_pdf', width: null, height: null, position: 0 },
];

let upload: Mock;
let remove: Mock;
let setCover: Mock;

beforeEach(() => {
  upload = vi.fn().mockResolvedValue({});
  remove = vi.fn();
  setCover = vi.fn();
  (trpc.recipeFile.upload.useMutation as unknown as Mock).mockReturnValue({ mutateAsync: upload });
  (trpc.recipeFile.remove.useMutation as unknown as Mock).mockReturnValue({ mutate: remove });
  (trpc.recipeFile.setCover.useMutation as unknown as Mock).mockReturnValue({ mutate: setCover });
  (trpc.useUtils as unknown as Mock).mockReturnValue({
    recipe: { get: { invalidate: vi.fn() }, list: { invalidate: vi.fn() } },
    cookLog: { list: { invalidate: vi.fn() } },
  });
});

const renderPhotos = (files = FILES) =>
  render(<RecipePhotos recipeId="r1" recipeTitle="Soup" files={files} coverFileId="p1" />);

describe('RecipePhotos', () => {
  it('shows the photos with the cover marked, and the source pages and PDF apart', () => {
    renderPhotos();
    expect(screen.getByRole('button', { name: 'Photo 1 of Soup, the cover' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Photo 2 of Soup' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Source page 1' })).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Download the original PDF' })).toHaveAttribute(
      'href',
      '/api/files/d1/full',
    );
  });

  it('makes another photo the cover from the viewer', () => {
    renderPhotos();
    fireEvent.click(screen.getByRole('button', { name: 'Photo 2 of Soup' }));
    const viewer = screen.getByRole('dialog', { name: 'Photo' });
    fireEvent.click(within(viewer).getByRole('button', { name: 'Make cover' }));
    expect(setCover).toHaveBeenCalledWith({ recipeId: 'r1', fileId: 'p2' });
  });

  it('deletes only after an in-page confirmation, and Escape closes the viewer', () => {
    renderPhotos();
    fireEvent.click(screen.getByRole('button', { name: 'Photo 1 of Soup, the cover' }));
    const viewer = screen.getByRole('dialog', { name: 'Photo' });
    expect(within(viewer).getByText('Cover photo')).toBeInTheDocument();
    fireEvent.click(within(viewer).getByRole('button', { name: 'Delete' }));
    expect(remove).not.toHaveBeenCalled();
    fireEvent.click(within(viewer).getByRole('button', { name: 'Yes, delete' }));
    expect(remove).toHaveBeenCalledWith({ id: 'p1' });

    fireEvent.click(screen.getByRole('button', { name: 'Photo 2 of Soup' }));
    fireEvent.keyDown(document, { key: 'Escape' });
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it('uploads each chosen photo with its thumbnail', async () => {
    renderPhotos([]);
    expect(screen.getByText(/The first one you add becomes the cover/)).toBeInTheDocument();
    const input = screen.getByLabelText('+ Add photos');
    fireEvent.change(input, {
      target: { files: [new File(['a'], 'a.jpg'), new File(['b'], 'b.jpg')] },
    });
    await waitFor(() => expect(upload).toHaveBeenCalledTimes(2));
    // Let the refresh after the uploads settle inside the test, not after it.
    await waitFor(() => expect(input).toBeEnabled());
    expect(upload.mock.calls[0]![0]).toMatchObject({
      recipeId: 'r1',
      kind: 'photo',
      width: 1600,
      height: 1200,
    });
    expect(upload.mock.calls[0]![0].thumbBase64).toBeTruthy();
  });
});
