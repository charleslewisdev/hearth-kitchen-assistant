import { useEffect } from 'react';

/**
 * The browser tab's title for a screen: "Osso Buco - Hearth", or plain "Hearth" while there is
 * nothing to name yet (a recipe still loading). Put back to "Hearth" when the screen goes, so a
 * screen that sets none never shows the last one's.
 */
export function useDocumentTitle(title: string | null | undefined): void {
  useEffect(() => {
    document.title = title ? `${title} - Hearth` : 'Hearth';
    return () => {
      document.title = 'Hearth';
    };
  }, [title]);
}
