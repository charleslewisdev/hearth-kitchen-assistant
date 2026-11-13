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
      syncListServings: { useMutation: vi.fn() },
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
const useSync = trpc.plan.syncListServings.useMutation as unknown as Mock;
const useRecipes = trpc.recipe.list.useQuery as unknown as Mock;
const useUtils = trpc.useUtils as unknown as Mock;

let addMutate: Mock;
let updateMutate: Mock;
let removeMutate: Mock;
let buildMutate: Mock;
let syncMutate: Mock;

const START = '2026-09-20';

function entry(over: Record<string, unknown> = {}) {
  return {
    id: 'e1',
    date: '2026-09-22',
    meal: 'dinner',
    servings: 4,
    onList: false,
    listServings: null,
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
  syncMutate = vi.fn();
  useSync.mockReturnValue({ mutate: syncMutate, isPending: false });
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

  it('applies a move to the cached week at once and puts it back if the server refuses', async () => {
    const cached = { start: START, weekStart: 0, entries: [entry()] };
    let data: unknown = cached;
    const week = {
      invalidate: vi.fn(),
      cancel: vi.fn(),
      getData: vi.fn(() => data),
      setData: vi.fn((_input: unknown, next: unknown) => {
        data = typeof next === 'function' ? (next as (old: unknown) => unknown)(data) : next;
      }),
    };
    useUtils.mockReturnValue({ plan: { week }, shoppingList: { get: { invalidate: vi.fn() } } });
    mockWeek([entry()]);
    renderPlan();
    const options = useUpdate.mock.lastCall![0];
    const move = { id: 'e1', date: '2026-09-24', meal: 'lunch' };

    const context = await options.onMutate(move);
    expect(week.cancel).toHaveBeenCalled();
    expect(week.getData).toHaveBeenCalledWith({ date: localToday() });
    expect(data).toMatchObject({
      entries: [{ id: 'e1', date: '2026-09-24', meal: 'lunch', servings: 4, onList: false }],
    });

    options.onError(new Error('refused'), move, context);
    expect(data).toBe(cached);
    options.onSettled();
    expect(week.invalidate).toHaveBeenCalled();
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

describe('dragging a meal on a desktop', () => {
  // A wide screen with a mouse is the only setting in which entries are draggable.
  // Only this spy is restored afterwards: restoreAllMocks would also strip the implementation
  // from test-setup's own matchMedia stub, and every later test would crash on it.
  let media: { mockRestore: () => void } | undefined;
  function desktop(matches: boolean) {
    media = vi.spyOn(window, 'matchMedia').mockImplementation(
      (query: string) =>
        ({
          matches,
          media: query,
          addEventListener: vi.fn(),
          removeEventListener: vi.fn(),
        }) as unknown as MediaQueryList,
    );
  }
  afterEach(() => media?.mockRestore());

  function drag(from: HTMLElement, to: HTMLElement) {
    const dataTransfer = {
      setData: vi.fn(),
      getData: vi.fn(() => ''),
      effectAllowed: '',
      dropEffect: '',
    };
    fireEvent.dragStart(from, { dataTransfer });
    fireEvent.dragEnter(to, { dataTransfer });
    fireEvent.dragOver(to, { dataTransfer });
    fireEvent.drop(to, { dataTransfer });
    fireEvent.dragEnd(from, { dataTransfer });
  }

  const soup = () => screen.getByRole('link', { name: 'Tomato Soup' }).closest('li')!;

  it('moves a meal onto an empty meal of another day', () => {
    desktop(true);
    mockWeek([entry()]);
    renderPlan();
    expect(soup()).toHaveAttribute('draggable', 'true');
    drag(soup(), screen.getByRole('button', { name: 'Add to Thursday Lunch' }));
    expect(updateMutate).toHaveBeenCalledWith({ id: 'e1', date: '2026-09-24', meal: 'lunch' });
  });

  it('adds a meal dropped on a planned slot alongside what is there', () => {
    desktop(true);
    mockWeek([
      entry(),
      entry({
        id: 'e2',
        date: '2026-09-23',
        recipe: { id: 'r3', slug: 'pilaf', title: 'Pilaf', servings: 6 },
      }),
    ]);
    renderPlan();
    drag(soup(), screen.getByRole('group', { name: 'Wednesday Dinner' }));
    expect(updateMutate).toHaveBeenCalledTimes(1);
    expect(updateMutate).toHaveBeenCalledWith({ id: 'e1', date: '2026-09-23', meal: 'dinner' });
  });

  it('does nothing when a meal is dropped back on its own slot', () => {
    desktop(true);
    mockWeek([entry()]);
    renderPlan();
    drag(soup(), screen.getByRole('group', { name: 'Tuesday Dinner' }));
    expect(updateMutate).not.toHaveBeenCalled();
  });

  it('does not make meals draggable on a phone, where Move does the job', () => {
    desktop(false);
    mockWeek([entry()]);
    renderPlan();
    expect(soup()).not.toHaveAttribute('draggable', 'true');
    drag(soup(), screen.getByRole('button', { name: 'Add to Thursday Lunch' }));
    expect(updateMutate).not.toHaveBeenCalled();
    expect(screen.getByRole('button', { name: 'Move' })).toBeInTheDocument();
  });
});

describe('servings changed after the list was built (#12)', () => {
  it('asks only when the list holds a different serving count', () => {
    mockWeek([
      entry({ id: 'e1', onList: true, servings: 4, listServings: 4 }),
      entry({ id: 'e2', meal: 'lunch', onList: false, servings: 6, listServings: null }),
    ]);
    renderPlan();
    expect(screen.queryByRole('button', { name: /update list/i })).not.toBeInTheDocument();
  });

  it('offers to update the list or leave it, and sends the choice', () => {
    mockWeek([entry({ onList: true, servings: 6, listServings: 4 })]);
    renderPlan();
    expect(screen.getByText(/list has amounts for 4 servings/i)).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: /update list/i }));
    expect(syncMutate).toHaveBeenCalledWith({ id: 'e1', choice: 'update' });
    fireEvent.click(screen.getByRole('button', { name: /leave it/i }));
    expect(syncMutate).toHaveBeenCalledWith({ id: 'e1', choice: 'leave' });
  });
});

describe('planner change failures', () => {
  it('says so when a move or servings change is refused', () => {
    useUpdate.mockReturnValue({ mutate: updateMutate, isPending: false, isError: true });
    mockWeek([entry()]);
    renderPlan();
    expect(screen.getByRole('alert')).toHaveTextContent(/back as it was/i);
  });

  it('says so when the list could not be updated', () => {
    useSync.mockReturnValue({ mutate: syncMutate, isPending: false, isError: true });
    mockWeek([entry({ onList: true, servings: 6, listServings: 4 })]);
    renderPlan();
    expect(screen.getByRole('alert')).toHaveTextContent(/couldn’t update the shopping list/i);
  });

  it('holds the list question while a servings change is on its way', () => {
    useUpdate.mockReturnValue({ mutate: updateMutate, isPending: true });
    mockWeek([entry({ onList: true, servings: 6, listServings: 4 })]);
    renderPlan();
    expect(screen.getByRole('button', { name: /update list/i })).toBeDisabled();
  });
});
