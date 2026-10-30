---
paths:
  - "apps/server/drizzle/**"
  - "apps/server/src/db/**"
---
# Schema and migrations

- Table DDL: edit `src/db/schema.ts`, then `pnpm --filter @hearth/server db:generate`.
- RLS, grants, triggers and indexes: a hand-written SQL migration with `--> statement-breakpoint` between statements and a matching entry added by hand to `drizzle/meta/_journal.json`. Copy the shape of `0003_rls_recipe_core.sql` (0001 targets a dropped table and also creates the role).
- Every new `household_id` table needs ENABLE and FORCE row level security, a policy on `current_setting('app.current_household', true)`, and a DML grant to `hearth_app`. `src/db/rls.test.ts` fails otherwise.
- Invariants on Better Auth's tables are triggers or constraints (see 0005, 0006), because its HTTP routes never pass through tRPC.
- Add every new table to the `resetDb` TRUNCATE list in `test/db.ts`.
- Never edit an applied migration; add a new one.
- Under RLS, GIN and full-text indexes go unused because the operators are not leakproof. This is accepted (D43); don't try to fix it.
- The server container migrates on boot, so a broken migration takes the instance down.
