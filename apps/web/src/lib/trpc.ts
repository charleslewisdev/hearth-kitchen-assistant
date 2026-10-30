import { createTRPCReact } from '@trpc/react-query';
import { httpBatchLink } from '@trpc/client';
import type { AppRouter } from '@hearth/server/src/trpc/routers';
import { MAX_TRPC_BATCH } from '@hearth/shared';

export const trpc = createTRPCReact<AppRouter>();

export const trpcClient = trpc.createClient({
  // Relative URL -> goes through the Vite proxy (dev) / reverse proxy (prod), same origin.
  links: [
    httpBatchLink({
      url: '/trpc',
      // The server refuses larger batches; split here so the app never sends one.
      maxItems: MAX_TRPC_BATCH,
      fetch: (u, o) => fetch(u, { ...o, credentials: 'include' }),
    }),
  ],
});
