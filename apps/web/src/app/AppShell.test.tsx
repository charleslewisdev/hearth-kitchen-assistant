import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { AppShell } from './AppShell';

function renderAt(path: string) {
  return render(
    <MemoryRouter initialEntries={[path]}>
      <AppShell />
    </MemoryRouter>,
  );
}

describe('AppShell', () => {
  it('renders the four destinations as links to the right routes', () => {
    renderAt('/recipes');
    const expected: [string, string][] = [
      ['Recipes', '/recipes'],
      ['Plan', '/plan'],
      ['Shop', '/shop'],
      ['More', '/more'],
    ];
    for (const [label, href] of expected) {
      expect(screen.getByRole('link', { name: label })).toHaveAttribute('href', href);
    }
  });

  it('marks the active route link with aria-current="page"', () => {
    renderAt('/shop');
    expect(screen.getByRole('link', { name: 'Shop' })).toHaveAttribute('aria-current', 'page');
    expect(screen.getByRole('link', { name: 'Recipes' })).not.toHaveAttribute('aria-current');
  });

  it('nests Recipe Book and Tags under Recipes, keeping Recipes lit on both', () => {
    renderAt('/tags');
    expect(screen.getByRole('link', { name: 'Recipe Book' })).toHaveAttribute('href', '/recipes');
    expect(screen.getByRole('link', { name: 'Tags' })).toHaveAttribute('aria-current', 'page');
    expect(screen.getByRole('link', { name: 'Recipes' })).toHaveAttribute('aria-current', 'page');
    expect(screen.getByRole('link', { name: 'Recipe Book' })).not.toHaveAttribute('aria-current');
  });

  it('marks Recipe Book on a recipe page', () => {
    renderAt('/recipes/osso-buco');
    expect(screen.getByRole('link', { name: 'Recipe Book' })).toHaveAttribute(
      'aria-current',
      'page',
    );
    expect(screen.getByRole('link', { name: 'Tags' })).not.toHaveAttribute('aria-current');
  });
});
