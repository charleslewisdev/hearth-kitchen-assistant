import { describe, it, expect, vi, beforeEach, type Mock } from 'vitest';
import { render, screen, fireEvent, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { Library } from './Library';
import { trpc } from '../lib/trpc';

// Mock the typed tRPC client. The Library touches four hooks: the recipe list it renders, the
// tag counts behind the quick chips, the food suggestions behind the `contains {ingredient}`
// token, and the multi-add mutation.
vi.mock('../lib/trpc', () => ({
  trpc: {
    recipe: { list: { useQuery: vi.fn() }, tagCounts: { useQuery: vi.fn() } },
    food: { list: { useQuery: vi.fn() } },
    shoppingList: { addRecipe: { useMutation: vi.fn() } },
    // The Tags screen's chosen colours. None chosen: every chip wears its default.
    tag: { all: { useQuery: vi.fn(() => ({ data: [] })) } },
  },
}));

const useListQuery = trpc.recipe.list.useQuery as unknown as Mock;
const useTagCountsQuery = trpc.recipe.tagCounts.useQuery as unknown as Mock;
const useFoodQuery = trpc.food.list.useQuery as unknown as Mock;
const useAddRecipeMutation = trpc.shoppingList.addRecipe.useMutation as unknown as Mock;

// The extra `foods` field exists only for the stand-in server below. The component renders
// `RecipeCard` fields and never reads it.
const CARDS = [
  {
    id: 'r1',
    title: 'White Bean Soup',
    slug: 'white-bean-soup',
    description: null,
    servings: 4,
    mealTypes: ['dinner'] as const,
    prepMinutes: 10,
    cookMinutes: 30,
    tags: ['Quick'],
    foods: ['white bean'],
    createdAt: '2026-09-03T00:00:00.000Z',
    updatedAt: '2026-09-03T00:00:00.000Z',
    rating: 3,
    cookCount: 1,
    lastCookedOn: '2026-09-01',
  },
  {
    id: 'r2',
    title: 'Morning Oats',
    slug: 'morning-oats',
    description: null,
    servings: 2,
    mealTypes: ['breakfast'] as const,
    prepMinutes: null,
    cookMinutes: null,
    tags: ['Vegetarian'],
    foods: ['oat'],
    createdAt: '2026-09-02T00:00:00.000Z',
    updatedAt: '2026-09-20T00:00:00.000Z',
    rating: null,
    cookCount: 0,
    lastCookedOn: null,
  },
  {
    id: 'r3',
    title: 'Roasted Chicken',
    slug: 'roasted-chicken',
    description: null,
    servings: 6,
    mealTypes: ['dinner'] as const,
    prepMinutes: 15,
    cookMinutes: 90,
    tags: ['Quick', 'Sunday'],
    foods: ['chicken', 'tomato'],
    createdAt: '2026-09-01T00:00:00.000Z',
    updatedAt: '2026-09-01T00:00:00.000Z',
    rating: 5,
    cookCount: 3,
    lastCookedOn: '2026-08-15',
  },
];

const TAG_COUNTS = [
  { name: 'Quick', normalizedName: 'quick', count: 2 },
  { name: 'Sunday', normalizedName: 'sunday', count: 1 },
  { name: 'Vegetarian', normalizedName: 'vegetarian', count: 1 },
];

type SearchParams = {
  text?: string;
  ingredient?: string;
  mealType?: string;
  tag?: string;
};

/**
 * A stand-in for the search endpoint, NOT a copy of it.
 *
 * It exists so a test about the Library can assert on the grid that comes back rather than on
 * the arguments the component passed, which is the difference between "typing filters the grid"
 * and "typing calls a function". Its matching is deliberately crude - the real normalization,
 * ranking and tag prefixing are covered against a real Postgres in `repo/recipes.test.ts`, and
 * duplicating them here would only mean two implementations to keep in step.
 */
function matches(card: (typeof CARDS)[number], params: SearchParams): boolean {
  if (params.text !== undefined) {
    const needle = params.text.toLowerCase();
    const hit =
      card.title.toLowerCase().includes(needle) ||
      card.tags.some((t) => t.toLowerCase().startsWith(needle));
    if (!hit) return false;
  }
  if (params.mealType !== undefined && !card.mealTypes.some((m) => m === params.mealType)) {
    return false;
  }
  if (
    params.tag !== undefined &&
    !card.tags.some((t) => t.toLowerCase() === params.tag!.toLowerCase())
  ) {
    return false;
  }
  if (params.ingredient !== undefined) {
    const needle = params.ingredient.toLowerCase();
    if (!card.foods.some((f) => needle.startsWith(f))) return false;
  }
  return true;
}

let mutateAsync: Mock;

/** A query whose result is fixed, for the loading / error / empty-library cases. */
function mockQuery(overrides: Record<string, unknown>) {
  useListQuery.mockReturnValue({
    data: undefined,
    isLoading: false,
    isError: false,
    ...overrides,
  });
}

/** A query that answers each set of parameters, for the tests about searching. */
function mockSearchableLibrary(cards = CARDS) {
  useListQuery.mockImplementation((params: SearchParams = {}) => ({
    data: cards.filter((c) => matches(c, params)),
    isLoading: false,
    isError: false,
  }));
}

/** The parameters the component asked the search for on its most recent render. */
function lastSearchParams(): SearchParams {
  const call = useListQuery.mock.calls.at(-1);
  return (call?.[0] as SearchParams | undefined) ?? {};
}

beforeEach(() => {
  localStorage.clear();
  mutateAsync = vi.fn().mockResolvedValue({});
  useAddRecipeMutation.mockReturnValue({ mutateAsync, isPending: false });
  useTagCountsQuery.mockReturnValue({ data: TAG_COUNTS });
  useFoodQuery.mockReturnValue({ data: [] });
});

function renderLibrary() {
  return render(
    <MemoryRouter>
      <Library />
    </MemoryRouter>,
  );
}

const searchBox = () => screen.getByLabelText('Search recipes');
const titlesOnScreen = () => screen.getAllByRole('heading', { level: 2 }).map((h) => h.textContent);

describe('Library', () => {
  it('renders recipe cards that link to their view route', () => {
    mockQuery({ data: CARDS });
    renderLibrary();

    expect(screen.getByRole('heading', { name: 'White Bean Soup' })).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: 'Morning Oats' })).toBeInTheDocument();

    expect(screen.getByRole('link', { name: /White Bean Soup/ })).toHaveAttribute(
      'href',
      '/recipes/white-bean-soup',
    );
    expect(screen.getByRole('link', { name: /Morning Oats/ })).toHaveAttribute(
      'href',
      '/recipes/morning-oats',
    );
  });

  it('shows a card’s types, tags, servings and total time, and no time when there is none', () => {
    mockQuery({ data: CARDS });
    renderLibrary();

    const soup = screen.getByRole('link', { name: /White Bean Soup/ });
    expect(within(soup).getByLabelText('Recipe type')).toHaveTextContent('Dinner');
    expect(
      within(within(soup).getByRole('list', { name: 'Tags' })).getByText('Quick'),
    ).toBeVisible();
    expect(within(soup).getByText('Serves 4')).toBeInTheDocument();
    expect(within(soup).getByText('40 min')).toBeInTheDocument();
    // 15 + 90 minutes.
    expect(
      within(screen.getByRole('link', { name: /Roasted Chicken/ })).getByText('1 h 45 min'),
    ).toBeInTheDocument();
    const oats = screen.getByRole('link', { name: /Morning Oats/ });
    expect(within(oats).queryByText(/min/)).not.toBeInTheDocument();
    expect(
      screen.getByText('Tick recipes to add them to your shopping list together.'),
    ).toBeInTheDocument();
  });

  it('starts filtered to the tag in the URL, from the Tags screen', () => {
    mockQuery({ data: CARDS });
    render(
      <MemoryRouter initialEntries={['/recipes?tag=Sunday']}>
        <Library />
      </MemoryRouter>,
    );
    expect(useListQuery).toHaveBeenLastCalledWith({ tag: 'Sunday' }, expect.anything());
  });

  it('shows the first four tags and a count of the rest', () => {
    mockQuery({
      data: [{ ...CARDS[0]!, tags: ['A', 'B', 'C', 'D', 'E', 'F'] }],
    });
    renderLibrary();
    const tags = screen.getByRole('list', { name: 'Tags' });
    expect(
      within(tags)
        .getAllByRole('listitem')
        .map((li) => li.textContent),
    ).toEqual(['A', 'B', 'C', 'D', '+2']);
  });

  it('sorts by title, by quickest with unknown times last, and by last edited', () => {
    mockQuery({ data: CARDS });
    renderLibrary();
    const titles = () => screen.getAllByRole('heading', { level: 2 }).map((h) => h.textContent);
    expect(titles()).toEqual(['White Bean Soup', 'Morning Oats', 'Roasted Chicken']);

    const sort = screen.getByLabelText('Sort recipes');
    fireEvent.change(sort, { target: { value: 'title' } });
    expect(titles()).toEqual(['Morning Oats', 'Roasted Chicken', 'White Bean Soup']);
    fireEvent.change(sort, { target: { value: 'time' } });
    expect(titles()).toEqual(['White Bean Soup', 'Roasted Chicken', 'Morning Oats']);
    fireEvent.change(sort, { target: { value: 'updated' } });
    expect(titles()).toEqual(['Morning Oats', 'White Bean Soup', 'Roasted Chicken']);
  });

  it('sorts by rating and by cooking, with the unrated and never cooked last', () => {
    mockQuery({ data: CARDS });
    renderLibrary();
    const titles = () => screen.getAllByRole('heading', { level: 2 }).map((h) => h.textContent);
    const sort = screen.getByLabelText('Sort recipes');
    fireEvent.change(sort, { target: { value: 'rating' } });
    expect(titles()).toEqual(['Roasted Chicken', 'White Bean Soup', 'Morning Oats']);
    fireEvent.change(sort, { target: { value: 'cooked' } });
    expect(titles()).toEqual(['White Bean Soup', 'Roasted Chicken', 'Morning Oats']);
    fireEvent.change(sort, { target: { value: 'mostCooked' } });
    expect(titles()).toEqual(['Roasted Chicken', 'White Bean Soup', 'Morning Oats']);
    const chicken = screen.getByRole('link', { name: /Roasted Chicken/ });
    expect(within(chicken).getByLabelText('Rated 5 out of 5')).toBeInTheDocument();
    expect(within(chicken).getByText(/^Cooked 3× · last/)).toBeInTheDocument();
  });

  it('switches to a list and remembers the view and sort on this device', () => {
    mockQuery({ data: CARDS });
    const first = renderLibrary();
    fireEvent.click(screen.getByRole('button', { name: 'List' }));
    fireEvent.change(screen.getByLabelText('Sort recipes'), { target: { value: 'title' } });
    expect(screen.getByRole('button', { name: 'List' })).toHaveAttribute('aria-pressed', 'true');
    first.unmount();

    renderLibrary();
    expect(screen.getByRole('button', { name: 'List' })).toHaveAttribute('aria-pressed', 'true');
    expect(screen.getByLabelText('Sort recipes')).toHaveValue('title');
    // Selection still works from a row.
    fireEvent.click(screen.getByRole('checkbox', { name: 'Select White Bean Soup' }));
    expect(screen.getByRole('button', { name: 'Add 1 to shopping list' })).toBeInTheDocument();
  });

  it('adds selected recipes to the shopping list at their base servings', async () => {
    mockQuery({ data: CARDS });
    renderLibrary();

    fireEvent.click(screen.getByRole('checkbox', { name: 'Select White Bean Soup' }));
    fireEvent.click(screen.getByRole('button', { name: 'Add 1 to shopping list' }));

    expect(mutateAsync).toHaveBeenCalledTimes(1);
    expect(mutateAsync).toHaveBeenCalledWith({ recipeId: 'r1', servings: 4 });

    // Confirmation shows and selection clears (action bar gone).
    expect(await screen.findByRole('status')).toHaveTextContent(/added 1 recipe/i);
    expect(screen.queryByRole('button', { name: /shopping list/ })).not.toBeInTheDocument();
  });

  it('surfaces an error and keeps the selection when the multi-add fails', async () => {
    mutateAsync.mockRejectedValue(new Error('nope'));
    mockQuery({ data: CARDS });
    renderLibrary();

    fireEvent.click(screen.getByRole('checkbox', { name: 'Select White Bean Soup' }));
    fireEvent.click(screen.getByRole('button', { name: 'Add 1 to shopping list' }));

    // Error alert appears, no success confirmation.
    expect(await screen.findByRole('alert')).toHaveTextContent(/shopping list/i);
    expect(screen.queryByRole('status')).not.toBeInTheDocument();

    // Selection is kept so the button remains for a retry.
    expect(screen.getByRole('button', { name: 'Add 1 to shopping list' })).toBeInTheDocument();
  });

  it('shows a friendly empty state with a new-recipe call to action', () => {
    mockQuery({ data: [] });
    renderLibrary();

    expect(screen.getByText('No recipes yet')).toBeInTheDocument();
    const newLinks = screen.getAllByRole('link', { name: /New recipe/ });
    expect(newLinks.length).toBeGreaterThan(0);
    for (const link of newLinks) {
      expect(link).toHaveAttribute('href', '/recipes/new');
    }
  });
});

