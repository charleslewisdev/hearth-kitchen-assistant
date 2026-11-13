import { useEffect } from 'react';

/**
 * Keep the screen on while `active` (cook mode, a long zip import).
 *
 * Three things about the Screen Wake Lock API drive the shape of this:
 *
 *  - It is absent in Firefox and on any insecure origin other than localhost, so the guard
 *    below is a real branch rather than defensive padding. Hearth is self-hosted and reaching
 *    an instance over plain http on a LAN address is an ordinary way to run it.
 *  - `request()` rejects when the document is hidden, and can be refused outright.
 *  - The browser releases the lock when the tab is hidden and does NOT restore it, so coming
 *    back to the tab has to ask again.
 *
 * Every failure here is silent by design: the screen dims, which is the behaviour these screens had
 * before this existed, and nothing on the screen depends on holding a lock.
 */
export function useScreenWakeLock(active = true): void {
  useEffect(() => {
    if (!active) return;
    // lib.dom types this as always present; it is not.
    const api: WakeLock | undefined = navigator.wakeLock;
    if (!api) return;

    let sentinel: WakeLockSentinel | null = null;
    let requestInFlight = false;
    let leftScreen = false;

    async function acquire(): Promise<void> {
      // `api` is re-checked because TypeScript does not carry the narrowing above into this
      // closure, not because it can become undefined after the fact.
      if (leftScreen || api === undefined) return;
      // A lock we hold, or one already on its way, does not need asking for again. Without the
      // in-flight half, a visibilitychange arriving before the first request resolves starts a
      // second one, and the sentinel the second overwrites is never released: the screen then
      // stays awake after the cook leaves cook mode.
      if (requestInFlight) return;
      if (sentinel !== null && !sentinel.released) return;
      requestInFlight = true;
      try {
        const next = await api.request('screen');
        if (leftScreen) {
          void next.release().catch(() => {});
          return;
        }
        sentinel = next;
      } catch {
        // Refused, or asked for while hidden. The screen dims; nothing else changes.
      } finally {
        requestInFlight = false;
      }
    }

    function handleVisibilityChange(): void {
      if (document.visibilityState === 'visible') void acquire();
    }

    void acquire();
    document.addEventListener('visibilitychange', handleVisibilityChange);

    return () => {
      leftScreen = true;
      document.removeEventListener('visibilitychange', handleVisibilityChange);
      void sentinel?.release().catch(() => {});
      sentinel = null;
    };
  }, [active]);
}
