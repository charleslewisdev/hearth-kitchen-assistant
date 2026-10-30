import { describe, it, expect, vi, beforeEach, afterEach, type Mock } from 'vitest';
import { render, screen, fireEvent, cleanup, within } from '@testing-library/react';
import { NOT_A_MEMBER_MESSAGE } from '@hearth/server/src/messages';
import { Household } from './Household';
import { trpc } from '../lib/trpc';
import { authClient } from '../lib/auth';

// Mock the typed tRPC client: the screen touches household.members + household.invitations,
// three mutations, and useUtils for query invalidation.
// The planner setting has its own tests and its own procedures.
vi.mock('./WeekStartSetting', () => ({ WeekStartSetting: () => null }));

vi.mock('../lib/trpc', () => ({
  trpc: {
    useUtils: vi.fn(),
    household: {
      members: { useQuery: vi.fn() },
      invitations: { useQuery: vi.fn() },
      invite: { useMutation: vi.fn() },
      revokeInvitation: { useMutation: vi.fn() },
      removeMember: { useMutation: vi.fn() },
      name: { useQuery: vi.fn(() => ({ data: { name: 'Blueberry House' } })) },
      rename: { useMutation: vi.fn() },
    },
  },
}));

// The session says which row in the member list is the caller, which is what decides whether
// the owner-only controls render at all.
vi.mock('../lib/auth', () => ({
  authClient: { useSession: vi.fn(), signOut: vi.fn() },
}));

const useMembers = trpc.household.members.useQuery as unknown as Mock;
const useInvitations = trpc.household.invitations.useQuery as unknown as Mock;
const useInvite = trpc.household.invite.useMutation as unknown as Mock;
const useRevoke = trpc.household.revokeInvitation.useMutation as unknown as Mock;
const useRemove = trpc.household.removeMember.useMutation as unknown as Mock;
const useRename = trpc.household.rename.useMutation as unknown as Mock;
const useUtils = trpc.useUtils as unknown as Mock;
const useSession = authClient.useSession as unknown as Mock;
const signOut = authClient.signOut as unknown as Mock;

const OWNER_USER = 'user-ada';
const MEMBER_USER = 'user-gran';

const DAY = 24 * 60 * 60 * 1000;
const future = () => new Date(Date.now() + 3 * DAY).toISOString();
const past = () => new Date(Date.now() - 3 * DAY).toISOString();

function makeMember(overrides: Record<string, unknown> = {}) {
  return {
    id: 'member-1',
    userId: OWNER_USER,
    name: 'Ada',
    email: 'ada@example.com',
    role: 'owner',
    joinedAt: '2026-02-03T10:00:00.000Z',
    ...overrides,
  };
}

function makeInvitation(overrides: Record<string, unknown> = {}) {
  return {
    id: 'invitation-1',
    email: 'gran@example.com',
    role: 'member',
    expiresAt: future(),
    ...overrides,
  };
}

/** The household as both queries would return it, plus who is looking at it. */
function mockHousehold(opts: {
  members?: unknown[];
  invitations?: unknown[];
  viewer?: string;
  membersError?: { message: string };
}) {
  useMembers.mockReturnValue(
    opts.membersError
      ? { data: undefined, isLoading: false, isError: true, error: opts.membersError }
      : { data: opts.members ?? [makeMember()], isLoading: false, isError: false, error: null },
  );
  useInvitations.mockReturnValue({
    data: opts.invitations ?? [],
    isLoading: false,
    isError: false,
    error: null,
  });
  useSession.mockReturnValue({
    data: { user: { id: opts.viewer ?? OWNER_USER } },
    isPending: false,
  });
}

let inviteMutate: Mock;
let revokeMutate: Mock;
let removeMutate: Mock;
let renameMutate: Mock;

beforeEach(() => {
  inviteMutate = vi.fn();
  revokeMutate = vi.fn();
  removeMutate = vi.fn();

  useInvite.mockReturnValue({ mutate: inviteMutate, isPending: false, error: null });
  useRevoke.mockReturnValue({ mutate: revokeMutate, isPending: false, error: null });
  useRemove.mockReturnValue({ mutate: removeMutate, isPending: false, error: null });
  renameMutate = vi.fn();
  useRename.mockReturnValue({ mutate: renameMutate, isPending: false, error: null });
  useUtils.mockReturnValue({
    household: { members: { invalidate: vi.fn() }, invitations: { invalidate: vi.fn() } },
  });
  signOut.mockReset();
});

afterEach(cleanup);

