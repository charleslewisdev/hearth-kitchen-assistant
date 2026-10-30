import { describe, it, expect, vi, beforeEach, afterEach, type Mock } from 'vitest';
import { render, screen, fireEvent, cleanup, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { MAX_IMAGE_BYTES } from '@hearth/shared';
import { Import, defaultPageOrder } from './Import';
import { trpc } from '../lib/trpc';

// The screen touches all four import procedures and, once a draft exists, recipe.create through
// <ImportReview />. All are mocked: a web test must never reach a server.
vi.mock('../lib/trpc', () => ({
  trpc: {
    recipeFile: {
      upload: { useMutation: vi.fn(() => ({ mutateAsync: vi.fn(), isPending: false })) },
      remove: { useMutation: vi.fn(() => ({ mutate: vi.fn() })) },
      setCover: { useMutation: vi.fn(() => ({ mutate: vi.fn() })) },
    },
    import: {
      fromUrl: { useMutation: vi.fn() },
      fromText: { useMutation: vi.fn() },
      fromPdf: { useMutation: vi.fn() },
      fromImage: { useMutation: vi.fn() },
    },
    recipe: {
      sourceNames: {
        useQuery: vi.fn(() => ({ data: [{ name: 'The Newlywed Cookbook', count: 9 }] })),
      },
      create: { useMutation: vi.fn() },
    },
    tag: { all: { useQuery: vi.fn(() => ({ data: [] })) } },
  },
}));

const navigate = vi.fn();
vi.mock('react-router-dom', async () => {
  const actual = await vi.importActual<typeof import('react-router-dom')>('react-router-dom');
  return { ...actual, useNavigate: () => navigate };
});

const useCreate = trpc.recipe.create.useMutation as unknown as Mock;

/** Every import procedure's mocked mutation, so a test can watch or steer any of them. */
type Source = 'fromUrl' | 'fromText' | 'fromPdf' | 'fromImage';
const SOURCES: Source[] = ['fromUrl', 'fromText', 'fromPdf', 'fromImage'];

const mutate: Record<Source, Mock> = {} as Record<Source, Mock>;
const reset: Record<Source, Mock> = {} as Record<Source, Mock>;

/** Point one procedure's `useMutation` at a given state; the rest stay idle. */
function mockSource(source: Source, over: Record<string, unknown> = {}) {
  (trpc.import[source].useMutation as unknown as Mock).mockReturnValue({
    mutate: mutate[source],
    reset: reset[source],
    data: undefined,
    isPending: false,
    isError: false,
    error: null,
    ...over,
  });
}

beforeEach(() => {
  navigate.mockClear();
  for (const source of SOURCES) {
    mutate[source] = vi.fn();
    reset[source] = vi.fn();
    mockSource(source);
  }
  useCreate.mockReturnValue({
    mutateAsync: vi.fn().mockResolvedValue({ id: 'r1', slug: 'x' }),
    isPending: false,
    isError: false,
    error: null,
  });
});

afterEach(cleanup);

const renderImport = () =>
  render(
    <MemoryRouter>
      <Import />
    </MemoryRouter>,
  );

/** A File of a given size, without allocating a real photograph. */
const fileOf = (name: string, type: string, bytes: number) =>
  new File([new Uint8Array(bytes)], name, { type });

describe('the source tiles', () => {
  it('offers every source, and none of them says "not yet" any more', () => {
    renderImport();
    expect(screen.getByRole('button', { name: /paste link/i })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /^text/i })).toBeInTheDocument();
    expect(screen.getByLabelText(/photo/i)).toBeInTheDocument();
    expect(screen.getByLabelText(/pdf/i)).toBeInTheDocument();
    expect(screen.getByRole('link', { name: /by hand/i })).toHaveAttribute('href', '/recipes/new');

    expect(screen.queryByText(/not yet/i)).not.toBeInTheDocument();
  });

  it('states the offline promise, which is a competitive position and not decoration', () => {
    renderImport();
    expect(screen.getByText(/works offline\. no api key/i)).toBeInTheDocument();
  });

  it('offers the two file tiles as file inputs a keyboard can reach', () => {
    // A label wrapping the input rather than a button clicking a hidden one: the input keeps its
    // place in the tab order and takes the tile's words as its accessible name.
    renderImport();
    for (const [label, accept] of [
      [/photo/i, 'image/*'],
      [/pdf/i, 'application/pdf,.pdf'],
    ] as const) {
      const input = screen.getByLabelText(label);
      expect(input).toHaveAttribute('type', 'file');
      expect(input).toHaveAttribute('accept', accept);
      expect(input).not.toBeDisabled();
    }
  });

  it('opens one inline field at a time', () => {
    renderImport();
    expect(screen.queryByLabelText(/recipe link/i)).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: /paste link/i }));
    expect(screen.getByLabelText(/recipe link/i)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /paste link/i })).toHaveAttribute(
      'aria-expanded',
      'true',
    );

    fireEvent.click(screen.getByRole('button', { name: /^text/i }));
    expect(screen.queryByLabelText(/recipe link/i)).not.toBeInTheDocument();
    expect(screen.getByLabelText(/recipe text/i)).toBeInTheDocument();
  });
});

