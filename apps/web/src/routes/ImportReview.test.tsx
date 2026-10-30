import { describe, it, expect, vi, beforeEach, afterEach, type Mock } from 'vitest';
import { render, screen, fireEvent, cleanup, waitFor, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { ImportReview, type RecipeDraft } from './ImportReview';
import { trpc } from '../lib/trpc';

vi.mock('../lib/trpc', () => ({
  trpc: {
    recipeFile: {
      upload: { useMutation: vi.fn(() => ({ mutateAsync: vi.fn(), isPending: false })) },
      remove: { useMutation: vi.fn(() => ({ mutate: vi.fn() })) },
      setCover: { useMutation: vi.fn(() => ({ mutate: vi.fn() })) },
    },
    import: { fromUrl: { useMutation: vi.fn() } },
    recipe: {
      sourceNames: {
        useQuery: vi.fn(() => ({ data: [{ name: 'The Newlywed Cookbook', count: 9 }] })),
      },
      create: { useMutation: vi.fn() },
    },
    // The household already uses "Breads", so the draft's own "Breads" keyword is filled in.
    tag: {
      all: {
        useQuery: vi.fn(() => ({
          data: [
            { name: 'Breads', normalizedName: 'bread', color: null, uses: 3 },
            { name: 'Butter', normalizedName: 'butter', color: null, uses: 5 },
          ],
        })),
      },
    },
  },
}));

const navigate = vi.fn();
vi.mock('react-router-dom', async () => {
  const actual = await vi.importActual<typeof import('react-router-dom')>('react-router-dom');
  return { ...actual, useNavigate: () => navigate };
});

const useCreate = trpc.recipe.create.useMutation as unknown as Mock;
let mutateAsync: Mock;

/** A draft where everything was stated outright. Tests flag what they want flagged. */
function makeDraft(over: Partial<RecipeDraft> = {}): RecipeDraft {
  return {
    title: { value: 'Best Banana Bread', confidence: 'high', raw: 'Best Banana Bread' },
    servings: { value: 10, confidence: 'high', raw: '1 loaf, 10 serving(s)' },
    mealTypes: { value: ['dessert'], confidence: 'high', raw: 'Quick Breads' },
    tags: { value: ['Breads'], confidence: 'high', raw: 'Breads,Fruit' },
    ingredientLines: {
      value: ['1/2 cup butter, softened', '1 cup sugar'],
      confidence: 'high',
      raw: null,
    },
    steps: { value: ['Cream the butter.', 'Add the eggs.'], confidence: 'high', raw: null },
    details: { description: null, prepMinutes: null, cookMinutes: null },
    amountsToCheck: [],
    source: { kind: 'url', url: 'https://www.food.com/recipe/best-banana-bread-2886' },
    ...over,
  } as RecipeDraft;
}

beforeEach(() => {
  mutateAsync = vi.fn().mockResolvedValue({ id: 'r1', slug: 'best-banana-bread' });
  navigate.mockClear();
  useCreate.mockReturnValue({ mutateAsync, isPending: false, isError: false, error: null });
});

afterEach(cleanup);

const renderReview = (draft: RecipeDraft = makeDraft(), onCancel = vi.fn()) =>
  render(
    <MemoryRouter>
      <ImportReview draft={draft} onCancel={onCancel} />
    </MemoryRouter>,
  );

describe('an amount OCR could not read', () => {
  it('marks the line whose amount was guessed, and only that line', () => {
    renderReview(makeDraft({ amountsToCheck: ['1 cup sugar'] }));
    const marks = screen.getAllByText(/check the amount against the page/i);
    expect(marks).toHaveLength(1);
    expect(marks[0]!.closest('li')).toHaveTextContent(/sugar/);
  });

  it('drops the mark once the cook has edited the line', () => {
    renderReview(makeDraft({ amountsToCheck: ['1 cup sugar'] }));
    fireEvent.change(screen.getByLabelText(/ingredients, one per line/i), {
      target: { value: '1/2 cup butter, softened\n¾ cup sugar' },
    });
    expect(screen.queryByText(/check the amount against the page/i)).not.toBeInTheDocument();
  });
});

describe('only what was guessed is flagged', () => {
  it('does not flag a field the source stated outright', () => {
    renderReview();
    const title = screen.getByLabelText(/title/i);
    expect(title).toHaveValue('Best Banana Bread');
    expect(title.className).not.toMatch(/Flagged/);
    expect(screen.queryByText(/taken from the page title/i)).not.toBeInTheDocument();
  });

  it('flags a field that was worked out, and says why in words', () => {
    renderReview(
      makeDraft({ servings: { value: 24, confidence: 'low', raw: '24 cookies' } } as never),
    );
    const servings = screen.getByLabelText(/servings/i);
    expect(servings.className).toMatch(/Flagged/);
    // The reason is TEXT, not colour alone.
    expect(screen.getByText(/24 cookies.*yield rather than a serving count/i)).toBeInTheDocument();
  });

  it('counts the flagged fields for the cook up front', () => {
    renderReview(
      makeDraft({
        servings: { value: 1, confidence: 'low', raw: null },
        mealTypes: { value: [], confidence: 'low', raw: null },
      } as never),
    );
    expect(screen.getByText(/2 fields were worked out/i)).toBeInTheDocument();
  });

  it('says so plainly when nothing needed guessing', () => {
    renderReview();
    expect(screen.getByText(/said all of this outright/i)).toBeInTheDocument();
  });
});

describe('the flag reaches a screen reader, not just an eye', () => {
  it('describes a flagged field with the sentence that explains it', () => {
    renderReview(
      makeDraft({ servings: { value: 24, confidence: 'low', raw: '24 cookies' } } as never),
    );
    const servings = screen.getByLabelText(/servings/i);
    const describedBy = servings.getAttribute('aria-describedby');
    expect(describedBy).toBeTruthy();
    // The element it points at is the one the sighted cook reads, not a second hidden copy.
    expect(document.getElementById(describedBy ?? '')).toHaveTextContent(/24 cookies/i);
  });

  it('describes nothing when the field was not flagged', () => {
    renderReview();
    expect(screen.getByLabelText(/servings/i)).not.toHaveAttribute('aria-describedby');
  });
});

describe('editing a flagged field clears its flag', () => {
  it('clears the title flag once the cook types', () => {
    renderReview(
      makeDraft({ title: { value: 'Untitled', confidence: 'low', raw: null } } as never),
    );
    const title = screen.getByLabelText(/title/i);
    expect(title.className).toMatch(/Flagged/);

    fireEvent.change(title, { target: { value: 'Banana bread' } });

    expect(screen.getByLabelText(/title/i).className).not.toMatch(/Flagged/);
    expect(screen.queryByText(/taken from the page title/i)).not.toBeInTheDocument();
  });

  it('clears the meal-type flag once the cook picks one', () => {
    renderReview(makeDraft({ mealTypes: { value: [], confidence: 'low', raw: 'Mains' } } as never));
    expect(screen.getByText(/worked out from the site/i)).toBeInTheDocument();

    fireEvent.click(screen.getByLabelText('dinner'));

    expect(screen.queryByText(/worked out from the site/i)).not.toBeInTheDocument();
  });
});

describe('what the parser made of each line', () => {
  it('previews the structure, so the cook can see it before saving', () => {
    renderReview();
    // Through the same `parseIngredientLine` the server will use on save.
    expect(screen.getByText('½ · cup · butter')).toBeInTheDocument();
    expect(screen.getByText('softened')).toBeInTheDocument();
    expect(screen.getByText('1 · cup · sugar')).toBeInTheDocument();
  });

  it('follows an edit to the ingredient text', () => {
    renderReview();
    fireEvent.change(screen.getByLabelText(/ingredients/i), {
      target: { value: '2 tbsp olive oil' },
    });
    expect(screen.getByText('2 · tbsp · olive oil')).toBeInTheDocument();
    expect(screen.queryByText('0.5 · cup · butter')).not.toBeInTheDocument();
  });

  it('never mentions which aisle anything is in', () => {
    // The Food-to-department mapping is a server concern and stays invisible here (D29).
    const { container } = renderReview();
    expect(container.textContent).not.toMatch(/produce|dairy|aisle|department/i);
  });
});

describe('saving', () => {
  it('calls recipe.create exactly once, with the edited draft', async () => {
    renderReview();
    fireEvent.change(screen.getByLabelText(/title/i), { target: { value: 'Banana bread' } });
    fireEvent.click(screen.getByRole('button', { name: /save recipe/i }));

    await waitFor(() => expect(mutateAsync).toHaveBeenCalledTimes(1));
    expect(mutateAsync).toHaveBeenCalledWith({
      title: 'Banana bread',
      servings: 10,
      mealTypes: ['dessert'],
      tags: ['Breads'],
      ingredientLines: ['1/2 cup butter, softened', '1 cup sugar'],
      steps: ['Cream the butter.', 'Add the eggs.'],
      sourceName: null,
      description: null,
      prepMinutes: null,
      cookMinutes: null,
      sourceUrl: 'https://www.food.com/recipe/best-banana-bread-2886',
    });
  });

  it("links a photo or PDF import's kept draft to the saved recipe", async () => {
    renderReview(
      makeDraft({
        source: { kind: 'image' },
        importDraftId: '7c0a6f0e-3a51-4c56-9d3e-5d8f0b1c2a3e',
      }),
    );
    fireEvent.click(screen.getByRole('button', { name: /save recipe/i }));
    await waitFor(() => expect(mutateAsync).toHaveBeenCalledTimes(1));
    expect(mutateAsync.mock.calls[0]?.[0]).toMatchObject({
      importDraftId: '7c0a6f0e-3a51-4c56-9d3e-5d8f0b1c2a3e',
    });
  });

  it('goes to the saved recipe afterwards', async () => {
    renderReview();
    fireEvent.click(screen.getByRole('button', { name: /save recipe/i }));
    await waitFor(() => expect(navigate).toHaveBeenCalledWith('/recipes/best-banana-bread'));
  });

  it('will not save a recipe with no title', () => {
    renderReview(makeDraft({ title: { value: '', confidence: 'low', raw: null } } as never));
    expect(screen.getByRole('button', { name: /save recipe/i })).toBeDisabled();
  });

  it('drops blank lines rather than saving empty ingredients', async () => {
    renderReview();
    fireEvent.change(screen.getByLabelText(/ingredients/i), {
      target: { value: '1 onion\n\n   \n2 parsnips\n' },
    });
    fireEvent.click(screen.getByRole('button', { name: /save recipe/i }));
    await waitFor(() => expect(mutateAsync).toHaveBeenCalledTimes(1));
    expect(mutateAsync.mock.calls[0]?.[0]).toMatchObject({
      ingredientLines: ['1 onion', '2 parsnips'],
    });
  });

  it('shows a refusal from the server rather than swallowing it', () => {
    useCreate.mockReturnValue({
      mutateAsync,
      isPending: false,
      isError: true,
      error: { message: 'Title is required' },
    });
    renderReview();
    expect(screen.getByRole('alert')).toHaveTextContent('Title is required');
  });

  it('offers a way back out without saving', () => {
    const onCancel = vi.fn();
    renderReview(makeDraft(), onCancel);
    fireEvent.click(screen.getByRole('button', { name: /start over/i }));
    expect(onCancel).toHaveBeenCalledTimes(1);
    expect(mutateAsync).not.toHaveBeenCalled();
  });
});

describe('the source panel', () => {
  it('shows where the recipe came from and what the page actually said', () => {
    renderReview();
    const link = screen.getByRole('link', {
      name: 'https://www.food.com/recipe/best-banana-bread-2886',
    });
    expect(link).toHaveAttribute('href', 'https://www.food.com/recipe/best-banana-bread-2886');
    // Opening someone else's page must not hand it this tab's window object.
    expect(link).toHaveAttribute('rel', expect.stringContaining('noreferrer'));
    expect(screen.getByText('1 loaf, 10 serving(s)')).toBeInTheDocument();
  });

  it('says "not stated" rather than leaving a field blank', () => {
    renderReview(makeDraft({ tags: { value: [], confidence: 'low', raw: null } } as never));
    expect(screen.getAllByText(/not stated/i).length).toBeGreaterThan(0);
  });
});

describe('a draft from something other than a page', () => {
  /** The shape every heuristic source produces: nothing stated, so everything flagged. */
  const inferred = (kind: 'text' | 'pdf' | 'image') =>
    makeDraft({
      title: { value: 'Skillet Cornbread', confidence: 'low', raw: 'Skillet Cornbread' },
      servings: { value: 8, confidence: 'low', raw: 'Serves 8' },
      mealTypes: { value: [], confidence: 'low', raw: null },
      tags: { value: [], confidence: 'low', raw: null },
      ingredientLines: { value: ['2 tsp baking powder'], confidence: 'low', raw: null },
      steps: { value: ['Bake it.'], confidence: 'low', raw: null },
      source: { kind },
    } as never);

  it.each([
    ['text', /first line of the text/i, /the text did not say what kind of meal/i],
    ['pdf', /first line of the PDF/i, /the PDF did not say what kind of meal/i],
    ['image', /first line of the photo/i, /the photo did not say what kind of meal/i],
  ] as const)(
    'names the %s in its flags rather than calling it a page',
    (kind, titleFlag, mealFlag) => {
      renderReview(inferred(kind));
      expect(screen.getByText(titleFlag)).toBeInTheDocument();
      expect(screen.getByText(mealFlag)).toBeInTheDocument();
      // The wording a URL import uses, which would be wrong here.
      expect(screen.queryByText(/taken from the page title/i)).not.toBeInTheDocument();
    },
  );

  it('says where a yield was read from, rather than calling it the wrong kind of number', () => {
    // The URL path says "which is a yield rather than a serving count", because there it means
    // the page labelled it something else. A paste has no label to disagree with.
    renderReview(inferred('text'));
    expect(screen.getByText(/read out of “Serves 8”/i)).toBeInTheDocument();
  });

  it('offers no link back, because there is nowhere to go', () => {
    renderReview(inferred('image'));
    expect(screen.getByRole('heading', { name: /what the photo said/i })).toBeInTheDocument();
    expect(screen.queryByRole('link')).not.toBeInTheDocument();
  });

  it.each(['javascript:alert(1)', 'data:text/html,<script>x</script>'])(
    'refuses to put %s in an href',
    (url) => {
      // The fetcher cannot produce these, so this is the second lock rather than the only one -
      // the same one `RecipeView` and `recipe.create` both have. React does not sanitize an
      // href, so every one of them in this diff should have it.
      renderReview(makeDraft({ source: { kind: 'url', url } } as never));
      expect(screen.queryByRole('link')).not.toBeInTheDocument();
      expect(screen.queryByText(url)).not.toBeInTheDocument();
    },
  );
});

describe('provenance survives the save', () => {
  it('sends the source URL with a URL import, so the recipe keeps where it came from', async () => {
    renderReview();
    fireEvent.click(screen.getByRole('button', { name: /save recipe/i }));
    await waitFor(() => expect(mutateAsync).toHaveBeenCalledTimes(1));
    expect(mutateAsync.mock.calls[0]?.[0]).toMatchObject({
      sourceUrl: 'https://www.food.com/recipe/best-banana-bread-2886',
    });
  });

  it('sends none for a draft that came from a file, which has no address', async () => {
    renderReview(makeDraft({ source: { kind: 'pdf' } } as never));
    fireEvent.click(screen.getByRole('button', { name: /save recipe/i }));
    await waitFor(() => expect(mutateAsync).toHaveBeenCalledTimes(1));
    expect(mutateAsync.mock.calls[0]?.[0]).not.toHaveProperty('sourceUrl');
  });

  it('sends the link a cook types for a pasted recipe', async () => {
    renderReview(makeDraft({ source: { kind: 'text' } } as never));
    fireEvent.change(screen.getByLabelText('Source link'), {
      target: { value: 'https://www.delish.com/osso-buco' },
    });
    fireEvent.click(screen.getByRole('button', { name: /save recipe/i }));
    await waitFor(() => expect(mutateAsync).toHaveBeenCalledTimes(1));
    expect(mutateAsync.mock.calls[0]?.[0]).toMatchObject({
      sourceUrl: 'https://www.delish.com/osso-buco',
    });
  });

  it('asks for no link on a URL import, which has its own', () => {
    renderReview();
    expect(screen.queryByLabelText('Source link')).not.toBeInTheDocument();
  });
});

describe('a book source for a file import', () => {
  beforeEach(() => localStorage.clear());

  it('saves the source typed in and offers it again on the next file import', async () => {
    const { unmount } = renderReview(makeDraft({ source: { kind: 'image' } } as never));
    fireEvent.change(screen.getByLabelText('Source'), {
      target: { value: 'Joy of Cooking, p. 212' },
    });
    fireEvent.click(screen.getByRole('button', { name: /save recipe/i }));
    await waitFor(() => expect(mutateAsync).toHaveBeenCalledTimes(1));
    expect(mutateAsync.mock.calls[0]?.[0]).toMatchObject({ sourceName: 'Joy of Cooking, p. 212' });
    unmount();

    renderReview(makeDraft({ source: { kind: 'image' } } as never));
    expect(screen.getByLabelText('Source')).toHaveValue('Joy of Cooking, p. 212');
  });

  it('starts blank for a link, which is its own source', () => {
    localStorage.setItem('hearth.import.lastSource', 'Joy of Cooking');
    renderReview();
    expect(screen.getByLabelText('Source')).toHaveValue('');
  });
});

describe('what a page stated about itself', () => {
  it('starts Notes and the times from the page, and saves what the cook leaves there', async () => {
    renderReview(
      makeDraft({
        details: { description: 'A family favourite.', prepMinutes: 10, cookMinutes: 60 },
      } as never),
    );
    expect(screen.getByLabelText('Notes')).toHaveValue('A family favourite.');
    expect(screen.getByLabelText('Prep minutes')).toHaveValue(10);
    fireEvent.change(screen.getByLabelText('Cook minutes'), { target: { value: '' } });
    fireEvent.click(screen.getByRole('button', { name: /save recipe/i }));
    await waitFor(() => expect(mutateAsync).toHaveBeenCalledTimes(1));
    expect(mutateAsync.mock.calls[0]?.[0]).toMatchObject({
      description: 'A family favourite.',
      prepMinutes: 10,
      cookMinutes: null,
    });
  });
});

describe('tags', () => {
  /** The tag chips on the recipe, by name. */
  const chips = () =>
    within(screen.getByRole('list', { name: 'Tags on this recipe' }))
      .queryAllByRole('listitem')
      .map((li) => li.firstChild?.textContent);

  const seo = () =>
    makeDraft({
      title: { value: 'Easy Baked Pork Tenderloin', confidence: 'high', raw: null },
      tags: {
        value: ['baked pork tenderloin recipe', 'Breads', 'weeknight dinner'],
        confidence: 'low',
        raw: 'baked pork tenderloin recipe, Breads, weeknight dinner',
      },
    } as never);

  it('fills in only tags the household uses, and offers the rest one tap each', async () => {
    renderReview(seo());
    expect(chips()).toEqual(['Breads']);
    expect(screen.getByText('Filled in from tags you already use that this recipe mentions.'));
    // "Butter" is an existing tag an ingredient names; the SEO keyword is dropped.
    expect(screen.getByRole('button', { name: 'Add tag Butter' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /pork tenderloin recipe/ })).toBeNull();

    fireEvent.click(screen.getByRole('button', { name: 'Add tag weeknight dinner' }));
    expect(chips()).toEqual(['Breads', 'weeknight dinner']);
    expect(screen.queryByRole('button', { name: 'Add tag weeknight dinner' })).toBeNull();

    fireEvent.click(screen.getByRole('button', { name: /save recipe/i }));
    await waitFor(() => expect(mutateAsync).toHaveBeenCalledTimes(1));
    expect(mutateAsync.mock.calls[0]?.[0]).toMatchObject({ tags: ['Breads', 'weeknight dinner'] });
  });

  it('turns a typed comma into a chip and saves the typed tags', async () => {
    renderReview(makeDraft({ tags: { value: [], confidence: 'low', raw: null } } as never));
    fireEvent.change(screen.getByLabelText('Tags'), { target: { value: 'breads, Soup' } });
    fireEvent.blur(screen.getByLabelText('Tags'));
    // "breads" is the household's own "Breads"; "Soup" is new.
    expect(chips()).toEqual(['Breads', 'Soup']);
    fireEvent.click(screen.getByRole('button', { name: /save recipe/i }));
    await waitFor(() => expect(mutateAsync).toHaveBeenCalledTimes(1));
    expect(mutateAsync.mock.calls[0]?.[0]).toMatchObject({ tags: ['Breads', 'Soup'] });
  });
});

describe('keeping what a file import was read from', () => {
  it('uploads the PDF as the recipe’s source once the recipe is saved, then opens it', async () => {
    const upload = vi.fn().mockResolvedValue({});
    (trpc.recipeFile.upload.useMutation as unknown as Mock).mockReturnValue({
      mutateAsync: upload,
      isPending: false,
    });
    render(
      <MemoryRouter>
        <ImportReview
          draft={makeDraft({ source: { kind: 'pdf' } } as never)}
          onCancel={vi.fn()}
          sourceFiles={{ kind: 'pdf', file: new Blob(['%PDF-1.7']) }}
        />
      </MemoryRouter>,
    );
    fireEvent.click(screen.getByRole('button', { name: /save recipe/i }));
    await waitFor(() => expect(navigate).toHaveBeenCalledWith('/recipes/best-banana-bread'));
    expect(upload).toHaveBeenCalledWith(
      expect.objectContaining({ recipeId: 'r1', kind: 'source_pdf' }),
    );
  });
});
