import { describe, it, expect, vi, beforeEach, afterEach, type Mock } from 'vitest';
import { render, screen, fireEvent, cleanup, waitFor } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { INVITE_ONLY_MESSAGE } from '@hearth/server/src/messages';
import { AcceptInvite } from './AcceptInvite';
import { authClient } from '../lib/auth';

// The whole screen is Better Auth: a session, a sign-up, a sign-in, and the two organization
// endpoints that read and accept an invitation. No tRPC procedure is reachable from here,
// because the person following the link may have no household yet.
vi.mock('../lib/auth', () => ({
  authClient: {
    useSession: vi.fn(),
    signUp: { email: vi.fn() },
    signIn: { email: vi.fn() },
    signOut: vi.fn(),
    organization: { getInvitation: vi.fn(), acceptInvitation: vi.fn() },
  },
}));

const useSession = authClient.useSession as unknown as Mock;
const signUpEmail = authClient.signUp.email as unknown as Mock;
const signInEmail = authClient.signIn.email as unknown as Mock;
const signOut = authClient.signOut as unknown as Mock;
const getInvitation = authClient.organization.getInvitation as unknown as Mock;
const acceptInvitation = authClient.organization.acceptInvitation as unknown as Mock;

const INVITATION_ID = 'invitation-42';

function signedOut() {
  useSession.mockReturnValue({ data: null, isPending: false });
}

function signedInAs(email: string) {
  useSession.mockReturnValue({
    data: { user: { id: 'user-1', email } },
    isPending: false,
  });
}

function renderInvite() {
  return render(
    <MemoryRouter initialEntries={[`/accept-invite/${INVITATION_ID}`]}>
      <Routes>
        <Route path="/accept-invite/:invitationId" element={<AcceptInvite />} />
        <Route path="/" element={<h1>Hearth</h1>} />
      </Routes>
    </MemoryRouter>,
  );
}

beforeEach(() => {
  signUpEmail.mockReset();
  signInEmail.mockReset();
  signOut.mockReset();
  getInvitation.mockReset();
  acceptInvitation.mockReset();
});

afterEach(cleanup);

describe('AcceptInvite, signed out', () => {
  it('signs the invitee up, signs them in, and lands them in the household', async () => {
    signedOut();
    signUpEmail.mockResolvedValue({ data: { user: { id: 'user-1' } }, error: null });
    signInEmail.mockResolvedValue({ data: { user: { id: 'user-1' } }, error: null });
    renderInvite();

    fireEvent.change(screen.getByLabelText('Email address'), {
      target: { value: 'gran@example.com' },
    });
    fireEvent.change(screen.getByLabelText('Your name'), { target: { value: 'Gran' } });
    fireEvent.change(screen.getByLabelText('Password'), { target: { value: 'a-good-password' } });
    fireEvent.click(screen.getByRole('button', { name: 'Create account and join' }));

    await waitFor(() => expect(signUpEmail).toHaveBeenCalledTimes(1));
    expect(signUpEmail).toHaveBeenCalledWith({
      email: 'gran@example.com',
      password: 'a-good-password',
      name: 'Gran',
    });
    // Sign-up returns no session on this server, so the account is signed in as its own step.
    await waitFor(() => expect(signInEmail).toHaveBeenCalledTimes(1));
    expect(signInEmail).toHaveBeenCalledWith({
      email: 'gran@example.com',
      password: 'a-good-password',
    });
    expect(await screen.findByRole('heading', { name: 'Hearth' })).toBeInTheDocument();
  });

  it('shows why a refused sign-up was refused, and does not sign anyone in', async () => {
    signedOut();
    signUpEmail.mockResolvedValue({ data: null, error: { message: INVITE_ONLY_MESSAGE } });
    renderInvite();

    fireEvent.change(screen.getByLabelText('Email address'), {
      target: { value: 'stranger@example.com' },
    });
    fireEvent.change(screen.getByLabelText('Your name'), { target: { value: 'Stranger' } });
    fireEvent.change(screen.getByLabelText('Password'), { target: { value: 'a-good-password' } });
    fireEvent.click(screen.getByRole('button', { name: 'Create account and join' }));

    expect(await screen.findByRole('alert')).toHaveTextContent(INVITE_ONLY_MESSAGE);
    expect(signInEmail).not.toHaveBeenCalled();
  });

  it('retries only the sign-in when the account was already created', async () => {
    signedOut();
    signUpEmail.mockResolvedValue({ data: { user: { id: 'user-1' } }, error: null });
    signInEmail.mockResolvedValue({ data: null, error: { message: 'Too many requests' } });
    renderInvite();

    fireEvent.change(screen.getByLabelText('Email address'), {
      target: { value: 'gran@example.com' },
    });
    fireEvent.change(screen.getByLabelText('Your name'), { target: { value: 'Gran' } });
    fireEvent.change(screen.getByLabelText('Password'), { target: { value: 'a-good-password' } });
    fireEvent.click(screen.getByRole('button', { name: 'Create account and join' }));

    expect(await screen.findByRole('alert')).toHaveTextContent('Too many requests');

    // Signing up consumed the invitation, so a second sign-up for this address would be refused
    // as uninvited. Only the sign-in is left to retry, and the button now says so.
    fireEvent.click(await screen.findByRole('button', { name: 'Sign in and join' }));

    await waitFor(() => expect(signInEmail).toHaveBeenCalledTimes(2));
    expect(signUpEmail).toHaveBeenCalledTimes(1);
  });

  it('does not look the invitation up while signed out', () => {
    signedOut();
    renderInvite();

    // `/organization/get-invitation` answers 401 without a session, and asking anyway would
    // tell a signed-out visitor nothing while spending their rate-limit budget.
    expect(getInvitation).not.toHaveBeenCalled();
  });
});

