import { describe, it, expect, vi, beforeEach, afterEach, type Mock } from 'vitest';
import { render, screen, fireEvent, cleanup } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { WeekStartSetting } from './WeekStartSetting';
import { trpc } from '../lib/trpc';

vi.mock('../lib/trpc', () => ({
  trpc: {
    useUtils: vi.fn(),
    plan: { weekStart: { useQuery: vi.fn() }, setWeekStart: { useMutation: vi.fn() } },
  },
}));

const useWeekStart = trpc.plan.weekStart.useQuery as unknown as Mock;
const useSet = trpc.plan.setWeekStart.useMutation as unknown as Mock;
let mutate: Mock;

beforeEach(() => {
  mutate = vi.fn();
  useSet.mockReturnValue({ mutate, isPending: false });
  (trpc.useUtils as unknown as Mock).mockReturnValue({
    plan: { weekStart: { invalidate: vi.fn() }, week: { invalidate: vi.fn() } },
  });
});
afterEach(cleanup);

describe('WeekStartSetting', () => {
  it('shows the household setting and saves a change', () => {
    useWeekStart.mockReturnValue({ data: 1, isLoading: false });
    render(
      <MemoryRouter>
        <WeekStartSetting />
      </MemoryRouter>,
    );
    const select = screen.getByLabelText('Weeks start on');
    expect(select).toHaveValue('1');
    fireEvent.change(select, { target: { value: '0' } });
    expect(mutate).toHaveBeenCalledWith({ weekStart: 0 });
  });

  it('links to the Foods screen', () => {
    useWeekStart.mockReturnValue({ data: 0, isLoading: false });
    render(
      <MemoryRouter>
        <WeekStartSetting />
      </MemoryRouter>,
    );
    expect(screen.getByRole('link', { name: /Foods/ })).toHaveAttribute('href', '/foods');
  });
});
