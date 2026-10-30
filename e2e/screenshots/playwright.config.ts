import { defineConfig } from '@playwright/test';
import { fileURLToPath } from 'node:url';
import { dirname } from 'node:path';
import base from '../playwright.config';

const __dirname = dirname(fileURLToPath(import.meta.url));

/**
 * The README screenshots, run by `pnpm screenshots` (run.sh), never by `pnpm test:e2e`.
 *
 * Servers are never reused. A server already on :3000 could be the dev or test-kitchen API, and
 * the capture would seed one database while the browser read another.
 */
export default defineConfig({
  ...base,
  testDir: __dirname,
  testMatch: '*.shot.ts',
  outputDir: '../../test-results/screenshots',
  webServer: (Array.isArray(base.webServer) ? base.webServer : []).map((server) => ({
    ...server,
    reuseExistingServer: false,
  })),
});
