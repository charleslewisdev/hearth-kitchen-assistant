# P0 Deferred Work & Hardening Backlog

> **Internal tracking doc.** Items consciously deferred during P0 execution (2026-06-19) so they aren't lost. None block P0 (which is complete — see [2026-06-17-p0-foundations.md](2026-06-17-p0-foundations.md)). Each notes *why deferred* and *when it must be addressed*. Promote an item to its own spec → plan when its trigger arrives.

_Created 2026-06-19 at the close of P0 execution._

---

## 🔴 Must address before ANY public / multi-tenant / internet-exposed instance

These are safe to skip for solo/local/dogfood use, but are load-bearing the moment a stranger can reach the instance. Grouping them as "P0.5 — public-readiness" is the natural next plan if/when hosting happens.

1. **First-boot secret generation + secret hygiene.** `docker-compose.yml` defaults `BETTER_AUTH_SECRET` to `dev-secret-change-me-min-32-chars-long`. A real deploy MUST override it (env/secret store). Ideal: generate a strong secret on first boot if unset and persist it, and refuse to start in a "public" mode with the default. Today nothing enforces this.
2. **Email verification.** `emailAndPassword` is enabled with no verification (`emailVerified` defaults false and is unused). Public sign-up needs verification + an email transport (deterministic-first: console/SMTP, BYO provider). Wire Better Auth's email-verification flow.
3. **Auth rate-limiting / brute-force protection.** No throttling on `/api/auth/*`. Add rate limits (Better Auth has options; or Fastify-level) before exposure.
4. **Production TLS + real origin.** Compose serves HTTP on `:8080`. Caddy was chosen precisely because swapping `:80` for a hostname in `apps/web/Caddyfile` yields automatic TLS — do that for a real domain, and set `PUBLIC_URL` (drives `BETTER_AUTH_URL` + `WEB_ORIGIN`/trusted origins) to the public `https://…` origin.

**Trigger:** the "audience-vs-delivery" decision (ROADMAP backlog) resolving toward any hosted/public instance. Until then, document "local/trusted-network only" expectations.

---

## 🟠 Engineering hygiene & known shortcuts (address opportunistically)

5. **RLS rollout discipline as tables grow.** The tenancy pattern is established in migration `0001_rls_recipes.sql`: every domain table must (a) `GRANT … TO hearth_app`, (b) `ENABLE` + `FORCE ROW LEVEL SECURITY`, (c) add a `household_id = current_setting('app.current_household', true)` policy, and (d) be accessed only via a `withHousehold(...)` repo function. This is convention, not yet automation. **Before P1 adds its first new domain table,** consider a schema helper / migration template / test that asserts "every table with a `household_id` has RLS enabled + a policy," so a forgotten table can't silently bypass isolation.
6. **Server image runs via `tsx` (dev runtime) in production.** `apps/server/Dockerfile` installs all deps (incl. dev) and runs `tsx src/server.ts`. Fine for P0. For a leaner/faster prod image later: `tsc` build (config already exists at `apps/server/tsconfig.build.json`), run compiled JS, and `pnpm prune --prod`.
7. **CI actions on deprecated Node 20 runtime.** `.github/workflows/ci.yml` uses `actions/checkout@v4`, `actions/setup-node@v4`, `pnpm/action-setup@v4`, which GitHub now force-runs on Node 24 with a deprecation warning. Bump to the majors that target Node 24 when convenient (no functional impact today).
8. **Disposable `recipes` table is scaffolding, not the real model.** P0's `recipes` (id/householdId/title/slug/createdAt) exists only to prove the stack. **P1 replaces it** with the Decision 9 structured core (ingredients, steps, canonical Foods, scaling rules). Treat as throwaway — don't build on its shape. This is effectively the P1 starting point, not a separate task.

---

## 🟡 Cross-cutting (tracked in ROADMAP, restated here for completeness)

9. **PWA offline-sync conflict resolution.** The web app is an installable PWA (service worker via `vite-plugin-pwa`), but there is no offline data strategy or conflict resolution. Needed before "works on the subway" claims; design alongside the first heavily-used data flow (P3 shopping check-off is the likely forcing function).
10. **Data-portability / export earlier than P5.** P0 sets `household → recipes` cascade-delete. Per Principle #1 ("no lock-in"), schedule a basic structured export before early adopters can churn. (Strategic item — see ROADMAP backlog.)

---

## Strategic questions (bigger than any single plan)

Unchanged and still open — tracked in [DECISION_LOG.md](../../DECISION_LOG.md#pending-decisions) + the [ROADMAP backlog](../../ROADMAP.md#open-questions-backlog): audience-vs-self-host tension, solo-build scope / dogfood line, sale-ad T1 input availability, pulling data export earlier. Answer each before the phase that depends on it.
