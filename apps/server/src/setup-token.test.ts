import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  deleteSetupToken,
  ensureSetupToken,
  readSetupToken,
  setupTokenMatches,
  setupTokenPath,
} from './setup-token';

let dataDir: string;

beforeEach(() => {
  dataDir = mkdtempSync(join(tmpdir(), 'hearth-setup-'));
});
afterEach(() => {
  rmSync(dataDir, { recursive: true, force: true });
});

describe('ensureSetupToken', () => {
  it('generates one on first call and reuses it afterwards', () => {
    const first = ensureSetupToken(dataDir);
    expect(first).toMatch(/^[0-9a-f]{64}$/);
    expect(ensureSetupToken(dataDir)).toBe(first);
  });

  it('creates the data directory when it does not exist yet', () => {
    const nested = join(dataDir, 'missing');
    expect(ensureSetupToken(nested)).toMatch(/^[0-9a-f]{64}$/);
    expect(readSetupToken(nested)).toMatch(/^[0-9a-f]{64}$/);
  });

  // The token is bearer authority to claim the instance, so the file it lives in is no more
  // readable than the auth secret beside it.
  it('writes the file readable only by its owner', () => {
    ensureSetupToken(dataDir);
    expect(statSync(setupTokenPath(dataDir)).mode & 0o777).toBe(0o600);
  });

  // A container killed mid-write leaves a zero-byte file. Returning '' from it would make the
  // empty string a valid token, which every request that omits the field would then supply.
  it('replaces an empty file rather than returning the empty string', () => {
    writeFileSync(setupTokenPath(dataDir), '');
    expect(ensureSetupToken(dataDir)).toMatch(/^[0-9a-f]{64}$/);
  });

  it('ignores a trailing newline, so a hand-edited file still matches', () => {
    writeFileSync(setupTokenPath(dataDir), 'abc123\n');
    expect(readSetupToken(dataDir)).toBe('abc123');
  });
});

describe('setupTokenMatches', () => {
  it('accepts the stored token', () => {
    const token = ensureSetupToken(dataDir);
    expect(setupTokenMatches(token, dataDir)).toBe(true);
  });

  it('rejects a wrong token', () => {
    ensureSetupToken(dataDir);
    expect(setupTokenMatches('f'.repeat(64), dataDir)).toBe(false);
  });

  /**
   * The case that decides whether the bootstrap door is open to everyone.
   *
   * A signup body that omits the field arrives here as `undefined`, and a caller can also send a
   * number, an array or an object. None of them may be coerced into something that compares
   * equal to a missing or empty stored token.
   */
  it.each([
    ['undefined', undefined],
    ['null', null],
    ['an empty string', ''],
    ['a number', 1234],
    ['an array', ['x']],
    ['an object', {}],
  ])('rejects %s', (_name, supplied) => {
    ensureSetupToken(dataDir);
    expect(setupTokenMatches(supplied, dataDir)).toBe(false);
  });

  it('rejects everything once the token has been deleted', () => {
    const token = ensureSetupToken(dataDir);
    deleteSetupToken(dataDir);
    expect(readSetupToken(dataDir)).toBeNull();
    expect(setupTokenMatches(token, dataDir)).toBe(false);
    expect(setupTokenMatches('', dataDir)).toBe(false);
    expect(setupTokenMatches(undefined, dataDir)).toBe(false);
  });
});

describe('deleteSetupToken', () => {
  it('is silent when there is nothing to delete', () => {
    expect(() => deleteSetupToken(dataDir)).not.toThrow();
    expect(() => deleteSetupToken(join(dataDir, 'missing'))).not.toThrow();
  });

  it('removes the file', () => {
    ensureSetupToken(dataDir);
    deleteSetupToken(dataDir);
    expect(() => readFileSync(setupTokenPath(dataDir), 'utf8')).toThrow();
  });
});
