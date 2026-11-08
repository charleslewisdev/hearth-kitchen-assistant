/**
 * What this phone keeps so the app opens with no signal (D56): who was signed in, and a copy of
 * the shopping list with any changes still waiting to be sent.
 *
 * Everything lives in localStorage under one prefix, so forgetting it is one sweep:
 *
 *   - `hearth.offline.session`: the user, household and session ids last confirmed by the server.
 *     No token, no email, no name: a session id names the row, it does not sign anyone in. The
 *     session itself is Better Auth's HttpOnly cookie, which no script here can read or copy.
 *   - `hearth.offline.cache`: the TanStack Query cache, filtered to the queries and queued changes
 *     in `PERSISTED_QUERIES` and the list's own changes, stamped with the session it belongs to
 *     (the `buster`). A copy stamped for anyone else is thrown away rather than shown.
 *
 * It is written only while a known session is stored, so once sign-out or the server's "nobody is
 * signed in" has swept it, a component still on screen for one more render cannot put it back.
 */
import type { Mutation, MutationFunctionContext, Query, QueryClient } from '@tanstack/react-query';
import type {
  PersistedClient,
  Persister,
  PersistQueryClientOptions,
} from '@tanstack/react-query-persist-client';

export const OFFLINE_PREFIX = 'hearth.offline.';
const SESSION_KEY = `${OFFLINE_PREFIX}session`;
const CACHE_KEY = `${OFFLINE_PREFIX}cache`;
/**
 * A sign-out the server has not heard about yet, made with no signal. Kept outside the prefix on
 * purpose: forgetting everything else is part of signing out, and this has to outlive that until
 * the server has ended the session too.
 */
const SIGN_OUT_KEY = 'hearth.signOutPending';

/** A copy older than this is not shown: a list from a fortnight ago is no longer the list. */
export const OFFLINE_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;

/** Queries copied to the phone, as tRPC paths. The Shop tab needs only its list. */
export const PERSISTED_QUERIES: readonly string[] = ['shoppingList.get'];

/** Changes that survive the app being closed while they wait for a signal: the list's own. */
const PERSISTED_MUTATION_ROUTER = 'shoppingList';

/** Who the copy belongs to. Ids only. */
export type KnownSession = { userId: string; householdId: string; sessionId: string };

function storage(): Storage | null {
  try {
    return window.localStorage;
  } catch {
    return null; // blocked storage: the app works as before, online only
  }
}

function isKnownSession(value: unknown): value is KnownSession {
  if (typeof value !== 'object' || value === null) return false;
  const record = value as Record<string, unknown>;
  return ['userId', 'householdId', 'sessionId'].every(
    (field) => typeof record[field] === 'string' && record[field] !== '',
  );
}

export function readKnownSession(): KnownSession | null {
  return parseKnownSession(storage()?.getItem(SESSION_KEY) ?? null);
}

/** The stored record read back, or null when it is absent or not one this module wrote. */
export function parseKnownSession(raw: string | null): KnownSession | null {
  if (!raw) return null;
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!isKnownSession(parsed)) return null;
    // Rebuilt field by field, so nothing else that found its way into the record is carried.
    return { userId: parsed.userId, householdId: parsed.householdId, sessionId: parsed.sessionId };
  } catch {
    return null;
  }
}

/**
 * The stamp a cached copy carries, so one person's list never opens for another. Not the session
 * id: signing in again on the same phone keeps the same person's copy.
 */
export function scopeOf(session: Pick<KnownSession, 'userId' | 'householdId'>): string {
  return `${session.userId}:${session.householdId}`;
}

const listeners = new Set<() => void>();
function notify() {
  for (const listener of listeners) listener();
}

/** For `useSyncExternalStore`: follows remember and forget here, and in other tabs. */
export function subscribeKnownSession(listener: () => void): () => void {
  listeners.add(listener);
  const onStorage = (e: StorageEvent) => {
    if (e.key === null || e.key === SESSION_KEY) listener();
  };
  window.addEventListener('storage', onStorage);
  return () => {
    listeners.delete(listener);
    window.removeEventListener('storage', onStorage);
  };
}

/** The stored record as a string, which is what `useSyncExternalStore` needs to compare. */
export function knownSessionSnapshot(): string | null {
  return storage()?.getItem(SESSION_KEY) ?? null;
}

function storedScope(): string | null {
  const session = readKnownSession();
  return session ? scopeOf(session) : null;
}

/**
 * Record who the server just confirmed. A different person or household than the stored one
 * means the old copy is someone else's, so it goes first.
 */
export function rememberSession(session: KnownSession): void {
  const store = storage();
  if (!store) return;
  const previous = readKnownSession();
  if (
    previous &&
    scopeOf(previous) === scopeOf(session) &&
    previous.sessionId === session.sessionId
  ) {
    return;
  }
  if (previous && scopeOf(previous) !== scopeOf(session)) forgetOfflineData();
  const { userId, householdId, sessionId } = session;
  try {
    store.setItem(SESSION_KEY, JSON.stringify({ userId, householdId, sessionId }));
  } catch {
    return; // full or blocked: nothing is kept, so nothing is shown offline
  }
  notify();
}

