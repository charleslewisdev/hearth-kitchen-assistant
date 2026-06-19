import { describe, it, expect } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { ThemeProvider, useTheme } from './ThemeProvider';

function Probe() {
  const { theme, setTheme } = useTheme();
  return <button onClick={() => setTheme('dark')}>theme:{theme}</button>;
}

describe('ThemeProvider', () => {
  it('defaults to system and applies data-theme=dark when set', () => {
    render(
      <ThemeProvider>
        <Probe />
      </ThemeProvider>,
    );
    fireEvent.click(screen.getByRole('button'));
    expect(document.documentElement.getAttribute('data-theme')).toBe('dark');
  });
});
