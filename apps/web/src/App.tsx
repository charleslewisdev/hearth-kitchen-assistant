import { useState } from 'react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { trpc, trpcClient } from './lib/trpc';
import { authClient } from './lib/auth';
import { AppShell } from './app/AppShell';
import { SignIn } from './routes/SignIn';
import { Onboarding } from './routes/Onboarding';
import { Recipes } from './routes/Recipes';

const queryClient = new QueryClient();

export function App() {
  const { data: session, isPending } = authClient.useSession();
  const { data: activeOrg, isPending: orgPending } = authClient.useActiveOrganization();
  const [active, setActive] = useState('recipes');
  if (isPending) return null;
  if (!session) return <SignIn />;
  if (orgPending) return null;
  if (!activeOrg) return <Onboarding />; // signed in but no household yet
  return (
    <trpc.Provider client={trpcClient} queryClient={queryClient}>
      <QueryClientProvider client={queryClient}>
        <AppShell active={active} onNavigate={setActive}>
          {active === 'recipes' ? <Recipes /> : <p>Coming soon</p>}
        </AppShell>
      </QueryClientProvider>
    </trpc.Provider>
  );
}
