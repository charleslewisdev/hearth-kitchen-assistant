/**
 * Navigations the service worker must leave to the network.
 *
 * The generated worker answers every navigation it has no cached match for with index.html.
 * A link that opens a server route in the address bar, like the email verification link at
 * /api/auth/verify-email, then got the app shell instead of reaching the server: a blank page,
 * and the address never verified. The same prefixes as API_PREFIXES in the server's server.ts.
 */
export const navigateFallbackDenylist = [/^\/api\//, /^\/trpc\//, /^\/health$/];
