# P0 Deferred Work & Hardening Backlog

> **Internal tracking doc.** Items consciously deferred during P0 execution (2026-06-19) so they aren't lost. None block P0 (which is complete — see [2026-06-17-p0-foundations.md](2026-06-17-p0-foundations.md)). Each notes *why deferred* and *when it must be addressed*. Promote an item to its own spec → plan when its trigger arrives.

_Created 2026-06-19 at the close of P0 execution._

---

## 🔴 Must address before ANY public / multi-tenant / internet-exposed instance ✅ ALL FOUR DONE 2026-09-09

Closed by the [P0.5 self-host readiness milestone](2026-09-08-p05-selfhost-readiness.md). Each entry
below keeps its original text with the outcome appended, including where the milestone reached a
different answer than this backlog anticipated.

1. **First-boot secret generation + secret hygiene.** `docker-compose.yml` defaults `BETTER_AUTH_SECRET` to `dev-secret-change-me-min-32-chars-long`. A real deploy MUST override it (env/secret store). Ideal: generate a strong secret on first boot if unset and persist it, and refuse to start in a "public" mode with the default. Today nothing enforces this.

   **✅ Done (Task 5).** `resolveAuthSecret` generates 32 random bytes into `DATA_DIR/auth-secret` at mode `0600` on first boot and reuses it, and **refuses to start** under `NODE_ENV=production` with the published dev default. The guard was inert when first written, because compose set no `NODE_ENV` - fixed in the same phase, and verified against a real container: the dev secret now exits non-zero with the reason, and a generated secret survives a restart via the `hearth_data` volume.
2. **Email verification.** `emailAndPassword` is enabled with no verification (`emailVerified` defaults false and is unused). Public sign-up needs verification + an email transport (deterministic-first: console/SMTP, BYO provider). Wire Better Auth's email-verification flow.

   **✅ Done (Phase C, Tasks 11-12).** Nodemailer over env SMTP with a console fallback so a zero-config install still works; `requireEmailVerification` on. **Public sign-up did not happen** - the milestone answered the audience question differently (→ D36): accounts are invite-only, so verification protects the invitation flow rather than open registration.
3. **Auth rate-limiting / brute-force protection.** No throttling on `/api/auth/*`. Add rate limits (Better Auth has options; or Fastify-level) before exposure.

   **✅ Done (Phase E).** Both, as it turned out: Better Auth's own path-aware limiter for `/api/auth/*` (sign-in 25/900s, sign-up 15/900s, tighter defaults elsewhere) plus `@fastify/rate-limit` at 300/min as a coarse cap, keyed on the same address. Two holes found by measurement rather than reading: CORS preflights bypassed the cap entirely (cors answers from an instance-level hook, the limiter attaches per route), and the setup token needed the limiter to run *ahead* of the invite-only refusal or an attacker got unlimited guesses at a 403.
4. **Production TLS + real origin.** Compose serves HTTP on `:8080`. Caddy was chosen precisely because swapping `:80` for a hostname in `apps/web/Caddyfile` yields automatic TLS — do that for a real domain, and set `PUBLIC_URL` (drives `BETTER_AUTH_URL` + `WEB_ORIGIN`/trusted origins) to the public `https://…` origin.

   **✅ Done (Tasks 4, 24), by a different route than this entry expected.** TLS terminates at the owner's **existing nginx** (→ D35), not at Caddy, because that box already runs one and a second cert-provisioning proxy would fight it for :443. `PUBLIC_URL` is the single source of the app's public identity and drives both origins plus `useSecureCookies`. The unexpected part: Caddy is still a hop, and it **replaces** `X-Forwarded-For` for untrusted peers (→ D39), which meant every client shared one rate-limit bucket and eleven requests from anyone could lock out the household. Closed with `trusted_proxies private_ranges`, `TRUST_PROXY=2`, and binding the published port off `0.0.0.0`; verified against a real four-container chain.

**Trigger:** the "audience-vs-delivery" decision (ROADMAP backlog) resolving toward any hosted/public instance. Until then, document "local/trusted-network only" expectations.

---

## 🟠 Engineering hygiene & known shortcuts (address opportunistically)

5. ✅ **Done 2026-06-20 (#1).** **RLS rollout discipline as tables grow.** The tenancy pattern is established in migration `0001_rls_recipes.sql`: every domain table must (a) `GRANT … TO hearth_app`, (b) `ENABLE` + `FORCE ROW LEVEL SECURITY`, (c) add a `household_id = current_setting('app.current_household', true)` policy, and (d) be accessed only via a `withHousehold(...)` repo function. ~~This is convention, not yet automation.~~ **Now automated:** `apps/server/src/db/rls.test.ts` introspects the catalogs and fails the build if any `public` table with a `household_id` column lacks ENABLE+FORCE RLS, a policy, or `hearth_app` DML grants. Verified it red-flags a non-compliant table (not a vacuous pass). The `withHousehold(...)` repo-access half remains convention (lint guard), but a forgotten table can no longer silently bypass isolation.
6. **Server image runs via `tsx` (dev runtime) in production.** `apps/server/Dockerfile` installs all deps (incl. dev) and runs `tsx src/server.ts`. Fine for P0. For a leaner/faster prod image later: `tsc` build (config already exists at `apps/server/tsconfig.build.json`), run compiled JS, and `pnpm prune --prod`.
7. ✅ **Done 2026-06-20 (#1).** **CI actions on deprecated Node 20 runtime.** Bumped `actions/checkout@v4→v7`, `actions/setup-node@v4→v6`, `pnpm/action-setup@v4→v6` (all on the current Node 24 runtime; versions verified against latest releases, CI green). The project's own `node-version` stays at 20 for now — note Node 20 LTS is near end-of-life (~mid-2026), so bumping the project runtime to 22 LTS is a small future follow-up.
8. **Disposable `recipes` table is scaffolding, not the real model.** P0's `recipes` (id/householdId/title/slug/createdAt) exists only to prove the stack. **P1 replaces it** with the Decision 9 structured core (ingredients, steps, canonical Foods, scaling rules). Treat as throwaway — don't build on its shape. This is effectively the P1 starting point, not a separate task.

---

## 🟡 Cross-cutting (tracked in ROADMAP, restated here for completeness)

9. **PWA offline-sync conflict resolution.** The web app is an installable PWA (service worker via `vite-plugin-pwa`), but there is no offline data strategy or conflict resolution. Needed before "works on the subway" claims; design alongside the first heavily-used data flow (P3 shopping check-off is the likely forcing function).
10. **Data-portability / export earlier than P5.** P0 sets `household → recipes` cascade-delete. Per Principle #1 ("no lock-in"), schedule a basic structured export before early adopters can churn. (Strategic item — see ROADMAP backlog.)

---

## Strategic questions (bigger than any single plan)

Unchanged and still open — tracked in [DECISION_LOG.md](../DECISION_LOG.md#pending-decisions) + the [ROADMAP backlog](../ROADMAP.md#open-questions-backlog): audience-vs-self-host tension, solo-build scope / dogfood line, sale-ad T1 input availability, pulling data export earlier. Answer each before the phase that depends on it.
