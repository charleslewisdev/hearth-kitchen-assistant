import { randomBytes, timingSafeEqual } from 'node:crypto';
import { chmodSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

/** Where the first-boot token lives, relative to DATA_DIR. */
const SETUP_TOKEN_FILE = 'setup-token';

export function setupTokenPath(dataDir: string): string {
  return join(dataDir, SETUP_TOKEN_FILE);
}

/**
 * The credential that claims a fresh instance.
 *
 * D36 makes an invitation the only route to an account, and issuing one needs an owner, so the
 * very first account has to be exempt. Exempting it on "no accounts exist yet" alone is what
 * made an unauthenticated POST able to BRICK a fresh box: anyone could create the one user row
 * that closes the exemption, and on the shipped zero-config console mailer they could not read
 * their own verification link either, so nobody ended up able to sign in and there was no
 * in-app way back. Requiring a token that only the operator can read closes both halves at
 * once - a stranger cannot create that row, and whoever can read the logs or DATA_DIR is the
 * person who owns the machine.
 *
 * Deliberately the same shape as the generated auth secret next to it (`secret.ts`): 32 random
 * bytes as hex, 0o600 in DATA_DIR, created on first boot and reused from there. That is not
 * imitation for its own sake - it means one file to back up, one directory to protect, and one
 * mechanism for an operator to learn.
 */
export function ensureSetupToken(dataDir: string): string {
  const stored = readSetupToken(dataDir);
  if (stored !== null) return stored;

  const generated = randomBytes(32).toString('hex');
  // 0o700 on the directory, 0o600 on the file, and `mode` applies only where the call creates
  // it - hence the explicit chmod, which is what covers rewriting a file that already existed
  // with a laxer mode.
  mkdirSync(dataDir, { recursive: true, mode: 0o700 });
  writeFileSync(setupTokenPath(dataDir), generated, { mode: 0o600 });
  chmodSync(setupTokenPath(dataDir), 0o600);
  return generated;
}

/**
 * The stored token, or null when there is none.
 *
 * Every failure reads as "no token", which is the safe direction here and the opposite of the
 * choice `secret.ts` makes: a secret that cannot be read must not be regenerated, because that
 * would log every household out, whereas a token that cannot be read must not be honoured,
 * because honouring it is what opens the bootstrap door. Empty counts as none for the same
 * reason - a zero-byte file from a container killed mid-write would otherwise make '' a valid
 * token, and '' is what every request that omits the field supplies.
 */
export function readSetupToken(dataDir: string): string | null {
  let contents: string;
  try {
    contents = readFileSync(setupTokenPath(dataDir), 'utf8');
  } catch {
    return null;
  }
  // Trimmed so a hand-edited file with a trailing newline is not a different token.
  const trimmed = contents.trim();
  return trimmed === '' ? null : trimmed;
}

/** Remove the token. Idempotent: a missing file is the desired end state, not an error. */
export function deleteSetupToken(dataDir: string): void {
  rmSync(setupTokenPath(dataDir), { force: true });
}

/**
 * Whether `supplied` is this instance's setup token.
 *
 * `unknown` in, because the value comes off a request body before any schema has looked at it,
 * so it can be a number, an array, or absent. Anything that is not a non-empty string is
 * rejected outright rather than coerced - `String(undefined)` is `'undefined'`, and a stored
 * token that failed to read is null, and the two must never meet in the middle.
 *
 * The comparison is constant-time, which matters more here than it looks: this is one of the
 * few unauthenticated endpoints where a wrong answer can be retried without limit until Phase E
 * lands rate limiting, and the reward for guessing it is the instance.
 */
export function setupTokenMatches(supplied: unknown, dataDir: string): boolean {
  if (typeof supplied !== 'string' || supplied === '') return false;
  const expected = readSetupToken(dataDir);
  if (expected === null) return false;

  const a = Buffer.from(expected, 'utf8');
  const b = Buffer.from(supplied, 'utf8');
  // `timingSafeEqual` throws on a length mismatch, so the length is checked first and does leak.
  // For a fixed-length hex token that reveals nothing an attacker cannot read off this file.
  return a.length === b.length && timingSafeEqual(a, b);
}
