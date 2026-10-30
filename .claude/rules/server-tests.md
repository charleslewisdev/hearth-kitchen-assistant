---
paths:
  - "apps/server/test/**"
  - "apps/server/src/**/*.test.ts"
---
# Server tests

- They need Postgres at `DATABASE_URL` (5433 on this machine via the compose override, 5432 in CI): `pnpm test:local`, or `pnpm db:up && pnpm db:migrate` once, then `pnpm vitest run <file>`.
- Server tests run in a single fork on purpose: files truncate a shared DB, and parallel forks raced. Better Auth is instantiated per file so rate-limit buckets don't collide. Don't undo either.
- `resetDb()` restores the one-household singleton index before each test; call `liftHouseholdCap` only in tests that need two households.
- Sign-in requires `verifyEmail` first (`requireEmailVerification: true`).
- Build rows with the factories in `test/factories.ts`, which own the raw SQL, and call procedures through `testContext()` in `test/trpc.ts`.
