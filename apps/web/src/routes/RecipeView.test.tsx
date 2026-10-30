import { describe, it, expect, vi, beforeEach, type Mock } from 'vitest';
import { render, screen, fireEvent, within, cleanup } from '@testing-library/react';
import { MemoryRouter, Routes, Route } from 'react-router-dom';
import { RecipeView } from './RecipeView';
import { trpc } from '../lib/trpc';

// Mock the typed tRPC client: RecipeView touches recipe.get.useQuery and
// shoppingList.addRecipe.useMutation, so we stub just those hooks.
// Planning from here has its own tests and its own procedures.
vi.mock('./PlanThisRecipe', () => ({ PlanThisRecipe: () => null }));

vi.mock('../lib/trpc', () => ({
  trpc: {
    cookLog: {
      list: { useQuery: vi.fn(() => ({ data: [] })) },
      add: { useMutation: vi.fn(() => ({ mutateAsync: vi.fn(), isPending: false })) },
      update: { useMutation: vi.fn(() => ({ mutateAsync: vi.fn(), isPending: false })) },
      remove: { useMutation: vi.fn(() => ({ mutate: vi.fn() })) },
    },
    recipeFile: {
      upload: { useMutation: vi.fn(() => ({ mutateAsync: vi.fn(), isPending: false })) },
      remove: { useMutation: vi.fn(() => ({ mutate: vi.fn() })) },
      setCover: { useMutation: vi.fn(() => ({ mutate: vi.fn() })) },
    },
    useUtils: vi.fn(),
    // Linked recipes for Share and Print; none by default.
    useQueries: vi.fn(() => []),
    recipe: {
      get: { useQuery: vi.fn() },
      delete: { useMutation: vi.fn() },
      setRating: { useMutation: vi.fn(() => ({ mutate: vi.fn() })) },
    },
    shoppingList: { addRecipe: { useMutation: vi.fn() } },
    tag: { all: { useQuery: vi.fn(() => ({ data: [] })) } },
  },
}));

const useGetQuery = trpc.recipe.get.useQuery as unknown as Mock;
const useAddRecipeMutation = trpc.shoppingList.addRecipe.useMutation as unknown as Mock;
const useDeleteMutation = trpc.recipe.delete.useMutation as unknown as Mock;
let deleteMutate: Mock;

const RECIPE = {
  id: 'r1',
  files: [],
  coverFileId: null,
  rating: null,
  title: 'White Bean Soup',
  slug: 'white-bean-soup',
  description: 'Cozy and simple.',
  servings: 4,
  prepMinutes: 10,
  cookMinutes: 30,
  mealTypes: ['dinner'],
  ingredients: [
    {
      id: 'i1',
      position: 0,
      quantity: 2,
      unit: 'cup',
      note: null,
      rawText: '2 cups flour',
      scalingMode: 'linear',
      foodId: 'f1',
      foodName: 'flour',
      department: 'baking',
      linkedRecipe: null,
    },
    {
      id: 'i2',
      position: 1,
      quantity: null,
      unit: null,
      note: 'to taste',
      rawText: 'salt, to taste',
      scalingMode: 'linear',
      foodId: 'f2',
      foodName: 'salt',
      department: 'pantry',
      linkedRecipe: null,
    },
  ],
  steps: [
    { id: 's1', position: 0, text: 'Combine everything.' },
    { id: 's2', position: 1, text: 'Simmer until done.' },
  ],
  tags: ['comfort'],
  usedIn: [] as { id: string; slug: string; title: string }[],
};

let mutateAsync: Mock;

beforeEach(() => {
  mutateAsync = vi.fn().mockResolvedValue({});
  useGetQuery.mockReturnValue({ data: RECIPE, isLoading: false, isError: false });
  useAddRecipeMutation.mockReturnValue({ mutateAsync, isPending: false });
  deleteMutate = vi.fn();
  useDeleteMutation.mockReturnValue({ mutate: deleteMutate, isPending: false, isError: false });
  (trpc.useUtils as unknown as Mock).mockReturnValue({
    recipe: { list: { invalidate: vi.fn() } },
    plan: { week: { invalidate: vi.fn() } },
  });
});

function renderView() {
  return render(
    <MemoryRouter initialEntries={['/recipes/white-bean-soup']}>
      <Routes>
        <Route path="/recipes/:slug" element={<RecipeView />} />
      </Routes>
    </MemoryRouter>,
  );
}

