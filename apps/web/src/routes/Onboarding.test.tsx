import { describe, it, expect, vi, beforeEach, afterEach, type Mock } from 'vitest';
import { render, screen, fireEvent, cleanup } from '@testing-library/react';
import { ONE_HOUSEHOLD_MESSAGE } from '@hearth/server/src/messages';
import { Onboarding } from './Onboarding';
import { authClient } from '../lib/auth';

vi.mock('../lib/auth', () => ({
  authClient: {
    signOut: vi.fn(),
    organization: { create: vi.fn(), setActive: vi.fn() },
  },
}));

const create = authClient.organization.create as unknown as Mock;
const setActive = authClient.organization.setActive as unknown as Mock;
const signOut = authClient.signOut as unknown as Mock;

function nameTheHousehold(name = 'The Bell Kitchen') {
  fireEvent.change(screen.getByLabelText('Household name'), { target: { value: name } });
  fireEvent.click(screen.getByRole('button', { name: 'Create household' }));
}

beforeEach(() => {
  create.mockReset();
  setActive.mockReset();
  signOut.mockReset();
  setActive.mockResolvedValue({ data: {}, error: null });
});

afterEach(cleanup);

describe('Onboarding', () => {
  it('creates the household the first account names, and opens it', async () => {
    create.mockResolvedValue({ data: { id: 'org-1' }, error: null });
    render(<Onboarding />);

    nameTheHousehold();

    await vi.waitFor(() => expect(create).toHaveBeenCalledTimes(1));
    expect(create).toHaveBeenCalledWith({ name: 'The Bell Kitchen', slug: 'the-bell-kitchen' });
    await vi.waitFor(() => expect(setActive).toHaveBeenCalledWith({ organizationId: 'org-1' }));
  });

  it('stops offering the form once the instance says it already has a household', async () => {
    create.mockResolvedValue({ data: null, error: { message: ONE_HOUSEHOLD_MESSAGE } });
    render(<Onboarding />);

    nameTheHousehold();

    expect(await screen.findByText(ONE_HOUSEHOLD_MESSAGE)).toBeInTheDocument();
    // The form is gone, because on a claimed instance it is one that can never succeed.
    expect(screen.queryByLabelText('Household name')).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Create household' })).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'Sign out' }));
    expect(signOut).toHaveBeenCalledTimes(1);
  });

  it('keeps the form for any other failure, which may be worth retrying', async () => {
    create.mockResolvedValue({ data: null, error: { message: 'Something went wrong' } });
    render(<Onboarding />);

    nameTheHousehold();

    expect(await screen.findByRole('alert')).toHaveTextContent('Something went wrong');
    expect(screen.getByLabelText('Household name')).toBeInTheDocument();
  });
});
