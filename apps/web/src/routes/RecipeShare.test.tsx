import { describe, it, expect, vi, afterEach } from 'vitest';
import { act, render, screen, fireEvent, waitFor, cleanup } from '@testing-library/react';
import { PrintSheet, ShareButtons } from './RecipeShare';
import type { ShareableRecipe } from '../lib/recipe-text';

const RECIPE: ShareableRecipe = {
  id: 'soup',
  title: 'Parsnip Soup',
  servings: 4,
  prepMinutes: null,
  cookMinutes: 30,
  description: null,
  sourceName: 'Grandma',
  sourceUrl: null,
  ingredients: [
    {
      id: 'i0',
      position: 0,
      quantity: 2,
      unit: 'lb',
      altQuantity: null,
      altUnit: null,
      scalingMode: 'linear',
      foodName: 'parsnips',
      note: 'peeled',
      linkedRecipe: null,
    },
  ],
  steps: [{ id: 's0', position: 0, text: 'Peel the parsnips.' }],
};
const VIEW = { servings: 8, system: 'us' as const };

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

/** A navigator with `share` and `clipboard` as given, and everything else jsdom's. */
function stubNavigator(over: { share?: unknown; clipboard?: unknown }) {
  vi.stubGlobal('navigator', Object.assign(Object.create(navigator), over));
}

describe('Share', () => {
  it('hands the recipe, as it is on screen, to the share sheet', async () => {
    const share = vi.fn().mockResolvedValue(undefined);
    stubNavigator({ share });
    render(<ShareButtons recipe={RECIPE} view={VIEW} />);
    fireEvent.click(screen.getByRole('button', { name: 'Share' }));

    await waitFor(() => expect(share).toHaveBeenCalledTimes(1));
    const sent = share.mock.calls[0]![0] as { title: string; text: string };
    expect(sent.title).toBe('Parsnip Soup');
    expect(sent.text).toContain('Serves 8');
    expect(sent.text).toContain('- 4 lb parsnips, peeled');
    expect(screen.queryByRole('status')).toBeNull();
  });

  it('copies it where there is no share sheet, and says so', async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    stubNavigator({ share: undefined, clipboard: { writeText } });
    render(<ShareButtons recipe={RECIPE} view={VIEW} />);
    fireEvent.click(screen.getByRole('button', { name: 'Share' }));

    expect(await screen.findByRole('status')).toHaveTextContent(/recipe copied/i);
    expect(writeText.mock.calls[0]![0]).toContain('Parsnip Soup');
  });

  it('clears the note after a few seconds', async () => {
    stubNavigator({
      share: undefined,
      clipboard: { writeText: vi.fn().mockResolvedValue(undefined) },
    });
    vi.useFakeTimers({ shouldAdvanceTime: true });
    try {
      render(<ShareButtons recipe={RECIPE} view={VIEW} />);
      fireEvent.click(screen.getByRole('button', { name: 'Share' }));
      await screen.findByRole('status');
      act(() => vi.advanceTimersByTime(4000));
      expect(screen.queryByRole('status')).toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });

  it('does not also copy when a second tap finds the share sheet already open', async () => {
    const share = vi.fn().mockRejectedValue(new DOMException('busy', 'InvalidStateError'));
    const writeText = vi.fn();
    stubNavigator({ share, clipboard: { writeText } });
    render(<ShareButtons recipe={RECIPE} view={VIEW} />);
    fireEvent.click(screen.getByRole('button', { name: 'Share' }));
    await waitFor(() => expect(share).toHaveBeenCalled());
    expect(writeText).not.toHaveBeenCalled();
  });

  it('copies when the browser will not share from here at all', async () => {
    const share = vi.fn().mockRejectedValue(new DOMException('no', 'NotAllowedError'));
    const writeText = vi.fn().mockResolvedValue(undefined);
    stubNavigator({ share, clipboard: { writeText } });
    render(<ShareButtons recipe={RECIPE} view={VIEW} />);
    fireEvent.click(screen.getByRole('button', { name: 'Share' }));
    expect(await screen.findByRole('status')).toHaveTextContent(/recipe copied/i);
  });

  it('says nothing when the cook closes the share sheet', async () => {
    const share = vi.fn().mockRejectedValue(new DOMException('closed', 'AbortError'));
    const writeText = vi.fn();
    stubNavigator({ share, clipboard: { writeText } });
    render(<ShareButtons recipe={RECIPE} view={VIEW} />);
    fireEvent.click(screen.getByRole('button', { name: 'Share' }));

    await waitFor(() => expect(share).toHaveBeenCalled());
    expect(writeText).not.toHaveBeenCalled();
    expect(screen.queryByRole('status')).toBeNull();
    expect(screen.queryByRole('alert')).toBeNull();
  });

  it('points to Print when copying fails too', async () => {
    stubNavigator({
      share: undefined,
      clipboard: { writeText: vi.fn().mockRejectedValue(new Error('denied')) },
    });
    render(<ShareButtons recipe={RECIPE} view={VIEW} />);
    fireEvent.click(screen.getByRole('button', { name: 'Share' }));
    expect(await screen.findByRole('alert')).toHaveTextContent(/try print/i);
  });
});

describe('Print', () => {
  it('opens the browser’s print dialog', () => {
    const print = vi.spyOn(window, 'print').mockImplementation(() => {});
    render(<ShareButtons recipe={RECIPE} view={VIEW} />);
    fireEvent.click(screen.getByRole('button', { name: 'Print' }));
    expect(print).toHaveBeenCalledTimes(1);
  });

  it('prints every ingredient and every step, straight into the body', () => {
    render(<PrintSheet recipe={RECIPE} view={VIEW} coverFileId={null} />);
    const sheet = document.body.querySelector(':scope > [data-print-sheet]');
    expect(sheet).not.toBeNull();
    expect(sheet).toHaveTextContent('Parsnip Soup');
    expect(sheet).toHaveTextContent('Serves 8 · Cook 30 min');
    expect(sheet).toHaveTextContent('4 lb parsnips, peeled');
    expect(sheet).toHaveTextContent('Peel the parsnips.');
    expect(sheet).toHaveTextContent('Source: Grandma');
  });

  it('prints the recipes its lines are made from after it', () => {
    const stock: ShareableRecipe = {
      ...RECIPE,
      id: 'stock',
      title: 'Chicken Stock',
      servings: 8,
      steps: [{ id: 'k0', position: 0, text: 'Simmer four hours.' }],
    };
    render(
      <PrintSheet recipe={{ ...RECIPE, linkedRecipes: [stock] }} view={VIEW} coverFileId={null} />,
    );
    const sheet = document.body.querySelector(':scope > [data-print-sheet]')!;
    const titles = Array.from(sheet.querySelectorAll('h2'), (h) => h.textContent);
    expect(titles).toContain('Chicken Stock');
    expect(sheet).toHaveTextContent('Simmer four hours.');
    // At its own servings, not the main recipe's 8 of 4.
    expect(sheet.querySelectorAll('li')[2]).toHaveTextContent('2 lb parsnips, peeled');
  });

  it('takes over printing only while it is on screen, so other screens still print', () => {
    const { unmount } = render(<PrintSheet recipe={RECIPE} view={VIEW} coverFileId={null} />);
    expect(document.body).toHaveAttribute('data-printing-recipe');
    unmount();
    expect(document.body).not.toHaveAttribute('data-printing-recipe');
  });
});
