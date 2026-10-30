import { describe, it, expect, afterEach } from 'vitest';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import {
  fetchPage,
  isPublicAddress,
  MAX_PAGE_BYTES,
  MAX_REDIRECTS,
  MAX_URL_LENGTH,
} from './fetch-page';

/**
 * No test here touches the network. The address rules are a pure function, and everything that
 * needs a real socket binds a server on loopback and is pointed at it explicitly.
 */

const servers: http.Server[] = [];

afterEach(async () => {
  await Promise.all(
    servers.splice(0).map((s) => new Promise<void>((resolve) => s.close(() => resolve()))),
  );
});

/** Bind `handler` on loopback and return its origin plus the requests it saw. */
function serve(handler: http.RequestListener): Promise<{
  origin: string;
  port: number;
  requests: { url: string; headers: http.IncomingHttpHeaders }[];
}> {
  const requests: { url: string; headers: http.IncomingHttpHeaders }[] = [];
  const server = http.createServer((req, res) => {
    requests.push({ url: req.url ?? '', headers: req.headers });
    handler(req, res);
  });
  servers.push(server);
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address() as AddressInfo;
      resolve({ origin: `http://127.0.0.1:${port}`, port, requests });
    });
  });
}

/** A resolver stub: what DNS would have said, without asking it. */
function resolvesTo(map: Record<string, string[]>) {
  return async (hostname: string) => {
    const addresses = map[hostname];
    if (!addresses) throw new Error(`no test address for ${hostname}`);
    return addresses;
  };
}

describe('isPublicAddress: the ranges a recipe can never live in', () => {
  const blockedV4 = [
    ['0.0.0.0', 'this network'],
    ['0.1.2.3', 'this network'],
    ['10.0.0.1', 'private'],
    ['10.255.255.255', 'private'],
    ['100.64.0.1', 'carrier-grade NAT'],
    ['127.0.0.1', 'loopback'],
    ['127.1.2.3', 'loopback, and not the obvious spelling of it'],
    ['169.254.0.1', 'link-local'],
    ['169.254.169.254', 'the cloud metadata address'],
    ['172.16.0.1', 'private'],
    ['172.31.255.255', 'private'],
    ['192.0.0.1', 'IETF protocol assignments'],
    ['192.168.1.1', 'private, and the router on the owner LAN'],
    ['198.18.0.1', 'benchmarking'],
    ['224.0.0.1', 'multicast'],
    ['239.255.255.255', 'multicast'],
    ['240.0.0.1', 'reserved'],
    ['255.255.255.255', 'broadcast'],
  ] as const;

  it.each(blockedV4)('blocks %s (%s)', (ip) => {
    expect(isPublicAddress(ip)).toBe(false);
  });

  const blockedV6 = [
    ['::', 'unspecified'],
    ['::1', 'loopback'],
    ['fe80::1', 'link-local'],
    ['febf::1', 'link-local, top of the /10'],
    ['fc00::1', 'unique local'],
    ['fd12:3456::1', 'unique local'],
    ['ff02::1', 'multicast'],
    ['::ffff:127.0.0.1', 'IPv4-mapped loopback'],
    ['::ffff:192.168.1.1', 'IPv4-mapped private'],
    ['::ffff:169.254.169.254', 'IPv4-mapped cloud metadata'],
    ['::ffff:7f00:1', 'IPv4-mapped loopback written in hex, not dotted'],
    ['0:0:0:0:0:ffff:127.0.0.1', 'IPv4-mapped loopback written out in full'],
    ['::127.0.0.1', 'the deprecated IPv4-compatible form of loopback'],
    ['::192.168.1.1', 'IPv4-compatible private'],
    ['::a9fe:a9fe', 'the cloud metadata address as an IPv4-compatible address'],
    ['::ffff:0:127.0.0.1', 'IPv4-translated loopback'],
    ['fec0::1', 'site-local, which some consumer gear still answers on'],
    ['2001:db8::1', 'documentation'],
    ['2001::1', 'Teredo'],
    ['100::1', 'discard-only'],
    ['64:ff9b::7f00:1', 'NAT64-embedded loopback'],
    ['2002:7f00:0001::', '6to4-embedded loopback'],
    ['2002:c0a8:0101::', '6to4-embedded private'],
  ] as const;

  it.each(blockedV6)('blocks %s (%s)', (ip) => {
    expect(isPublicAddress(ip)).toBe(false);
  });

  const allowed = [
    '1.1.1.1',
    '8.8.8.8',
    '93.184.216.34',
    '172.32.0.1',
    '100.128.0.1',
    '2606:4700:4700::1111',
    '2a00:1450:4001:800::200e',
  ];

  it.each(allowed)('allows %s', (ip) => {
    // A pure predicate: this opens nothing. The addresses are real and public on purpose, so
    // that "allowed" means what it says rather than being satisfied by a reserved range.
    expect(isPublicAddress(ip)).toBe(true);
  });

  it('never dials the public addresses it uses as examples', async () => {
    // `isPublicAddress` cannot open a socket, but `fetchPage` can, and a regression that made
    // one of these reachable would otherwise sit here spending the timeout on a real
    // connection - which is both a slow test and a test that touches the network. Refusing at
    // the policy keeps it a decision rather than a round trip.
    let dialled = false;
    const result = await fetchPage('http://93.184.216.34/recipe', {
      isAddressAllowed: () => false,
      resolve: async () => {
        dialled = true;
        return ['93.184.216.34'];
      },
      timeoutMs: 500,
    });
    expect(result).toEqual({ ok: false, reason: 'blocked-address' });
    // The stub resolver ran; no socket followed it, because the policy refused first.
    expect(dialled).toBe(true);
  });

  it('refuses anything that is not an IP address at all', () => {
    // The check is on a RESOLVED address; a hostname reaching it is a bug, not a public host.
    for (const notAnIp of ['example.com', '', '1.2.3', '1.2.3.4.5', '999.1.1.1', 'zz::1']) {
      expect(isPublicAddress(notAnIp)).toBe(false);
    }
  });
});

