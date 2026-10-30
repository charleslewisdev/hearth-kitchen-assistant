import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));

/** The repository root. This file lives in `e2e/` at the top of it. */
export const repoRoot = resolve(__dirname, '..');

// The server + web dev processes read their config from process.env (server/src/env.ts
// parses it directly; there is no dotenv loader in the dev scripts). Playwright's
// webServer children inherit THIS process's env, so we load the repo-root .env here, once,
// without clobbering anything already set in the shell/CI.
//
// It lives in this module rather than in playwright.config.ts because the fixtures need the
// same values AND the same side effect: they import server modules that parse process.env at
// import time (env.ts), where a missing DATABASE_URL throws. Importing this module first is
// what has loaded it by then - see the import order in e2e/fixtures.ts.
function loadDotenv(path: string) {
  let raw: string;
  try {
    raw = readFileSync(path, 'utf8');
  } catch {
    return; // no .env (e.g. CI provides real env vars): nothing to load
  }
  for (const line of raw.split('\n')) {
    const match = line.match(/^\s*([\w.-]+)\s*=\s*(.*)\s*$/);
    if (!match) continue;
    const key = match[1]!;
    if (process.env[key] !== undefined) continue;
    let value = match[2]!.trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    process.env[key] = value;
  }
}

loadDotenv(resolve(repoRoot, '.env'));

/** The origin the browser uses: Vite, which proxies /api and /trpc to the API. */
export const WEB_ORIGIN = process.env.WEB_ORIGIN ?? 'http://localhost:5173';

/**
 * The API origin. The fixtures talk to it directly; the browser never does.
 *
 * Built from `PORT` rather than read from a variable of its own, because `PORT` is what the
 * server actually binds (`apps/server/src/env.ts`), so the two cannot disagree. This used to
 * read `BETTER_AUTH_URL`, which the server stopped reading at D35 and which is no longer in the
 * schema at all: it happened to hold the right address, and would have gone on doing so until
 * someone changed the port and got a health check that never came up.
 */
export const API_URL = `http://localhost:${process.env.PORT ?? '3000'}`;

/**
 * Where the API server's DATA_DIR resolves to, which is where its first-boot setup token lives.
 *
 * `DATA_DIR` defaults to `./.data`, relative to the server process's working directory, and
 * `pnpm --filter @hearth/server dev` runs it in the package directory. So the token this
 * process writes and the file the server reads are the same one only if the relative default is
 * resolved against `apps/server` rather than against the repository root, where Playwright runs.
 */
export const SERVER_DATA_DIR = resolve(repoRoot, 'apps/server', process.env.DATA_DIR ?? './.data');

/**
 * Where the webServer command tees the API server's output, relative to the repository root
 * (the webServer `cwd`), and the absolute path the fixtures read it back from.
 *
 * Playwright's `stdout: 'pipe'` forwards a web server's output to the runner's own stdout and
 * offers no way to read it from a test, so the invitation spec would have nothing to parse. The
 * copy on disk is what gives it one. Ignored by git through the `*.log` rule.
 */
export const SERVER_LOG_RELATIVE = 'e2e/server.log';
export const SERVER_LOG = resolve(repoRoot, SERVER_LOG_RELATIVE);
