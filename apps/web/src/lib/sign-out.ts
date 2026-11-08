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
let inFlight = false;

/** Whether a sign-out request from this page is still out, so the gate does not send another. */
export function signOutInFlight(): boolean {
  return inFlight;
}

export async function signOut(): Promise<void> {
  const known = readKnownSession();
  // Noted before the sweep, whose notice re-renders the gate: it must already see the sign-out.
  if (known) setPendingSignOut(known.sessionId);
  inFlight = true;
  leaveScope(queryClient);
  forgetOfflineData();
  try {
    if (await sendSignOut()) setPendingSignOut(null);
  } finally {
    inFlight = false;
  }
}

/** Ask the server to end the session. True when it did; never throws. */
export async function sendSignOut(): Promise<boolean> {
  try {
    const result: unknown = await authClient.signOut();
    return !(result as { error?: unknown } | undefined)?.error;
  } catch {
    return false;
  }
}
