import { createContext, useContext } from 'react';

/**
 * Whether the app is open from the session this phone remembers, because the server could not be
 * reached to confirm it (D56). The browser's own online flag misses a signal too weak to carry a
 * request, so a screen that says "offline" asks this as well.
 */
export const KeptSessionContext = createContext(false);

export function useOnKeptSession(): boolean {
  return useContext(KeptSessionContext);
}