/** Remove everything this module keeps: the session record and the cached list. */
export function forgetOfflineData(): void {
  const store = storage();
  if (!store) return;
  const keys: string[] = [];
  for (let i = 0; i < store.length; i += 1) {
    const key = store.key(i);
    if (key?.startsWith(OFFLINE_PREFIX)) keys.push(key);
  }
  for (const key of keys) store.removeItem(key);
  if (keys.includes(SESSION_KEY)) notify();
}

/** The session whose sign-out has still to reach the server, if any. */
export function pendingSignOut(): string | null {
  return storage()?.getItem(SIGN_OUT_KEY) ?? null;
}

export function setPendingSignOut(sessionId: string | null): void {
  const store = storage();
  if (!store) return;
  try {
    if (sessionId === null) store.removeItem(SIGN_OUT_KEY);
    else store.setItem(SIGN_OUT_KEY, sessionId);
  } catch {
    // Blocked: the sign-out is only as good as the request that carries it.
  }
}

/**
 * Where the cache is kept. Writes only for `scope`, and only while that scope is the stored
 * session: after a sweep, a write from a screen that has not yet unmounted is dropped.
 */
export function createListPersister(scope: string): Persister {
  return {
    persistClient(client: PersistedClient) {
      const store = storage();
      if (!store || client.buster !== scope || storedScope() !== scope) return;
      try {
        store.setItem(CACHE_KEY, JSON.stringify(client));
      } catch {
        // Full: the last copy that fitted stays, and the next change tries again.
      }
    },
    restoreClient() {
      const raw = storage()?.getItem(CACHE_KEY);
      if (!raw) return undefined;
      try {
        return JSON.parse(raw) as PersistedClient;
      } catch {
        return undefined;
      }
    },
    removeClient() {
      storage()?.removeItem(CACHE_KEY);
    },
  };
}

/** A tRPC query or mutation key's path, `['shoppingList', 'get']`, as `shoppingList.get`. */
function pathOf(key: readonly unknown[] | undefined): string | null {
  const first = key?.[0];
  if (!Array.isArray(first) || !first.every((part) => typeof part === 'string')) return null;
  return first.join('.');
}

export function shouldPersistQuery(query: Query): boolean {
  const path = pathOf(query.queryKey);
  return query.state.status === 'success' && path !== null && PERSISTED_QUERIES.includes(path);
}

/** A list change still waiting for a signal. One that has been sent is not replayed. */
export function shouldPersistMutation(mutation: Mutation): boolean {
  const path = pathOf(mutation.options.mutationKey);
  return mutation.state.isPaused && path?.split('.')[0] === PERSISTED_MUTATION_ROUTER;
}

/** The options `PersistQueryClientProvider` takes for one session's copy. */
export function persistOptionsFor(scope: string): Omit<PersistQueryClientOptions, 'queryClient'> {
  return {
    persister: createListPersister(scope),
    buster: scope,
    maxAge: OFFLINE_MAX_AGE_MS,
    dehydrateOptions: {
      shouldDehydrateQuery: shouldPersistQuery,
      shouldDehydrateMutation: shouldPersistMutation,
    },
  };
}

/**
 * Teach the client how to send a list change restored from storage.
 *
 * A change queued in this page carries its own function from `useMutation`. One restored after the
 * app was closed has only its key and input, so it is sent by path through `send`, and then the
 * list is asked for again, as the screen's own `onSettled` would have done. The server checks the
 * session and the membership on every request, so a change queued by someone who has since
 * lost access is refused there, not trusted because it was queued.
 *
 * The persisted queries are kept in memory as long as the copy is good for, or a list not on
 * screen for five minutes would be dropped from the next copy written.
 */
export function installOfflineDefaults(
  queryClient: QueryClient,
  send: (path: string, input: unknown) => Promise<unknown>,
): void {
  queryClient.setMutationDefaults([[PERSISTED_MUTATION_ROUTER]], {
    mutationFn: (input: unknown, context: MutationFunctionContext) => {
      const path = pathOf(context.mutationKey);
      if (!path) return Promise.reject(new Error('A queued change has no procedure'));
      return send(path, input);
    },
    onSettled: () =>
      queryClient.invalidateQueries({ queryKey: [[PERSISTED_MUTATION_ROUTER, 'get']] }),
  });
  for (const path of PERSISTED_QUERIES) {
    queryClient.setQueryDefaults([path.split('.')], { gcTime: OFFLINE_MAX_AGE_MS });
  }
}

/**
 * Empty the in-memory cache once when the session it was filled for gives way to another, so one
 * person's list is never on screen for the next, even for a render.
 */
let memoryScope: string | null = null;
export function enterScope(queryClient: QueryClient, scope: string): void {
  if (memoryScope !== null && memoryScope !== scope) queryClient.clear();
  memoryScope = scope;
}
export function leaveScope(queryClient: QueryClient): void {
  queryClient.clear();
  memoryScope = null;
}