describe('RecipeView', () => {
  it('renders the numeric ingredient scaled at base and the "to taste" one with no number', () => {
    renderView();

    // flour: base servings (4 → 4) shows its quantity of 2.
    const flour = screen.getByText('flour').closest('li') as HTMLElement;
    expect(within(flour).getByText(/2/)).toBeInTheDocument();
    expect(within(flour).getByText(/cup/)).toBeInTheDocument();

    // salt: "to taste" (null quantity) renders without any number.
    const salt = screen.getByText('salt').closest('li') as HTMLElement;
    expect(within(salt).getByText('to taste')).toBeInTheDocument();
    expect(salt.textContent).not.toMatch(/\d/);
  });

  it('scales the numeric ingredient when servings are doubled and leaves "to taste" unchanged', () => {
    renderView();

    // 4 → 8 servings.
    fireEvent.click(screen.getByRole('button', { name: 'Increase servings' }));
    fireEvent.click(screen.getByRole('button', { name: 'Increase servings' }));
    fireEvent.click(screen.getByRole('button', { name: 'Increase servings' }));
    fireEvent.click(screen.getByRole('button', { name: 'Increase servings' }));

    const flour = screen.getByText('flour').closest('li') as HTMLElement;
    expect(within(flour).getByText(/4/)).toBeInTheDocument();

    const salt = screen.getByText('salt').closest('li') as HTMLElement;
    expect(salt.textContent).not.toMatch(/\d/);
  });

  it('shows a scaled amount as the fraction a cook measures, not a decimal', () => {
    renderView();

    // 2 cups for 4, cooked for 3: 1.5 cups.
    fireEvent.click(screen.getByRole('button', { name: 'Decrease servings' }));

    const flour = screen.getByText('flour').closest('li') as HTMLElement;
    expect(within(flour).getByText(/1 ½/)).toBeInTheDocument();
    expect(flour.textContent).not.toContain('1.5');
  });

  it('adds the recipe to the shopping list at the current scaled servings', async () => {
    renderView();

    // Double 4 → 8.
    for (let i = 0; i < 4; i++) {
      fireEvent.click(screen.getByRole('button', { name: 'Increase servings' }));
    }

    fireEvent.click(screen.getByRole('button', { name: 'Add to list' }));

    expect(mutateAsync).toHaveBeenCalledTimes(1);
    expect(mutateAsync).toHaveBeenCalledWith({ recipeId: 'r1', servings: 8 });

    expect(await screen.findByRole('status')).toHaveTextContent(/shopping list/i);
  });

  it('surfaces an error and no confirmation when add-to-list fails', async () => {
    mutateAsync.mockRejectedValue(new Error('nope'));
    renderView();

    fireEvent.click(screen.getByRole('button', { name: 'Add to list' }));

    expect(await screen.findByRole('alert')).toHaveTextContent(/shopping list/i);
    expect(screen.queryByRole('status')).not.toBeInTheDocument();
  });

  it('switches to the Steps pane and back to Ingredients', () => {
    // Inside the screen itself: the print sheet, beside it in <body>, holds both panes.
    const { container } = renderView();
    const view = within(container);

    // Ingredients shown by default.
    expect(view.getByText('flour')).toBeInTheDocument();
    expect(view.queryByText('Combine everything.')).not.toBeInTheDocument();

    fireEvent.click(view.getByRole('tab', { name: 'Steps' }));
    expect(view.getByText('Combine everything.')).toBeInTheDocument();
    expect(view.queryByText('flour')).not.toBeInTheDocument();

    fireEvent.click(view.getByRole('tab', { name: 'Ingredients' }));
    expect(view.getByText('flour')).toBeInTheDocument();
    expect(view.queryByText('Combine everything.')).not.toBeInTheDocument();
  });

  it('prints the recipes its lines are made from, loaded by slug', () => {
    const useQueries = trpc.useQueries as unknown as Mock;
    const stock = { ...RECIPE, id: 'r2', slug: 'chicken-stock', title: 'Chicken Stock' };
    useQueries.mockImplementation((build: (t: unknown) => unknown[]) => {
      const asked = build({ recipe: { get: (input: { idOrSlug: string }) => input.idOrSlug } });
      expect(asked).toEqual(['chicken-stock']);
      return [{ data: stock }];
    });
    useGetQuery.mockReturnValue({
      isLoading: false,
      isError: false,
      data: {
        ...RECIPE,
        ingredients: [
          ...RECIPE.ingredients,
          {
            ...RECIPE.ingredients[0]!,
            id: 'i3',
            position: 2,
            foodName: null,
            linkedRecipe: { id: 'r2', slug: 'chicken-stock', title: 'Chicken Stock' },
          },
        ],
      },
    });
    try {
      renderView();
      const sheet = document.body.querySelector(':scope > [data-print-sheet]');
      expect(sheet?.querySelectorAll('h2')[2]).toHaveTextContent('Chicken Stock');
    } finally {
      useQueries.mockImplementation(() => []);
    }
  });

  it('holds Share and Print until the linked recipes have loaded', () => {
    const useQueries = trpc.useQueries as unknown as Mock;
    useQueries.mockImplementation(() => [{ data: undefined, isLoading: true }]);
    try {
      renderView();
      expect(screen.getByRole('button', { name: 'Share' })).toBeDisabled();
      expect(screen.getByRole('button', { name: 'Print' })).toBeDisabled();
    } finally {
      useQueries.mockImplementation(() => []);
    }
  });

  it('offers Share and Print beside Edit', () => {
    renderView();
    expect(screen.getByRole('button', { name: 'Share' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Print' })).toBeInTheDocument();
    // The sheet Print prints, with both panes on it.
    const sheet = document.body.querySelector(':scope > [data-print-sheet]');
    expect(sheet).toHaveTextContent('flour');
    expect(sheet).toHaveTextContent('Combine everything.');
  });

  it("starts cooking at the recipe's own servings when the scaler is untouched", () => {
    renderView();
    expect(screen.getByRole('link', { name: 'Start cooking' })).toHaveAttribute(
      'href',
      '/recipes/white-bean-soup/cook?servings=4',
    );
  });

  it('carries the scaled servings into cook mode', () => {
    renderView();
    fireEvent.click(screen.getByRole('button', { name: 'Increase servings' }));
    fireEvent.click(screen.getByRole('button', { name: 'Increase servings' }));

    // The cook scaled to 6 here; the cook screen has to be told, or it shows amounts for 4.
    expect(screen.getByRole('link', { name: 'Start cooking' })).toHaveAttribute(
      'href',
      '/recipes/white-bean-soup/cook?servings=6',
    );
  });
});

describe('where an imported recipe came from', () => {
  /** The same render, over a recipe with a different `sourceUrl` on it. */
  function renderWith(recipe: Record<string, unknown>) {
    useGetQuery.mockReturnValue({ data: recipe, isLoading: false, isError: false });
    return renderView();
  }

  it('shows the site as a link, with the whole address behind it', () => {
    const url = 'https://www.budgetbytes.com/garlic-butter-baked-chicken-thighs/?utm_source=x';
    renderWith({ ...RECIPE, sourceUrl: url });

    const link = screen.getByRole('link', { name: 'budgetbytes.com' });
    expect(link).toHaveAttribute('href', url);
    expect(link).toHaveAttribute('title', url);
    // Opened away from the app, and told not to hand the opener a window handle.
    expect(link).toHaveAttribute('rel', expect.stringContaining('noopener'));
  });

  it('shows nothing at all for a recipe typed by hand', () => {
    renderWith({ ...RECIPE, sourceUrl: null });
    expect(screen.queryByText('Source')).not.toBeInTheDocument();
  });

  it.each([
    ['javascript:alert(1)', 'a script that would run for everybody in the household'],
    ['data:text/html,<script>alert(1)</script>', 'a document the browser would treat as ours'],
    ['//evil.example/recipe', 'a protocol-relative link off this origin'],
    ['not a url at all', 'a value that does not parse'],
  ])('refuses to render %s', (sourceUrl) => {
    // `recipe.create` refuses the first three, so this is the second lock rather than the only
    // one: React does not sanitize an href. The last one is the parse failure, which has to
    // degrade to "show nothing" rather than throw on a screen the cook is reading.
    renderWith({ ...RECIPE, sourceUrl });
    expect(screen.queryByRole('link', { name: /alert|evil|not a url/i })).not.toBeInTheDocument();
    expect(screen.queryByText('Source')).not.toBeInTheDocument();
  });

  it('deletes only after an in-page confirmation', () => {
    renderView();
    fireEvent.click(screen.getByRole('button', { name: 'Delete recipe' }));
    expect(deleteMutate).not.toHaveBeenCalled();
    const confirm = screen.getByRole('group', { name: 'Confirm delete' });
    fireEvent.click(within(confirm).getByRole('button', { name: 'Cancel' }));
    expect(screen.queryByRole('group', { name: 'Confirm delete' })).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'Delete recipe' }));
    fireEvent.click(screen.getByRole('button', { name: 'Yes, delete' }));
    expect(deleteMutate).toHaveBeenCalledWith({ id: 'r1' });
  });

  it('shows a book source typed in by the cook', () => {
    useGetQuery.mockReturnValue({
      data: { ...RECIPE, sourceUrl: null, sourceName: 'Joy of Cooking, p. 212' },
      isLoading: false,
      isError: false,
    });
    renderView();
    expect(screen.getByText('Source')).toBeInTheDocument();
    expect(screen.getByText('Joy of Cooking, p. 212')).toBeInTheDocument();
  });

  it('shows a named source and its link on one line', () => {
    renderWith({
      ...RECIPE,
      sourceName: 'King Arthur',
      sourceUrl: 'https://www.kingarthurbaking.com/r',
    });
    const line = screen.getByText('Source').parentElement!;
    expect(within(line).getByText('King Arthur')).toBeInTheDocument();
    expect(within(line).getByRole('link', { name: 'kingarthurbaking.com' })).toBeInTheDocument();
  });
});

