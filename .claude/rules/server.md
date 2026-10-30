---
paths:
  - "apps/server/src/**"
---
# Server code

- Reach tenant data only through `withHousehold(householdId, tx => ...)` (`src/repo/tenant.ts`), which sets the `hearth_app` role and `app.current_household`; each repo query also adds its own `where(householdId)`. ESLint bans importing `db/client` outside `repo/**`, `db/**`, `auth.ts` and `auth-invite.ts`.
- `createContext` (`trpc/context.ts`) derives `session` and `householdId` from `session.activeOrganizationId`; `protectedProcedure` narrows both. `ctx.headers` is only a credential to forward to `auth.api.*`: never branch on it, never log ctx.
- `/api/auth/*` bypasses tRPC. An auth rule in a procedure covers one path out of four: enforce it in the Better Auth hooks (`auth.ts`, `auth-invite.ts`) or as a DB constraint or trigger. A router-only check let a removed member keep reading recipes for 7 days, and let an owner invite a second owner.
- Race-prone invariants (last owner, one household per instance, D41) are DB constraints, not read-then-write. Map Better Auth's `APIError.body.code` for them, or the loser gets a 500 (see `household.ts`, the removeMember handler).
- Ids-only logging (D38, D40): never log `err.message`, request input or tRPC `?input=`; every `err` call site passes its own message. Own every logger, including Better Auth's. A pino child's level replaces its parent's, so use `noQuieterThan` (log.ts) wherever a line must survive `LOG_LEVEL=warn`.
- New env vars go in `env.ts`: wrap optional ones in `z.preprocess(blankIsAbsent, ...)` (an empty `PORT` once became port 0), and use `envBoolean(...)` for flags, never `z.coerce.boolean`. Add each to `.env.example`, `docker-compose.yml`, `deploy/unraid/*.xml` and CI.
- Strings the web client must spell exactly as the server does (it matches on them, sends them or shows them on its own) go in `src/messages.ts`, which imports nothing. A message the server only throws stays beside the code that throws it.
- Only `ENOENT` on the secret file means first boot; any other error must fail, not regenerate and log everyone out (see `secret.ts`).
