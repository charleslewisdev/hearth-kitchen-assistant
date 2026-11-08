import { useEffect, useMemo, useRef, useState, useSyncExternalStore, type ReactNode } from 'react';
import { onlineManager, QueryClientProvider } from '@tanstack/react-query';
import { PersistQueryClientProvider } from '@tanstack/react-query-persist-client';
import { BrowserRouter, Outlet, Routes, Route } from 'react-router-dom';
import { trpc, trpcClient } from './lib/trpc';
import { authClient } from './lib/auth';
import { queryClient } from './lib/query-client';
import {
  enterScope,
  forgetOfflineData,
  knownSessionSnapshot,
  leaveScope,
  pendingSignOut,
  persistOptionsFor,
  parseKnownSession,
  rememberSession,
  scopeOf,
  setPendingSignOut,
  subscribeKnownSession,
  type KnownSession,
} from './lib/offline';
import { KeptSessionContext } from './lib/offline-context';
import { decideGate } from './lib/session-gate';
import { sendSignOut, signOutInFlight } from './lib/sign-out';
import { AppShell } from './app/AppShell';
import { ScrollToTopOnNavigate } from './app/ScrollToTopOnNavigate';
import { SignIn } from './routes/SignIn';
import { Onboarding } from './routes/Onboarding';
import { AcceptInvite } from './routes/AcceptInvite';
import { ResetPassword } from './routes/ResetPassword';
import { Library } from './routes/Library';
import { Import } from './routes/Import';
import { RecipeEdit } from './routes/RecipeEdit';
import { RecipeView } from './routes/RecipeView';
import { CookMode } from './routes/CookMode';
import { ShoppingList } from './routes/ShoppingList';
import { Household } from './routes/Household';
import { Plan } from './routes/Plan';
import { Foods } from './routes/Foods';
import { Tags } from './routes/Tags';

/**
 * How long the first session check may take before a phone that remembers its session opens from
 * it. A signal too weak to carry a request leaves `navigator.onLine` true and the check hanging.
 */
export const SLOW_SESSION_CHECK_MS = 4_000;

/** How often the app, open from the remembered session, asks the server again. */
export const KEPT_RECHECK_MS = 30_000;

/**
 * The ids the gate reads, or null for anything else. A captive portal answering the session check
 * with a 200 page of HTML hands the auth client a string, and reading `.user.id` off that would
 * blank the app.
 */
function sessionIds(data: unknown): { userId: string; sessionId: string } | null {
  const d = data as { user?: { id?: unknown }; session?: { id?: unknown } } | null;
  const userId = d?.user?.id;
  const sessionId = d?.session?.id;
  return typeof userId === 'string' && typeof sessionId === 'string' ? { userId, sessionId } : null;
}

function householdId(data: unknown): { id: string } | null {
  const id = (data as { id?: unknown } | null)?.id;
  return typeof id === 'string' ? { id } : null;
}

/**
 * Who may see the app: a session, and a household to see it in.
 *
 * A layout route rather than a branch above the router, because one route has to be reachable
 * without either of those and cannot be if the whole router sits behind them.
 *
 * With no signal, the session this phone last had stands in for the check that cannot be made, and
 * only an answer from the server signs anyone out (D56; the rules are in `lib/session-gate.ts`).
 */
