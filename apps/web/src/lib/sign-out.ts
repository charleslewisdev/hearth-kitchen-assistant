import { authClient } from './auth';
import { queryClient } from './query-client';
import { forgetOfflineData, leaveScope, readKnownSession, setPendingSignOut } from './offline';

/**
 * Sign out, and leave nothing of this person's on the phone (D56).
 *
 * The kept copy and the in-memory cache go first, before the request, so that on a shared phone
 * signing out with no signal still leaves no list behind. Queued list changes go with them: they
 * belonged to the person who just left. The session cookie is HttpOnly, so only the server can end
 * it; if the request cannot get there, the session id is noted and the session gate ends it the next
 * time the server shows it.
 */
export async function signOut(): Promise<void> {
  const known = readKnownSession();
  leaveScope(queryClient);
  forgetOfflineData();
  if (known) setPendingSignOut(known.sessionId);
  let failed = true;
  try {
    const result: unknown = await authClient.signOut();
    failed = Boolean((result as { error?: unknown } | undefined)?.error);
  } catch {
    failed = true;
  }
  if (!failed) setPendingSignOut(null);
}
