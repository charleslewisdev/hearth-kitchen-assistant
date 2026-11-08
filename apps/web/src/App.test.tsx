import { describe, it, expect, vi, beforeEach, afterEach, type Mock } from 'vitest';
import { render, screen, cleanup, act } from '@testing-library/react';
import { onlineManager } from '@tanstack/react-query';
import type { ReactNode } from 'react';
import { App } from './App';
import { authClient } from './lib/auth';
import {
  pendingSignOut,
  readKnownSession,
  rememberSession,
  setPendingSignOut,
} from './lib/offline';
import { signOut } from './lib/sign-out';

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
  localStorage.clear();
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

describe('App with no signal (D56)', () => {
  const offline = { data: null, isPending: false, error: new TypeError('Failed to fetch') };

  it('opens from the remembered session when the session check cannot reach the server', async () => {
    rememberSession({ userId: 'user-1', householdId: 'org-1', sessionId: 'session-1' });
    useSession.mockReturnValue(offline);
    useActiveOrganization.mockReturnValue({ ...offline, refetch });

    renderAt('/plan');

    expect(await screen.findByRole('heading', { name: 'Plan' })).toBeInTheDocument();
    expect(screen.queryByRole('heading', { name: 'Sign in to Hearth' })).not.toBeInTheDocument();
  });

  it('shows sign-in, and keeps nothing, when unreachable on a phone that remembers no one', () => {
    useSession.mockReturnValue(offline);
    useActiveOrganization.mockReturnValue({ ...offline, refetch });

    renderAt('/plan');

    expect(screen.getByRole('heading', { name: 'Sign in to Hearth' })).toBeInTheDocument();
  });

  it('forgets the kept list when the server says nobody is signed in', () => {
    rememberSession({ userId: 'user-1', householdId: 'org-1', sessionId: 'session-1' });
    localStorage.setItem('hearth.offline.cache', '{}');
    useSession.mockReturnValue(noSession());
    useActiveOrganization.mockReturnValue(household(null));

    renderAt('/');

    expect(screen.getByRole('heading', { name: 'Sign in to Hearth' })).toBeInTheDocument();
    expect(readKnownSession()).toBeNull();
    expect(localStorage.getItem('hearth.offline.cache')).toBeNull();
  });

  it('remembers a session the server confirmed', () => {
    useSession.mockReturnValue({ ...session(), isPending: false });
    useActiveOrganization.mockReturnValue(household({ id: 'org-1', name: 'The Bell Kitchen' }));

    renderAt('/plan');

    expect(readKnownSession()).toEqual({
      userId: 'user-1',
      householdId: 'org-1',
      sessionId: 'session-1',
    });
  });

  it('ends a sign-out made offline once the server shows that session again', async () => {
    setPendingSignOut('session-1');
    (authClient.signOut as unknown as Mock).mockResolvedValue({ data: {}, error: null });
    useSession.mockReturnValue({ ...session(), isPending: false });
    useActiveOrganization.mockReturnValue(household({ id: 'org-1', name: 'The Bell Kitchen' }));

    renderAt('/plan');

    expect(screen.getByRole('heading', { name: 'Sign in to Hearth' })).toBeInTheDocument();
    expect(authClient.signOut).toHaveBeenCalledTimes(1);
    await vi.waitFor(() => expect(pendingSignOut()).toBeNull());
  });

  it('holds list changes while open from the remembered session', async () => {
    rememberSession({ userId: 'user-1', householdId: 'org-1', sessionId: 'session-1' });
    useSession.mockReturnValue({ ...offline, refetch: vi.fn() });
    useActiveOrganization.mockReturnValue({ ...offline, refetch });

    renderAt('/plan');
    await screen.findByRole('heading', { name: 'Plan' });

    // The browser may still say online on a signal too weak to use; the queue must not.
    expect(onlineManager.isOnline()).toBe(false);
    onlineManager.setOnline(true);
  });

  it('signs out with no signal: sign-in at once, nothing kept, and the session noted to end', async () => {
    rememberSession({ userId: 'user-1', householdId: 'org-1', sessionId: 'session-1' });
    localStorage.setItem('hearth.offline.cache', '{}');
    // The auth client still holds the session, as it does when its sign-out request fails.
    useSession.mockReturnValue({ ...session(), isPending: false });
    useActiveOrganization.mockReturnValue(household({ id: 'org-1', name: 'The Bell Kitchen' }));
    const authSignOut = authClient.signOut as unknown as Mock;
    authSignOut.mockReset();
    authSignOut.mockRejectedValue(new TypeError('Failed to fetch'));
    const onLine = vi.spyOn(navigator, 'onLine', 'get').mockReturnValue(false);
    try {
      renderAt('/plan');
      expect(screen.getByRole('heading', { name: 'Plan' })).toBeInTheDocument();

      await act(() => signOut());

      expect(screen.getByRole('heading', { name: 'Sign in to Hearth' })).toBeInTheDocument();
      expect(readKnownSession()).toBeNull();
      expect(localStorage.getItem('hearth.offline.cache')).toBeNull();
      expect(pendingSignOut()).toBe('session-1');
      // Its own request only: the gate sends no second one while there is no signal.
      expect(authSignOut).toHaveBeenCalledTimes(1);
    } finally {
      onLine.mockRestore();
    }
  });
});
