import { describe, it, expect, vi, beforeEach, type Mock } from 'vitest';
import { render, screen, fireEvent, within } from '@testing-library/react';
import { MemoryRouter, Routes, Route } from 'react-router-dom';
import { RecipeEdit } from './RecipeEdit';
import { trpc } from '../lib/trpc';

// Mock the typed tRPC client: RecipeEdit touches recipe.get.useQuery plus the
// create/update mutations. Stub just those hooks.
vi.mock('../lib/trpc', () => ({
  trpc: {
    recipe: {
      sourceNames: {
        useQuery: vi.fn(() => ({ data: [{ name: 'The Newlywed Cookbook', count: 9 }] })),
      },
      get: { useQuery: vi.fn() },
      list: { useQuery: vi.fn() },
      create: { useMutation: vi.fn() },
      update: { useMutation: vi.fn() },
    },
    tag: {
      all: {
        useQuery: vi.fn(() => ({
          data: [{ name: 'Beans', normalizedName: 'bean', color: null, uses: 2 }],
        })),
      },
    },
  },
}));

const useGetQuery = trpc.recipe.get.useQuery as unknown as Mock;
const useListQuery = trpc.recipe.list.useQuery as unknown as Mock;
const useCreateMutation = trpc.recipe.create.useMutation as unknown as Mock;
const useUpdateMutation = trpc.recipe.update.useMutation as unknown as Mock;

let createMutateAsync: Mock;
let updateMutateAsync: Mock;

beforeEach(() => {
  createMutateAsync = vi.fn().mockResolvedValue({ id: 'new-id', slug: 'new-slug' });
  updateMutateAsync = vi.fn().mockResolvedValue({ id: 'id', slug: 'slug' });
  useGetQuery.mockReturnValue({ data: undefined, isLoading: false, isError: false });
  useListQuery.mockReturnValue({ data: LIBRARY, isSuccess: true });
  useCreateMutation.mockReturnValue({
    mutateAsync: createMutateAsync,
    isPending: false,
    isError: false,
  });
  useUpdateMutation.mockReturnValue({
    mutateAsync: updateMutateAsync,
    isPending: false,
    isError: false,
  });
});

// The household's recipes, for the link picker.
const LIBRARY = [
  { id: 'recipe-1', title: 'White Bean Soup', slug: 'white-bean-soup' },
  { id: 'dough-1', title: 'Neapolitan Pizza Dough', slug: 'neapolitan-pizza-dough' },
  { id: 'sauce-1', title: 'Pizza Sauce', slug: 'pizza-sauce' },
];

// Render in create mode by default (route /recipes/new — no :slug).
function renderCreate() {
  return render(
    <MemoryRouter initialEntries={['/recipes/new']}>
      <RecipeEdit />
    </MemoryRouter>,
  );
}

// A populated assembled recipe as recipe.get returns it (edit mode).
const EXISTING_RECIPE = {
  id: 'recipe-1',
  title: 'White Bean Soup',
  slug: 'white-bean-soup',
  servings: 4,
  mealTypes: ['dinner'],
  tags: ['comfort', 'quick'],
  ingredients: [
    { id: 'i1', position: 0, rawText: '2 cups flour', linkedRecipe: null },
    { id: 'i2', position: 1, rawText: '1 tsp salt', linkedRecipe: null },
  ],
  steps: [{ id: 's1', position: 0, text: 'Mix everything' }],
};

// Render in edit mode (route /recipes/:slug/edit) so useParams().slug resolves.
function renderEdit() {
  return render(
    <MemoryRouter initialEntries={['/recipes/white-bean-soup/edit']}>
      <Routes>
        <Route path="/recipes/:slug/edit" element={<RecipeEdit />} />
      </Routes>
    </MemoryRouter>,
  );
}

