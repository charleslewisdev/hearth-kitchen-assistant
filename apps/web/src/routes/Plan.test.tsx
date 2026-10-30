import { describe, it, expect, vi, beforeEach, afterEach, type Mock } from 'vitest';
import { render, screen, fireEvent, cleanup, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { Plan, localToday } from './Plan';
import { trpc } from '../lib/trpc';

vi.mock('../lib/trpc', () => ({
  trpc: {
    useUtils: vi.fn(),
    plan: {
      week: { useQuery: vi.fn() },
      add: { useMutation: vi.fn() },
      update: { useMutation: vi.fn() },
      remove: { useMutation: vi.fn() },
      buildList: { useMutation: vi.fn() },
    },
    recipe: { list: { useQuery: vi.fn() } },
    cookLog: {
      add: { useMutation: vi.fn() },
      update: { useMutation: vi.fn(() => ({ mutateAsync: vi.fn(), isPending: false })) },
    },
    recipeFile: { upload: { useMutation: vi.fn(() => ({ mutateAsync: vi.fn() })) } },
  },
}));

const useWeek = trpc.plan.week.useQuery as unknown as Mock;
const useAdd = trpc.plan.add.useMutation as unknown as Mock;
const useUpdate = trpc.plan.update.useMutation as unknown as Mock;
const useRemove = trpc.plan.remove.useMutation as unknown as Mock;
const useBuild = trpc.plan.buildList.useMutation as unknown as Mock;
const useRecipes = trpc.recipe.list.useQuery as unknown as Mock;
const useUtils = trpc.useUtils as unknown as Mock;

let addMutate: Mock;
let updateMutate: Mock;
let removeMutate: Mock;
let buildMutate: Mock;

const START = '2026-09-20';

function entry(over: Record<string, unknown> = {}) {
  return {
    id: 'e1',
    date: '2026-09-22',
    meal: 'dinner',
    servings: 4,
    onList: false,
    recipe: { id: 'r1', slug: 'soup', title: 'Tomato Soup', servings: 4 },
    ...over,
  };
}

function mockWeek(entries: unknown[]) {
  useWeek.mockReturnValue({
    data: { start: START, weekStart: 0, entries },
    isLoading: false,
    isError: false,
  });
}

beforeEach(() => {
  addMutate = vi.fn();
  updateMutate = vi.fn();
  removeMutate = vi.fn();
  buildMutate = vi.fn();
  useAdd.mockReturnValue({ mutate: addMutate, isPending: false, isError: false });
  useUpdate.mockReturnValue({ mutate: updateMutate, isPending: false });
  useRemove.mockReturnValue({ mutate: removeMutate, isPending: false });
  useBuild.mockReturnValue({ mutate: buildMutate, isPending: false });
  useRecipes.mockReturnValue({
    data: [{ id: 'r2', title: 'Pilaf', slug: 'pilaf', servings: 6 }],
    isLoading: false,
  });
  useUtils.mockReturnValue({
    plan: { week: { invalidate: vi.fn() } },
    shoppingList: { get: { invalidate: vi.fn() } },
  });
});

afterEach(cleanup);

function renderPlan() {
  return render(
    <MemoryRouter>
      <Plan />
    </MemoryRouter>,
  );
}

describe('localToday', () => {
  it('formats the local calendar day', () => {
    expect(localToday(new Date(2026, 0, 5, 23, 59))).toBe('2026-01-05');
  });
});

describe('Plan', () => {
  it('shows seven days, each empty meal as one small add button', () => {
    mockWeek([]);
    renderPlan();
    expect(screen.getAllByRole('article')).toHaveLength(7);
    // An empty week has no meal rows at all, only the pills to fill them.
    expect(screen.queryByRole('heading', { name: 'Dinner' })).not.toBeInTheDocument();
    expect(screen.getAllByRole('button', { name: /^Add to \w+ Dinner$/ })).toHaveLength(7);
    expect(screen.getByRole('button', { name: 'Add to Tuesday Breakfast' })).toHaveTextContent(
      '+ Breakfast',
    );
  });

  it('gives a planned meal its own row and leaves the others as pills', () => {
    mockWeek([entry()]);
    renderPlan();
    const tuesday = screen.getByRole('article', { name: /September 22/ });
    expect(within(tuesday).getByRole('heading', { name: 'Dinner' })).toBeInTheDocument();
    expect(within(tuesday).queryByRole('heading', { name: 'Lunch' })).not.toBeInTheDocument();
    // Dinner's add button is the row's "+ Add"; breakfast and lunch are pills.
    expect(
      within(tuesday).getByRole('button', { name: 'Add to Tuesday Dinner' }),
    ).toHaveTextContent('+ Add');
    expect(within(tuesday).getByRole('button', { name: 'Add to Tuesday Lunch' })).toHaveTextContent(
      '+ Lunch',
    );
  });

  it('puts an entry in its day and meal', () => {
    mockWeek([entry()]);
    renderPlan();
    const tuesday = screen.getByRole('article', { name: /September 22/ });
    expect(within(tuesday).getByRole('link', { name: 'Tomato Soup' })).toHaveAttribute(
      'href',
      '/recipes/soup',
    );
    const monday = screen.getByRole('article', { name: /September 21/ });
    expect(within(monday).queryByText('Tomato Soup')).not.toBeInTheDocument();
  });

  it('changes servings and removes', () => {
    mockWeek([entry()]);
    renderPlan();
    fireEvent.click(screen.getByRole('button', { name: 'More servings of Tomato Soup' }));
    expect(updateMutate).toHaveBeenCalledWith({ id: 'e1', servings: 5 });
    fireEvent.click(screen.getByRole('button', { name: 'Remove Tomato Soup' }));
    expect(removeMutate).toHaveBeenCalledWith({ id: 'e1' });
  });

  it('adds a recipe through the picker with its own servings as the default', () => {
    mockWeek([]);
    renderPlan();
    fireEvent.click(screen.getByRole('button', { name: 'Add to Wednesday Lunch' }));
    const sheet = screen.getByRole('dialog');
    fireEvent.click(within(sheet).getByRole('button', { name: /Pilaf/ }));
    expect(within(sheet).getByLabelText('Servings')).toHaveValue(6);
    fireEvent.click(within(sheet).getByRole('button', { name: 'Add to plan' }));
    expect(addMutate).toHaveBeenCalledWith({
      date: '2026-09-23',
      meal: 'lunch',
      recipeId: 'r2',
      servings: 6,
    });
  });

  it('builds the list for the week and counts only meals not on it yet', () => {
    mockWeek([entry(), entry({ id: 'e2', onList: true })]);
    renderPlan();
    const build = screen.getByRole('button', { name: /Build shopping list \(1 new\)/ });
    fireEvent.click(build);
    expect(buildMutate).toHaveBeenCalledWith({ start: START });
  });

  it('disables build when everything is on the list', () => {
    mockWeek([entry({ onList: true })]);
    renderPlan();
    expect(screen.getByRole('button', { name: /Build shopping list/ })).toBeDisabled();
    expect(screen.getByText('On list')).toBeInTheDocument();
  });

  it('moves an entry to another day and meal', () => {
    mockWeek([entry()]);
    renderPlan();
    fireEvent.click(screen.getByRole('button', { name: 'Move' }));
    const sheet = screen.getByRole('dialog');
    fireEvent.change(within(sheet).getByLabelText('Day'), { target: { value: '2026-09-24' } });
    fireEvent.change(within(sheet).getByLabelText('Meal'), { target: { value: 'lunch' } });
    fireEvent.click(within(sheet).getByRole('button', { name: 'Move' }));
    expect(updateMutate).toHaveBeenCalledWith(
      { id: 'e1', date: '2026-09-24', meal: 'lunch' },
      expect.anything(),
    );
  });

  it('steps to the next week', () => {
    mockWeek([]);
    renderPlan();
    fireEvent.click(screen.getByRole('button', { name: 'Next ›' }));
    expect(useWeek).toHaveBeenLastCalledWith({ date: '2026-09-27' }, expect.anything());
  });
});

describe('logging a planned meal as cooked', () => {
  afterEach(() => vi.useRealTimers());

  it('offers Cooked it on today’s and earlier meals only, pre-filled from the plan', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date(2026, 8, 23, 18, 0));
    const addLog = vi.fn().mockResolvedValue({ id: 'log1' });
    (trpc.cookLog.add.useMutation as unknown as Mock).mockReturnValue({
      mutateAsync: addLog,
      isPending: false,
    });
    useUtils.mockReturnValue({
      plan: { week: { invalidate: vi.fn() } },
      shoppingList: { get: { invalidate: vi.fn() } },
      cookLog: { list: { invalidate: vi.fn() } },
      recipe: { list: { invalidate: vi.fn() }, get: { invalidate: vi.fn() } },
    });
    mockWeek([
      entry({ id: 'past', date: '2026-09-22', servings: 3 }),
      entry({
        id: 'later',
        date: '2026-09-25',
        recipe: { id: 'r3', slug: 'pilaf', title: 'Pilaf', servings: 6 },
      }),
    ]);
    renderPlan();
    expect(screen.queryByRole('button', { name: 'Cooked Pilaf' })).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Cooked Tomato Soup' }));

    const sheet = screen.getByRole('dialog', { name: 'Cooked Tomato Soup' });
    expect(within(sheet).getByLabelText('Cooked on')).toHaveValue('2026-09-22');
    expect(within(sheet).getByLabelText('Servings')).toHaveValue(3);
    fireEvent.click(within(sheet).getByRole('button', { name: 'Log it' }));
    expect(await screen.findByRole('status')).toHaveTextContent('Logged Tomato Soup.');
    expect(addLog).toHaveBeenCalledWith(
      expect.objectContaining({ recipeId: 'r1', cookedOn: '2026-09-22', servings: 3 }),
    );
  });
});