describe('Household', () => {
  it('lists every member with their role, and marks which one is you', () => {
    mockHousehold({
      members: [
        makeMember({ id: 'member-1', userId: OWNER_USER, name: 'Ada', role: 'owner' }),
        makeMember({
          id: 'member-2',
          userId: MEMBER_USER,
          name: 'Gran',
          email: 'gran@example.com',
          role: 'member',
        }),
      ],
    });
    render(<Household />);

    const ada = screen.getByText('Ada').closest('li') as HTMLElement;
    expect(within(ada).getByText('ada@example.com')).toBeInTheDocument();
    expect(within(ada).getByText('Owner')).toBeInTheDocument();
    expect(within(ada).getByText('You')).toBeInTheDocument();

    const gran = screen.getByText('Gran').closest('li') as HTMLElement;
    expect(within(gran).getByText('Member')).toBeInTheDocument();
    expect(within(gran).queryByText('You')).not.toBeInTheDocument();
  });

  it('invites the address the owner typed', () => {
    mockHousehold({});
    render(<Household />);

    fireEvent.change(screen.getByLabelText('Email address'), {
      target: { value: 'gran@example.com' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Send invitation' }));

    expect(inviteMutate).toHaveBeenCalledTimes(1);
    expect(inviteMutate).toHaveBeenCalledWith({ email: 'gran@example.com' }, expect.anything());
  });

  it('does not offer the invite form to a member', () => {
    mockHousehold({
      viewer: MEMBER_USER,
      members: [
        makeMember({ id: 'member-1', userId: OWNER_USER, name: 'Ada', role: 'owner' }),
        makeMember({ id: 'member-2', userId: MEMBER_USER, name: 'Gran', role: 'member' }),
      ],
    });
    render(<Household />);

    // The list itself still renders, so this is the role check failing to grant rather than
    // the screen failing to draw.
    expect(screen.getByText('Gran')).toBeInTheDocument();
    expect(screen.queryByLabelText('Email address')).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Send invitation' })).not.toBeInTheDocument();
  });

  it('does not offer revoke or remove to a member', () => {
    mockHousehold({
      viewer: MEMBER_USER,
      members: [
        makeMember({ id: 'member-1', userId: OWNER_USER, name: 'Ada', role: 'owner' }),
        makeMember({ id: 'member-2', userId: MEMBER_USER, name: 'Gran', role: 'member' }),
      ],
      invitations: [makeInvitation()],
    });
    render(<Household />);

    expect(screen.getByText('gran@example.com')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Remove Ada' })).not.toBeInTheDocument();
    expect(
      screen.queryByRole('button', { name: 'Revoke the invitation for gran@example.com' }),
    ).not.toBeInTheDocument();
  });

  it('surfaces a failed invite rather than failing silently', () => {
    mockHousehold({});
    useInvite.mockReturnValue({
      mutate: inviteMutate,
      isPending: false,
      error: { message: 'That address is already in this household.' },
    });
    render(<Household />);

    expect(screen.getByRole('alert')).toHaveTextContent(
      'That address is already in this household.',
    );
  });

  it('keeps an expired invitation on the list and says that it expired', () => {
    mockHousehold({ invitations: [makeInvitation({ expiresAt: past() })] });
    render(<Household />);

    const row = screen.getByText('gran@example.com').closest('li') as HTMLElement;
    expect(within(row).getByText(/^Expired/)).toBeInTheDocument();
    // Re-inviting the same address extends and resends that row, so the owner is told so.
    expect(screen.getByText(/send it again/i)).toBeInTheDocument();
  });

  it('revokes the invitation the owner picked', () => {
    mockHousehold({ invitations: [makeInvitation({ id: 'invitation-7' })] });
    render(<Household />);

    fireEvent.click(
      screen.getByRole('button', { name: 'Revoke the invitation for gran@example.com' }),
    );

    expect(revokeMutate).toHaveBeenCalledTimes(1);
    expect(revokeMutate).toHaveBeenCalledWith({ invitationId: 'invitation-7' });
  });

  it('removes a member only once the owner has confirmed', () => {
    mockHousehold({
      members: [
        makeMember({ id: 'member-1', userId: OWNER_USER, name: 'Ada', role: 'owner' }),
        makeMember({ id: 'member-2', userId: MEMBER_USER, name: 'Gran', role: 'member' }),
      ],
    });
    render(<Household />);

    fireEvent.click(screen.getByRole('button', { name: 'Remove Gran' }));
    expect(removeMutate).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole('button', { name: 'Yes, remove Gran' }));
    expect(removeMutate).toHaveBeenCalledTimes(1);
    expect(removeMutate).toHaveBeenCalledWith({ memberId: 'member-2' });
  });

  it('offers no remove control on the owner’s own row', () => {
    mockHousehold({
      members: [
        makeMember({ id: 'member-1', userId: OWNER_USER, name: 'Ada', role: 'owner' }),
        makeMember({ id: 'member-2', userId: MEMBER_USER, name: 'Gran', role: 'member' }),
      ],
    });
    render(<Household />);

    expect(screen.getByRole('button', { name: 'Remove Gran' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Remove Ada' })).not.toBeInTheDocument();
  });

  it('signs out a member whose membership ended under them', () => {
    mockHousehold({ viewer: MEMBER_USER, membersError: { message: NOT_A_MEMBER_MESSAGE } });
    render(<Household />);

    expect(signOut).toHaveBeenCalledTimes(1);
    expect(screen.queryByRole('button', { name: 'Send invitation' })).not.toBeInTheDocument();
  });

  it('does not sign anyone out for an ordinary query failure', () => {
    mockHousehold({ membersError: { message: 'Something else went wrong' } });
    render(<Household />);

    expect(signOut).not.toHaveBeenCalled();
    expect(screen.getByRole('alert')).toBeInTheDocument();
  });

  it('signs the current user out on request', () => {
    mockHousehold({});
    render(<Household />);

    fireEvent.click(screen.getByRole('button', { name: 'Sign out' }));

    expect(signOut).toHaveBeenCalledTimes(1);
  });
});

describe('the household name', () => {
  it('lets the owner rename the household, saving the trimmed name', () => {
    mockHousehold({});
    render(<Household />);
    const box = screen.getByLabelText('Name');
    expect(box).toHaveValue('Blueberry House');
    expect(screen.getByRole('button', { name: 'Save' })).toBeDisabled();
    fireEvent.change(box, { target: { value: '  The Lewis Kitchen ' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    expect(renameMutate).toHaveBeenCalledWith({ name: 'The Lewis Kitchen' }, expect.anything());
  });

  it('shows a member the name without a box to change it', () => {
    mockHousehold({
      members: [makeMember(), makeMember({ id: 'member-2', userId: MEMBER_USER, role: 'member' })],
      viewer: MEMBER_USER,
    });
    render(<Household />);
    expect(screen.getByText('Blueberry House')).toBeInTheDocument();
    expect(screen.queryByLabelText('Name')).toBeNull();
  });
});
