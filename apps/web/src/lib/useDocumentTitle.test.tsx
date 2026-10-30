import { describe, it, expect } from 'vitest';
import { render } from '@testing-library/react';
import { useDocumentTitle } from './useDocumentTitle';

function Screen({ title }: { title: string | null }) {
  useDocumentTitle(title);
  return null;
}

describe('useDocumentTitle', () => {
  it('names the tab after the screen, and goes back to Hearth when it leaves', () => {
    const view = render(<Screen title="Osso Buco" />);
    expect(document.title).toBe('Osso Buco - Hearth');
    view.rerender(<Screen title={null} />);
    expect(document.title).toBe('Hearth');
    view.rerender(<Screen title="Tags" />);
    view.unmount();
    expect(document.title).toBe('Hearth');
  });
});
