import dns from 'node:dns/promises';
import http from 'node:http';
import https from 'node:https';
import net from 'node:net';

/**
 * Fetching a page a person pasted, without turning Hearth into a proxy into the LAN it runs on.
 *
 * This is the security core of recipe import. Hearth runs on a home server, on a LAN, beside a
 * Postgres instance and an unraid web UI, so `http://192.168.1.1/`, `http://127.0.0.1:5432/`
 * and the cloud metadata address are all reachable FROM the server and none of them are
 * reachable from the cook's browser. Everyone with an account is trusted, which lowers this and
 * does not remove it: a recipe link is exactly the kind of thing someone forwards without
 * looking at it.
 *
 * ## DNS rebinding: CLOSED, not accepted.
 *
 * The gap is that the address checked and the address connected to can differ, because a
 * hostname resolved twice can answer differently the second time. It is closed here by
 * resolving ONCE per hop and connecting to that pinned address: `lookup` below hands Node the
 * address that was actually validated, so no second resolution happens between the check and
 * the socket.
 *
 * Pinning an address does not break name-based hosting, because Node still derives both the
 * `Host` header and the TLS servername from the URL's hostname rather than from the address it
 * dials. Both halves were measured rather than assumed: the `Host` header has a test in
 * `fetch-page.test.ts`, and the TLS half was checked against a local HTTPS server whose
 * `SNICallback` recorded `recipes.invalid` while the socket went to 127.0.0.1 - that check is
 * not in the suite because committing it means committing a private key. Certificate
 * validation stays on, and the same run confirmed it: a self-signed cert was refused.
 *
 * The one thing this does NOT defend against is a host that is genuinely public at check time
 * and whose operator points it somewhere private later; that is a different attack (it needs
 * control of the name) and it is not what pinning is for.
 */

/**
 * The largest page worth reading, and the longest to wait for it.
 *
 * Measured on five large recipe sites as they are served: 336KB to 823KB. The cap sits about
 * five times above the largest of those, which is room for a heavier page than any of them
 * rather than a round number chosen for looking like one.
 */
export const MAX_PAGE_BYTES = 4 * 1024 * 1024;

/**
 * The budget for one whole fetch: name resolution and every redirect hop together.
 *
 * It is spent down rather than granted per phase, so a chain of individually-quick steps
 * cannot outlast it. Both halves are covered by tests - a resolver that never answers and a
 * server that accepts a connection and then says nothing - because each was uncovered once:
 * the socket phases were bounded while resolution was not.
 */
export const DEFAULT_TIMEOUT_MS = 10_000;

/** How many hops before giving up. Real recipe sites use one or two (http->https, or a slug). */
export const MAX_REDIRECTS = 5;

/**
 * The longest URL the importer will look at.
 *
 * The sibling of `MAX_SEARCH_LENGTH` in the recipe router, and here for the same reason: the
 * point is that an arbitrarily long string is refused at the edge rather than becoming a DNS
 * query, a header, or a log line. Generous enough for a real recipe permalink with tracking
 * parameters still attached, which is how they arrive when someone shares one.
 */
export const MAX_URL_LENGTH = 2048;

/**
 * Why a page could not be fetched.
 *
 * Named as a union so the router's table of cook-facing sentences can be typed against it:
 * adding a reason here without giving it a message becomes a compile error rather than an
 * `undefined` sentence in front of somebody.
 */
export type FetchFailureReason =
  | 'bad-url'
  | 'bad-scheme'
  | 'blocked-address'
  | 'too-many-redirects'
  | 'too-large'
  | 'timeout'
  | 'unreachable'
  | 'http-error';

/** What the caller gets back. Everything that can go wrong is a `reason`, never a throw. */
export type FetchPageResult =
  | { ok: true; html: string; finalUrl: string }
  | { ok: false; reason: Exclude<FetchFailureReason, 'http-error'> }
  | { ok: false; reason: 'http-error'; status: number };

export interface FetchPageOptions {
  /**
   * How a hostname becomes addresses. Injectable so a test can state what DNS would have said
   * without asking it; production uses the real resolver.
   */
  resolve?: (hostname: string) => Promise<string[]>;
  /**
   * Whether an address may be connected to. Injectable ONLY so a test can bind a real server on
   * loopback and still exercise the redirect and streaming paths; production uses
   * `isPublicAddress`, and `fetch-page.test.ts` covers the default end to end with no injection
   * at all.
   */
  isAddressAllowed?: (ip: string) => boolean;
  timeoutMs?: number;
  /** Test-only: the loopback port a stubbed hostname should be dialled on. */
  port?: number;
}

