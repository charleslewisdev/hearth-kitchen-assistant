import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { Link, MemoryRouter, Route, Routes, useNavigate } from 'react-router-dom';
import { ScrollToTopOnNavigate } from './ScrollToTopOnNavigate';

function Back() {
  const navigate = useNavigate();
  return (
    <button type="button" onClick={() => navigate(-1)}>
      Back
    </button>
  );
}

function tree() {
  return (
    <MemoryRouter initialEntries={['/recipes']}>
      <ScrollToTopOnNavigate />
      <Routes>
        <Route path="/recipes" element={<Link to="/recipes/soup">Soup</Link>} />
        <Route path="/recipes/soup" element={<Back />} />
      </Routes>
    </MemoryRouter>
  );
}

describe('ScrollToTopOnNavigate', () => {
  it('scrolls to the top when a link opens another screen', () => {
    render(tree());
    const scrollTo = vi.spyOn(window, 'scrollTo');
    fireEvent.click(screen.getByRole('link', { name: 'Soup' }));
    expect(scrollTo).toHaveBeenCalledWith({ top: 0 });
  });

  it('leaves the offset alone on back, for the browser to restore', () => {
    render(tree());
    fireEvent.click(screen.getByRole('link', { name: 'Soup' }));
    const scrollTo = vi.spyOn(window, 'scrollTo');
    fireEvent.click(screen.getByRole('button', { name: 'Back' }));
    expect(screen.getByRole('link', { name: 'Soup' })).toBeInTheDocument();
    expect(scrollTo).not.toHaveBeenCalled();
  });
});