describe('RecipeView links to other recipes', () => {
  it('opens the linked recipe from its ingredient line and lists where it is used', () => {
    const dough = {
      id: 'i3',
      position: 2,
      quantity: 1,
      unit: null,
      note: null,
      rawText: '1 pizza dough',
      scalingMode: 'linear',
      foodId: 'f3',
      foodName: 'pizza dough',
      department: null,
      linkedRecipe: { id: 'r2', slug: 'pizza-dough', title: 'Pizza Dough' },
    };
    useGetQuery.mockReturnValue({
      data: {
        ...RECIPE,
        ingredients: [...RECIPE.ingredients, dough],
        usedIn: [{ id: 'r3', slug: 'party', title: 'Pizza Party' }],
      },
      isLoading: false,
      isError: false,
    });
    render(
      <MemoryRouter initialEntries={['/recipes/white-bean-soup']}>
        <Routes>
          <Route path="/recipes/:slug" element={<RecipeView />} />
        </Routes>
      </MemoryRouter>,
    );

    expect(screen.getByRole('link', { name: 'Made from Pizza Dough' })).toHaveAttribute(
      'href',
      '/recipes/pizza-dough',
    );
    expect(screen.getByRole('link', { name: 'Pizza Party' })).toHaveAttribute(
      'href',
      '/recipes/party',
    );
  });
});

