import { describe, it, expect, vi, beforeEach, afterEach, type Mock } from 'vitest';
import { render, screen, fireEvent, act, within, cleanup } from '@testing-library/react';
import { MemoryRouter, Routes, Route } from 'react-router-dom';
import { CookMode } from './CookMode';
import { trpc } from '../lib/trpc';

// The screen reads ONE query and calls nothing else. That is the point: checked steps are
// client state (D26), kept on the device and never written to the server, so a mock with no
// mutation on it would break the moment this screen tried to write cooking progress anywhere.
vi.mock('../lib/trpc', () => ({
  trpc: { recipe: { get: { useQuery: vi.fn() } } },
}));

const useRecipeQuery = trpc.recipe.get.useQuery as unknown as Mock;

function makeStep(id: string, position: number, text: string) {
  return { id, position, text };
}

function makeRecipe(overrides: Record<string, unknown> = {}) {
  return {
    id: 'r1',
    title: 'E2E Soup',
    slug: 'e2e-soup',
    description: null,
    servings: 4,
    prepMinutes: null,
    cookMinutes: null,
    sourceUrl: null,
    sourceName: null,
    mealTypes: [],
    tags: [],
    // Out of position order for the same reason as the steps below.
    ingredients: [
      {
        id: 'i2',
        position: 1,
        quantity: null,
        unit: null,
        note: 'to taste',
        rawText: 'salt to taste',
        scalingMode: 'linear',
        foodId: 'f2',
        foodName: 'salt',
        department: 'Pantry',
        linkedRecipe: null,
      },
      {
        id: 'i1',
        position: 0,
        quantity: 2,
        unit: 'cup',
        note: null,
        rawText: '2 cups broth',
        scalingMode: 'linear',
        foodId: 'f1',
        foodName: 'broth',
        department: 'Pantry',
        linkedRecipe: null,
      },
    ],
    // Deliberately NOT in position order: the screen sorts by position, and a fixture that
    // arrives pre-sorted lets that sort be deleted without a test noticing.
    steps: [
      makeStep('s2', 1, 'Whisk in the cream for 30 seconds, then serve.'),
      makeStep('s1', 0, 'Simmer the broth for 20 minutes.'),
    ],
    ...overrides,
  };
}