describe('importing a link', () => {
  function openAndType(url: string) {
    renderImport();
    fireEvent.click(screen.getByRole('button', { name: /paste link/i }));
    fireEvent.change(screen.getByLabelText(/recipe link/i), { target: { value: url } });
  }

  it('sends the URL, trimmed, exactly once', () => {
    openAndType('  https://example.com/soup  ');
    fireEvent.click(screen.getByRole('button', { name: /^import$/i }));
    expect(mutate.fromUrl).toHaveBeenCalledTimes(1);
    expect(mutate.fromUrl).toHaveBeenCalledWith({ url: 'https://example.com/soup' });
  });

  it('will not submit an empty box', () => {
    renderImport();
    fireEvent.click(screen.getByRole('button', { name: /paste link/i }));
    expect(screen.getByRole('button', { name: /^import$/i })).toBeDisabled();
    expect(mutate.fromUrl).not.toHaveBeenCalled();
  });

  it('shows the server sentence for a blocked URL, not a stack trace', () => {
    const message =
      'That link points into this server’s own network rather than out to the web, so Hearth will not open it.';
    mockSource('fromUrl', { isError: true, error: { message } });
    renderImport();
    fireEvent.click(screen.getByRole('button', { name: /paste link/i }));

    const alert = screen.getByRole('alert');
    expect(alert).toHaveTextContent(message);
    expect(alert.textContent).not.toMatch(/at .*\.ts:|Error:|stack/i);
  });

  it('says it is working while the fetch is in flight', () => {
    mockSource('fromUrl', { isPending: true });
    renderImport();
    fireEvent.click(screen.getByRole('button', { name: /paste link/i }));
    expect(screen.getByRole('button', { name: /reading/i })).toBeDisabled();
  });
});

describe('importing pasted text', () => {
  function openAndType(text: string) {
    renderImport();
    fireEvent.click(screen.getByRole('button', { name: /^text/i }));
    fireEvent.change(screen.getByLabelText(/recipe text/i), { target: { value: text } });
  }

  it('sends the text, trimmed, exactly once', () => {
    openAndType('\n Soup \n2 cups stock\n');
    fireEvent.click(screen.getByRole('button', { name: /^import$/i }));
    expect(mutate.fromText).toHaveBeenCalledTimes(1);
    expect(mutate.fromText).toHaveBeenCalledWith({ text: 'Soup \n2 cups stock' });
  });

  it('will not submit an empty box', () => {
    renderImport();
    fireEvent.click(screen.getByRole('button', { name: /^text/i }));
    expect(screen.getByRole('button', { name: /^import$/i })).toBeDisabled();
  });

  it('shows the server sentence when the paste had no recipe in it', () => {
    const message = 'No recipe was found in that text.';
    mockSource('fromText', { isError: true, error: { message } });
    renderImport();
    expect(screen.getByRole('alert')).toHaveTextContent(message);
  });
});