/* ------------------------------------------------------------------ addresses */

function ipv4ToInt(ip: string): number | null {
  const parts = ip.split('.');
  if (parts.length !== 4) return null;
  let value = 0;
  for (const part of parts) {
    if (!/^\d{1,3}$/.test(part)) return null;
    const octet = Number(part);
    if (octet > 255) return null;
    value = value * 256 + octet;
  }
  return value;
}

/**
 * The IPv4 ranges no recipe is served from, as [network, prefix length].
 *
 * `169.254.0.0/16` covers `169.254.169.254`, the cloud metadata address, which is the single
 * most valuable thing an SSRF reaches on a hosted box and is why link-local is on this list
 * rather than treated as merely unroutable. `100.64.0.0/10` is carrier-grade NAT, which is a
 * real LAN on a lot of home connections.
 */
const BLOCKED_V4: [string, number][] = [
  ['0.0.0.0', 8], // "this network"
  ['10.0.0.0', 8], // private
  ['100.64.0.0', 10], // carrier-grade NAT
  ['127.0.0.0', 8], // loopback
  ['169.254.0.0', 16], // link-local, incl. 169.254.169.254 cloud metadata
  ['172.16.0.0', 12], // private
  ['192.0.0.0', 24], // IETF protocol assignments
  ['192.0.2.0', 24], // TEST-NET-1
  ['192.168.0.0', 16], // private
  ['198.18.0.0', 15], // benchmarking
  ['198.51.100.0', 24], // TEST-NET-2
  ['203.0.113.0', 24], // TEST-NET-3
  ['224.0.0.0', 4], // multicast
  ['240.0.0.0', 4], // reserved, incl. 255.255.255.255 broadcast
];

function isBlockedV4(ip: string): boolean {
  const value = ipv4ToInt(ip);
  if (value === null) return true;
  for (const [network, bits] of BLOCKED_V4) {
    const base = ipv4ToInt(network);
    if (base === null) continue;
    // `>>> 0` keeps the mask unsigned: a /1..8 shift produces a negative int32 otherwise.
    const mask = bits === 0 ? 0 : (~0 << (32 - bits)) >>> 0;
    if ((value & mask) >>> 0 === (base & mask) >>> 0) return true;
  }
  return false;
}

/** Expand an IPv6 address to its 16 bytes, or `null` if it is not one. */
function ipv6ToBytes(ip: string): Uint8Array | null {
  if (!net.isIPv6(ip)) return null;
  let text = ip;

  // A trailing dotted quad (IPv4-mapped, NAT64, 6to4-as-written) becomes two more groups.
  const dotted = text.match(/(\d{1,3}(?:\.\d{1,3}){3})$/);
  if (dotted) {
    const v4 = ipv4ToInt(dotted[1] ?? '');
    if (v4 === null) return null;
    const high = ((v4 >>> 16) & 0xffff).toString(16);
    const low = (v4 & 0xffff).toString(16);
    text = `${text.slice(0, dotted.index)}${high}:${low}`;
  }

  const [head, tail, ...extra] = text.split('::');
  if (extra.length > 0) return null;
  const headGroups = head === undefined || head === '' ? [] : head.split(':');
  const tailGroups = tail === undefined || tail === '' ? [] : tail.split(':');
  const missing = 8 - headGroups.length - tailGroups.length;
  if (tail === undefined ? missing !== 0 : missing < 0) return null;

  const groups = [
    ...headGroups,
    ...Array<string>(tail === undefined ? 0 : missing).fill('0'),
    ...tailGroups,
  ];
  if (groups.length !== 8) return null;

  const bytes = new Uint8Array(16);
  for (let i = 0; i < 8; i++) {
    const group = groups[i] ?? '';
    if (!/^[0-9a-fA-F]{1,4}$/.test(group)) return null;
    const value = parseInt(group, 16);
    bytes[i * 2] = (value >> 8) & 0xff;
    bytes[i * 2 + 1] = value & 0xff;
  }
  return bytes;
}

