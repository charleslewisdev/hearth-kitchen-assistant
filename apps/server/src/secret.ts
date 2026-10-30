import { randomBytes } from 'node:crypto';
import { chmodSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Logger } from 'pino';
import { logger } from './log';

/**
 * The value shipped in `.env.example`. It is public, so
 * anything signed with it is forgeable by anyone who has read this repository. Exported so the
 * check below and the file that ships it cannot drift apart.
 */
export const DEV_AUTH_SECRET = 'dev-secret-change-me-min-32-chars-long';

/** Where a generated secret lives, relative to DATA_DIR. */
const SECRET_FILE = 'auth-secret';

/**
 * The key every session cookie is signed with, resolved in three ways so that no deployment
 * has to invent one, and none can accidentally ship without one.
 *
 * 1. `BETTER_AUTH_SECRET` wins when set. An operator with a secret manager keeps using it.
 * 2. The shipped default is refused in production and warned about elsewhere. Refusing is the
 *    point: it is published in this repo, so a production instance running on it lets anyone
 *    mint a session cookie for any account. That is not a configuration smell, it is an
 *    authentication bypass, and it is exactly the value a `docker compose up` inherits.
 * 3. Otherwise a random one is generated once and kept in DATA_DIR. This is what makes
 *    first boot work with no configuration at all, which is the P0.5 goal, and keeping it in
 *    a file rather than in memory is what keeps a container restart from logging the whole
 *    household out.
 */
export function resolveAuthSecret(opts: {
  envSecret: string | undefined;
  dataDir: string;
  nodeEnv: string;
  /** Injection seam, as in buildServer: tests read the lines this actually emitted. */
  log?: Pick<Logger, 'warn' | 'info'>;
}): string {
  const { envSecret, dataDir, nodeEnv } = opts;
  const log = opts.log ?? logger;

  if (envSecret !== undefined && envSecret !== '') {
    if (envSecret === DEV_AUTH_SECRET) {
      if (nodeEnv === 'production') {
        throw new Error(
          'BETTER_AUTH_SECRET is still the published dev default. Anyone can forge a session ' +
            'cookie with it. Unset it to have one generated in DATA_DIR, or set your own.',
        );
      }
      log.warn(
        'BETTER_AUTH_SECRET is the published dev default; sessions are forgeable. Fine locally, ' +
          'never in production.',
      );
    }
    return envSecret;
  }

  const path = join(dataDir, SECRET_FILE);
  const stored = readSecretFile(path);
  if (stored !== null) return stored;

  // 32 bytes as hex: 256 bits of entropy, and a value that survives being copied through a
  // shell, an env file, or a compose file without quoting.
  const generated = randomBytes(32).toString('hex');
  // 0o700 on the directory as well as 0o600 on the file: on a single-user box neither matters,
  // and on a shared one both do. `mode` applies only to directories this call creates.
  mkdirSync(dataDir, { recursive: true, mode: 0o700 });
  writeFileSync(path, generated, { mode: 0o600 });
  // `mode` on writeFileSync applies only when it CREATES the file. Regenerating over a broken
  // one would otherwise inherit whatever mode that file had, which is how a world-readable
  // signing key survives being rewritten.
  chmodSync(path, 0o600);
  // The path, never the secret. Worth a line at info: it tells the operator which file to back
  // up, and its loss is what logs every account out.
  log.info({ path }, 'generated a new auth secret');
  return generated;
}

/**
 * The stored secret, or null when there is genuinely no file yet.
 *
 * Only ENOENT means "first boot". Every other read failure - a permission problem, a directory
 * in the way, a transient EIO or an EMFILE under load - is rethrown, because the alternative is
 * to read a temporary fault as absence, generate a new secret over a perfectly good one, and
 * log every household member out for good. Refusing to start is recoverable; that is not. The
 * write that follows would catch most of these anyway, but "most" is the wrong guarantee for
 * something that only fails on a bad day.
 *
 * Empty counts as nothing: a container killed mid-write leaves a zero-byte file, and returning
 * '' from it would sign every session with the empty string. Regenerating self-heals that, and
 * costs only the sessions that a broken file had already invalidated. A short-but-non-empty
 * file is returned as-is rather than second-guessed, because overwriting it is what would log
 * a whole household out.
 */
function readSecretFile(path: string): string | null {
  let contents: string;
  try {
    contents = readFileSync(path, 'utf8');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw new Error(
      `cannot read the auth secret at ${path}. Refusing to generate a new one, which would ` +
        'invalidate every existing session. Fix the file or move it aside.',
      { cause: err },
    );
  }
  // Trimmed, so a hand-edited file with a trailing newline is not a different secret from the
  // one that was written.
  const trimmed = contents.trim();
  return trimmed === '' ? null : trimmed;
}
