import { describe, it, expect } from 'vitest';
import { mkdtempSync, readFileSync, statSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DEV_AUTH_SECRET, resolveAuthSecret } from './secret';
import { createLogger } from './log';
import { capture } from '../test/logs';

/** A fresh data dir per test: first-boot behaviour is only first-boot on an empty one. */
function dataDir(): string {
  return mkdtempSync(join(tmpdir(), 'hearth-secret-'));
}

function loggerOverSink(): { log: ReturnType<typeof createLogger>; lines: () => unknown[] } {
  const { sink, lines } = capture();
  return { log: createLogger({ level: 'info', pretty: false, destination: sink }), lines };
}

describe('resolveAuthSecret', () => {
  it('uses a configured secret that is not the shipped default', () => {
    const configured = 'x'.repeat(64);
    const dir = dataDir();
    expect(resolveAuthSecret({ envSecret: configured, dataDir: dir, nodeEnv: 'production' })).toBe(
      configured,
    );
    // A configured secret must not be persisted: the file is the fallback, and writing to it
    // would leave a stale copy that silently takes over the day the env var is removed.
    expect(() => readFileSync(join(dir, 'auth-secret'))).toThrow();
  });

  it('refuses to start in production with the shipped dev default', () => {
    expect(() =>
      resolveAuthSecret({ envSecret: DEV_AUTH_SECRET, dataDir: dataDir(), nodeEnv: 'production' }),
    ).toThrow(/BETTER_AUTH_SECRET/);
  });

  it('allows the shipped dev default outside production, but says so', () => {
    const { log, lines } = loggerOverSink();
    const secret = resolveAuthSecret({
      envSecret: DEV_AUTH_SECRET,
      dataDir: dataDir(),
      nodeEnv: 'development',
      log,
    });
    expect(secret).toBe(DEV_AUTH_SECRET);
    const warned = lines() as { level: number; msg: string }[];
    expect(warned.some((l) => l.level === 40 && /BETTER_AUTH_SECRET/.test(l.msg))).toBe(true);
  });

  it('generates a 32-byte secret on first boot and persists it', () => {
    const dir = dataDir();
    const secret = resolveAuthSecret({ envSecret: undefined, dataDir: dir, nodeEnv: 'production' });
    expect(secret).toMatch(/^[0-9a-f]{64}$/);
    expect(readFileSync(join(dir, 'auth-secret'), 'utf8')).toBe(secret);
  });

  // The file is the only thing standing between an attacker and forged sessions for every
  // account, so it must not be readable by other users on the box.
  it('writes the secret file readable only by its owner', () => {
    const dir = dataDir();
    resolveAuthSecret({ envSecret: undefined, dataDir: dir, nodeEnv: 'production' });
    expect(statSync(join(dir, 'auth-secret')).mode & 0o777).toBe(0o600);
  });

  // A different secret on every boot would sign every existing session cookie invalid, i.e.
  // log the whole household out on each container restart.
  it('returns the same secret on the next call rather than a fresh one', () => {
    const dir = dataDir();
    const first = resolveAuthSecret({ envSecret: undefined, dataDir: dir, nodeEnv: 'production' });
    const second = resolveAuthSecret({ envSecret: undefined, dataDir: dir, nodeEnv: 'production' });
    expect(second).toBe(first);
  });

  it('creates the data dir when it does not exist yet', () => {
    const dir = join(dataDir(), 'nested', 'data');
    const secret = resolveAuthSecret({ envSecret: undefined, dataDir: dir, nodeEnv: 'production' });
    expect(readFileSync(join(dir, 'auth-secret'), 'utf8')).toBe(secret);
  });

  // The file holds the key to every account, so the directory it sits in should not be
  // listable by other users on the box either.
  it('creates the data dir private to its owner', () => {
    const dir = join(dataDir(), 'nested');
    resolveAuthSecret({ envSecret: undefined, dataDir: dir, nodeEnv: 'production' });
    expect(statSync(dir).mode & 0o777).toBe(0o700);
  });

  // `writeFileSync`'s mode applies only when it CREATES the file, so a regenerate over an
  // existing broken file would otherwise keep whatever mode that file had.
  it('tightens the mode when regenerating over an existing file', () => {
    const dir = dataDir();
    const path = join(dir, 'auth-secret');
    writeFileSync(path, '', { mode: 0o644 });
    resolveAuthSecret({ envSecret: undefined, dataDir: dir, nodeEnv: 'production' });
    expect(statSync(path).mode & 0o777).toBe(0o600);
  });

  /**
   * Only a missing file means "first boot". Every other read failure - a permission problem, a
   * transient EIO, EMFILE under load - used to be read as absence, which would generate a NEW
   * secret over a perfectly good one and log every household member out permanently, with an
   * info line as the only trace. Refusing to start is recoverable; that is not.
   */
  it('refuses to start on a read failure that is not a missing file', () => {
    const dir = dataDir();
    // A directory where the file should be: readFileSync fails with EISDIR, deterministically
    // and without depending on which user the suite runs as.
    mkdirSync(join(dir, 'auth-secret'));
    // Named by the path, and thrown from the READ rather than incidentally by the write that
    // would otherwise have followed it: the distinction is the whole point of the branch.
    expect(() =>
      resolveAuthSecret({ envSecret: undefined, dataDir: dir, nodeEnv: 'production' }),
    ).toThrow(/auth-secret.*Refusing to generate/s);
    expect(existsSync(join(dir, 'auth-secret'))).toBe(true);
  });

  // A container killed mid-write leaves a zero-byte file. Returning '' from it would sign
  // sessions with the empty string, so an unusable file is treated as no file at all.
  it('regenerates when the stored file is empty', () => {
    const dir = dataDir();
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'auth-secret'), '  \n');
    const secret = resolveAuthSecret({ envSecret: undefined, dataDir: dir, nodeEnv: 'production' });
    expect(secret).toMatch(/^[0-9a-f]{64}$/);
    expect(readFileSync(join(dir, 'auth-secret'), 'utf8')).toBe(secret);
  });

  it('tolerates a trailing newline in a hand-edited secret file', () => {
    const dir = dataDir();
    writeFileSync(join(dir, 'auth-secret'), `${'a'.repeat(64)}\n`);
    expect(resolveAuthSecret({ envSecret: undefined, dataDir: dir, nodeEnv: 'production' })).toBe(
      'a'.repeat(64),
    );
  });

  // The generated secret is not a thing to have in a log file, on any level.
  it('never writes the secret itself into the log', () => {
    const { log, lines } = loggerOverSink();
    const dir = dataDir();
    const secret = resolveAuthSecret({
      envSecret: undefined,
      dataDir: dir,
      nodeEnv: 'production',
      log,
    });
    expect(JSON.stringify(lines())).not.toContain(secret);
  });
});
