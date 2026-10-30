import { defineConfig } from 'vitest/config';
import { config } from 'dotenv';
import { fileURLToPath } from 'node:url';
// Resolve relative to THIS file, not process.cwd(): root `pnpm test` runs from the repo root,
// where '../../.env' would point above the repo. In CI there is no .env file and the vars come
// from the job env, so dotenv is a harmless no-op there.
config({ path: fileURLToPath(new URL('../../.env', import.meta.url)) });

export default defineConfig({
  test: {
    environment: 'node',
    // The suite posts requests through a two-proxy chain written out as addresses (see
    // auth-ratelimit.test.ts and test/session.ts), so it states that chain here rather than
    // leaning on a shipped default, which is 0 (D46). CI sets nothing, so this is the value.
    env: { TRUST_PROXY: '2' },
    // Server tests share one Postgres database and reset it via TRUNCATE. Running
    // test files in parallel lets one file's reset wipe another's rows mid-test
    // (surfaces as FK violations / wrong counts). A single fork runs this project's
    // files sequentially in one process, isolating DB state per file.
    pool: 'forks',
    poolOptions: { forks: { singleFork: true } },
    // Runs after the last file, pass or fail, and puts the household cap back (see
    // test/global-setup.ts). The per-test restore in `resetDb()` cannot do this: it runs
    // BEFORE each test, so the state a run ends in is whatever its last file left behind.
    globalSetup: ['./test/global-setup.ts'],
    /**
     * Give each test file its own copy of Better Auth, which it does not get by default.
     *
     * Vitest re-evaluates SOURCE modules per file but externalizes node_modules to Node's own
     * ESM loader, which caches by resolved path - so a package's module-level state is shared by
     * every file in the fork. Two pieces of Better Auth state made that matter once rate
     * limiting was always on (auth.ts):
     *
     *  - The rate limiter's `memory` Map is module-level, so every file's HTTP sign-ups shared
     *    one bucket for 127.0.0.1, and two files failed with `sign-up failed: 429`. This line is
     *    what that is insured against. It no longer shows up as a failure, because
     *    `nextClientAddress()` (test/session.ts) gave the fixtures addresses of their own in the
     *    same commit - but that counter resets per file too, since `test/` is source, so
     *    fixtures in different files reuse the same addresses and only this line keeps them in
     *    different stores.
     *  - `@better-auth/core/env` captures NODE_ENV once, at import, so whichever file loaded it
     *    first decided it for the whole run. auth-ratelimit.test.ts sets NODE_ENV=production for
     *    itself, and without this that setting is a no-op whenever another file got there first.
     *
     * Measured today: removing this line fails exactly one test, the production-semantics guard
     * at the top of auth-ratelimit.test.ts, and costs about 3% of the suite runtime (104.3s
     * without, 107.8s with).
     */
    server: { deps: { inline: [/better-auth/] } },
  },
});