function SessionGate() {
  const {
    data: session,
    isPending,
    error: sessionError,
    refetch: refetchSession,
  } = authClient.useSession();
  const activeOrg = authClient.useActiveOrganization();
  const knownRecord = useSyncExternalStore(subscribeKnownSession, knownSessionSnapshot, () => null);
  const known = useMemo(() => parseKnownSession(knownRecord), [knownRecord]);
  const [slow, setSlow] = useState(false);
  useEffect(() => {
    const timer = setTimeout(() => setSlow(true), SLOW_SESSION_CHECK_MS);
    return () => clearTimeout(timer);
  }, []);
  // Once open from the remembered session, a recheck in flight does not blank the screen.
  const onKept = useRef(false);

  /*
    Ask for the household again once a session appears.

    The auth client refetches it when an `/organization/*` call or a sign-out happens, and not
    when a sign-in does. Measured against the real client: `/organization/get-full-organization`
    is requested once, before the sign-in, and the empty answer from that moment is what this
    gate would go on reading. Without this, a fresh sign-in lands on `<Onboarding />` - a form
    that on an instance which already has a household cannot succeed - until the page is
    reloaded by hand.

    Once per session, and only while there is nothing to show: a household that loaded normally
    costs no second request, and an account that genuinely has none (a first boot, or an owner
    who left) asks once and then stops rather than looping on the same empty answer.
  */
  const askedFor = useRef<string | null>(null);
  const ids = sessionIds(session);
  const sessionId = ids?.sessionId;
  useEffect(() => {
    if (sessionId === undefined || activeOrg.isPending || activeOrg.data) return;
    if (askedFor.current === sessionId) return;
    askedFor.current = sessionId;
    void activeOrg.refetch();
  }, [sessionId, activeOrg.isPending, activeOrg.data, activeOrg.refetch]);

  const view = decideGate({
    session: ids,
    sessionPending: isPending,
    sessionError,
    household: householdId(activeOrg.data),
    householdPending: activeOrg.isPending,
    householdError: activeOrg.error,
    known,
    signOutPending: pendingSignOut(),
    signOutInFlight: signOutInFlight(),
    preferKnown: !navigator.onLine || slow || onKept.current,
  });
  const appSession = view.kind === 'app' ? view.session : null;
  const offline = view.kind === 'app' && view.offline;
  const forget = (view.kind === 'sign-in' && view.forget) || view.kind === 'onboarding';
  const finishing = view.kind === 'finish-sign-out';

  useEffect(() => {
    onKept.current = offline;
  }, [offline]);

  /*
    Open from the remembered session: changes to the list wait for a signal rather than being
    sent into one too weak to carry them (the browser's online flag would let them through and
    roll them back), and the server is asked again now and then, and whenever the browser says the
    signal is back. The auth client asks again for the session by itself only on that event, and
    never for the household, so without this a failed check would hold the app here for good.
  */
  const refetchHousehold = activeOrg.refetch;
  useEffect(() => {
    onlineManager.setOnline(offline ? false : navigator.onLine);
    if (!offline) return;
    const recheck = () => {
      if (!navigator.onLine) return;
      void refetchSession();
      void refetchHousehold();
    };
    const timer = setInterval(recheck, KEPT_RECHECK_MS);
    window.addEventListener('online', recheck);
    return () => {
      clearInterval(timer);
      window.removeEventListener('online', recheck);
    };
  }, [offline, refetchSession, refetchHousehold]);

  // Confirmed by the server: remember it, so the next start with no signal can open.
  const fresh = !offline && appSession ? JSON.stringify(appSession) : null;
  useEffect(() => {
    if (fresh) rememberSession(JSON.parse(fresh) as KnownSession);
  }, [fresh]);

  // The server says nobody, or nobody with a household: nothing of anyone's stays on this phone.
  useEffect(() => {
    if (!forget) return;
    leaveScope(queryClient);
    forgetOfflineData();
    setPendingSignOut(null);
  }, [forget]);

  /*
    A sign-out made with no signal, and the server has shown that session again: end it now, and
    keep trying while the request fails. Success empties the session, which leaves this state.
  */
  useEffect(() => {
    if (!finishing) return;
    let busy = false;
    const attempt = () => {
      if (busy || !navigator.onLine) return;
      busy = true;
      void sendSignOut().then((ended) => {
        busy = false;
        if (ended) setPendingSignOut(null);
      });
    };
    attempt();
    const timer = setInterval(attempt, KEPT_RECHECK_MS);
    window.addEventListener('online', attempt);
    return () => {
      clearInterval(timer);
      window.removeEventListener('online', attempt);
    };
  }, [finishing]);

  switch (view.kind) {
    case 'wait':
      return null;
    case 'sign-in':
    case 'finish-sign-out':
      return <SignIn />;
    case 'onboarding':
      return <Onboarding />; // signed in but no household yet
    case 'app':
      return (
        <KeptSessionContext.Provider value={view.offline}>
          <KeptCopy key={scopeOf(view.session)} scope={scopeOf(view.session)}>
            <Outlet />
          </KeptCopy>
        </KeptSessionContext.Provider>
      );
  }
}

/**
 * The query cache, restored from and saved to this phone's copy for one session (D56). A list
 * change still queued from before the app was closed is sent once the copy is back and a signal is.
 */
function KeptCopy({ scope, children }: { scope: string; children: ReactNode }) {
  const persistOptions = useMemo(() => {
    enterScope(queryClient, scope);
    return persistOptionsFor(scope);
  }, [scope]);
  return (
    <PersistQueryClientProvider
      client={queryClient}
      persistOptions={persistOptions}
      onSuccess={() => void queryClient.resumePausedMutations()}
    >
      {children}
    </PersistQueryClientProvider>
  );
}

export function App() {
  return (
    <trpc.Provider client={trpcClient} queryClient={queryClient}>
      <QueryClientProvider client={queryClient}>
        <BrowserRouter>
          <ScrollToTopOnNavigate />
          <Routes>
            {/*
              Outside the gate, and that is the point of it. The person following an emailed
              invitation has no account yet, and an owner who left has an account with no
              household - which is the state the gate answers with <Onboarding />, where creating
              one is refused. Both have to land here instead.
            */}
            <Route path="/accept-invite/:invitationId" element={<AcceptInvite />} />
            {/* Also outside the gate: whoever follows a reset link is not signed in. */}
            <Route path="/reset-password" element={<ResetPassword />} />
            <Route element={<SessionGate />}>
              {/* Full-screen cook mode: outside the shell, never a tab (design D25). */}
              <Route path="/recipes/:slug/cook" element={<CookMode />} />
              {/* Everything else lives inside the responsive shell. */}
              <Route element={<AppShell />}>
                <Route path="/" element={<Library />} />
                <Route path="/recipes" element={<Library />} />
                <Route path="/recipes/new" element={<RecipeEdit />} />
                {/* Import lives beside the library rather than inside it: it is how a recipe
                    gets in, not a view of the ones already there. */}
                <Route path="/import" element={<Import />} />
                <Route path="/recipes/:slug/edit" element={<RecipeEdit />} />
                <Route path="/recipes/:slug" element={<RecipeView />} />
                {/* Recipes → Tags. Not under /recipes/, where it would shadow a recipe whose
                    slug is "tags". */}
                <Route path="/tags" element={<Tags />} />
                <Route path="/plan" element={<Plan />} />
                <Route path="/shop" element={<ShoppingList />} />
                {/* The "More" tab is the household: who is in it, and who has been asked. */}
                <Route path="/more" element={<Household />} />
                <Route path="/foods" element={<Foods />} />
              </Route>
            </Route>
          </Routes>
        </BrowserRouter>
      </QueryClientProvider>
    </trpc.Provider>
  );
}