describe('fetchPage: scheme', () => {
  it.each([
    'file:///etc/passwd',
    'gopher://example.com/',
    'ftp://example.com/x',
    'data:text/html,hi',
  ])('refuses %s without resolving anything', async (url) => {
    let resolverCalled = false;
    const result = await fetchPage(url, {
      resolve: async () => {
        resolverCalled = true;
        return ['1.1.1.1'];
      },
    });
    expect(result).toEqual({ ok: false, reason: 'bad-scheme' });
    expect(resolverCalled).toBe(false);
  });

  it('refuses a URL that is not a URL', async () => {
    expect(await fetchPage('not a url')).toEqual({ ok: false, reason: 'bad-url' });
  });

  it('refuses a URL longer than the cap before doing anything with it', async () => {
    const long = `https://example.com/${'a'.repeat(MAX_URL_LENGTH)}`;
    expect(await fetchPage(long)).toEqual({ ok: false, reason: 'bad-url' });
  });
});

describe('fetchPage: the address is checked, not the string', () => {
  it('refuses a public-looking hostname that resolves to loopback', async () => {
    const upstream = await serve((_req, res) => res.end('<html>never</html>'));
    const result = await fetchPage(`http://recipes.example/x`, {
      resolve: resolvesTo({ 'recipes.example': ['127.0.0.1'] }),
      port: upstream.port,
    });
    expect(result).toEqual({ ok: false, reason: 'blocked-address' });
    // Refused BEFORE connecting, which is the whole point.
    expect(upstream.requests).toHaveLength(0);
  });

  it('refuses when any of several resolved addresses is private', async () => {
    // A resolver answering [public, private] must not be talked into the public one: which
    // address a connection actually uses is not something this can control after the fact.
    const result = await fetchPage('http://recipes.example/x', {
      resolve: resolvesTo({ 'recipes.example': ['93.184.216.34', '192.168.1.1'] }),
    });
    expect(result).toEqual({ ok: false, reason: 'blocked-address' });
  });

  it('refuses a literal loopback URL with the REAL resolver and the REAL policy', async () => {
    // No injection at all: this is the default path the router will use.
    const upstream = await serve((_req, res) => res.end('<html>never</html>'));
    const result = await fetchPage(`${upstream.origin}/recipe`);
    expect(result).toEqual({ ok: false, reason: 'blocked-address' });
    expect(upstream.requests).toHaveLength(0);
  });

  it('refuses the cloud metadata address', async () => {
    expect(await fetchPage('http://169.254.169.254/latest/meta-data/')).toEqual({
      ok: false,
      reason: 'blocked-address',
    });
  });
});

