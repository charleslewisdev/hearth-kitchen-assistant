import { createAuthClient } from 'better-auth/react';
import { organizationClient } from 'better-auth/client/plugins';

// Same-origin: the Vite dev proxy (and the prod reverse proxy) forward /api/auth to the
// server. Absolute cross-origin URLs would break the session cookie in the browser.
export const authClient = createAuthClient({
  baseURL: window.location.origin,
  plugins: [organizationClient()],
});
