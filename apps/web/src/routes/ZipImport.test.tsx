import { describe, it, expect, vi, beforeEach, afterEach, type Mock } from 'vitest';
import { render, screen, fireEvent, cleanup, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { strToU8, zipSync } from 'fflate';
import { recipeToMarkdown, type MarkdownRecipe } from '@hearth/shared';
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

function libraryHas(titles: string[]) {
  (trpc.recipe.list.useQuery as unknown as Mock).mockReturnValue({
    data: titles.map((title, i) => ({ id: `lib-${i}`, title })),
    isSuccess: true,
    isError: false,
  });
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

afterEach(cleanup);

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

const renderZip = (file: File) =>
  render(
    <MemoryRouter>
      <ZipImport file={file} onCancel={vi.fn()} />
    </MemoryRouter>,
  );

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
    expect(screen.getByRole('button', { name: 'Import 2 recipes' })).toBeEnabled();
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
      ['id-pizza', 'photo'],
      ['id-pizza-dough', 'photo'],
      ['id-pizza-dough', 'photo'],
      ['id-pizza-dough', 'source_page'],
      ['id-pizza-dough', 'source_pdf'],
    ]);
    expect(prepareImage).toHaveBeenCalledTimes(3);
    expect(prepareSourcePage).toHaveBeenCalledTimes(1);
    const page = upload.mock.calls[3]![0];
    expect(page).toMatchObject({ width: 2000, height: 2800 });
    expect(atob(page.fullBase64)).toBe('page-full');
    const pdfCall = upload.mock.calls[4]![0];
    expect(pdfCall.thumbBase64).toBeUndefined();
    expect(Uint8Array.from(atob(pdfCall.fullBase64), (c) => c.charCodeAt(0))).toEqual(pdf);

    // Pizza's cover is its first photo already; Pizza Dough's is its second (file-3).
    expect(setCover).toHaveBeenCalledTimes(1);
    expect(setCover).toHaveBeenCalledWith({ recipeId: 'id-pizza-dough', fileId: 'file-3' });
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
    expect(within(files).getByText('soup/photo-1.jpg')).toBeInTheDocument();
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