describe('fetchPage: an IPv6 literal in a URL reaches the address policy', () => {
  /**
   * The unit table above calls `isPublicAddress` with bare strings like `::a9fe:a9fe`. A pasted
   * URL cannot produce those: `new URL('http://[::1]/').hostname` keeps the brackets. These go
   * through `fetchPage` instead, so the IPv6 rules are exercised in the form the caller
   * actually hands them over in.
   *
   * `blocked-address` and not `unreachable` is the whole point. Both refuse, but `unreachable`
   * would mean getaddrinfo declined to parse the brackets rather than the policy refusing the
   * address, and a rule that is only ever reached by its own unit test is not enforcing
   * anything.
   */
  it.each([
    ['http://[::1]/', 'loopback'],
    ['http://[::a9fe:a9fe]/', 'the cloud metadata address, IPv4-compatible form'],
    ['http://[::ffff:169.254.169.254]/', 'the cloud metadata address, IPv4-mapped form'],
    ['http://[fe80::1]/', 'link-local'],
    ['http://[fc00::1]/', 'unique local'],
    ['http://[fec0::1]/', 'site-local'],
    ['http://[::ffff:127.0.0.1]/', 'IPv4-mapped loopback'],
    ['http://[64:ff9b::7f00:1]/', 'NAT64-embedded loopback'],
  ])('refuses %s (%s) by policy, not by failing to resolve it', async (url) => {
    expect(await fetchPage(url, { timeoutMs: 2000 })).toEqual({
      ok: false,
      reason: 'blocked-address',
    });
  });

  it('does not refuse a PUBLIC IPv6 literal, and never dials it', async () => {
    // The same unwrapping bug refused `[2606:4700:4700::1111]` too, which is a plain bug rather
    // than a safe failure. The policy has to say yes here. Nothing is dialled: the address is
    // allowed and then the request is stopped by a resolver-free deadline of 1ms.
    let asked: string | null = null;
    const result = await fetchPage('http://[2606:4700:4700::1111]/recipe', {
      isAddressAllowed: (ip) => {
        asked = ip;
        return false; // refuse AFTER recording, so no socket is ever opened
      },
    });
    expect(asked).toBe('2606:4700:4700::1111');
    expect(result).toEqual({ ok: false, reason: 'blocked-address' });
  });
});

describe('fetchPage: the checked address is the one connected to', () => {
  it('connects to the pinned address instead of resolving the hostname again', async () => {
    // `.invalid` can never resolve (RFC 2606), so the ONLY way this request can arrive is if
    // the connection used the address the policy already approved. Remove the pinning and Node
    // resolves the hostname itself at connect time, which fails - which is what makes this a
    // real test of the DNS-rebinding closure rather than a comment about it.
    const upstream = await serve((_req, res) => {
      res.setHeader('content-type', 'text/html');
      res.end('<html>pinned</html>');
    });

    let resolveCalls = 0;
    const result = await fetchPage('http://recipes.invalid/soup', {
      resolve: async () => {
        resolveCalls += 1;
        return ['127.0.0.1'];
      },
      isAddressAllowed: () => true,
      port: upstream.port,
    });

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error('unreachable');
    expect(result.html).toContain('pinned');
    // Resolved once, for the check. A second resolution is the gap this closes.
    expect(resolveCalls).toBe(1);
  });

  it('still sends the hostname as Host, so virtual hosting and TLS keep working', async () => {
    const upstream = await serve((_req, res) => {
      res.setHeader('content-type', 'text/html');
      res.end('<html>ok</html>');
    });
    await fetchPage('http://recipes.invalid/soup', {
      resolve: async () => ['127.0.0.1'],
      isAddressAllowed: () => true,
      port: upstream.port,
    });
    expect(upstream.requests[0]?.headers.host).toBe(`recipes.invalid:${upstream.port}`);
  });
});

describe('fetchPage: the pinned address is what the socket reaches', () => {
  it('does not let a pooled connection serve a request pinned elsewhere', async () => {
    // `globalAgent` has keepAlive on and pools by host:port:localAddress:family. The pinned
    // address is NOT in that key, so without an agent of its own the second call here - pinned
    // at 127.0.0.2 - was answered by the socket still open to 127.0.0.1.
    const a = http.createServer((_q, r) => r.end('<html>SERVED-BY-A</html>'));
    const b = http.createServer((_q, r) => r.end('<html>SERVED-BY-B</html>'));
    servers.push(a, b);
    await new Promise<void>((r) => a.listen(0, '127.0.0.1', () => r()));
    const port = (a.address() as AddressInfo).port;
    await new Promise<void>((r) => b.listen(port, '127.0.0.2', () => r()));

    const first = await fetchPage(`http://recipes.invalid:${port}/`, {
      resolve: async () => ['127.0.0.1'],
      isAddressAllowed: () => true,
    });
    const second = await fetchPage(`http://recipes.invalid:${port}/`, {
      resolve: async () => ['127.0.0.2'],
      isAddressAllowed: () => true,
    });

    expect(first.ok && first.html).toContain('SERVED-BY-A');
    expect(second.ok && second.html).toContain('SERVED-BY-B');
  });
});

