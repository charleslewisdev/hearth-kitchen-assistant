import { describe, it, expect, vi, beforeEach, type Mock } from 'vitest';
import { authClient } from './auth';
import { queryClient } from './query-client';
import { pendingSignOut, readKnownSession, rememberSession } from './offline';
import { signOut } from './sign-out';

vi.mock('./auth', () => ({ authClient: { signOut: vi.fn() } }));
vi.mock('./trpc', () => ({ trpcClient: {} }));

const authSignOut = authClient.signOut as unknown as Mock;
const LIST_KEY = [['shoppingList', 'get'], { type: 'query' }];

beforeEach(() => {
  localStorage.clear();
  queryClient.clear();
  rememberSession({ userId: 'u1', householdId: 'h1', sessionId: 's1' });
  localStorage.setItem('hearth.offline.cache', '{"buster":"u1:h1"}');
  queryClient.setQueryData(LIST_KEY, { items: [{ name: 'coffee beans' }] });
});

describe('signOut', () => {
  it('forgets the kept copy and the in-memory list before asking the server', async () => {
    let seenAtRequest: unknown[] = [];
    authSignOut.mockImplementation(async () => {
      seenAtRequest = [
        readKnownSession(),
        localStorage.getItem('hearth.offline.cache'),
        queryClient.getQueryData(LIST_KEY),
      ];
      return { data: { success: true }, error: null };
    });

    await signOut();

    expect(seenAtRequest).toEqual([null, null, undefined]);
    expect(pendingSignOut()).toBeNull();
  });

  it('notes the session to end later when the server cannot be reached', async () => {
    authSignOut.mockRejectedValue(new TypeError('Failed to fetch'));

    await signOut();

    expect(readKnownSession()).toBeNull();
    expect(localStorage.getItem('hearth.offline.cache')).toBeNull();
    expect(pendingSignOut()).toBe('s1');
  });

  it('notes it too when the server answers with an error', async () => {
    authSignOut.mockResolvedValue({ data: null, error: { status: 502 } });
    await signOut();
    expect(pendingSignOut()).toBe('s1');
  });
});