describe('importing a file', () => {
  it('sends a chosen PDF as base64', async () => {
    renderImport();
    fireEvent.change(screen.getByLabelText(/pdf/i), {
      target: { files: [new File([new Uint8Array([37, 80, 68, 70])], 'r.pdf', {})] },
    });

    await waitFor(() => expect(mutate.fromPdf).toHaveBeenCalledTimes(1));
    // "%PDF" as base64. The screen sends bytes, not a data URL: the media type the browser
    // guessed is not something the server has any use for.
    expect(mutate.fromPdf).toHaveBeenCalledWith({ fileBase64: 'JVBERg==' });
  });

  it('sends a chosen photo, through the downscaler', async () => {
    // jsdom has no `createImageBitmap`, so the downscaler falls through to the original bytes -
    // which is the fallback path it is built to have, and the one this asserts reaches the
    // server intact. The resize arithmetic is covered in image-upload.test.ts.
    renderImport();
    fireEvent.change(screen.getByLabelText(/photo/i), {
      target: { files: [new File([new Uint8Array([255, 216, 255])], 'page.jpg', {})] },
    });

    await waitFor(() => expect(mutate.fromImage).toHaveBeenCalledTimes(1));
    expect(mutate.fromImage).toHaveBeenCalledWith({ pagesBase64: ['/9j/'] });
  });

  it('refuses more photos than one recipe spans, without uploading any', async () => {
    renderImport();
    const five = Array.from({ length: 5 }, (_, i) => new File([new Uint8Array([i])], `p${i}.jpg`));
    fireEvent.change(screen.getByLabelText(/photo/i), { target: { files: five } });
    expect(await screen.findByRole('alert')).toHaveTextContent('Choose up to 4 photos');
    expect(mutate.fromImage).not.toHaveBeenCalled();
  });

  it('refuses an oversized photo itself, without uploading it first', async () => {
    renderImport();
    fireEvent.change(screen.getByLabelText(/photo/i), {
      target: { files: [fileOf('huge.jpg', 'image/jpeg', MAX_IMAGE_BYTES + 1)] },
    });

    expect(await screen.findByRole('alert')).toHaveTextContent(/too large/i);
    expect(mutate.fromImage).not.toHaveBeenCalled();
  });

  it('does nothing at all when the picker is dismissed', async () => {
    renderImport();
    fireEvent.change(screen.getByLabelText(/pdf/i), { target: { files: [] } });
    await waitFor(() => expect(mutate.fromPdf).not.toHaveBeenCalled());
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  });

  it('shows the server sentence when a PDF has nothing in it to read', () => {
    const message =
      'That PDF has no text in it and no scanned page Hearth can read. Photograph the page and use Photo instead.';
    mockSource('fromPdf', { isError: true, error: { message } });
    renderImport();
    expect(screen.getByRole('alert')).toHaveTextContent(message);
  });

  it('disables the file tiles while something is already in flight', () => {
    mockSource('fromImage', { isPending: true });
    renderImport();
    expect(screen.getByLabelText(/photo/i)).toBeDisabled();
    expect(screen.getByLabelText(/pdf/i)).toBeDisabled();
  });
});

/** A one-byte photo, so the base64 the server receives names the page: 1 -> 'AQ==', 2 -> 'Ag=='. */
const page = (name: string, byte: number, lastModified = 0) =>
  new File([new Uint8Array([byte])], name, { type: 'image/jpeg', lastModified });
const B64: Record<number, string> = { 1: 'AQ==', 2: 'Ag==', 3: 'Aw==', 4: 'BA==' };

/** The file names in the Pages step, top to bottom. */
const listedNames = () =>
  screen.getAllByRole('listitem', { name: /^page \d/i }).map((item) => item.dataset.name);

describe('defaultPageOrder', () => {
  it('sorts by name the way a person counts, so IMG_2 comes before IMG_10', () => {
    const files = [page('IMG_10.jpg', 3), page('IMG_2.jpg', 2), page('IMG_1.jpg', 1)];
    expect(defaultPageOrder(files).map((f) => f.name)).toEqual([
      'IMG_1.jpg',
      'IMG_2.jpg',
      'IMG_10.jpg',
    ]);
  });

  it('ignores when a photo was modified, which copies and shares rewrite', () => {
    const files = [page('b.jpg', 2, 1000), page('a.jpg', 1, 9000)];
    expect(defaultPageOrder(files).map((f) => f.name)).toEqual(['a.jpg', 'b.jpg']);
  });

  it('keeps the picker order when names repeat, as every iPhone photo is image.jpg', () => {
    const files = [page('image.jpg', 3, 1), page('image.jpg', 1, 2), page('other.jpg', 2, 3)];
    expect(defaultPageOrder(files)).toEqual(files);
  });

  it('does not change the array it was given', () => {
    const files = [page('b.jpg', 2), page('a.jpg', 1)];
    defaultPageOrder(files);
    expect(files.map((f) => f.name)).toEqual(['b.jpg', 'a.jpg']);
  });
});