describe('fetchPage: the deadline covers name resolution too', () => {
  it('gives up on a resolver that never answers', async () => {
    // In production this is getaddrinfo against a stalled nameserver, and `MAX_REDIRECTS`
    // means it can happen up to six times in one call.
    const started = Date.now();
    const result = await fetchPage('http://recipes.invalid/x', {
      resolve: () => new Promise<string[]>(() => {}),
      timeoutMs: 150,
    });
    expect(result).toEqual({ ok: false, reason: 'timeout' });
    expect(Date.now() - started).toBeLessThan(2000);
  });

  it('spends the deadline ACROSS hops rather than granting it to each', async () => {
    // Two slow resolutions under one deadline must not add up past it, which is the property
    // a per-hop timeout would not have.
    const entry = await serve((_req, res) => {
      res.writeHead(302, { location: 'http://second.invalid/' });
      res.end();
    });
    const started = Date.now();
    const result = await fetchPage(`${entry.origin}/start`, {
      resolve: async (host) => {
        if (host === 'second.invalid') await new Promise((r) => setTimeout(r, 5000));
        return ['127.0.0.1'];
      },
      isAddressAllowed: () => true,
      timeoutMs: 300,
    });
    expect(result).toEqual({ ok: false, reason: 'timeout' });
    expect(Date.now() - started).toBeLessThan(2000);
  });
});

describe('fetchPage: redirects are re-checked, every hop', () => {
  it('follows a redirect and returns the final page', async () => {
    const target = await serve((_req, res) => {
      res.setHeader('content-type', 'text/html');
      res.end('<html><body>arrived</body></html>');
    });
    const entry = await serve((_req, res) => {
      res.writeHead(302, { location: `${target.origin}/final` });
      res.end();
    });
    const seen: string[] = [];
    const result = await fetchPage(`${entry.origin}/start`, {
      isAddressAllowed: (ip) => {
        seen.push(ip);
        return true;
      },
    });
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error('unreachable');
    expect(result.html).toContain('arrived');
    expect(result.finalUrl).toBe(`${target.origin}/final`);
    // Both hops were put to the policy, not just the one the cook typed.
    expect(seen).toEqual(['127.0.0.1', '127.0.0.1']);
  });

  it('refuses a redirect whose target is blocked, and never connects to it', async () => {
    const privateTarget = await serve((_req, res) => res.end('<html>secret</html>'));
    const entry = await serve((_req, res) => {
      res.writeHead(302, { location: `${privateTarget.origin}/admin` });
      res.end();
    });

    // Allows the first hop and refuses the second, which is exactly the shape of the attack:
    // a public URL that 302s somewhere private. An input-only check passes this vacuously.
    const seen: string[] = [];
    const result = await fetchPage(`${entry.origin}/start`, {
      isAddressAllowed: (ip) => {
        seen.push(ip);
        return seen.length === 1;
      },
    });

    expect(result).toEqual({ ok: false, reason: 'blocked-address' });
    expect(seen).toHaveLength(2);
    expect(entry.requests).toHaveLength(1);
    expect(privateTarget.requests).toHaveLength(0);
  });

  it('gives up once the redirect chain passes the cap', async () => {
    const hop = await serve((req, res) => {
      const n = Number(new URL(req.url ?? '/', 'http://x').searchParams.get('n') ?? '0');
      res.writeHead(302, { location: `/?n=${n + 1}` });
      res.end();
    });
    const result = await fetchPage(`${hop.origin}/?n=0`, { isAddressAllowed: () => true });
    expect(result).toEqual({ ok: false, reason: 'too-many-redirects' });
    // The cap is a bound on requests made, not just on the number reported.
    expect(hop.requests.length).toBe(MAX_REDIRECTS + 1);
  });

  it('refuses a redirect to a URL longer than a typed one may be', async () => {
    // Checking only the typed URL let a redirect hand back a finalUrl the recipe cannot store:
    // the import reached the review screen and then failed to save with a raw validation error.
    const target = await serve((_req, res) => res.end('<html>long</html>'));
    const entry = await serve((_req, res) => {
      res.writeHead(302, { location: `${target.origin}/${'a'.repeat(MAX_URL_LENGTH)}` });
      res.end();
    });
    const result = await fetchPage(`${entry.origin}/start`, { isAddressAllowed: () => true });
    expect(result).toEqual({ ok: false, reason: 'bad-url' });
    expect(target.requests).toHaveLength(0);
  });

  it('refuses a redirect to a non-http scheme', async () => {
    const entry = await serve((_req, res) => {
      res.writeHead(302, { location: 'file:///etc/passwd' });
      res.end();
    });
    const result = await fetchPage(`${entry.origin}/start`, { isAddressAllowed: () => true });
    expect(result).toEqual({ ok: false, reason: 'bad-scheme' });
  });
});