describe('rating a recipe', () => {
  it('sets the household’s rating and shows how recent cooks went, oldest to newest', () => {
    const setRating = vi.fn();
    (trpc.recipe.setRating.useMutation as unknown as Mock).mockReturnValue({ mutate: setRating });
    (trpc.cookLog.list.useQuery as unknown as Mock).mockReturnValue({
      data: [
        { id: 'c', cookedOn: '2026-09-20', rating: 5, photoIds: [] },
        { id: 'b', cookedOn: '2026-09-10', rating: null, photoIds: [] },
        { id: 'a', cookedOn: '2026-09-01', rating: 3, photoIds: [] },
      ],
    });
    useGetQuery.mockReturnValue({
      data: { ...RECIPE, rating: 4 },
      isLoading: false,
      isError: false,
    });
    renderView();
    const stars = screen.getByRole('group', { name: 'Your rating' });
    expect(within(stars).getByRole('button', { name: '4 stars' })).toHaveAttribute(
      'aria-pressed',
      'true',
    );
    expect(screen.getByText('Recent cooks: 3 → 5')).toBeInTheDocument();
    fireEvent.click(within(stars).getByRole('button', { name: '5 stars' }));
    expect(setRating).toHaveBeenCalledWith({ id: 'r1', rating: 5 });
  });
});

describe('reading amounts in grams', () => {
  const withGrams = () =>
    useGetQuery.mockReturnValue({
      data: {
        ...RECIPE,
        ingredients: [
          { ...RECIPE.ingredients[0]!, quantity: 3, altQuantity: 360, altUnit: 'g' },
          ...RECIPE.ingredients.slice(1),
        ],
      },
      isLoading: false,
      isError: false,
    });

  beforeEach(() => {
    localStorage.clear();
  });

  it('has no switch for a recipe that prints one measure', () => {
    renderView();
    expect(screen.queryByRole('radiogroup', { name: 'Measures' })).not.toBeInTheDocument();
  });

  it('shows the printed grams, scaled, once Metric is picked, and remembers it', () => {
    withGrams();
    renderView();
    const flour = () => screen.getByText('flour').closest('li') as HTMLElement;
    expect(flour()).toHaveTextContent(/3 cups/);

    fireEvent.click(screen.getByRole('radio', { name: 'Metric' }));
    expect(flour()).toHaveTextContent(/360 g/);
    fireEvent.click(screen.getByRole('button', { name: 'Increase servings' }));
    // 4 → 5 servings: 450 g.
    expect(flour()).toHaveTextContent(/450 g/);
    // Salt has one measure, and keeps showing it.
    expect(screen.getByText('salt').closest('li')).toHaveTextContent('to taste');

    cleanup();
    withGrams();
    renderView();
    expect(screen.getByRole('radio', { name: 'Metric' })).toHaveAttribute('aria-checked', 'true');
  });
});