describe('putting several photos in page order', () => {
  // jsdom has no object URLs; the thumbnails need one each and must hand them back.
  let created: string[];
  let revoked: string[];
  const { createObjectURL, revokeObjectURL } = URL;
  afterEach(() => {
    cleanup(); // unmount first: the thumbnails revoke their URLs as they go
    URL.createObjectURL = createObjectURL;
    URL.revokeObjectURL = revokeObjectURL;
  });
  beforeEach(() => {
    created = [];
    revoked = [];
    let n = 0;
    URL.createObjectURL = vi.fn(() => {
      const url = `blob:thumb-${++n}`;
      created.push(url);
      return url;
    });
    URL.revokeObjectURL = vi.fn((url: string) => {
      revoked.push(url);
    });
  });

  function choose(files: File[]) {
    const view = renderImport();
    fireEvent.change(screen.getByLabelText(/photo/i), { target: { files } });
    return view;
  }

  it('shows a Pages step instead of importing, in natural name order', async () => {
    choose([page('IMG_10.jpg', 3), page('IMG_2.jpg', 2), page('IMG_1.jpg', 1)]);

    expect(await screen.findByRole('heading', { name: /pages/i })).toBeInTheDocument();
    expect(listedNames()).toEqual(['IMG_1.jpg', 'IMG_2.jpg', 'IMG_10.jpg']);
    expect(screen.getByText('IMG_10.jpg')).toBeInTheDocument();
    // A thumbnail per page, so the cook can see which page is which. Decorative to a screen
    // reader (alt=""), which hears the file name instead.
    await waitFor(() => expect(document.querySelectorAll('img[src^="blob:"]')).toHaveLength(3));
    expect(mutate.fromImage).not.toHaveBeenCalled();
    // The tiles step aside while the cook orders the pages.
    expect(screen.queryByRole('button', { name: /paste link/i })).not.toBeInTheDocument();
  });

  it('sends the pages in the order shown when Read is pressed', async () => {
    choose([page('IMG_2.jpg', 2), page('IMG_1.jpg', 1)]);
    fireEvent.click(await screen.findByRole('button', { name: /read 2 pages/i }));

    await waitFor(() => expect(mutate.fromImage).toHaveBeenCalledTimes(1));
    expect(mutate.fromImage).toHaveBeenCalledWith({ pagesBase64: [B64[1], B64[2]] });
  });

  it('moves a page up or down, and sends the order the cook set', async () => {
    choose([page('a.jpg', 1), page('b.jpg', 2), page('c.jpg', 3)]);

    fireEvent.click(await screen.findByRole('button', { name: 'Move page 3 up' }));
    expect(listedNames()).toEqual(['a.jpg', 'c.jpg', 'b.jpg']);
    fireEvent.click(screen.getByRole('button', { name: 'Move page 1 down' }));
    expect(listedNames()).toEqual(['c.jpg', 'a.jpg', 'b.jpg']);

    fireEvent.click(screen.getByRole('button', { name: /read 3 pages/i }));
    await waitFor(() => expect(mutate.fromImage).toHaveBeenCalledTimes(1));
    expect(mutate.fromImage).toHaveBeenCalledWith({ pagesBase64: [B64[3], B64[1], B64[2]] });
  });

  it('will not move the first page up or the last page down', async () => {
    choose([page('a.jpg', 1), page('b.jpg', 2)]);
    expect(await screen.findByRole('button', { name: 'Move page 1 up' })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Move page 2 down' })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Move page 1 down' })).toBeEnabled();
  });

  it('drops a removed page, and does not send it', async () => {
    choose([page('a.jpg', 1), page('b.jpg', 2), page('c.jpg', 3)]);

    fireEvent.click(await screen.findByRole('button', { name: 'Remove page 2' }));
    expect(listedNames()).toEqual(['a.jpg', 'c.jpg']);
    fireEvent.click(screen.getByRole('button', { name: /read 2 pages/i }));

    await waitFor(() => expect(mutate.fromImage).toHaveBeenCalledTimes(1));
    expect(mutate.fromImage).toHaveBeenCalledWith({ pagesBase64: [B64[1], B64[3]] });
  });

  it('says "Read 1 page" once only one is left', async () => {
    choose([page('a.jpg', 1), page('b.jpg', 2)]);
    fireEvent.click(await screen.findByRole('button', { name: 'Remove page 1' }));
    expect(screen.getByRole('button', { name: /^read 1 page$/i })).toBeInTheDocument();
  });

  it('goes back to the tiles on Cancel, sends nothing, and lets go of the thumbnails', async () => {
    choose([page('a.jpg', 1), page('b.jpg', 2)]);
    fireEvent.click(await screen.findByRole('button', { name: /cancel/i }));

    expect(screen.queryByRole('heading', { name: /pages/i })).not.toBeInTheDocument();
    expect(screen.getByLabelText(/photo/i)).toBeInTheDocument();
    expect(mutate.fromImage).not.toHaveBeenCalled();
    expect(created).toHaveLength(2);
    expect([...revoked].sort()).toEqual([...created].sort());
  });

  it('lets go of the thumbnails when the screen goes away', async () => {
    const view = choose([page('a.jpg', 1), page('b.jpg', 2)]);
    await screen.findByRole('heading', { name: /pages/i });
    view.unmount();
    expect([...revoked].sort()).toEqual([...created].sort());
  });

  it('keeps the picker order when the names repeat', async () => {
    choose([page('image.jpg', 2), page('image.jpg', 1)]);
    fireEvent.click(await screen.findByRole('button', { name: /read 2 pages/i }));

    await waitFor(() => expect(mutate.fromImage).toHaveBeenCalledTimes(1));
    expect(mutate.fromImage).toHaveBeenCalledWith({ pagesBase64: [B64[2], B64[1]] });
  });

  it('still refuses a page that is too large when Read is pressed, without uploading', async () => {
    choose([page('a.jpg', 1), fileOf('huge.jpg', 'image/jpeg', MAX_IMAGE_BYTES + 1)]);
    fireEvent.click(await screen.findByRole('button', { name: /read 2 pages/i }));

    expect(await screen.findByRole('alert')).toHaveTextContent(/too large/i);
    expect(mutate.fromImage).not.toHaveBeenCalled();
    // The pages stay, so the cook can drop the big one and try again.
    expect(listedNames()).toEqual(['a.jpg', 'huge.jpg']);
  });

  it('still refuses more than 4 photos straight away, without a Pages step', async () => {
    const five = Array.from({ length: 5 }, (_, i) => page(`p${i}.jpg`, i));
    choose(five);
    expect(await screen.findByRole('alert')).toHaveTextContent('Choose up to 4 photos');
    expect(screen.queryByRole('heading', { name: /pages/i })).not.toBeInTheDocument();
    expect(mutate.fromImage).not.toHaveBeenCalled();
  });
});