function isBlockedV6(ip: string): boolean {
  const bytes = ipv6ToBytes(ip);
  if (bytes === null) return true;

  const first = bytes[0] ?? 0;
  const second = bytes[1] ?? 0;

  // `::` and `::1` are also caught by the ::/64 rule below, which reads their last four bytes
  // as 0.0.0.0 and 0.0.0.1 and refuses both under 0.0.0.0/8. They are stated here as well so
  // that an audit looking for "is IPv6 loopback refused" finds a line saying so, and so that
  // narrowing that rule later cannot quietly unblock them.
  if (bytes.every((b) => b === 0)) return true; // :: unspecified
  if (bytes.slice(0, 15).every((b) => b === 0) && bytes[15] === 1) return true; // ::1 loopback
  if (first === 0xff) return true; // ff00::/8 multicast
  if (first === 0xfe && (second & 0xc0) === 0x80) return true; // fe80::/10 link-local
  if (first === 0xfe && (second & 0xc0) === 0xc0) return true; // fec0::/10 site-local
  if ((first & 0xfe) === 0xfc) return true; // fc00::/7 unique local

  // Ranges that are not private but are not somewhere a recipe is served from either.
  // `fec0::/10` above is formally deprecated and is listed because consumer gear still answers
  // on it. `2001::/32` is Teredo, which tunnels IPv4 and so is a way to reach one.
  if (first === 0x20 && second === 0x01 && bytes[2] === 0x00 && bytes[3] === 0x00) return true; // Teredo
  if (first === 0x20 && second === 0x01 && bytes[2] === 0x0d && bytes[3] === 0xb8) return true; // 2001:db8::/32 docs
  if (first === 0x01 && second === 0x00 && bytes.slice(2, 8).every((b) => b === 0)) return true; // 100::/64 discard

  // Addresses that CARRY an IPv4 address: the embedded one is where a packet actually ends up,
  // so it has to face the IPv4 rules rather than being waved through for being written in hex.
  const embedded = (offset: number): string =>
    `${bytes[offset]}.${bytes[offset + 1]}.${bytes[offset + 2]}.${bytes[offset + 3]}`;

  // Everything in ::/64 is reserved, and every form of it that exists carries an IPv4 address
  // in its last four bytes: IPv4-mapped (::ffff:a.b.c.d), IPv4-translated (::ffff:0:a.b.c.d)
  // and the deprecated IPv4-compatible form (::a.b.c.d). Treating the whole /64 this way
  // rather than matching each prefix is what catches the spellings, and it is not academic:
  // `::a9fe:a9fe` is the cloud metadata address written as an IPv4-compatible address, and
  // matching only ::ffff:0:0/96 lets it straight through.
  if (bytes.slice(0, 8).every((b) => b === 0)) return isBlockedV4(embedded(12));

  // 64:ff9b::/96 is NAT64; 2002::/16 is 6to4, whose IPv4 sits in bytes 2..5, not 12..15.
  if (first === 0x00 && second === 0x64 && bytes[2] === 0xff && bytes[3] === 0x9b) {
    return isBlockedV4(embedded(12));
  }
  if (first === 0x20 && second === 0x02) return isBlockedV4(embedded(2));

  return false;
}

/**
 * Whether a RESOLVED address may be connected to.
 *
 * Takes an address, never a hostname: a blocklist of name patterns catches nothing, because
 * `recipes.example` is free to have an A record pointing at `127.0.0.1`. Anything that is not
 * a well-formed IP is refused, since reaching here with one is a bug rather than a public host.
 */
export function isPublicAddress(ip: string): boolean {
  if (net.isIPv4(ip)) return !isBlockedV4(ip);
  if (net.isIPv6(ip)) return !isBlockedV6(ip);
  return false;
}

/* ------------------------------------------------------------------ fetching */

/**
 * The IP address a hostname IS, or `null` when it is a name to be resolved.
 *
 * The brackets matter. `new URL('http://[::1]/').hostname` returns `'[::1]'` WITH them, and
 * `net.isIP('[::1]')` is 0, so a check that forgets to unwrap treats every IPv6 literal as a
 * hostname and hands it to `dns.lookup`, which cannot parse it. That failed closed, but the
 * thing doing the refusing was getaddrinfo declining the string rather than the address policy
 * below - which meant the entire IPv6 blocklist was unreachable from a pasted URL, and a public
 * literal like `[2606:4700:4700::1111]` was refused along with the private ones.
 *
 * A bracketed hostname that is not a valid address (a zone index, say) is left as a name and
 * fails to resolve, which is the safe direction.
 */
