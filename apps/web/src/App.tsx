import { useEffect, useRef } from 'react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { BrowserRouter, Outlet, Routes, Route } from 'react-router-dom';
import { trpc, trpcClient } from './lib/trpc';
import { authClient } from './lib/auth';
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

const queryClient = new QueryClient();

/**
 * Who may see the app: a session, and a household to see it in.
 *
 * A layout route rather than a branch above the router, because one route has to be reachable
 * without either of those and cannot be if the whole router sits behind them.
 */
function SessionGate() {
  const { data: session, isPending } = authClient.useSession();
  const activeOrg = authClient.useActiveOrganization();

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
  const sessionId = session?.session.id;
  useEffect(() => {
    if (sessionId === undefined || activeOrg.isPending || activeOrg.data) return;
    if (askedFor.current === sessionId) return;
    askedFor.current = sessionId;
    void activeOrg.refetch();
  }, [sessionId, activeOrg.isPending, activeOrg.data, activeOrg.refetch]);

  if (isPending) return null;
  if (!session) return <SignIn />;
  if (activeOrg.isPending) return null;
  if (!activeOrg.data) return <Onboarding />; // signed in but no household yet
  return <Outlet />;
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