describe('once a draft comes back', () => {
  const draft = {
    title: { value: 'Best Banana Bread', confidence: 'high', raw: 'Best Banana Bread' },
    servings: { value: 10, confidence: 'high', raw: '1 loaf, 10 serving(s)' },
    mealTypes: { value: [], confidence: 'low', raw: 'Quick Breads' },
    tags: { value: ['Breads'], confidence: 'low', raw: 'Breads,Fruit' },
    ingredientLines: { value: ['1/2 cup butter, softened'], confidence: 'high', raw: null },
    steps: { value: ['Cream the butter.'], confidence: 'high', raw: null },
    details: { description: null, prepMinutes: null, cookMinutes: null },
    source: { kind: 'url', url: 'https://www.food.com/recipe/x' },
  };

  it('hands straight over to the review screen', async () => {
    mockSource('fromUrl', { data: draft });
    renderImport();
    expect(await screen.findByRole('heading', { name: /check this over/i })).toBeInTheDocument();
    // The entry tiles are gone; the cook is reviewing now.
    expect(screen.queryByRole('button', { name: /paste link/i })).not.toBeInTheDocument();
  });

  it('reviews a photo draft on the same screen, with the source panel renamed', async () => {
    // One review screen for four sources is the whole point of the draft type.
    mockSource('fromImage', { data: { ...draft, source: { kind: 'image' } } });
    renderImport();
    expect(await screen.findByRole('heading', { name: /check this over/i })).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: /what the photo said/i })).toBeInTheDocument();
    expect(screen.queryByRole('link', { name: /food\.com/i })).not.toBeInTheDocument();
  });

  it('clears every source when the cook starts over', async () => {
    mockSource('fromUrl', { data: draft });
    renderImport();
    fireEvent.click(await screen.findByRole('button', { name: /start over/i }));
    for (const source of SOURCES) expect(reset[source]).toHaveBeenCalled();
  });
});