function mockRecipe(recipe: unknown) {
  useRecipeQuery.mockReturnValue({ data: recipe, isLoading: false, isError: false });
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

beforeEach(() => {
  localStorage.clear();
  mockRecipe(makeRecipe());
});

afterEach(() => {
  delete (navigator as { wakeLock?: unknown }).wakeLock;
  vi.restoreAllMocks();
});

function cookTree(path: string) {
  return (
    <MemoryRouter initialEntries={[path]}>
      <Routes>
        <Route path="/recipes/:slug/cook" element={<CookMode />} />
        <Route path="/recipes/:slug" element={<h1>Recipe view</h1>} />
      </Routes>
    </MemoryRouter>
  );
}

function renderCook(path = '/recipes/e2e-soup/cook') {
  return render(cookTree(path));
}

function tray() {
  return screen.getByRole('list', { name: 'Running timers' });
}

describe('CookMode', () => {
  it('renders the steps in order', () => {
    renderCook();
    const steps = screen.getAllByRole('checkbox');
    expect(steps).toHaveLength(2);
    expect(steps[0]).toHaveAccessibleName(/Step 1.*Simmer the broth/s);
    expect(steps[1]).toHaveAccessibleName(/Step 2.*Whisk in the cream/s);
  });

  it('checks a step off when it is tapped, and back on again', () => {
    renderCook();
    const first = screen.getAllByRole('checkbox')[0]!;
    expect(first).toHaveAttribute('aria-checked', 'false');

    fireEvent.click(first);
    expect(screen.getAllByRole('checkbox')[0]!).toHaveAttribute('aria-checked', 'true');

    fireEvent.click(screen.getAllByRole('checkbox')[0]!);
    expect(screen.getAllByRole('checkbox')[0]!).toHaveAttribute('aria-checked', 'false');
  });

  it('marks the first unchecked step as the current one, and moves it on', () => {
    renderCook();
    expect(screen.getByText(/Step 1 of 2/)).toBeInTheDocument();

    const items = screen.getAllByRole('listitem');
    expect(items[0]).toHaveAttribute('aria-current', 'step');
    expect(items[1]).not.toHaveAttribute('aria-current');

    fireEvent.click(screen.getAllByRole('checkbox')[0]!);

    const afterCheck = screen.getAllByRole('listitem');
    expect(afterCheck[0]).not.toHaveAttribute('aria-current');
    expect(afterCheck[1]).toHaveAttribute('aria-current', 'step');
    expect(screen.getByText(/Step 2 of 2/)).toBeInTheDocument();
  });

  it('opens at the top with step 1 focused, whatever the recipe screen was scrolled to', () => {
    const scrollTo = vi.spyOn(window, 'scrollTo');
    renderCook();
    expect(scrollTo).toHaveBeenCalledWith({ top: 0 });
    expect(screen.getAllByRole('checkbox')[0]).toHaveFocus();
  });

  it('opens a resumed session on the step the cook is up to', () => {
    const scrollIntoView = vi.fn();
    Element.prototype.scrollIntoView = scrollIntoView;
    const first = renderCook();
    fireEvent.click(screen.getAllByRole('checkbox')[0]!);
    first.unmount();

    const scrollTo = vi.spyOn(window, 'scrollTo');
    renderCook();
    const items = screen.getAllByRole('listitem');
    expect(scrollIntoView).toHaveBeenCalledTimes(1);
    expect(scrollIntoView.mock.contexts[0]).toBe(items[1]);
    expect(scrollTo).not.toHaveBeenCalled();
    expect(screen.getAllByRole('checkbox')[1]).toHaveFocus();
    delete (Element.prototype as { scrollIntoView?: unknown }).scrollIntoView;
  });

  it('says so when every step is checked', () => {
    renderCook();
    fireEvent.click(screen.getAllByRole('checkbox')[0]!);
    fireEvent.click(screen.getAllByRole('checkbox')[1]!);
    expect(screen.getByText(/All 2 steps done/)).toBeInTheDocument();
  });

  it('goes back to the recipe', () => {
    renderCook();
    fireEvent.click(screen.getByRole('link', { name: /back to recipe/i }));
    expect(screen.getByRole('heading', { name: 'Recipe view' })).toBeInTheDocument();
  });

  it('requests a screen wake lock on mount', async () => {
    const { request } = installWakeLock();
    renderCook();
    await act(async () => {});
    expect(request).toHaveBeenCalledWith('screen');
  });

  it('releases the wake lock when the screen is left', async () => {
    const { sentinel } = installWakeLock();
    const view = renderCook();
    await act(async () => {});
    expect(sentinel.release).not.toHaveBeenCalled();

    view.unmount();
    expect(sentinel.release).toHaveBeenCalledTimes(1);
  });

  it('re-requests the lock when the tab comes back, because the browser does not', async () => {
    const { request, sentinel } = installWakeLock();
    renderCook();
    await act(async () => {});
    expect(request).toHaveBeenCalledTimes(1);

    // What a browser does when the tab is hidden: it releases the lock and never restores it.
    sentinel.released = true;
    await act(async () => {
      document.dispatchEvent(new Event('visibilitychange'));
    });
    expect(request).toHaveBeenCalledTimes(2);
  });

  it('does not ask again while the lock it already holds is still held', async () => {
    const { request } = installWakeLock();
    renderCook();
    await act(async () => {});

    await act(async () => {
      document.dispatchEvent(new Event('visibilitychange'));
    });
    expect(request).toHaveBeenCalledTimes(1);
  });

  it('does not start a second request while the first is still in flight', async () => {
    // The sentinel is only assigned after the request resolves, so without an in-flight guard
    // a visibilitychange landing in that window starts a second lock and orphans the first,
    // which then keeps the screen awake after cook mode is left.
    let resolveRequest: ((sentinel: unknown) => void) | undefined;
    const sentinel = {
      released: false,
      release: vi.fn(async () => {
        sentinel.released = true;
      }),
    };
    const request = vi.fn(
      () =>
        new Promise((resolve) => {
          resolveRequest = resolve;
        }),
    );
    Object.defineProperty(navigator, 'wakeLock', {
      value: { request },
      configurable: true,
      writable: true,
    });

    renderCook();
    expect(request).toHaveBeenCalledTimes(1);

    await act(async () => {
      document.dispatchEvent(new Event('visibilitychange'));
    });
    expect(request).toHaveBeenCalledTimes(1);

    await act(async () => {
      resolveRequest?.(sentinel);
    });
    expect(request).toHaveBeenCalledTimes(1);
  });

  it('works with no Wake Lock API at all', () => {
    expect((navigator as { wakeLock?: unknown }).wakeLock).toBeUndefined();
    expect(() => renderCook()).not.toThrow();

    fireEvent.click(screen.getAllByRole('checkbox')[0]!);
    expect(screen.getAllByRole('checkbox')[0]!).toHaveAttribute('aria-checked', 'true');
  });

  it('works when the lock request is refused', async () => {
    const request = vi.fn(async () => {
      throw new DOMException('denied', 'NotAllowedError');
    });
    Object.defineProperty(navigator, 'wakeLock', {
      value: { request },
      configurable: true,
      writable: true,
    });

    renderCook();
    await act(async () => {});

    fireEvent.click(screen.getAllByRole('checkbox')[0]!);
    expect(screen.getAllByRole('checkbox')[0]!).toHaveAttribute('aria-checked', 'true');
  });

  it('makes only the duration inside a step tappable', () => {
    renderCook();
    const phrase = screen.getByRole('button', { name: /Start a timer for 20 minutes, step 1/ });
    expect(phrase).toHaveTextContent('20 minutes');
    // The words around it are text, not a second button.
    expect(screen.getAllByRole('button', { name: /Start a timer/ })).toHaveLength(2);
    expect(screen.getByText(/Simmer the broth for/)).toBeInTheDocument();
  });

  it('starts a timer in the tray when a duration is tapped', () => {
    renderCook();
    expect(screen.queryByRole('list', { name: 'Running timers' })).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: /Start a timer for 20 minutes, step 1/ }));

    expect(within(tray()).getByText('Step 1 · 20 minutes')).toBeInTheDocument();
    expect(within(tray()).getByText('20:00')).toBeInTheDocument();
  });

  it('does not check the step off when its duration is tapped', () => {
    // Weak on its own: in jsdom the phrase is a SIBLING of the toggle, so nothing could have
    // bubbled anyway. What actually delivers this is the stacking in CookMode.module.css, and
    // e2e/cook.spec.ts is where a real browser proves it. This guards a regression that put a
    // handler on the row itself.
    renderCook();
    fireEvent.click(screen.getByRole('button', { name: /Start a timer for 20 minutes, step 1/ }));
    expect(screen.getAllByRole('checkbox')[0]!).toHaveAttribute('aria-checked', 'false');
  });

  it('keeps a running timer when the step that started it is gone', () => {
    // The tray is what makes a timer reachable after the cook has scrolled past its step, so
    // the timer cannot be owned by the step: this unmounts step 2 underneath a running timer.
    const view = renderCook();
    fireEvent.click(screen.getByRole('button', { name: /Start a timer for 30 seconds, step 2/ }));
    expect(within(tray()).getByText('Step 2 · 30 seconds')).toBeInTheDocument();

    mockRecipe(makeRecipe({ steps: [makeStep('s1', 0, 'Simmer the broth for 20 minutes.')] }));
    view.rerender(cookTree('/recipes/e2e-soup/cook'));

    expect(
      screen.queryByRole('button', { name: /Start a timer for 30 seconds, step 2/ }),
    ).not.toBeInTheDocument();
    expect(within(tray()).getByText('Step 2 · 30 seconds')).toBeInTheDocument();
    expect(within(tray()).getByText('0:30')).toBeInTheDocument();
  });

  it('opens and closes the ingredient peek', () => {
    renderCook();
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'Ingredients' }));
    const sheet = screen.getByRole('dialog');
    const rows = within(sheet).getAllByRole('listitem');
    expect(rows[0]).toHaveTextContent('broth'); // position 0, though it is second in the data
    expect(rows[1]).toHaveTextContent('salt');

    fireEvent.click(within(sheet).getByRole('button', { name: /close/i }));
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  });

  it('peeks at the amounts the cook SCALED to, not the recipe base', () => {
    renderCook('/recipes/e2e-soup/cook?servings=8');
    fireEvent.click(screen.getByRole('button', { name: 'Ingredients' }));

    const sheet = screen.getByRole('dialog');
    expect(within(sheet).getByText('4 cups')).toBeInTheDocument();
    expect(within(sheet).queryByText('2 cups')).not.toBeInTheDocument();
    expect(within(sheet).getByText(/8 servings/)).toBeInTheDocument();
  });

  it('peeks in grams when the recipe prints them and the cook reads metric', () => {
    localStorage.setItem('hearth.measureSystem', 'metric');
    const recipe = makeRecipe();
    mockRecipe({
      ...recipe,
      ingredients: (recipe.ingredients as Record<string, unknown>[]).map((i) =>
        i.id === 'i1' ? { ...i, altQuantity: 480, altUnit: 'ml' } : i,
      ),
    });
    renderCook('/recipes/e2e-soup/cook?servings=8');
    fireEvent.click(screen.getByRole('button', { name: 'Ingredients' }));

    const sheet = screen.getByRole('dialog');
    expect(within(sheet).getByText('960 ml')).toBeInTheDocument();
    fireEvent.click(within(sheet).getByRole('button', { name: 'Show US measures' }));
    expect(within(sheet).getByText('4 cups')).toBeInTheDocument();
    localStorage.clear();
  });

  it('leaves an unquantified ingredient alone', () => {
    renderCook('/recipes/e2e-soup/cook?servings=8');
    fireEvent.click(screen.getByRole('button', { name: 'Ingredients' }));

    const salt = within(screen.getByRole('dialog')).getByText('salt').closest('li');
    expect(salt).not.toBeNull();
    expect(salt!.textContent).toContain('to taste');
    expect(salt!.textContent).not.toMatch(/\d/);
  });

  it('falls back to the recipe servings when the URL carries nothing usable', () => {
    const unusable = [
      '',
      '?servings=abc',
      '?servings=0',
      '?servings=-3',
      '?servings=2.5',
      '?servings=0x10', // Number() reads this as 16
      '?servings=1e3', // ...and this as 1000
      '?servings=%204%20', // ...and this as 4
      '?servings=99999', // no upper bound would scale a recipe into scientific notation
    ];
    for (const query of unusable) {
      cleanup();
      renderCook(`/recipes/e2e-soup/cook${query}`);
      fireEvent.click(screen.getByRole('button', { name: 'Ingredients' }));
      const sheet = screen.getByRole('dialog');
      expect(within(sheet).getByText('2 cups')).toBeInTheDocument();
      expect(within(sheet).getByText(/4 servings/)).toBeInTheDocument();
    }
  });

  it('is dismissible by keyboard, and gives focus back to what opened it', () => {
    renderCook();
    const trigger = screen.getByRole('button', { name: 'Ingredients' });
    fireEvent.click(trigger);

    // Focus lands inside the sheet, so the next Tab is inside it rather than back at the top
    // of the screen.
    const sheet = screen.getByRole('dialog');
    expect(within(sheet).getByRole('button', { name: /close/i })).toHaveFocus();

    fireEvent.keyDown(document, { key: 'Escape' });
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Ingredients' })).toHaveFocus();
  });

  it('says when the recipe is missing rather than rendering an empty screen', () => {
    mockRecipe(null);
    renderCook();
    expect(screen.getByText(/Recipe not found/)).toBeInTheDocument();
  });
});