describe('RecipeEdit', () => {
  it('renders a live parsed preview from parseIngredientLine as you type', () => {
    renderCreate();

    fireEvent.change(screen.getByLabelText('Ingredients, one per line'), {
      target: { value: '2 cups flour' },
    });

    const preview = screen.getByLabelText('Parsed ingredient preview');
    // parseIngredientLine('2 cups flour') => { quantity: 2, unit: 'cup', foodName: 'flour' }
    expect(within(preview).getByText('2 · cups · flour')).toBeInTheDocument();
  });

  it('saves a create payload with the typed ingredient lines and title', async () => {
    renderCreate();

    fireEvent.change(screen.getByLabelText('Title'), {
      target: { value: 'Test Recipe' },
    });
    fireEvent.change(screen.getByLabelText('Servings'), { target: { value: '3' } });
    fireEvent.change(screen.getByLabelText('Ingredients, one per line'), {
      target: { value: '2 cups flour' },
    });
    fireEvent.change(screen.getByLabelText('Step 1'), {
      target: { value: 'Mix everything' },
    });

    fireEvent.click(screen.getByRole('button', { name: 'Save' }));

    expect(createMutateAsync).toHaveBeenCalledTimes(1);
    expect(createMutateAsync).toHaveBeenCalledWith(
      expect.objectContaining({
        title: 'Test Recipe',
        servings: 3,
        ingredientLines: ['2 cups flour'],
        steps: ['Mix everything'],
      }),
    );
  });

  it('sends source, notes and times, and blanks as null', () => {
    renderCreate();
    fireEvent.change(screen.getByLabelText('Title'), { target: { value: 'Rolls' } });
    fireEvent.change(screen.getByLabelText('Source'), {
      target: { value: 'Joy of Cooking, p. 212' },
    });
    fireEvent.change(screen.getByLabelText('Prep minutes'), { target: { value: '20' } });
    fireEvent.change(screen.getByLabelText('Notes'), { target: { value: '  ' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    expect(createMutateAsync).toHaveBeenCalledWith(
      expect.objectContaining({
        sourceName: 'Joy of Cooking, p. 212',
        prepMinutes: 20,
        cookMinutes: null,
        description: null,
      }),
    );
  });

  it('saves a source link, reading a bare address as https', () => {
    renderCreate();
    fireEvent.change(screen.getByLabelText('Title'), { target: { value: 'Osso Buco' } });
    fireEvent.change(screen.getByLabelText('Source link'), {
      target: { value: 'www.delish.com/osso-buco' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    expect(createMutateAsync).toHaveBeenCalledWith(
      expect.objectContaining({ sourceUrl: 'https://www.delish.com/osso-buco' }),
    );
  });

  it('holds Save and says why when the source link is not a web address', () => {
    renderCreate();
    fireEvent.change(screen.getByLabelText('Title'), { target: { value: 'Osso Buco' } });
    fireEvent.change(screen.getByLabelText('Source link'), {
      target: { value: 'javascript:alert(1)' },
    });
    expect(screen.getByText('That doesn’t look like a web address.')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Save' })).toBeDisabled();
  });

  it('offers a tag the household uses when the recipe mentions it, added on a tap', () => {
    renderCreate();
    expect(screen.queryByRole('button', { name: 'Add tag Beans' })).toBeNull();
    fireEvent.change(screen.getByLabelText('Title'), { target: { value: 'White Bean Soup' } });
    fireEvent.change(screen.getByLabelText('Tags'), { target: { value: 'Soup,' } });
    const chips = () =>
      within(screen.getByRole('list', { name: 'Tags on this recipe' }))
        .queryAllByRole('listitem')
        .map((li) => li.firstChild?.textContent);
    fireEvent.click(screen.getByRole('button', { name: 'Add tag Beans' }));
    expect(chips()).toEqual(['Soup', 'Beans']);
    expect(screen.queryByRole('button', { name: 'Add tag Beans' })).toBeNull();
  });

  it('keeps Save disabled until a title is entered', () => {
    renderCreate();

    const save = screen.getByRole('button', { name: 'Save' });
    expect(save).toBeDisabled();

    fireEvent.change(screen.getByLabelText('Title'), {
      target: { value: 'Now valid' },
    });
    expect(save).toBeEnabled();
  });

  it('prefills the form from the loaded recipe in edit mode', () => {
    useGetQuery.mockReturnValue({
      data: EXISTING_RECIPE,
      isLoading: false,
      isError: false,
    });
    renderEdit();

    // Title, servings and tags prefill from the loaded recipe.
    expect(screen.getByLabelText('Title')).toHaveValue('White Bean Soup');
    expect(screen.getByLabelText('Servings')).toHaveValue(4);
    expect(
      within(screen.getByRole('list', { name: 'Tags on this recipe' }))
        .getAllByRole('listitem')
        .map((li) => li.firstChild?.textContent),
    ).toEqual(['comfort', 'quick']);

    // Ingredients textarea holds one rawText line per ingredient.
    expect(screen.getByLabelText('Ingredients, one per line')).toHaveValue(
      '2 cups flour\n1 tsp salt',
    );

    // The loaded step text shows in the first step input.
    expect(screen.getByLabelText('Step 1')).toHaveValue('Mix everything');
  });

  it('saves an update payload including the loaded id and edited fields', () => {
    useGetQuery.mockReturnValue({
      data: EXISTING_RECIPE,
      isLoading: false,
      isError: false,
    });
    renderEdit();

    // Edit the title, then save.
    fireEvent.change(screen.getByLabelText('Title'), {
      target: { value: 'White Bean Stew' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));

    expect(createMutateAsync).not.toHaveBeenCalled();
    expect(updateMutateAsync).toHaveBeenCalledTimes(1);
    expect(updateMutateAsync).toHaveBeenCalledWith(
      expect.objectContaining({
        id: 'recipe-1',
        title: 'White Bean Stew',
        servings: 4,
        mealTypes: ['dinner'],
        tags: ['comfort', 'quick'],
        ingredientLines: ['2 cups flour', '1 tsp salt'],
        steps: ['Mix everything'],
      }),
    );
  });
});

describe('RecipeEdit recipe links', () => {
  it('links the line under the cursor through the picker, and shows it in the preview', () => {
    renderCreate();
    const box = screen.getByLabelText('Ingredients, one per line') as HTMLTextAreaElement;
    fireEvent.change(box, { target: { value: '1 pizza dough\n200 g mozzarella' } });
    box.setSelectionRange(3, 3);

    fireEvent.click(screen.getByRole('button', { name: 'Link a recipe to this line' }));
    fireEvent.change(screen.getByRole('combobox', { name: 'Search your recipes' }), {
      target: { value: 'dough' },
    });
    fireEvent.mouseDown(screen.getByRole('option', { name: 'Neapolitan Pizza Dough' }));

    expect(box.value).toBe('1 pizza dough [[Neapolitan Pizza Dough]]\n200 g mozzarella');
    const preview = screen.getByLabelText('Parsed ingredient preview');
    expect(within(preview).getByText('1 · pizza dough')).toBeInTheDocument();
    expect(
      within(preview).getByRole('link', { name: '→ Neapolitan Pizza Dough' }),
    ).toBeInTheDocument();
  });

  it('opens the picker when [[ is typed and picks with the keyboard', () => {
    renderCreate();
    const box = screen.getByLabelText('Ingredients, one per line') as HTMLTextAreaElement;
    fireEvent.change(box, { target: { value: '1 sauce [[', selectionStart: 10 } });

    const search = screen.getByRole('combobox', { name: 'Search your recipes' });
    fireEvent.change(search, { target: { value: 'pizza' } });
    // "Pizza Sauce" starts with the query, so it is offered first.
    fireEvent.keyDown(search, { key: 'Enter' });

    expect(box.value).toBe('1 sauce [[Pizza Sauce]]');
  });

  it('never offers the recipe being edited, and loads a link back as its token', () => {
    useGetQuery.mockReturnValue({
      data: {
        ...EXISTING_RECIPE,
        ingredients: [
          {
            id: 'i1',
            position: 0,
            rawText: '1 pizza dough',
            linkedRecipe: {
              id: 'dough-1',
              slug: 'neapolitan-pizza-dough',
              title: 'Neapolitan Pizza Dough',
            },
          },
        ],
      },
      isLoading: false,
      isError: false,
    });
    renderEdit();
    const box = screen.getByLabelText('Ingredients, one per line') as HTMLTextAreaElement;
    expect(box.value).toBe('1 pizza dough [[Neapolitan Pizza Dough]]');

    box.setSelectionRange(0, 0);
    fireEvent.click(screen.getByRole('button', { name: 'Link a recipe to this line' }));
    expect(screen.queryByRole('option', { name: 'White Bean Soup' })).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'Remove link to Neapolitan Pizza Dough' }));
    expect(box.value).toBe('1 pizza dough');
  });

  it('flags a token that names no recipe', () => {
    renderCreate();
    fireEvent.change(screen.getByLabelText('Ingredients, one per line'), {
      target: { value: '1 dough [[Nope]]' },
    });
    expect(screen.getByText('No recipe called “Nope”')).toBeInTheDocument();
  });

  it('shows why the server refused a link', () => {
    useCreateMutation.mockReturnValue({
      mutateAsync: createMutateAsync,
      isPending: false,
      isError: true,
      error: {
        message: 'Ingredient 1 links to a recipe that already uses this one.',
        data: { code: 'UNPROCESSABLE_CONTENT' },
      },
    });
    renderCreate();
    expect(screen.getByRole('alert')).toHaveTextContent(
      'Ingredient 1 links to a recipe that already uses this one.',
    );
  });
});

describe('RecipeEdit recipe links: what is sent and when the picker closes', () => {
  it('sends the picked recipe id with its line, so a shared title still saves', async () => {
    useListQuery.mockReturnValue({
      data: [...LIBRARY, { id: 'dough-2', title: 'Neapolitan Pizza Dough', slug: 'npd-2' }],
      isSuccess: true,
    });
    renderCreate();
    fireEvent.change(screen.getByLabelText('Title'), { target: { value: 'Binulati' } });
    const box = screen.getByLabelText('Ingredients, one per line') as HTMLTextAreaElement;
    fireEvent.change(box, { target: { value: 'salt\n1 pizza dough' } });
    box.setSelectionRange(box.value.length, box.value.length);
    fireEvent.click(screen.getByRole('button', { name: 'Link a recipe to this line' }));
    // Two recipes share the title; the second one is picked.
    fireEvent.mouseDown(screen.getAllByRole('option', { name: 'Neapolitan Pizza Dough' })[1]!);
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));

    expect(createMutateAsync).toHaveBeenCalledWith(
      expect.objectContaining({
        ingredientLines: ['salt', '1 pizza dough [[Neapolitan Pizza Dough]]'],
        ingredientLinks: [null, 'dough-2'],
      }),
    );
  });

  it('drops the [[ that opened the picker, and closes the picker on any other edit', () => {
    renderCreate();
    const box = screen.getByLabelText('Ingredients, one per line') as HTMLTextAreaElement;
    fireEvent.change(box, { target: { value: '1 [[pizza dough', selectionStart: 4 } });
    expect(box.value).toBe('1 pizza dough');
    expect(screen.getByRole('combobox', { name: 'Search your recipes' })).toBeInTheDocument();

    fireEvent.change(box, { target: { value: 'salt\n1 pizza dough', selectionStart: 4 } });
    expect(screen.queryByRole('combobox', { name: 'Search your recipes' })).not.toBeInTheDocument();
  });
});
