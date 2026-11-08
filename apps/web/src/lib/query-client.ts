import { onlineManager, QueryClient } from '@tanstack/react-query';
import { getUntypedClient } from '@trpc/client';
import { installOfflineDefaults } from './offline';
import { trpcClient } from './trpc';

/** The app's one query cache. A module of its own so sign-out can empty it from anywhere. */
export const queryClient = new QueryClient();

installOfflineDefaults(queryClient, (path, input) =>
  getUntypedClient(trpcClient).mutation(path, input),
);

/*
  React Query starts out believing it is online and changes its mind only on an 'offline' event,
  which a phone that was already offline when the app opened never fires. Then every list change
  is sent at once, fails, and rolls back, instead of waiting for a signal. Start from the browser's
  own answer.
*/
onlineManager.setOnline(navigator.onLine);
