import { env } from './env';

/** The app's public identity, all of it derived from one value (D35). */
export type PublicConfig = {
  /** Better Auth's `baseURL`: what callback and verification links are built against. */
  authUrl: string;
  /** The browser origin: the CORS allow-list and Better Auth's trusted origin. */
  webOrigin: string;
  /** `Secure` on session cookies, which a browser only returns over TLS. */
  useSecureCookies: boolean;
  /**
   * Whether this instance hosts exactly one household (D36).
   *
   * Not derived from PUBLIC_URL, unlike everything above it, and it is here anyway because it
   * is read by three places that would otherwise each hardcode the same assumption: who may
   * create a household, who may sign up uninvited, and which household a session opens in.
   * One named value that all three consult is what makes lifting the cap a decision rather
   * than a hunt.
   */
  singleHousehold: boolean;
};

/**
 * One `PUBLIC_URL` in, every origin-shaped setting out (D35).
 *
 * There is exactly one browser-facing origin in every deployment of this app, in dev as well:
 * the vite dev server proxies `/api` and `/trpc` to the server, so the browser only ever talks
 * to `:5173`, and in production this server serves the SPA and the API from one origin (D46). Deriving
 * `authUrl` and `webOrigin` from a single value is therefore not a simplification, it is the
 * actual topology. Two separately configured values can only ever disagree, and the failure when
 * they do is a login that sets a cookie the browser then refuses to send back.
 *
 * `useSecureCookies` follows the scheme rather than being its own knob for the same reason.
 * TLS terminates at nginx (D35), so the server cannot observe it, and `X-Forwarded-Proto` is not
 * a substitute: a proxy may replace that header for peers it does not trust. The public URL is the
 * only place the operator states whether the app is reachable over TLS, so it is what decides.
 */
export function derivePublicConfig(opts: {
  publicUrl: string | undefined;
  /** Defaults to the shipped posture (D36), so a caller that does not care cannot weaken it. */
  singleHousehold?: boolean;
}): PublicConfig {
  const { publicUrl } = opts;
  // Absent rather than defaulted. A default would boot a production server with a localhost
  // identity, which fails as an unexplained login loop rather than as a startup error.
  if (publicUrl === undefined || publicUrl.trim() === '') {
    throw new Error('PUBLIC_URL is required: set it to the URL the browser uses to reach Hearth');
  }

  let url: URL;
  try {
    url = new URL(publicUrl);
  } catch {
    // The message is deliberately not the caught one: `new URL` says only "Invalid URL", which
    // names neither the setting nor what a valid one looks like.
    throw new Error('PUBLIC_URL is not a URL: expected e.g. https://hearth.example.com');
  }

  // Not merely cosmetic. `useSecureCookies` follows the scheme, so an `ftp:` or `ws:` value
  // derives insecure cookies for what may be a TLS deployment; and for a NON-special scheme
  // (`foo:`, `file:`, `data:`) Node makes `origin` the literal string "null", which would then
  // be handed to CORS and to Better Auth as this app's identity.
  if (url.protocol !== 'https:' && url.protocol !== 'http:') {
    throw new Error(`PUBLIC_URL has an unsupported scheme "${url.protocol}": use http or https`);
  }
  // `new URL('https://x').pathname` is '/', so this rejects a path and accepts its absence.
  // A path here is not cosmetic: Better Auth appends its own basePath to `baseURL`, so
  // `https://example.com/hearth` produces callback links to `/hearth/api/auth/...` that the
  // proxy does not route, and an origin string the browser never sends.
  if (url.pathname !== '/') {
    throw new Error(`PUBLIC_URL must have no path, got "${url.pathname}"`);
  }
  // These ARE dropped by origin derivation, silently, so the only way an operator learns the
  // value in use is not the value they set is to refuse to start.
  if (url.search !== '' || url.hash !== '') {
    throw new Error('PUBLIC_URL must have no query string or fragment');
  }
  // Same reasoning, and worse consequences: this value gets pasted into compose files, unraid
  // templates and support threads, so a password that is silently ignored is a password
  // needlessly copied around.
  if (url.username !== '' || url.password !== '') {
    throw new Error('PUBLIC_URL must not embed credentials');
  }

  // `origin` does the normalizing: no trailing slash, and a default port (`:443` on https)
  // removed, because that is the form a browser puts in an `Origin` header. A NON-default port
  // is kept, since `http://localhost:8080` and `http://localhost` are different origins.
  const origin = url.origin;
  return {
    authUrl: origin,
    webOrigin: origin,
    useSecureCookies: url.protocol === 'https:',
    singleHousehold: opts.singleHousehold ?? true,
  };
}

/**
 * The config the app runs on.
 *
 * `WEB_ORIGIN` is the fallback, and it is the last of the pair that used to configure this.
 * `BETTER_AUTH_URL` is not in the schema at all any more: the browser origin is what both
 * derived values have to be, and in dev that is `:5173` (the vite proxy) while
 * `BETTER_AUTH_URL` was `:3000`, the address only the proxy ever talks to. Falling back to it
 * would drop `:5173` from the trusted origins and break sign-in for `pnpm dev`.
 *
 * Both are now optional, so a deployment sets PUBLIC_URL and nothing else. With neither set
 * the throw below names PUBLIC_URL, which is the one to set.
 */
export const publicConfig = derivePublicConfig({
  publicUrl: env.PUBLIC_URL ?? env.WEB_ORIGIN,
  singleHousehold: env.SINGLE_HOUSEHOLD,
});
