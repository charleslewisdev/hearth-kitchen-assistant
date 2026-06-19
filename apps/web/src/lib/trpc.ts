import { createTRPCReact } from '@trpc/react-query';
import { httpBatchLink } from '@trpc/client';
import type { AppRouter } from '@hearth/server/src/trpc/routers';

export const trpc = createTRPCReact<AppRouter>();

export const trpcClient = trpc.createClient({
  // Relative URL -> goes through the Vite proxy (dev) / reverse proxy (prod), same origin.
  links: [
    httpBatchLink({
      url: '/trpc',
      fetch: (u, o) => fetch(u, { ...o, credentials: 'include' }),
    }),
  ],
});
