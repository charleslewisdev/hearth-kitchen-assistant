import { describe, it, expect, vi, beforeEach, afterEach, type Mock } from 'vitest';
import { render, screen, fireEvent, cleanup, within, act, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { strToU8, zipSync } from 'fflate';
import { MAX_PDF_BYTES, recipeToMarkdown, type MarkdownRecipe } from '@hearth/shared';
import { ZipImport } from './ZipImport';
import { MAX_ZIP_RECIPES } from '../lib/zip-import';
import { trpc } from '../lib/trpc';
import { prepareImage, prepareSourcePage } from '../lib/photo-upload';

// Everything that reaches the server is mocked; the zips themselves are real, read by the real
// streaming reader, so these tests also cover the paths an export writes.
vi.mock('../lib/trpc', () => ({
  trpc: {
    useUtils: vi.fn(),
    recipe: {
      list: { useQuery: vi.fn() },
      create: { useMutation: vi.fn() },
    },
    recipeFile: {
      upload: { useMutation: vi.fn() },
      setCover: { useMutation: vi.fn() },
    },
  },
}));

// Re-encoding needs a canvas, which jsdom has not got: each preparation returns fixed blobs.
vi.mock('../lib/photo-upload', () => ({
  prepareImage: vi.fn(async () => ({
    full: new Blob(['photo-full']),
    thumb: new Blob(['photo-thumb']),
    width: 1600,
    height: 1200,
  })),
  prepareSourcePage: vi.fn(async () => ({
    full: new Blob(['page-full']),
    thumb: new Blob(['page-thumb']),
    width: 2000,
    height: 2800,
  })),
}));

const create = vi.fn();
const upload = vi.fn();
const setCover = vi.fn();
const invalidate = vi.fn();
const refetch = vi.fn();

function libraryHas(titles: string[]) {
  (trpc.recipe.list.useQuery as unknown as Mock).mockReturnValue({
    data: titles.map((title, i) => ({ id: `lib-${i}`, title })),
    isSuccess: true,
    isError: false,
    refetch,
  });
}

/** A stand-in for the Screen Wake Lock API, installed on the jsdom navigator. */
function installWakeLock() {
  const sentinel = {
    released: false,
    release: vi.fn(async () => {
      sentinel.released = true;
    }),
  };
  const request = vi.fn(async () => sentinel);
  Object.defineProperty(navigator, 'wakeLock', {
    value: { request },
    configurable: true,
    writable: true,
  });
  return { request, sentinel };
}

/** Whether a page leave would be asked about now: a listener cancels `beforeunload`. */
function leavingIsQuestioned(): boolean {
  const event = new Event('beforeunload', { cancelable: true });
  window.dispatchEvent(event);
  return event.defaultPrevented;
}

beforeEach(() => {
  vi.clearAllMocks();
  libraryHas([]);
  create.mockImplementation(async (input: { title: string }) => {
    const slug = input.title.toLowerCase().replace(/ /g, '-');
    return { id: `id-${slug}`, slug };
  });
  let n = 0;
  upload.mockImplementation(async () => ({ id: `file-${++n}` }));
  setCover.mockResolvedValue(undefined);
  (trpc.recipe.create.useMutation as unknown as Mock).mockReturnValue({ mutateAsync: create });
  (trpc.recipeFile.upload.useMutation as unknown as Mock).mockReturnValue({ mutateAsync: upload });
  (trpc.recipeFile.setCover.useMutation as unknown as Mock).mockReturnValue({
    mutateAsync: setCover,
  });
  (trpc.useUtils as unknown as Mock).mockReturnValue({ recipe: { list: { invalidate } } });
});

afterEach(() => {
  cleanup();
  delete (navigator as { wakeLock?: unknown }).wakeLock;
});

function recipe(title: string, over: Partial<MarkdownRecipe> = {}): MarkdownRecipe {
  return {
    title,
    servings: 4,
    servingsHigh: null,
    prepMinutes: null,
    cookMinutes: null,
    types: [],
    tags: [],
    rating: null,
    sourceName: null,
    sourceUrl: null,
    description: null,
    ingredientLines: ['1 egg'],
    steps: ['Cook it.'],
    ...over,
  };
}

/** A zip laid out as an export writes one: everything under one top folder. */
function zipOf(entries: Record<string, string | Uint8Array>): File {
  const files: Record<string, Uint8Array> = {};
  for (const [name, data] of Object.entries(entries)) {
    files[`hearth-recipes-2026-11-13/${name}`] = typeof data === 'string' ? strToU8(data) : data;
  }
  const bytes = zipSync(files);
  return new File([bytes as Uint8Array<ArrayBuffer>], 'hearth-recipes.zip', {
    type: 'application/zip',
  });
}

const renderZip = (file: File, onCancel = vi.fn()) =>
  render(
    <MemoryRouter>
      <ZipImport file={file} onCancel={onCancel} />
    </MemoryRouter>,
  );

const withFiles = (photos: string[], cover: string | null = null) => ({
  files: { photos, cover, sourcePages: [], sourcePdf: null },
});

const startImport = async (count: number) =>
  fireEvent.click(
    await screen.findByRole('button', {
      name: `Import ${count} ${count === 1 ? 'recipe' : 'recipes'}`,
    }),
  );

describe('ZipImport', () => {
  it('shows what it will import and what it will skip before saving anything', async () => {
    libraryHas(['Pizza Dough']);
    renderZip(
      zipOf({
        'pizza-dough.md': recipeToMarkdown(recipe('Pizza Dough')),
        'pizza.md': recipeToMarkdown(
          recipe('Pizza', {
            ingredientLines: ['1 [[Pizza Dough]]'],
            files: {
              photos: ['pizza/photo-1.jpg'],
              cover: 'pizza/photo-1.jpg',
              sourcePages: [],
              sourcePdf: null,
            },
          }),
        ),
        'pizza/photo-1.jpg': new Uint8Array([1, 2, 3]),
        'stew.md': recipeToMarkdown(recipe('Stew')),
        'notes.md': 'Just some notes, no front matter.\n',
      }),
    );

    expect(await screen.findByText(/2 recipes, 1 photo or scan/)).toBeInTheDocument();
    const skipped = screen.getByRole('region', { name: /already in your library/i });
    expect(within(skipped).getByText('Pizza Dough')).toBeInTheDocument();
    const notRecipes = screen.getByRole('region', { name: /not hearth recipes/i });
    expect(within(notRecipes).getByText('notes.md')).toBeInTheDocument();
    const importButton = screen.getByRole('button', { name: 'Import 2 recipes' });
    expect(importButton).toBeEnabled();
    // The button comes straight after the count, before any list a phone would scroll past.
    expect(
      importButton.compareDocumentPosition(skipped) & Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
    expect(create).not.toHaveBeenCalled();
    expect(upload).not.toHaveBeenCalled();
  });

  it('saves in link order, then uploads each recipe’s files and sets the cover', async () => {
    const pdf = new Uint8Array([37, 80, 68, 70, 45]);
    renderZip(
      zipOf({
        'pizza.md': recipeToMarkdown(
          recipe('Pizza', {
            rating: 4,
            ingredientLines: ['1 [[Pizza Dough]]', '200 g mozzarella'],
            files: {
              photos: ['pizza/photo-1.jpg'],
              cover: 'pizza/photo-1.jpg',
              sourcePages: [],
              sourcePdf: null,
            },
          }),
        ),
        'pizza/photo-1.jpg': new Uint8Array([1]),
        'pizza-dough.md': recipeToMarkdown(
          recipe('Pizza Dough', {
            rating: 5,
            types: ['side'],
            tags: ['bread'],
            sourceName: 'Grandma',
            files: {
              photos: ['pizza-dough/photo-1.jpg', 'pizza-dough/photo-2.jpg'],
              cover: 'pizza-dough/photo-2.jpg',
              sourcePages: ['pizza-dough/source-1.jpg'],
              sourcePdf: 'pizza-dough/source.pdf',
            },
          }),
        ),
        'pizza-dough/photo-1.jpg': new Uint8Array([2]),
        'pizza-dough/photo-2.jpg': new Uint8Array([3]),
        'pizza-dough/source-1.jpg': new Uint8Array([4]),
        'pizza-dough/source.pdf': pdf,
      }),
    );
    await startImport(2);
    expect(await screen.findByText(/saved 2 recipes/i)).toBeInTheDocument();

    expect(create.mock.calls.map(([input]) => input.title)).toEqual(['Pizza Dough', 'Pizza']);
    expect(create.mock.calls[0]![0]).toMatchObject({
      title: 'Pizza Dough',
      servings: 4,
      mealTypes: ['side'],
      tags: ['bread'],
      sourceName: 'Grandma',
      rating: 5,
    });
    expect(create.mock.calls[1]![0]).toMatchObject({
      ingredientLines: ['1 [[Pizza Dough]]', '200 g mozzarella'],
      rating: 4,
    });

    const kinds = upload.mock.calls.map(([input]) => [input.recipeId, input.kind]);
    expect(kinds).toEqual([
      ['id-pizza-dough', 'photo'],
      ['id-pizza-dough', 'photo'],
      ['id-pizza-dough', 'source_page'],
      ['id-pizza-dough', 'source_pdf'],
      ['id-pizza', 'photo'],
    ]);
    expect(prepareImage).toHaveBeenCalledTimes(3);
    expect(prepareSourcePage).toHaveBeenCalledTimes(1);
    const page = upload.mock.calls[2]![0];
    expect(page).toMatchObject({ width: 2000, height: 2800 });
    expect(atob(page.fullBase64)).toBe('page-full');
    const pdfCall = upload.mock.calls[3]![0];
    expect(pdfCall.thumbBase64).toBeUndefined();
    expect(Uint8Array.from(atob(pdfCall.fullBase64), (c) => c.charCodeAt(0))).toEqual(pdf);

    // Every named cover is set, the first photo too, so a re-zipped archive cannot pick another.
    expect(setCover.mock.calls.map(([input]) => input)).toEqual([
      { recipeId: 'id-pizza-dough', fileId: 'file-2' },
      { recipeId: 'id-pizza', fileId: 'file-5' },
    ]);
    expect(invalidate).toHaveBeenCalled();
    expect(screen.getByRole('link', { name: /library/i })).toHaveAttribute('href', '/');
  });

  it('keeps going after a failure and reports it', async () => {
    create.mockImplementation(async (input: { title: string }) => {
      if (input.title === 'Stew') throw new Error('nope');
      return { id: `id-${input.title}`, slug: input.title };
    });
    upload.mockRejectedValueOnce(new Error('too big'));
    renderZip(
      zipOf({
        'stew.md': recipeToMarkdown(
          recipe('Stew', {
            files: { photos: ['stew/photo-1.jpg'], cover: null, sourcePages: [], sourcePdf: null },
          }),
        ),
        'stew/photo-1.jpg': new Uint8Array([1]),
        'soup.md': recipeToMarkdown(
          recipe('Soup', {
            files: { photos: ['soup/photo-1.jpg'], cover: null, sourcePages: [], sourcePdf: null },
          }),
        ),
        'soup/photo-1.jpg': new Uint8Array([2]),
        'bread.md': recipeToMarkdown(recipe('Bread')),
      }),
    );
    await startImport(3);
    expect(await screen.findByText(/saved 2 recipes/i)).toBeInTheDocument();

    expect(create).toHaveBeenCalledTimes(3);
    const failed = screen.getByRole('region', { name: /recipes not saved/i });
    expect(within(failed).getByText('Stew')).toBeInTheDocument();
    // Stew's photo is never sent, as Stew was not saved; Soup's failed and is named.
    expect(upload).toHaveBeenCalledTimes(1);
    expect(upload.mock.calls[0]![0].recipeId).toBe('id-Soup');
    const files = screen.getByRole('region', { name: /files not added/i });
    expect(within(files).getByText('Soup: photo 1')).toBeInTheDocument();
    expect(within(files).getByText('Add these by hand from the recipe page.')).toBeInTheDocument();
    expect(screen.getByRole('alert')).toHaveTextContent(/saved 2 recipes/i);
  });

  it('writes a link to a recipe that failed as text instead of failing in turn', async () => {
    create.mockImplementation(async (input: { title: string }) => {
      if (input.title === 'Pizza Dough') throw new Error('nope');
      return { id: `id-${input.title}`, slug: input.title };
    });
    renderZip(
      zipOf({
        'pizza.md': recipeToMarkdown(
          recipe('Pizza', { ingredientLines: ['1 [[Pizza Dough]]', '200 g mozzarella'] }),
        ),
        'pizza-dough.md': recipeToMarkdown(recipe('Pizza Dough')),
      }),
    );
    await startImport(2);
    expect(await screen.findByText(/saved 1 recipe\b/i)).toBeInTheDocument();

    expect(create.mock.calls.map(([input]) => input.title)).toEqual(['Pizza Dough', 'Pizza']);
    expect(create.mock.calls[1]![0].ingredientLines).toEqual(['1 Pizza Dough', '200 g mozzarella']);
    const failed = screen.getByRole('region', { name: /recipes not saved/i });
    expect(within(failed).getByText('Pizza Dough')).toBeInTheDocument();
    const unlinked = screen.getByRole('region', { name: /links saved as text/i });
    expect(within(unlinked).getByText('Pizza')).toBeInTheDocument();
  });

  it('uploads in front-matter order: photos, then pages, then the PDF', async () => {
    renderZip(
      zipOf({
        // Stored in the zip in the opposite order to the one the front matter lists.
        'stew/source.pdf': new Uint8Array([37, 80, 68, 70]),
        'stew/source-2.jpg': new Uint8Array([4]),
        'stew/source-1.jpg': new Uint8Array([3]),
        'stew/photo-b.jpg': new Uint8Array([2]),
        'stew/photo-a.jpg': new Uint8Array([1]),
        'stew.md': recipeToMarkdown(
          recipe('Stew', {
            files: {
              photos: ['stew/photo-b.jpg', 'stew/photo-a.jpg'],
              cover: 'stew/photo-b.jpg',
              sourcePages: ['stew/source-1.jpg', 'stew/source-2.jpg'],
              sourcePdf: 'stew/source.pdf',
            },
          }),
        ),
      }),
    );
    await startImport(1);
    expect(await screen.findByText(/saved 1 recipe\b/i)).toBeInTheDocument();
    expect(upload.mock.calls.map(([input]) => input.kind)).toEqual([
      'photo',
      'photo',
      'source_page',
      'source_page',
      'source_pdf',
    ]);
    // photo-b, listed first though stored last, is read and sent first.
    const firstPhoto = (prepareImage as unknown as Mock).mock.calls[0]![0] as Blob;
    // jsdom's Blob has no arrayBuffer(); FileReader reads it.
    const bytes = await new Promise<ArrayBuffer>((resolve) => {
      const reader = new FileReader();
      reader.onload = () => resolve(reader.result as ArrayBuffer);
      reader.readAsArrayBuffer(firstPhoto);
    });
    expect([...new Uint8Array(bytes)]).toEqual([2]);
    expect(setCover).toHaveBeenCalledWith({ recipeId: 'id-stew', fileId: 'file-1' });
  });

  it('reports a cover that could not be set', async () => {
    setCover.mockRejectedValue(new Error('nope'));
    renderZip(
      zipOf({
        'stew.md': recipeToMarkdown(
          recipe('Green Chile Stew', withFiles(['stew/photo-1.jpg'], 'stew/photo-1.jpg')),
        ),
        'stew/photo-1.jpg': new Uint8Array([1]),
      }),
    );
    await startImport(1);
    const files = await screen.findByRole('region', { name: /files not added/i });
    expect(within(files).getByText('Green Chile Stew: cover photo')).toBeInTheDocument();
  });

  it('reports a file too large to add by recipe and name, not by path', async () => {
    renderZip(
      zipOf({
        'stew.md': recipeToMarkdown(
          recipe('Green Chile Stew', {
            files: { photos: [], cover: null, sourcePages: [], sourcePdf: 'stew/source.pdf' },
          }),
        ),
        'stew/source.pdf': new Uint8Array(MAX_PDF_BYTES + 1),
      }),
    );
    await startImport(1);
    const tooLarge = await screen.findByRole('region', { name: /too large/i });
    expect(within(tooLarge).getByText('Green Chile Stew: source PDF')).toBeInTheDocument();
    expect(upload).not.toHaveBeenCalled();
  });

  it('names a missing file once, by recipe and friendly name', async () => {
    renderZip(
      zipOf({
        'stew.md': recipeToMarkdown(
          recipe('Green Chile Stew', withFiles(['stew/photo-1.jpg', 'stew/photo-2.jpg'])),
        ),
        'stew/photo-1.jpg': new Uint8Array([1]),
      }),
    );
    await startImport(1);
    const files = await screen.findByRole('region', { name: /files not added/i });
    expect(
      within(files)
        .getAllByRole('listitem')
        .map((li) => li.textContent),
    ).toEqual(['Green Chile Stew: photo 2']);
  });

  it('collapses a long list behind its count', async () => {
    libraryHas(['A', 'B', 'C', 'D', 'E', 'F']);
    const entries: Record<string, string> = {};
    for (const title of ['A', 'B', 'C', 'D', 'E', 'F', 'G']) {
      entries[`${title}.md`] = recipeToMarkdown(recipe(title));
    }
    renderZip(zipOf(entries));
    const skipped = await screen.findByRole('region', { name: /already in your library/i });
    const details = skipped.querySelector('details');
    expect(details).not.toBeNull();
    expect(details).not.toHaveAttribute('open');
    expect(within(skipped).getByText(/already in your library, so skipped \(6\)/i)).toBeVisible();
  });

  it('says once that there is nothing new, with no Import button', async () => {
    libraryHas(['Stew']);
    renderZip(zipOf({ 'stew.md': recipeToMarkdown(recipe('Stew')) }));
    expect(await screen.findByText('There is nothing new to import.')).toBeInTheDocument();
    expect(screen.queryByText(/0 recipes/)).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /^import/i })).not.toBeInTheDocument();
    expect(create).not.toHaveBeenCalled();
  });

  it('offers to try again when the library cannot be loaded', async () => {
    (trpc.recipe.list.useQuery as unknown as Mock).mockReturnValue({
      data: undefined,
      isSuccess: false,
      isError: true,
      refetch,
    });
    renderZip(zipOf({ 'stew.md': recipeToMarkdown(recipe('Stew')) }));
    fireEvent.click(await screen.findByRole('button', { name: 'Try again' }));
    expect(refetch).toHaveBeenCalled();
    expect(screen.queryByRole('button', { name: /^import/i })).not.toBeInTheDocument();
  });

  it('says plainly when the file is not a zip', async () => {
    const notZip = new File(['just some text'], 'recipes.zip', { type: 'application/zip' });
    renderZip(notZip);
    expect(await screen.findByRole('alert')).toHaveTextContent(
      'That file is not a zip. Choose the zip Hearth exported.',
    );
  });

  it('says plainly when the zip is split or unusual', async () => {
    const bytes = zipSync({ 'a.md': strToU8('x') });
    // The end record's "number of this disk": a split zip's last part is not disk 0.
    bytes[bytes.length - 22 + 4] = 1;
    renderZip(new File([bytes as Uint8Array<ArrayBuffer>], 'split.zip'));
    expect(await screen.findByRole('alert')).toHaveTextContent(/cannot be read here/i);
  });

  it('can be cancelled while the zip is being read', () => {
    const onCancel = vi.fn();
    renderZip(zipOf({ 'stew.md': recipeToMarkdown(recipe('Stew')) }), onCancel);
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(onCancel).toHaveBeenCalled();
  });

  it('keeps the screen on and asks before leaving only while saving', async () => {
    const { request, sentinel } = installWakeLock();
    let finish: (value: { id: string; slug: string }) => void = () => {};
    create.mockImplementation(
      () =>
        new Promise((resolve) => {
          finish = resolve;
        }),
    );
    renderZip(zipOf({ 'stew.md': recipeToMarkdown(recipe('Stew')) }));
    await screen.findByRole('button', { name: 'Import 1 recipe' });
    expect(leavingIsQuestioned()).toBe(false);
    expect(request).not.toHaveBeenCalled();

    await startImport(1);
    await waitFor(() => expect(request).toHaveBeenCalledWith('screen'));
    expect(screen.getByText(/keep the screen on and this page open/i)).toBeInTheDocument();
    expect(leavingIsQuestioned()).toBe(true);

    await act(async () => finish({ id: 'id-stew', slug: 'stew' }));
    expect(await screen.findByText(/saved 1 recipe\b/i)).toBeInTheDocument();
    expect(sentinel.release).toHaveBeenCalled();
    expect(leavingIsQuestioned()).toBe(false);
  });

  it('reports links written back as text', async () => {
    renderZip(
      zipOf({
        'pizza.md': recipeToMarkdown(recipe('Pizza', { ingredientLines: ['1 [[Focaccia]]'] })),
      }),
    );
    await startImport(1);
    expect(await screen.findByText(/saved 1 recipe\b/i)).toBeInTheDocument();
    expect(create.mock.calls[0]![0].ingredientLines).toEqual(['1 Focaccia']);
    const unlinked = screen.getByRole('region', { name: /links saved as text/i });
    expect(within(unlinked).getByText('Pizza')).toBeInTheDocument();
  });

  it('says so when a zip holds more recipes than one import takes', async () => {
    const entries: Record<string, string> = {};
    for (let i = 0; i <= MAX_ZIP_RECIPES; i++) {
      entries[`r-${i}.md`] = `---\ntitle: "R ${i}"\n---\n`;
    }
    renderZip(zipOf(entries));
    expect(await screen.findByRole('alert', {}, { timeout: 10_000 })).toHaveTextContent(
      /at most 2,000 recipes/,
    );
    expect(create).not.toHaveBeenCalled();
  });
});
