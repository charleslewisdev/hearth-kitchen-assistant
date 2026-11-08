import type { KnownSession } from './offline';

/**
 * What the session gate shows, decided from what the server said and what this phone remembers.
 *
 * The rule (D56): only the server can say someone is signed out. A session check that could not
 * reach it (no signal, a timeout, a proxy's 502) is not an answer, so a phone that has a known
 * session opens the app from it, offline. A 401, or a check that answers "nobody", is an answer:
 * the sign-in screen, and this phone forgets what it kept.
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
  /**
   * Whether to open from the known session while the first check is still out: the browser says
   * there is no network, the check has been slow, or the remembered session is already on screen.
   */
  preferKnown: boolean;
};

/**
 * Whether the server answered, with a refusal: any 4xx but a timeout or a rate limit. Anything
 * else (no response, a 5xx from a proxy whose box is down) says nothing about the session.
 */
function isRefusal(error: unknown): boolean {
  const status = (error as { status?: unknown } | null)?.status;
  return (
    typeof status === 'number' && status >= 400 && status < 500 && status !== 408 && status !== 429
  );
}

export function decideGate(input: GateInput): GateView {
  const { session, known } = input;

  if (session) {
    if (input.signOutPending === session.sessionId) return { kind: 'finish-sign-out' };
    if (input.household) {
      return {
        kind: 'app',
        session: {
          userId: session.userId,
          householdId: input.household.id,
          sessionId: session.sessionId,
        },
        offline: false,
      };
    }
    // The session answered and the household check did not, for a known pair: open offline.
    const mine = known?.userId === session.userId ? known : null;
    if (input.householdPending)
      return mine && input.preferKnown ? offlineApp(mine) : { kind: 'wait' };
    if (input.householdError && !isRefusal(input.householdError)) {
      return mine ? offlineApp(mine) : { kind: 'wait' };
    }
    return { kind: 'onboarding' };
  }

  if (input.sessionPending)
    return known && input.preferKnown ? offlineApp(known) : { kind: 'wait' };
  if (input.sessionError && !isRefusal(input.sessionError)) {
    // Unreachable. A sign-out still to be sent counts as signed out here.
    return known ? offlineApp(known) : { kind: 'sign-in', forget: false };
  }
  return { kind: 'sign-in', forget: true };
}

function offlineApp(session: KnownSession): GateView {
  return { kind: 'app', session, offline: true };
}
