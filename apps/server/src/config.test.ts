import { describe, it, expect } from 'vitest';
import { derivePublicConfig } from './config';

describe('derivePublicConfig', () => {
  it('derives auth url and web origin from one PUBLIC_URL', () => {
    const c = derivePublicConfig({ publicUrl: 'https://hearth.example.com' });
    expect(c.authUrl).toBe('https://hearth.example.com');
    expect(c.webOrigin).toBe('https://hearth.example.com');
  });

  it('enables secure cookies for https', () => {
    expect(derivePublicConfig({ publicUrl: 'https://hearth.example.com' }).useSecureCookies).toBe(
      true,
    );
  });

  it('disables secure cookies for plain http so local dev still logs in', () => {
    expect(derivePublicConfig({ publicUrl: 'http://localhost:8080' }).useSecureCookies).toBe(false);
  });

  it('strips a trailing slash so origin comparisons match', () => {
    expect(derivePublicConfig({ publicUrl: 'https://hearth.example.com/' }).webOrigin).toBe(
      'https://hearth.example.com',
    );
  });

  it('rejects a PUBLIC_URL with a path, which would silently break auth callbacks', () => {
    expect(() => derivePublicConfig({ publicUrl: 'https://example.com/hearth' })).toThrow(/path/i);
  });

  // A non-default port IS part of the origin a browser sends, so it has to survive.
  it('keeps a non-default port', () => {
    expect(derivePublicConfig({ publicUrl: 'http://localhost:8080' }).webOrigin).toBe(
      'http://localhost:8080',
    );
  });

  // ...and a default port is NOT sent by a browser, so keeping it would make every origin
  // comparison fail against a config that is otherwise correct.
  it('drops a redundant default port so the origin matches what a browser sends', () => {
    expect(derivePublicConfig({ publicUrl: 'https://hearth.example.com:443' }).webOrigin).toBe(
      'https://hearth.example.com',
    );
  });

  it('rejects a missing PUBLIC_URL by name rather than guessing at localhost', () => {
    expect(() => derivePublicConfig({ publicUrl: undefined })).toThrow(/PUBLIC_URL/);
  });

  it('rejects a value that is not a URL at all, naming the variable that is wrong', () => {
    expect(() => derivePublicConfig({ publicUrl: 'hearth.example.com' })).toThrow(/PUBLIC_URL/);
  });

  /**
   * A scheme other than http(s) would derive `useSecureCookies: false` in what may well be a
   * TLS deployment, and half of them have no origin at all: Node returns the STRING "null" for
   * a non-special scheme (`foo:`, `file:`, `data:`, `mailto:`), while special ones (`ftp:`,
   * `ws:`) do produce an origin, which is the more dangerous case because it looks fine.
   */
  it.each([
    ['a special scheme, which yields a plausible-looking origin', 'ftp://hearth.example.com'],
    ['a non-special scheme, whose origin is the string "null"', 'foo://hearth.example.com'],
    ['a websocket scheme', 'ws://hearth.example.com'],
    ['a file url', 'file:///srv/hearth'],
  ])('rejects %s', (_name, publicUrl) => {
    expect(() => derivePublicConfig({ publicUrl })).toThrow(/scheme/i);
  });

  /**
   * Credentials are dropped by origin derivation exactly as a query string is, and this is the
   * setting an operator pastes into a compose file, an unraid template and a support message.
   * A password that silently does nothing is worse than one that stops the boot.
   */
  it('rejects embedded credentials rather than dropping them silently', () => {
    expect(() => derivePublicConfig({ publicUrl: 'https://user:pw@hearth.example.com' })).toThrow(
      /credential/i,
    );
    expect(() => derivePublicConfig({ publicUrl: 'https://user@hearth.example.com' })).toThrow(
      /credential/i,
    );
  });

  // A query or fragment is silently dropped by origin derivation, so rejecting it is the only
  // way the operator finds out the value they set is not the value in use.
  it.each([
    ['a query string', 'https://hearth.example.com/?a=1'],
    ['a fragment', 'https://hearth.example.com/#top'],
  ])('rejects %s rather than dropping it silently', (_name, publicUrl) => {
    expect(() => derivePublicConfig({ publicUrl })).toThrow(/PUBLIC_URL/);
  });
});