function literalAddress(hostname: string): string | null {
  const unwrapped =
    hostname.startsWith('[') && hostname.endsWith(']') ? hostname.slice(1, -1) : hostname;
  return net.isIP(unwrapped) === 0 ? null : unwrapped;
}

async function defaultResolve(hostname: string): Promise<string[]> {
  // A literal address needs no DNS, and asking for one would depend on the resolver's opinion
  // of a string it should never see.
  const literal = literalAddress(hostname);
  if (literal !== null) return [literal];
  const records = await dns.lookup(hostname, { all: true, verbatim: true });
  return records.map((r) => r.address);
}

/** Distinguishes "the resolver timed out" from any address list it could legitimately return. */
const TIMED_OUT = Symbol('resolve timed out');

interface Hop {
  url: URL;
  address: string;
}

/** One request, with the address already validated and pinned. Follows nothing. */
function requestOnce(
  hop: Hop,
  portOverride: number | undefined,
  deadlineAt: number,
): Promise<
  | { kind: 'body'; status: number; html: string }
  | { kind: 'redirect'; status: number; location: string }
  | { kind: 'too-large' }
  | { kind: 'timeout' }
  | { kind: 'unreachable' }
> {
  return new Promise((resolve) => {
    const transport = hop.url.protocol === 'https:' ? https : http;
    const family = net.isIPv6(hop.address) ? 6 : 4;
    let settled = false;
    const finish = (value: Parameters<typeof resolve>[0]): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      request.destroy();
      resolve(value);
    };

    // The remaining budget, not a fresh one: `deadlineAt` was fixed when the fetch started and
    // every hop and every resolution draws from it, so five slow hops cannot each get the full
    // allowance and add up past it. A per-socket timeout would bound only this request.
    const timer = setTimeout(
      () => finish({ kind: 'timeout' }),
      Math.max(1, deadlineAt - Date.now()),
    );

    const request = transport.request(
      {
        protocol: hop.url.protocol,
        host: hop.url.hostname,
        port: portOverride ?? (hop.url.port === '' ? undefined : hop.url.port),
        path: `${hop.url.pathname}${hop.url.search}`,
        method: 'GET',
        // No agent, so no connection pool. `globalAgent` keeps sockets alive and keys them by
        // host:port:localAddress:family, which does NOT include the pinned address - so a
        // second request to the same host and port could be handed a socket still open to a
        // DIFFERENT address than the one just checked. Measured: pinning 127.0.0.2 was served
        // by 127.0.0.1. Every address is checked before every request, so a pooled peer had
        // necessarily passed the policy and this was not exploitable; it is off because the
        // alternative is a comment about pinning that the socket layer does not honour.
        agent: false,
        // `lookup` decides where the connection goes: the address that was CHECKED. Node still
        // derives the `Host` header and the TLS servername from `host` above, so this pins the
        // socket without breaking virtual hosting or certificate validation.
        lookup: (_hostname, options, callback) => {
          if (options && (options as { all?: boolean }).all) {
            (callback as unknown as (e: null, a: { address: string; family: number }[]) => void)(
              null,
              [{ address: hop.address, family }],
            );
            return;
          }
          callback(null, hop.address, family);
        },
        headers: {
          // Deliberately the whole header set. No cookie jar, no authorization, and nothing
          // copied from the caller's own request: the server's credentials are not the cook's
          // to spend, and a page that needs a login is not a recipe source.
          accept: 'text/html,application/xhtml+xml',
          'accept-language': 'en',
          'user-agent': 'Hearth recipe import',
        },
      },
      (response) => {
        const status = response.statusCode ?? 0;
        const location = response.headers.location;
        if (status >= 300 && status < 400 && typeof location === 'string') {
          finish({ kind: 'redirect', status, location });
          return;
        }

        // Trust the declared length enough to refuse early, but never enough to stop counting:
        // a server is free to lie in either direction, so the running total below is the rule.
        const declared = Number(response.headers['content-length'] ?? '');
        if (Number.isFinite(declared) && declared > MAX_PAGE_BYTES) {
          finish({ kind: 'too-large' });
          return;
        }

        const chunks: Buffer[] = [];
        let bytes = 0;
        response.on('data', (chunk: Buffer) => {
          bytes += chunk.length;
          if (bytes > MAX_PAGE_BYTES) {
            finish({ kind: 'too-large' });
            return;
          }
          chunks.push(chunk);
        });
        response.on('end', () =>
          finish({ kind: 'body', status, html: Buffer.concat(chunks).toString('utf8') }),
        );
        response.on('error', () => finish({ kind: 'unreachable' }));
      },
    );

    request.on('error', () => finish({ kind: 'unreachable' }));
    request.end();
  });
}

