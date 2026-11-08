import { describe, it, expect, vi, beforeEach } from 'vitest';
import { QueryClient, onlineManager } from '@tanstack/react-query';
import {
  persistQueryClientRestore,
  persistQueryClientSave,
} from '@tanstack/react-query-persist-client';
import {
  OFFLINE_MAX_AGE_MS,
  enterScope,
  forgetOfflineData,
  installOfflineDefaults,
  pendingSignOut,
  persistOptionsFor,
  readKnownSession,
  rememberSession,
  scopeOf,
  setPendingSignOut,
  type KnownSession,
} from './offline';

const LIST_KEY = [['shoppingList', 'get'], { type: 'query' }];
const ANNA: KnownSession = { userId: 'user-anna', householdId: 'house-1', sessionId: 'sess-a1' };
const BEN: KnownSession = { userId: 'user-ben', householdId: 'house-1', sessionId: 'sess-b1' };

function listOf(...names: string[]) {
  return { list: { id: 'list-1' }, items: names.map((name, i) => ({ id: `i${i}`, name })) };
}

/** Save `client`'s copy as `session` would: the session is stored, then the cache written. */
async function saveAs(session: KnownSession, client: QueryClient) {
  rememberSession(session);
  await persistQueryClientSave({ queryClient: client, ...persistOptionsFor(scopeOf(session)) });
}

/** A fresh client (a cold start) restored for `session`. */
async function restoreAs(session: KnownSession, send = vi.fn()) {
  const client = new QueryClient();
  installOfflineDefaults(client, send);
  await persistQueryClientRestore({ queryClient: client, ...persistOptionsFor(scopeOf(session)) });
  return client;
}

beforeEach(() => {
  localStorage.clear();
  onlineManager.setOnline(true);
});

describe('the remembered session', () => {
  it('keeps the three ids and nothing else', () => {
    rememberSession({ ...ANNA, email: 'anna@example.com', token: 'secret' } as KnownSession);

    expect(readKnownSession()).toEqual(ANNA);
    const stored = localStorage.getItem('hearth.offline.session') ?? '';
    expect(stored).not.toContain('anna@example.com');
    expect(stored).not.toContain('secret');
  });

  it('ignores a record it did not write', () => {
    localStorage.setItem('hearth.offline.session', JSON.stringify({ userId: 'u' }));
    expect(readKnownSession()).toBeNull();
    localStorage.setItem('hearth.offline.session', 'not json');
    expect(readKnownSession()).toBeNull();
  });
});

