import { describe, it, expect, vi, beforeEach, afterEach, type Mock } from 'vitest';
import { render, screen, cleanup } from '@testing-library/react';
import type { ReactNode } from 'react';
import { App } from './App';
import { authClient } from './lib/auth';

// The gate is the whole subject here, so nothing below it needs a real tRPC client: the three
// screens these tests reach (sign in, onboarding, accept invite) do not call one.
vi.mock('./lib/trpc', () => ({
  trpc: { Provider: ({ children }: { children: ReactNode }) => children },
  trpcClient: {},
}));

// The planner reads the week over tRPC; this file only needs to see that the gate let it render.
vi.mock('./routes/Plan', () => ({ Plan: () => <h1>Plan</h1> }));

vi.mock('./lib/auth', () => ({
  authClient: {
    useSession: vi.fn(),
    useActiveOrganization: vi.fn(),
    signUp: { email: vi.fn() },
    signIn: { email: vi.fn() },
    signOut: vi.fn(),
    organization: { getInvitation: vi.fn(), acceptInvitation: vi.fn() },
  },
}));

const useSession = authClient.useSession as unknown as Mock;
const useActiveOrganization = authClient.useActiveOrganization as unknown as Mock;
const getInvitation = authClient.organization.getInvitation as unknown as Mock;

let refetch: Mock;

function session(id = 'session-1') {
  return { data: { session: { id }, user: { id: 'user-1', email: 'gran@example.com' } } };
}

function noSession() {
  return { data: null, isPending: false };
}

function household(data: unknown) {
  return { data, isPending: false, refetch };
}

function renderAt(path: string) {
  window.history.pushState({}, '', path);
  return render(<App />);
}

beforeEach(() => {
  refetch = vi.fn();
  getInvitation.mockResolvedValue({ data: null, error: { status: 400 } });
});

afterEach(cleanup);

describe('App routing', () => {
  it('opens an invitation link for a visitor with no account', async () => {
    useSession.mockReturnValue({ ...noSession(), isPending: false });
    useActiveOrganization.mockReturnValue(household(null));

    renderAt('/accept-invite/invitation-42');

    expect(await screen.findByRole('heading', { name: 'Join this Hearth' })).toBeInTheDocument();
    expect(screen.queryByRole('heading', { name: 'Sign in to Hearth' })).not.toBeInTheDocument();
  });

  it('opens an invitation link for an account that is in no household', async () => {
    // The state an owner who left is in: a session, and nothing to open it in. The gate answers
    // that with Onboarding everywhere else, and this route is why it must not answer it here.
    useSession.mockReturnValue({ ...session(), isPending: false });
    useActiveOrganization.mockReturnValue(household(null));

    renderAt('/accept-invite/invitation-42');

    expect(
      await screen.findByText(/expired, been withdrawn, or already been used/i),
    ).toBeInTheDocument();
    expect(screen.queryByRole('heading', { name: 'Name your household' })).not.toBeInTheDocument();
  });

  it('shows the sign-in screen to a signed-out visitor everywhere else', () => {
    useSession.mockReturnValue({ ...noSession(), isPending: false });
    useActiveOrganization.mockReturnValue(household(null));

    renderAt('/');

    expect(screen.getByRole('heading', { name: 'Sign in to Hearth' })).toBeInTheDocument();
  });

  it('asks once for the household a fresh sign-in has not fetched yet', () => {
    useSession.mockReturnValue({ ...session(), isPending: false });
    useActiveOrganization.mockReturnValue(household(null));

    const { rerender } = renderAt('/');

    expect(refetch).toHaveBeenCalledTimes(1);
    // Re-rendering with the same session does not ask again, so an account with no household
    // settles instead of looping on the same empty answer.
    rerender(<App />);
    expect(refetch).toHaveBeenCalledTimes(1);
  });

  it('does not ask again for a household it already has', () => {
    useSession.mockReturnValue({ ...session(), isPending: false });
    useActiveOrganization.mockReturnValue(household({ id: 'org-1', name: 'The Bell Kitchen' }));

    renderAt('/plan');

    expect(refetch).not.toHaveBeenCalled();
    expect(screen.getByRole('heading', { name: 'Plan' })).toBeInTheDocument();
  });
});