describe('fetchPage: size and time are bounded', () => {
  it('refuses a response larger than the cap without buffering all of it', async () => {
    let written = 0;
    const big = await serve((_req, res) => {
      res.setHeader('content-type', 'text/html');
      const chunk = 'x'.repeat(64 * 1024);
      const pump = (): void => {
        while (written < MAX_PAGE_BYTES * 4) {
          written += chunk.length;
          if (!res.write(chunk)) {
            res.once('drain', pump);
            return;
          }
        }
        res.end();
      };
      pump();
    });
    const result = await fetchPage(`${big.origin}/huge`, { isAddressAllowed: () => true });
    expect(result).toEqual({ ok: false, reason: 'too-large' });
  });

  it('refuses a response whose declared content-length is over the cap, before reading it', async () => {
    let bodyBytesSent = 0;
    const big = await serve((_req, res) => {
      res.writeHead(200, {
        'content-type': 'text/html',
        'content-length': String(MAX_PAGE_BYTES * 10),
      });
      bodyBytesSent += 16;
      res.write('x'.repeat(16));
    });
    const result = await fetchPage(`${big.origin}/huge`, { isAddressAllowed: () => true });
    expect(result).toEqual({ ok: false, reason: 'too-large' });
    expect(bodyBytesSent).toBeLessThan(MAX_PAGE_BYTES);
  });

  it('gives up on a server that accepts the connection and then says nothing', async () => {
    const slowloris = await serve(() => {
      /* deliberately never responds */
    });
    const result = await fetchPage(`${slowloris.origin}/slow`, {
      isAddressAllowed: () => true,
      timeoutMs: 150,
    });
    expect(result).toEqual({ ok: false, reason: 'timeout' });
  });

  it('gives up on a server that dribbles a body forever', async () => {
    const dribble = await serve((_req, res) => {
      res.setHeader('content-type', 'text/html');
      res.write('<html>');
      setInterval(() => res.write('.'), 10).unref();
    });
    const result = await fetchPage(`${dribble.origin}/dribble`, {
      isAddressAllowed: () => true,
      timeoutMs: 200,
    });
    expect(result).toEqual({ ok: false, reason: 'timeout' });
  });
});

describe('fetchPage: no ambient credentials', () => {
  it('sends no cookie and no authorization header', async () => {
    const page = await serve((_req, res) => {
      res.setHeader('content-type', 'text/html');
      res.end('<html>ok</html>');
    });
    await fetchPage(`${page.origin}/r`, { isAddressAllowed: () => true });
    const headers = page.requests[0]?.headers ?? {};
    expect(headers.cookie).toBeUndefined();
    expect(headers.authorization).toBeUndefined();
  });

  it('does not carry a cookie set on one hop into the next', async () => {
    const second = await serve((_req, res) => {
      res.setHeader('content-type', 'text/html');
      res.end('<html>done</html>');
    });
    const first = await serve((_req, res) => {
      res.writeHead(302, {
        location: `${second.origin}/next`,
        'set-cookie': 'session=abc; Path=/',
      });
      res.end();
    });
    await fetchPage(`${first.origin}/start`, { isAddressAllowed: () => true });
    expect(second.requests[0]?.headers.cookie).toBeUndefined();
  });
});

describe('fetchPage: ordinary failures are answers, not exceptions', () => {
  it('reports an HTTP error status rather than throwing', async () => {
    const gone = await serve((_req, res) => {
      res.writeHead(404, { 'content-type': 'text/html' });
      res.end('<html>no</html>');
    });
    const result = await fetchPage(`${gone.origin}/missing`, { isAddressAllowed: () => true });
    expect(result).toEqual({ ok: false, reason: 'http-error', status: 404 });
  });

  it('reports a host that does not resolve', async () => {
    const result = await fetchPage('https://recipes.example/x', {
      resolve: async () => {
        throw Object.assign(new Error('getaddrinfo ENOTFOUND'), { code: 'ENOTFOUND' });
      },
    });
    expect(result).toEqual({ ok: false, reason: 'unreachable' });
  });

  it('reports a refused connection', async () => {
    const closed = await serve((_req, res) => res.end());
    const port = closed.port;
    await new Promise<void>((resolve) => servers.splice(0)[0]?.close(() => resolve()));
    const result = await fetchPage(`http://127.0.0.1:${port}/x`, {
      isAddressAllowed: () => true,
      timeoutMs: 2000,
    });
    expect(result).toEqual({ ok: false, reason: 'unreachable' });
  });
});
