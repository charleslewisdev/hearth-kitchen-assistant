import { defineConfig, devices } from '@playwright/test';
import { fileURLToPath } from 'node:url';
import { dirname } from 'node:path';
// Importing this module is what loads the repo-root .env into process.env, which the webServer
// children below inherit. See e2e/env.ts.
import { API_URL, repoRoot, SERVER_LOG_RELATIVE, WEB_ORIGIN } from './env';

const __dirname = dirname(fileURLToPath(import.meta.url));

export default defineConfig({
  testDir: __dirname,
  fullyParallel: false,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 2 : 0,
  // One worker, because every spec seeds one shared database and the seed starts by emptying it
  // (e2e/fixtures.ts). Two files at once would each reset the other's household mid-test.
  workers: 1,
  reporter: 'list',
  use: {
    baseURL: WEB_ORIGIN,
    trace: 'on-first-retry',
  },
  projects: [
    {
      name: 'chromium',
      use: { ...devices['Desktop Chrome'] },
    },
  ],
  // Start BOTH the API (Fastify/tRPC + Better Auth) and the web dev server. The Vite
  // dev server proxies /api + /trpc to the API, so the browser only ever hits the web
  // origin (baseURL). Playwright waits for both to be reachable before running tests.
  webServer: [
    {
      /*
        Teed to a file as well as piped, because with no SMTP configured the API server's log IS
        the mail transport (mail/mailer.ts), so an invitation link only exists there. `stdout:
        'pipe'` forwards that output to the runner's own stdout and gives a test no way to read
        it; the copy on disk is what `inviteLinkFor` parses.

        `tee` truncates, so each run Playwright starts a server for begins with an empty file.
        A run that REUSES a server (below) inherits whatever that server has written so far,
        which is why the parser matches on a per-run address rather than on the newest link.

        The pipeline assumes a POSIX shell, as does everything else about running this suite.
      */
      command: `pnpm --filter @hearth/server dev 2>&1 | tee ${SERVER_LOG_RELATIVE}`,
      cwd: repoRoot,
      url: `${API_URL}/health`,
      reuseExistingServer: !process.env.CI,
      timeout: 120_000,
      stdout: 'pipe',
      stderr: 'pipe',
    },
    {
      command: 'pnpm --filter @hearth/web dev',
      cwd: repoRoot,
      url: WEB_ORIGIN,
      reuseExistingServer: !process.env.CI,
      timeout: 120_000,
      stdout: 'pipe',
      stderr: 'pipe',
    },
  ],
});
