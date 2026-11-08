import { describe, it, expect } from 'vitest';
import { decideGate, type GateInput } from './session-gate';

const KNOWN = { userId: 'u1', householdId: 'h1', sessionId: 's1' };
const NETWORK = new TypeError('Failed to fetch');

function input(overrides: Partial<GateInput>): GateInput {
  return {
    session: null,
    sessionPending: false,
    sessionError: null,
    household: null,
    householdPending: false,
    householdError: null,
    known: null,
    signOutPending: null,
    signOutInFlight: false,
    preferKnown: false,
    ...overrides,
  };
}

describe('decideGate', () => {
  it('opens the app for a session and household the server confirmed', () => {
    expect(
      decideGate(input({ session: { userId: 'u1', sessionId: 's1' }, household: { id: 'h1' } })),
    ).toEqual({ kind: 'app', session: KNOWN, offline: false });
  });

  it('opens from the known session when the check cannot reach the server', () => {
    expect(decideGate(input({ sessionError: NETWORK, known: KNOWN }))).toEqual({
      kind: 'app',
      session: KNOWN,
      offline: true,
    });
    // A proxy answering for a box that is down is not an answer either.
    expect(decideGate(input({ sessionError: { status: 502 }, known: KNOWN })).kind).toBe('app');
  });

  it('signs out, and forgets, only when the server says so', () => {
    expect(decideGate(input({ known: KNOWN }))).toEqual({ kind: 'sign-in', forget: true });
    expect(decideGate(input({ sessionError: { status: 401 }, known: KNOWN }))).toEqual({
      kind: 'sign-in',
      forget: true,
    });
    // Not Better Auth's no: a rate limit, or a proxy or captive portal in front of the box.
    for (const status of [403, 404, 429]) {
      expect(decideGate(input({ sessionError: { status }, known: KNOWN })).kind).toBe('app');
    }
  });

  it('shows sign-in without forgetting when unreachable and nothing is known', () => {
    expect(decideGate(input({ sessionError: NETWORK }))).toEqual({
      kind: 'sign-in',
      forget: false,
    });
  });

  it('waits for the first check online, and opens from the known session offline or when slow', () => {
    expect(decideGate(input({ sessionPending: true, known: KNOWN })).kind).toBe('wait');
    expect(decideGate(input({ sessionPending: true, known: KNOWN, preferKnown: true }))).toEqual({
      kind: 'app',
      session: KNOWN,
      offline: true,
    });
    expect(decideGate(input({ sessionPending: true, preferKnown: true })).kind).toBe('wait');
  });

  it('opens offline when only the household check failed, for the same person only', () => {
    const session = { userId: 'u1', sessionId: 's1' };
    expect(decideGate(input({ session, householdError: NETWORK, known: KNOWN }))).toMatchObject({
      kind: 'app',
      offline: true,
    });
    expect(
      decideGate(
        input({
          session: { userId: 'u2', sessionId: 's9' },
          householdError: NETWORK,
          known: KNOWN,
        }),
      ).kind,
    ).toBe('wait');
  });

  it('sends a member with no household to onboarding, which forgets', () => {
    const session = { userId: 'u1', sessionId: 's1' };
    expect(decideGate(input({ session, known: KNOWN })).kind).toBe('onboarding');
    expect(decideGate(input({ session, householdError: { status: 403 }, known: KNOWN })).kind).toBe(
      'onboarding',
    );
  });

  it('ends a sign-out made offline when that session shows up again, and not a newer one', () => {
    const household = { id: 'h1' };
    expect(
      decideGate(
        input({ session: { userId: 'u1', sessionId: 's1' }, household, signOutPending: 's1' }),
      ).kind,
    ).toBe('finish-sign-out');
    expect(
      decideGate(
        input({ session: { userId: 'u1', sessionId: 's2' }, household, signOutPending: 's1' }),
      ).kind,
    ).toBe('app');
  });

  it('does not send a sign-out on a session the auth client kept from before a failed check', () => {
    const household = { id: 'h1' };
    const session = { userId: 'u1', sessionId: 's1' };
    expect(
      decideGate(input({ session, household, signOutPending: 's1', sessionError: NETWORK })),
    ).toEqual({ kind: 'sign-in', forget: false });
    // Nor a second one while this page's own request is still out.
    expect(
      decideGate(input({ session, household, signOutPending: 's1', signOutInFlight: true })),
    ).toEqual({ kind: 'sign-in', forget: false });
  });

  it('marks a kept session as offline, so it is not remembered as fresh', () => {
    expect(
      decideGate(
        input({
          session: { userId: 'u1', sessionId: 's1' },
          household: { id: 'h1' },
          sessionError: NETWORK,
        }),
      ),
    ).toEqual({ kind: 'app', session: KNOWN, offline: true });
  });

  it('takes only 401 and 403 as a no from the household check', () => {
    const session = { userId: 'u1', sessionId: 's1' };
    expect(decideGate(input({ session, householdError: { status: 401 }, known: KNOWN })).kind).toBe(
      'onboarding',
    );
    expect(decideGate(input({ session, householdError: { status: 404 }, known: KNOWN })).kind).toBe(
      'app',
    );
  });
});