describe('Library search', () => {
  it('narrows the grid as the cook types', () => {
    mockSearchableLibrary();
    renderLibrary();
    expect(titlesOnScreen()).toHaveLength(3);

    fireEvent.change(searchBox(), { target: { value: 'oats' } });

    expect(lastSearchParams()).toEqual({ text: 'oats' });
    expect(titlesOnScreen()).toEqual(['Morning Oats']);
    // Typed text is not a sheet filter, so the sheet button carries no count for it.
    expect(screen.getByRole('button', { name: 'Filters' })).toBeInTheDocument();
  });

  it('sends no text filter for a box holding only spaces', () => {
    mockSearchableLibrary();
    renderLibrary();

    fireEvent.change(searchBox(), { target: { value: '   ' } });

    expect(lastSearchParams()).toEqual({});
    expect(titlesOnScreen()).toHaveLength(3);
  });

  it('offers a removable "contains" token from the food suggestions', () => {
    useFoodQuery.mockReturnValue({
      data: [{ id: 'f1', name: 'Tomatoes', normalizedName: 'tomato' }],
    });
    mockSearchableLibrary();
    renderLibrary();

    fireEvent.change(searchBox(), { target: { value: 'tom' } });
    fireEvent.click(screen.getByRole('button', { name: 'contains Tomatoes' }));

    // Choosing the token replaces the typed text with the filter it stands for.
    expect(lastSearchParams()).toEqual({ ingredient: 'Tomatoes' });
    expect(searchBox()).toHaveValue('');
    expect(titlesOnScreen()).toEqual(['Roasted Chicken']);

    fireEvent.click(screen.getByRole('button', { name: 'Remove filter contains Tomatoes' }));

    expect(lastSearchParams()).toEqual({});
    expect(titlesOnScreen()).toHaveLength(3);
  });

  it('narrows the grid from a meal-type chip, with no typing', () => {
    mockSearchableLibrary();
    renderLibrary();

    const chip = screen.getByRole('button', { name: 'breakfast' });
    expect(chip).toHaveAttribute('aria-pressed', 'false');
    fireEvent.click(chip);

    expect(lastSearchParams()).toEqual({ mealType: 'breakfast' });
    expect(titlesOnScreen()).toEqual(['Morning Oats']);
    expect(screen.getByRole('button', { name: 'Filters (1)' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'breakfast' })).toHaveAttribute(
      'aria-pressed',
      'true',
    );

    // The same chip again clears it, rather than leaving no way back out.
    fireEvent.click(screen.getByRole('button', { name: 'breakfast' }));
    expect(lastSearchParams()).toEqual({});
    expect(titlesOnScreen()).toHaveLength(3);
  });

  it('shows each popular tag chip with the number of recipes behind it', () => {
    mockSearchableLibrary();
    renderLibrary();

    const chip = screen.getByRole('button', { name: 'Quick 2' });
    fireEvent.click(chip);

    expect(lastSearchParams()).toEqual({ tag: 'Quick' });
    expect(titlesOnScreen()).toEqual(['White Bean Soup', 'Roasted Chicken']);
  });

  it('combines filters chosen in the Filters sheet', () => {
    mockSearchableLibrary();
    renderLibrary();

    const filters = screen.getByRole('button', { name: /^Filters/ });
    expect(filters).toHaveAttribute('aria-expanded', 'false');
    fireEvent.click(filters);
    expect(screen.getByRole('button', { name: /^Filters/ })).toHaveAttribute(
      'aria-expanded',
      'true',
    );

    const sheet = screen.getByRole('group', { name: 'Filters' });
    fireEvent.click(within(sheet).getByRole('button', { name: 'dinner' }));
    fireEvent.click(within(sheet).getByRole('button', { name: 'Quick 2' }));

    expect(lastSearchParams()).toEqual({ mealType: 'dinner', tag: 'Quick' });
    expect(titlesOnScreen()).toEqual(['White Bean Soup', 'Roasted Chicken']);
  });

  it('says nothing matched instead of rendering an empty grid', () => {
    mockSearchableLibrary();
    renderLibrary();

    fireEvent.change(searchBox(), { target: { value: 'zzzz' } });

    expect(screen.queryByRole('heading', { level: 2 })).not.toBeInTheDocument();
    expect(screen.getByText('No recipes match')).toBeInTheDocument();
    // Not the empty-library state, which would tell a cook with 3 recipes to add their first.
    expect(screen.queryByText('No recipes yet')).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'Clear filters' }));
    expect(searchBox()).toHaveValue('');
    expect(titlesOnScreen()).toHaveLength(3);
  });

  it('drops a filtered-out recipe from the multi-add rather than silently doing nothing', () => {
    mockSearchableLibrary();
    renderLibrary();

    fireEvent.click(screen.getByRole('checkbox', { name: 'Select Morning Oats' }));
    expect(screen.getByRole('button', { name: 'Add 1 to shopping list' })).toBeInTheDocument();

    fireEvent.change(searchBox(), { target: { value: 'soup' } });

    expect(screen.queryByRole('button', { name: /shopping list/ })).not.toBeInTheDocument();
  });

  it('labels the search box and keeps every control keyboard reachable', () => {
    mockSearchableLibrary();
    renderLibrary();

    // A real label, not a placeholder: `getByLabelText` fails on a placeholder alone.
    const box = searchBox();
    expect(box.tagName).toBe('INPUT');
    box.focus();
    expect(box).toHaveFocus();

    // Chips and the Filters toggle are focusable elements rather than clickable divs, which is
    // what `.focus()` landing on them proves - a div with an onClick would leave focus on body.
    for (const name of ['breakfast', 'Quick 2', /^Filters/] as const) {
      const control = screen.getByRole('button', { name });
      control.focus();
      expect(control).toHaveFocus();
      expect(control.tabIndex).toBe(0);
    }
  });
});
