import { describe, it, expect, afterEach } from 'vitest';
import { render, cleanup } from '@testing-library/react';
import { PrintPortal } from './PrintPortal';

afterEach(cleanup);

describe('PrintPortal', () => {
  it('renders straight into <body>, hidden from screen readers', () => {
    render(
      <div data-testid="screen">
        <PrintPortal>
          <p>On paper</p>
        </PrintPortal>
      </div>,
    );
    const sheet = document.body.querySelector(':scope > [data-print-sheet]');
    expect(sheet).toHaveTextContent('On paper');
    expect(sheet).toHaveAttribute('aria-hidden', 'true');
  });

  it('takes over printing only while it is mounted, so other screens still print', () => {
    const { unmount } = render(<PrintPortal>sheet</PrintPortal>);
    expect(document.body).toHaveAttribute('data-printing');
    unmount();
    expect(document.body).not.toHaveAttribute('data-printing');
  });
});