describe('AcceptInvite, signed in', () => {
  it('offers a single Accept button to the invited address', async () => {
    signedInAs('gran@example.com');
    getInvitation.mockResolvedValue({
      data: { id: INVITATION_ID, email: 'gran@example.com', organizationName: 'The Bell Kitchen' },
      error: null,
    });
    acceptInvitation.mockResolvedValue({ data: { member: { id: 'member-2' } }, error: null });
    renderInvite();

    const accept = await screen.findByRole('button', { name: 'Accept invitation' });
    expect(screen.getByText(/The Bell Kitchen/)).toBeInTheDocument();
    expect(screen.queryByLabelText('Password')).not.toBeInTheDocument();

    fireEvent.click(accept);

    await waitFor(() => expect(acceptInvitation).toHaveBeenCalledTimes(1));
    expect(acceptInvitation).toHaveBeenCalledWith({ invitationId: INVITATION_ID });
    expect(await screen.findByRole('heading', { name: 'Hearth' })).toBeInTheDocument();
  });

  it('explains a mismatch and offers to sign out, when signed in as someone else', async () => {
    signedInAs('ada@example.com');
    getInvitation.mockResolvedValue({
      data: null,
      error: { status: 403, message: 'You are not the recipient of the invitation' },
    });
    renderInvite();

    expect(await screen.findByText(/ada@example\.com/)).toBeInTheDocument();
    expect(screen.getByText(/different address/i)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Accept invitation' })).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'Sign out' }));
    expect(signOut).toHaveBeenCalledTimes(1);
  });

  it('explains an invitation that cannot be used, without a stack trace', async () => {
    signedInAs('gran@example.com');
    getInvitation.mockResolvedValue({
      data: null,
      error: { status: 400, message: 'Invitation not found!' },
    });
    renderInvite();

    expect(
      await screen.findByText(/expired, been withdrawn, or already been used/i),
    ).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Accept invitation' })).not.toBeInTheDocument();
    expect(screen.queryByText(/Invitation not found!/)).not.toBeInTheDocument();
  });

  it('surfaces a refused accept rather than looking like it worked', async () => {
    signedInAs('gran@example.com');
    getInvitation.mockResolvedValue({
      data: { id: INVITATION_ID, email: 'gran@example.com', organizationName: 'The Bell Kitchen' },
      error: null,
    });
    acceptInvitation.mockResolvedValue({
      data: null,
      error: { status: 400, message: 'Organization membership limit reached' },
    });
    renderInvite();

    fireEvent.click(await screen.findByRole('button', { name: 'Accept invitation' }));

    expect(await screen.findByRole('alert')).toHaveTextContent(
      'Organization membership limit reached',
    );
    expect(screen.queryByRole('heading', { name: 'Hearth' })).not.toBeInTheDocument();
  });
});
