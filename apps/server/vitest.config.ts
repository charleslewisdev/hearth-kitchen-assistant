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
    // Server tests share one Postgres database and reset it via TRUNCATE. Running
    // test files in parallel lets one file's reset wipe another's rows mid-test
    // (surfaces as FK violations / wrong counts). A single fork runs this project's
    // files sequentially in one process, isolating DB state per file.
    pool: 'forks',
    poolOptions: { forks: { singleFork: true } },
  },
});
