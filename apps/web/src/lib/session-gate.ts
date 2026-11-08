import type { KnownSession } from './offline';

/**
 * What the session gate shows, decided from what the server said and what this phone remembers.
 *
 * The rule (D56): only the server can say someone is signed out. A session check that could not
 * reach it (no signal, a timeout, a proxy's 502) is not an answer, so a phone that has a known
 * session opens the app from it, offline. Better Auth's own answers are what count: "nobody" (a
 * 200 with no session) or a 401 to the session check, and a 401 or 403 to the household check. Any
 * other 4xx may be a proxy or a captive portal in front of the box, so it is not taken as a no.
 * An answer means the sign-in screen (or onboarding), and this phone forgets what it kept.
 */
export type GateView =
  /** Nothing yet: the first check is still out and there is nothing to show meanwhile. */
  | { kind: 'wait' }
  /** Signed out, per the server. `forget` sweeps the kept copy. */
  | { kind: 'sign-in'; forget: boolean }
  /** Signed in with no household, per the server: also forgets the kept copy. */
  | { kind: 'onboarding' }
  /** The app, for this session. `offline` when it is the remembered one, not a fresh answer. */
  | { kind: 'app'; session: KnownSession; offline: boolean }
  /** A sign-out made offline, and the server has just shown that session again: end it. */
  | { kind: 'finish-sign-out' };

export type GateInput = {
  session: { userId: string; sessionId: string } | null;
  sessionPending: boolean;
  sessionError: unknown;
  household: { id: string } | null;
  householdPending: boolean;
  householdError: unknown;
  known: KnownSession | null;
  /** The session a sign-out made offline is still waiting to end on the server. */
  signOutPending: string | null;
  /** A sign-out request from this page is still out; the gate does not send a second. */
  signOutInFlight: boolean;
  /**
   * Whether to open from the known session while the first check is still out: the browser says
   * there is no network, the check has been slow, or the remembered session is already on screen.
   */
  preferKnown: boolean;
};

function statusOf(error: unknown): unknown {
  return (error as { status?: unknown } | null)?.status;
}

export function decideGate(input: GateInput): GateView {
  const { session, known } = input;

  if (session) {
    // The auth client keeps the last session it had when a later check fails: still this
    // person, but not a fresh answer, so not one to remember or to send a sign-out on.
    const stale = Boolean(input.sessionError);
    if (input.signOutPending === session.sessionId) {
      return stale || input.signOutInFlight
        ? { kind: 'sign-in', forget: false }
        : { kind: 'finish-sign-out' };
    }
    if (input.household) {
      return {
        kind: 'app',
        session: {
          userId: session.userId,
          householdId: input.household.id,
          sessionId: session.sessionId,
        },
        offline: stale,
      };
    }
    // The session answered and the household check did not, for a known pair: open offline.
    const mine = known?.userId === session.userId ? known : null;
    if (input.householdPending)
      return mine && input.preferKnown ? offlineApp(mine) : { kind: 'wait' };
    const refused = [401, 403].includes(statusOf(input.householdError) as number);
    if (input.householdError && !refused) {
      return mine ? offlineApp(mine) : { kind: 'wait' };
    }
    return { kind: 'onboarding' };
  }

  if (input.sessionPending)
    return known && input.preferKnown ? offlineApp(known) : { kind: 'wait' };
  if (input.sessionError && statusOf(input.sessionError) !== 401) {
    // Unreachable. A sign-out still to be sent counts as signed out here.
    return known ? offlineApp(known) : { kind: 'sign-in', forget: false };
  }
  return { kind: 'sign-in', forget: true };
}

function offlineApp(session: KnownSession): GateView {
  return { kind: 'app', session, offline: true };
}
