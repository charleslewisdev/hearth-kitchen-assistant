import { useEffect } from 'react';
import { useLocation, useNavigationType } from 'react-router-dom';

/**
 * A screen opened by a link starts at its top.
 *
 * `BrowserRouter` has no scroll restoration of its own, so the window kept the previous
 * screen's offset: a recipe opened from far down the library opened part way down. Back and
 * forward (POP) are left alone, so the browser can put the cook back where they were.
 */
export function ScrollToTopOnNavigate() {
  const { pathname } = useLocation();
  const navigationType = useNavigationType();
  useEffect(() => {
    if (navigationType !== 'POP') window.scrollTo({ top: 0 });
  }, [pathname, navigationType]);
  return null;
}