/**
 * Fetch a page for import, or say why not.
 *
 * Every hop is resolved, checked and pinned independently, because a public URL that redirects
 * to a private one defeats a check done only on what the cook typed.
 */
export async function fetchPage(
  rawUrl: string,
  options: FetchPageOptions = {},
): Promise<FetchPageResult> {
  const {
    resolve = defaultResolve,
    isAddressAllowed = isPublicAddress,
    timeoutMs = DEFAULT_TIMEOUT_MS,
    port,
  } = options;

  if (rawUrl.length > MAX_URL_LENGTH) return { ok: false, reason: 'bad-url' };

  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    return { ok: false, reason: 'bad-url' };
  }

  const deadlineAt = Date.now() + timeoutMs;

  for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
    // `file://`, `gopher://` and friends are not recipe sources, and this is checked before
    // anything is resolved so a bad scheme costs no DNS query.
    if (url.protocol !== 'http:' && url.protocol !== 'https:') {
      return { ok: false, reason: 'bad-scheme' };
    }

    // Raced against the deadline, because `dns.lookup` has no timeout of its own: against a
    // stalled nameserver it blocks for as long as the resolver wants, and `MAX_REDIRECTS`
    // means that can happen six times in one call. Before this, a 200ms deadline was still
    // hanging at 2s. The deadline is the REMAINING time, not a fresh one per hop, so several
    // slow resolutions cannot add up past it.
    let addresses: string[];
    try {
      const remaining = deadlineAt - Date.now();
      if (remaining <= 0) return { ok: false, reason: 'timeout' };
      const resolved = await Promise.race([
        resolve(url.hostname),
        new Promise<typeof TIMED_OUT>((r) => setTimeout(() => r(TIMED_OUT), remaining).unref()),
      ]);
      if (resolved === TIMED_OUT) return { ok: false, reason: 'timeout' };
      addresses = resolved;
    } catch {
      return { ok: false, reason: 'unreachable' };
    }
    if (addresses.length === 0) return { ok: false, reason: 'unreachable' };

    // EVERY answer has to pass, not just the one that gets used. A resolver replying
    // [public, private] must not be able to smuggle the second one past a check that stopped
    // at the first.
    if (!addresses.every((address) => isAddressAllowed(address))) {
      return { ok: false, reason: 'blocked-address' };
    }

    const pinned = addresses[0];
    if (pinned === undefined) return { ok: false, reason: 'unreachable' };

    if (Date.now() >= deadlineAt) return { ok: false, reason: 'timeout' };

    const outcome = await requestOnce({ url, address: pinned }, port, deadlineAt);

    if (outcome.kind === 'timeout') return { ok: false, reason: 'timeout' };
    if (outcome.kind === 'too-large') return { ok: false, reason: 'too-large' };
    if (outcome.kind === 'unreachable') return { ok: false, reason: 'unreachable' };
    if (outcome.kind === 'body') {
      if (outcome.status < 200 || outcome.status >= 300) {
        return { ok: false, reason: 'http-error', status: outcome.status };
      }
      return { ok: true, html: outcome.html, finalUrl: url.toString() };
    }

    // A redirect. Resolve it against the hop it came from and go round again, which is what
    // puts the next address through the same checks rather than trusting the first one.
    try {
      url = new URL(outcome.location, url);
    } catch {
      return { ok: false, reason: 'bad-url' };
    }
    // The same cap as the typed URL. The URL a fetch ends on becomes the recipe's source, and
    // one longer than the recipe can store turned a successful import into a failed save.
    if (url.toString().length > MAX_URL_LENGTH) return { ok: false, reason: 'bad-url' };
  }

  return { ok: false, reason: 'too-many-redirects' };
}