describe('CookMode across a reload', () => {
  const KEY = 'hearth.cook.v1.r1';

  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-09-10T10:00:00Z'));
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  /** Unmount, let the clock run while the page is gone, and open cook mode again. */
  function reload(view: ReturnType<typeof renderCook>, awayMs: number) {
    view.unmount();
    vi.setSystemTime(Date.now() + awayMs);
    return renderCook();
  }

  it('keeps the ticked steps', () => {
    const view = renderCook();
    fireEvent.click(screen.getAllByRole('checkbox')[0]!);

    reload(view, 60_000);
    expect(screen.getAllByRole('checkbox')[0]!).toHaveAttribute('aria-checked', 'true');
    expect(screen.getAllByRole('checkbox')[1]!).toHaveAttribute('aria-checked', 'false');
    expect(screen.getByText(/Step 2 of 2/)).toBeInTheDocument();
  });

  it('resumes a running timer with the time that is really left', () => {
    const view = renderCook();
    fireEvent.click(screen.getByRole('button', { name: /Start a timer for 20 minutes, step 1/ }));
    act(() => {
      vi.advanceTimersByTime(5 * 60_000);
    });

    reload(view, 3 * 60_000);
    expect(within(tray()).getByText('Step 1 · 20 minutes')).toBeInTheDocument();
    expect(within(tray()).getByText('12:00')).toBeInTheDocument();

    act(() => {
      vi.advanceTimersByTime(60_000);
    });
    expect(within(tray()).getByText('11:00')).toBeInTheDocument();
  });

  it('shows Done for a timer that ran out while the page was gone', () => {
    const view = renderCook();
    fireEvent.click(screen.getByRole('button', { name: /Start a timer for 30 seconds, step 2/ }));

    reload(view, 10 * 60_000);
    expect(within(tray()).getByText('Step 2 · 30 seconds')).toBeInTheDocument();
    expect(within(tray()).getByText('Done')).toBeInTheDocument();
  });

  it('forgets a timer once it is stopped', () => {
    const view = renderCook();
    fireEvent.click(screen.getAllByRole('checkbox')[0]!);
    fireEvent.click(screen.getByRole('button', { name: /Start a timer for 30 seconds, step 2/ }));
    fireEvent.click(screen.getByRole('button', { name: /Stop Step 2 · 30 seconds/ }));

    reload(view, 1_000);
    expect(screen.queryByRole('list', { name: 'Running timers' })).not.toBeInTheDocument();
    expect(screen.getAllByRole('checkbox')[0]!).toHaveAttribute('aria-checked', 'true');
  });

  it('clears the saved session once the timers are stopped and every step is done', () => {
    renderCook();
    fireEvent.click(screen.getByRole('button', { name: /Start a timer for 30 seconds, step 2/ }));
    fireEvent.click(screen.getAllByRole('checkbox')[0]!);
    fireEvent.click(screen.getAllByRole('checkbox')[1]!);
    expect(localStorage.getItem(KEY)).not.toBeNull();

    fireEvent.click(screen.getByRole('button', { name: /Stop Step 2 · 30 seconds/ }));
    expect(localStorage.getItem(KEY)).toBeNull();
  });

  it('starts over after a day away, and removes the stale session', () => {
    const view = renderCook();
    fireEvent.click(screen.getAllByRole('checkbox')[0]!);
    fireEvent.click(screen.getByRole('button', { name: /Start a timer for 30 seconds, step 2/ }));

    reload(view, 25 * 3600_000);
    expect(screen.getAllByRole('checkbox')[0]!).toHaveAttribute('aria-checked', 'false');
    expect(screen.queryByRole('list', { name: 'Running timers' })).not.toBeInTheDocument();
    expect(localStorage.getItem(KEY)).toBeNull();
  });

  it('ignores a ticked step the recipe no longer has', () => {
    localStorage.setItem(
      KEY,
      JSON.stringify({ savedAt: Date.now(), doneStepIds: ['gone', 's1'], timers: [] }),
    );
    renderCook();
    expect(screen.getAllByRole('checkbox')[0]!).toHaveAttribute('aria-checked', 'true');
    expect(screen.getByText(/Step 2 of 2/)).toBeInTheDocument();
  });

  it('works as before when storage throws', () => {
    for (const method of ['getItem', 'setItem', 'removeItem', 'key'] as const) {
      vi.spyOn(Storage.prototype, method).mockImplementation(() => {
        throw new DOMException('blocked', 'SecurityError');
      });
    }
    renderCook();

    fireEvent.click(screen.getAllByRole('checkbox')[0]!);
    expect(screen.getAllByRole('checkbox')[0]!).toHaveAttribute('aria-checked', 'true');
    fireEvent.click(screen.getByRole('button', { name: /Start a timer for 30 seconds, step 2/ }));
    expect(within(tray()).getByText('0:30')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: /Stop Step 2 · 30 seconds/ }));
    expect(screen.queryByRole('list', { name: 'Running timers' })).not.toBeInTheDocument();
  });
});
