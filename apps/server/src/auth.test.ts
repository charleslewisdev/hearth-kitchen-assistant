import { describe, it, expect, vi, afterEach } from 'vitest';
import type { FastifyRequest } from 'fastify';
import { auth, authHeaders, CLIENT_IP_HEADER } from './auth';
import { publicConfig } from './config';

/** Just enough of a Fastify request for the header copy: what it read, and what it resolved. */
const fakeRequest = (headers: Record<string, string | string[] | undefined>, ip: string) =>
  ({ headers, ip }) as unknown as FastifyRequest;

/**
 * One helper builds the headers every Better Auth call sees, from `server.ts`'s `/api/auth/*`
 * route and from the tRPC context alike. That is the point of it being a helper: the client-IP
 * overwrite cannot be present in one caller and forgotten in the other, which is what it was
 * before, and what would have become a rate-limit bypass the day a tRPC-side call started
 * creating sessions.
 */
describe('authHeaders', () => {
  it('carries the inbound headers through', () => {
    const headers = authHeaders(fakeRequest({ cookie: 'session=abc' }, '203.0.113.7'));
    expect(headers.get('cookie')).toBe('session=abc');
  });

  it('sets the client ip from the address Fastify resolved', () => {
    const headers = authHeaders(fakeRequest({}, '203.0.113.7'));
    expect(headers.get(CLIENT_IP_HEADER)).toBe('203.0.113.7');
  });

  // The overwrite, not a merge: a Headers object appends when a value is already present, so
  // getting this wrong yields "9.9.9.9, 203.0.113.7" and Better Auth reads the first entry.
  it.each([
    ['as sent', CLIENT_IP_HEADER],
    ['in a different case', 'X-Hearth-Client-IP'],
  ])('overwrites a client-supplied header %s', (_name, sentAs) => {
    const headers = authHeaders(fakeRequest({ [sentAs]: '9.9.9.9' }, '203.0.113.7'));
    expect(headers.get(CLIENT_IP_HEADER)).toBe('203.0.113.7');
  });

  it('ignores a forged X-Forwarded-For, which Fastify has already accounted for', () => {
    const headers = authHeaders(
      fakeRequest({ 'x-forwarded-for': '9.9.9.9, 203.0.113.7' }, '203.0.113.7'),
    );
    expect(headers.get(CLIENT_IP_HEADER)).toBe('203.0.113.7');
  });
});

describe('auth configuration', () => {
  it('takes its identity from the derived public config', () => {
    expect(auth.options.baseURL).toBe(publicConfig.authUrl);
    expect(auth.options.trustedOrigins).toEqual([publicConfig.webOrigin]);
  });

  // Never `x-forwarded-for`: Better Auth reads `value.split(',')[0]`, the entry a client writes.
  it('reads the client ip only from the header the server sets itself', () => {
    expect(auth.options.advanced?.ipAddress?.ipAddressHeaders).toEqual([CLIENT_IP_HEADER]);
  });
});

/**
 * The wiring that decides whether production cookies carry `Secure`, exercised the only way it
 * can be: `auth` is built once from the environment at import, so the https case needs a fresh
 * module graph. Asserting against `publicConfig` instead would pass with the value hardcoded to
 * `false`, since this suite runs on an http PUBLIC_URL.
 */
describe('auth cookie security follows PUBLIC_URL', () => {
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.resetModules();
  });

  it.each([
    ['https', 'https://hearth.example.com', true],
    ['http', 'http://localhost:8080', false],
  ])('marks cookies secure for %s: %s', async (_name, publicUrl, expected) => {
    vi.resetModules();
    vi.stubEnv('PUBLIC_URL', publicUrl);
    const fresh = await import('./auth');
    expect(fresh.auth.options.advanced?.useSecureCookies).toBe(expected);
    expect(fresh.auth.options.baseURL).toBe(publicUrl);
  });
});
