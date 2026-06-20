import { defineConfig } from 'drizzle-kit';
import { config } from 'dotenv';
import { fileURLToPath } from 'node:url';

// Load the repo-root .env (resolved relative to THIS file, not cwd) so a bare
// `pnpm db:migrate` works locally without manually exporting DATABASE_URL. In CI
// there is no .env and the vars come from the job env, so this is a harmless
// no-op. Mirrors the same approach in apps/server/vitest.config.ts.
config({ path: fileURLToPath(new URL('../../.env', import.meta.url)) });

export default defineConfig({
  schema: './src/db/schema.ts',
  out: './drizzle',
  dialect: 'postgresql',
  dbCredentials: { url: process.env.DATABASE_URL! },
});
