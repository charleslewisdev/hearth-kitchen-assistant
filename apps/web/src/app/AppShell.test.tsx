import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { AppShell } from './AppShell';

describe('AppShell', () => {
  it('renders the four destinations and reports navigation', () => {
    const onNavigate = vi.fn();
    render(
      <AppShell active="recipes" onNavigate={onNavigate}>
        body
      </AppShell>,
    );
    for (const label of ['Recipes', 'Plan', 'Shop', 'More']) {
      expect(screen.getByText(label)).toBeInTheDocument();
    }
    fireEvent.click(screen.getByText('Plan'));
    expect(onNavigate).toHaveBeenCalledWith('plan');
  });
});
