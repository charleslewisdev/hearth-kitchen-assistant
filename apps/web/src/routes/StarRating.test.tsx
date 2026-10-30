import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { StarRating } from './StarRating';

describe('StarRating', () => {
  it('sets a rating, and clears it when the same star is tapped again', () => {
    const onChange = vi.fn();
    const { rerender } = render(<StarRating value={null} onChange={onChange} />);
    fireEvent.click(screen.getByRole('button', { name: '4 stars' }));
    expect(onChange).toHaveBeenLastCalledWith(4);
    rerender(<StarRating value={4} onChange={onChange} />);
    expect(screen.getByRole('button', { name: '4 stars' })).toHaveAttribute('aria-pressed', 'true');
    fireEvent.click(screen.getByRole('button', { name: '4 stars' }));
    expect(onChange).toHaveBeenLastCalledWith(null);
  });

  it('reads as a rating when it is only shown', () => {
    render(<StarRating value={3} />);
    expect(screen.getByRole('img', { name: '3 out of 5 stars' })).toBeInTheDocument();
  });
});
