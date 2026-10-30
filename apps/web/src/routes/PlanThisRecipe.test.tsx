import { describe, it, expect, vi, beforeEach, afterEach, type Mock } from 'vitest';
import { render, screen, fireEvent, cleanup, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { addDays } from '@hearth/shared';
import { PlanThisRecipe } from './PlanThisRecipe';
import { localToday } from './Plan';
import { trpc } from '../lib/trpc';

vi.mock('../lib/trpc', () => ({
  trpc: { useUtils: vi.fn(), plan: { add: { useMutation: vi.fn() } } },
}));

const useAdd = trpc.plan.add.useMutation as unknown as Mock;
let mutate: Mock;
let onSuccess: (() => void) | undefined;

beforeEach(() => {
  mutate = vi.fn(() => onSuccess?.());
  useAdd.mockImplementation((opts: { onSuccess?: () => void }) => {
    onSuccess = opts.onSuccess;
    return { mutate, isPending: false, isError: false };
  });
  (trpc.useUtils as unknown as Mock).mockReturnValue({ plan: { week: { invalidate: vi.fn() } } });
});
afterEach(cleanup);

function renderIt(servings = 6) {
  return render(
    <MemoryRouter>
      <PlanThisRecipe recipeId="r1" servings={servings} />
    </MemoryRouter>,
  );
}

describe('PlanThisRecipe', () => {
  it('plans the recipe for a chosen day and meal at the servings on screen', () => {
    renderIt(6);
    fireEvent.click(screen.getByRole('button', { name: 'Add to plan' }));
    const form = screen.getByRole('form', { name: 'Add to plan' });
    const tomorrow = addDays(localToday(), 1);
    fireEvent.change(within(form).getByLabelText('Day'), { target: { value: tomorrow } });
    fireEvent.change(within(form).getByLabelText('Meal'), { target: { value: 'lunch' } });
    fireEvent.click(within(form).getByRole('button', { name: 'Plan 6 servings' }));
    expect(mutate).toHaveBeenCalledWith({
      date: tomorrow,
      meal: 'lunch',
      recipeId: 'r1',
      servings: 6,
    });
    expect(screen.getByRole('status')).toHaveTextContent('Planned for Tomorrow · Lunch');
  });

  it('defaults to dinner today, and Cancel closes without planning', () => {
    renderIt();
    fireEvent.click(screen.getByRole('button', { name: 'Add to plan' }));
    expect(screen.getByLabelText('Day')).toHaveValue(localToday());
    expect(screen.getByLabelText('Meal')).toHaveValue('dinner');
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(mutate).not.toHaveBeenCalled();
    expect(screen.getByRole('button', { name: 'Add to plan' })).toBeInTheDocument();
  });
});