describe('the kept copy of the list', () => {
  it('keeps the shopping list and no other query', async () => {
    const client = new QueryClient();
    client.setQueryData(LIST_KEY, listOf('coffee beans'));
    client.setQueryData([['recipe', 'list'], { type: 'query' }], [{ title: 'Soup' }]);
    await saveAs(ANNA, client);

    const stored = localStorage.getItem('hearth.offline.cache') ?? '';
    expect(stored).toContain('coffee beans');
    expect(stored).not.toContain('Soup');

    const restored = await restoreAs(ANNA);
    expect(restored.getQueryData(LIST_KEY)).toEqual(listOf('coffee beans'));
  });

  it('is never restored for someone else, and is thrown away when they try', async () => {
    const client = new QueryClient();
    client.setQueryData(LIST_KEY, listOf('coffee beans'));
    await saveAs(ANNA, client);

    const restored = await restoreAs(BEN);

    expect(restored.getQueryData(LIST_KEY)).toBeUndefined();
    expect(localStorage.getItem('hearth.offline.cache')).toBeNull();
  });

  it('is not kept for another household of the same person', async () => {
    const client = new QueryClient();
    client.setQueryData(LIST_KEY, listOf('coffee beans'));
    await saveAs(ANNA, client);

    const restored = await restoreAs({ ...ANNA, householdId: 'house-2' });
    expect(restored.getQueryData(LIST_KEY)).toBeUndefined();
  });

  it('survives signing in again as the same person', async () => {
    const client = new QueryClient();
    client.setQueryData(LIST_KEY, listOf('coffee beans'));
    await saveAs(ANNA, client);

    rememberSession({ ...ANNA, sessionId: 'sess-a2' });

    expect((await restoreAs(ANNA)).getQueryData(LIST_KEY)).toEqual(listOf('coffee beans'));
  });

  it('goes when a different person is remembered on this phone', async () => {
    const client = new QueryClient();
    client.setQueryData(LIST_KEY, listOf('coffee beans'));
    await saveAs(ANNA, client);

    rememberSession(BEN);

    expect(localStorage.getItem('hearth.offline.cache')).toBeNull();
    expect(readKnownSession()).toEqual(BEN);
  });

  it('is not written once the session record has been swept', async () => {
    rememberSession(ANNA);
    forgetOfflineData();

    const client = new QueryClient();
    client.setQueryData(LIST_KEY, listOf('coffee beans'));
    await persistQueryClientSave({ queryClient: client, ...persistOptionsFor(scopeOf(ANNA)) });

    expect(localStorage.getItem('hearth.offline.cache')).toBeNull();
  });

  it('is not shown once it is older than a week', async () => {
    vi.useFakeTimers();
    try {
      const client = new QueryClient();
      client.setQueryData(LIST_KEY, listOf('coffee beans'));
      await saveAs(ANNA, client);
      vi.setSystemTime(Date.now() + OFFLINE_MAX_AGE_MS + 1);

      expect((await restoreAs(ANNA)).getQueryData(LIST_KEY)).toBeUndefined();
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('a tick made with no signal', () => {
  it('is kept with the list and sent after a cold start once the signal is back', async () => {
    onlineManager.setOnline(false);
    const before = new QueryClient();
    installOfflineDefaults(before, vi.fn());
    before.setQueryData(LIST_KEY, listOf('coffee beans'));
    void before
      .getMutationCache()
      .build(before, { mutationKey: [['shoppingList', 'toggleChecked']] })
      .execute({ itemId: 'i0', checked: true })
      .catch(() => undefined);
    await vi.waitFor(() =>
      expect(before.getMutationCache().getAll()[0]?.state.isPaused).toBe(true),
    );
    await saveAs(ANNA, before);

    const send = vi.fn().mockResolvedValue({ ok: true });
    const after = await restoreAs(ANNA, send);
    after.mount(); // what QueryClientProvider does: follow the network, and resume on reconnect
    void after.resumePausedMutations();
    expect(send).not.toHaveBeenCalled();

    onlineManager.setOnline(true);
    await vi.waitFor(() =>
      expect(send).toHaveBeenCalledWith('shoppingList.toggleChecked', {
        itemId: 'i0',
        checked: true,
      }),
    );
    after.unmount();
  });

  it('is not kept once sent, and other screens’ changes are never kept', async () => {
    const client = new QueryClient();
    installOfflineDefaults(client, vi.fn().mockResolvedValue({}));
    await client
      .getMutationCache()
      .build(client, { mutationKey: [['shoppingList', 'toggleChecked']] })
      .execute({ itemId: 'i0', checked: true });
    onlineManager.setOnline(false);
    void client
      .getMutationCache()
      .build(client, { mutationKey: [['recipe', 'update']], mutationFn: vi.fn() })
      .execute({ title: 'Soup' })
      .catch(() => undefined);
    await saveAs(ANNA, client);

    const stored = JSON.parse(localStorage.getItem('hearth.offline.cache') ?? '{}');
    expect(stored.clientState.mutations).toEqual([]);
  });
});

describe('forgetting', () => {
  it('sweeps what this module keeps and leaves the phone’s other settings', async () => {
    const client = new QueryClient();
    client.setQueryData(LIST_KEY, listOf('coffee beans'));
    await saveAs(ANNA, client);
    localStorage.setItem('hearth.library.sort', 'title');

    forgetOfflineData();

    expect(readKnownSession()).toBeNull();
    expect(localStorage.getItem('hearth.offline.cache')).toBeNull();
    expect(localStorage.getItem('hearth.library.sort')).toBe('title');
  });

  it('keeps a pending sign-out, which has to outlive the sweep', () => {
    setPendingSignOut('sess-a1');
    forgetOfflineData();
    expect(pendingSignOut()).toBe('sess-a1');
  });

  it('empties the in-memory cache when another session takes over', () => {
    const client = new QueryClient();
    enterScope(client, scopeOf(ANNA));
    client.setQueryData(LIST_KEY, listOf('coffee beans'));

    enterScope(client, scopeOf(ANNA));
    expect(client.getQueryData(LIST_KEY)).toBeDefined();

    enterScope(client, scopeOf(BEN));
    expect(client.getQueryData(LIST_KEY)).toBeUndefined();
  });
});
