# Hearth — "Self-host, Cook, Import" Milestone Design

> **Slice design.** Covers the arc from the merged Grocery MVP to a Hearth instance
> the author runs on unraid, invites family into, cooks from, and imports into.
> Supersedes nothing; extends the approved
> [P1 recipe-core design](2026-06-21-p1-recipe-core-design.md) and drains the
> [P0 deferred/hardening backlog](../plans/2026-06-19-p0-deferred-and-hardening.md).

_Authored: 2026-09-08_

## Why this milestone, in this order

The owner's goal, in his words: *"a version of this I could put on my unraid server and
start importing my own recipes and adding new ones as I encounter them, and use it to
cook from for starters."*

That is a deployment goal first and a feature goal second. It also forces the
long-pending **audience-vs-delivery** question (ROADMAP backlog), which is now answered:
the instance will be **reachable from outside the house** so relatives can use it. The
moment a stranger can reach the box, the four red items in the hardening backlog stop
being optional.

The owner also asked for logging up front, on the grounds that observability is
miserable to retrofit. Agreed, and it is sequenced first because every later task in
this milestone benefits from it.

## Decisions taken this session

Recorded here, promoted to [DECISION_LOG.md](../DECISION_LOG.md) as D34–D38.

1. **Delivery to unraid = GHCR images + unraid XML templates.** Matches the owner's
   existing container workflow (Docker tab, one-click update). The repo keeps
   `docker compose up` as the documented path for everyone else; the templates are an
   additional target, not a replacement.
2. **Images publish to `ghcr.io/charleslewisdev/hearth-*`,** under the same account as
   the source, so publishing needs no second registry or credential.
3. **TLS terminates at the existing nginx**, not at Hearth's Caddy. Hearth serves plain
   HTTP on a LAN port; the app learns its public identity from `PUBLIC_URL` and trusts
   proxy headers.
4. **Accounts are invite-only.** Open self-service signup stays off. The household owner
   invites by email; the invitee joins **the owner's household** and shares its recipe
   library.
5. **Containers talk over a dedicated `hearth` docker network**, by service name, with
   Postgres unpublished. This departs from the "use host IP, not container names" unraid
   convention on purpose: it keeps the database off the LAN entirely.

## Sequencing

Four independently shippable milestones. Each ends with something the owner can use.

| | Milestone | Exit criterion |
|---|---|---|
| **A** | P0.5 foundations | Instance runs on unraid behind nginx at a real hostname; a relative accepts an emailed invite and signs in; structured logs are queryable |
| **B** | P1 remainder | A user cooks from a phone in Focus mode; library search + filters work |
| **C1** | URL import | A recipe URL becomes a clean, reviewable recipe with no AI |
| **C2** | Paste / PDF / photo import | A week of recipes imports from mixed sources |

Manual entry already works, so **A alone makes the instance genuinely usable**. Import is
split so the URL path ships without waiting on OCR.

---

## Milestone A — P0.5 foundations

### A1. Structured logging (first)

Fastify bundles pino; the server currently disables it (`logger: false`). Enable it.

- **Request-scoped child logger** carrying `requestId`, and once resolved, `userId` and
  `householdId`. Attached to the tRPC context so domain code logs with tenancy already
  bound.
- **Redaction** on `req.headers.cookie`, `req.headers.authorization`, `res.headers['set-cookie']`,
  and any `password` / `token` / `secret` field.
- **`LOG_LEVEL` env**, default `info`. `pino-pretty` transport in dev, JSON in prod.
- **tRPC middleware** logs `{ path, type, durationMs, ok }` per call, and logs thrown
  errors with their cause at `error`.
- **Rule: ids only.** Never log recipe content, ingredient text, email bodies, or
  addresses. Principle #1 (privacy) applies to logs, not just the database.

### A2. Secret hygiene and first boot

- `env.ts` gains `NODE_ENV` (`development|test|production`) and `DATA_DIR`
  (default `./.data`, `/data` in the image).
- **First-boot generation:** if `BETTER_AUTH_SECRET` is unset, generate 32 random bytes,
  persist to `${DATA_DIR}/auth-secret` with mode `0600`, and reuse it on later boots so
  sessions survive restarts.
- **Hard refusal:** booting with `NODE_ENV=production` and the literal
  `dev-secret-change-me-min-32-chars-long` exits non-zero with an explanatory message.
- Requires a persistent volume. Compose gets a named volume; unraid maps
  `/mnt/user/appdata/hearth/`.

### A3. Email transport

- **Nodemailer** over env SMTP: `SMTP_HOST`, `SMTP_PORT`, `SMTP_USER`, `SMTP_PASS`,
  `SMTP_SECURE`, `SMTP_FROM`.
- **Console fallback** when `SMTP_HOST` is unset: the recipient and the action link, and
  nothing else, are logged at **`warn`** instead of sent. Not the subject and not the body:
  the subject is built from user-supplied names, and the URL alone already distinguishes an
  invitation from a verification. Zero-config installs still work end to end, which is what
  keeps "deterministic-first, no external dependency" honest for email too.

  **This is a deliberate, narrow exception to D38, and it prints a live credential.** An
  invitation link is bearer authority to create an account in the household, so anyone who
  can read the logs can accept it. That is inherent to console delivery rather than a defect,
  and it is stated at startup, on the line itself, and in `.env.example`, because a
  self-hoster shipping logs to a third-party collector needs to know before it happens.
  Console mode is deliberately **not** refused in production and has **no opt-out flag**:
  `docker compose up` sets `NODE_ENV=production`, so refusing would break the shipped
  one-command install, and a flag whose name appears in the first error a zero-config user
  hits gets set once and is then permanently on and invisible. The dev-secret refusal in A2
  means something precisely because it has no opt-out; this is the opposite case and takes
  the opposite treatment.
- A tiny `Mailer` interface (`send({ to, subject, text, html, actionUrl })`) with `SmtpMailer`
  and `ConsoleMailer` implementations, selected once at startup. `actionUrl` is required and
  returned by the templates, so the link the console prints is provably the one inside the
  body. Tests use a `MemoryMailer` and assert on captured messages.
- Templates are plain text with a minimal HTML twin. Two to start: **household invitation**
  and **email verification**.

### A4. Invite-only accounts

- Better Auth `emailAndPassword.disableSignUp = true`; the only path to an account is an
  invitation. Email verification is wired and required.
- Better Auth's `organization` plugin already models invitations (the `invitation` table
  exists and is bound in `auth.ts`). Wire `sendInvitationEmail` to the mailer.
- **New web surfaces:**
  - **Household settings** (fills the current `/more` stub): member list with roles,
    pending invitations with resend/revoke, an invite-by-email form.
  - **`/accept-invite/:id`**: unauthenticated landing that reads the invitation, prompts
    for a password to create the account, accepts the invitation, and drops the user into
    the household.
- **Roles:** `owner` and `member` only for now. `admin` is left unused rather than
  designed prematurely; adding it later is additive.
- **Tenancy note:** invitees join the *existing* household, so `withHousehold` and RLS
  need no change. This is the cheapest correct answer and it is why it was chosen.

### A5. Rate limiting

- `@fastify/rate-limit`, in-memory (single instance; no Redis dependency).
- Tight bucket on `/api/auth/sign-in/*`, `/api/auth/sign-up/*`, and any
  forgot-password route, keyed on client IP: on the order of 10 attempts per 15 minutes.
- Looser global cap over everything else so a runaway client cannot trivially exhaust
  the box.
- **Depends on A6** for correct client IPs behind the proxy; without `trustProxy` every
  request appears to come from nginx and the limiter would throttle all users as one.

### A6. Running behind nginx

- Fastify `trustProxy: true` so `X-Forwarded-For` / `X-Forwarded-Proto` are honored.
- **`PUBLIC_URL` is the single source of truth** for the app's public identity; it drives
  `BETTER_AUTH_URL` and `WEB_ORIGIN`/trusted origins. Deriving both from one variable
  removes the classic self-host misconfiguration where they disagree.
- **Secure cookies auto-enable** when `PUBLIC_URL` starts with `https://`
  (`useSecureCookies` + `sameSite=lax`), rather than being a separate flag to forget.
- Caddy keeps listening on plain `:80` inside the container. The committed Caddyfile
  comment promising automatic TLS is now wrong for this deployment and gets corrected.
- Ship the nginx `server` block as documentation, including the WebSocket-safe
  `proxy_set_header` set and a note that `proxy_set_header X-Forwarded-Proto $scheme` is
  what makes secure cookies work.

### A7. Publishing and unraid templates

- **GitHub Actions workflow** building and pushing `ghcr.io/charleslewisdev/hearth-server`
  and `ghcr.io/charleslewisdev/hearth-web` on pushes to `main` and on version tags,
  multi-arch `linux/amd64` (unraid is x86; arm64 deferred until someone asks).
- **`unraid-template.xml`** per container under `deploy/unraid/`, plus a Postgres
  template pinned to `postgres:16`.
- All three templates join a dedicated **`hearth` docker bridge network** so they resolve
  each other by name and Postgres publishes **no host port**. The README documents the
  one-time `docker network create hearth`.
- A `deploy/unraid/README.md` walks the sequence: create network, start Postgres, set
  `PUBLIC_URL` + SMTP, start server, start web, point nginx at the web container's port.

### A8. Identity-separation gate

Before anything is pushed to GHCR or before repo visibility changes, run the
identity-separation audit defined in the author's global operating rules over the **full
history**, not just the working tree. Check both commit authorship and file contents.

That rule owns the list of patterns to screen for, and they are deliberately **not**
restated here: writing them down in this repo would plant the exact strings the audit
exists to keep out. This paragraph replaces an earlier draft that made that mistake.

Publishing images makes the project's namespace externally visible, so this runs as a
task in the plan, not as an afterthought. Findings get reported, never silently rewritten.

### A9. Testing posture

Follows D11 (deterministic core is test-first) and the existing suite's shape.

- **Unit:** secret generation/persistence/refusal; `PUBLIC_URL` → origin/cookie
  derivation; mailer selection; template rendering; redaction (assert a log line
  containing a session cookie comes out redacted).
- **Integration (real Postgres, as today):** full invite lifecycle - invite created,
  email captured by `MemoryMailer`, accept creates a verified user in the right household,
  the new member reads exactly that household's recipes and nothing else; revoked and
  expired invitations rejected; signup blocked outside the invite path.
- **Rate limiting:** the auth bucket returns 429 after its threshold and recovers.
- Every new table (if any) is covered automatically by the existing RLS guard.

### A10. Explicitly out of Milestone A

Each defers additively; none constrains the schema.

- Password reset flow (needs the same mailer; add on demand).
- 2FA, social login, OIDC (Better Auth supports them; no demand yet).
- Per-member permissions beyond owner/member.
- Multiple households per user in the UI.
- Metrics/tracing beyond logs. Logs first; reassess when there is traffic worth measuring.
- Log shipping or retention policy - stdout is the interface, the platform decides.

---

## Milestone B — P1 remainder (sketch)

Already designed in the [P1 recipe-core design](2026-06-21-p1-recipe-core-design.md)
§3 and §4; this milestone simply executes the parts the Grocery MVP re-scope (D33)
trimmed. Nothing here needs re-litigating.

- **Cook mode (Focus).** Full-screen single-scroll outside the AppShell (the route and
  placeholder already exist), Wake Lock to keep the screen on, tap-to-check steps as
  ephemeral client state, a sticky stacking timer tray with durations parsed from step
  text client-side, and an ingredient-peek bottom sheet showing **scaled** amounts.
- **Search and filters.** `recipe.list` grows into the params-driven `recipe.search`
  described in the P1 design: FTS text plus ingredient / meal-of-day / tag filters. The
  `search_tsv` generated column and its GIN index **already exist** in migration
  `0003_rls_recipe_core.sql`; only the query surface and UI are missing.
- **Library UI.** 2-up card grid, quick filter chips, Filters sheet, smart-search tokens.

## Milestone C — Import (sketch)

Creates `packages/enrichment`, the package the architecture reserved but never built.

- **The interface comes first.** `ImportSource → RecipeDraft` with per-field confidence,
  so every source shares one review screen. The deterministic baseline is the default
  implementation and an LLM provider is an optional decorator, never a requirement.
- **C1 — URL.** Fetch, parse schema.org JSON-LD `Recipe`, fall back to microdata, then to
  the paste heuristics. Normalize through the **existing** ingredient parser so imported
  recipes are indistinguishable from hand-entered ones.
- **C2 — paste text**, then **PDF** (text layer via `unpdf`, scanned falls through to
  OCR), then **image OCR** (`tesseract.js`).
- **Review UI per D29:** source tiles, editable draft, only low-confidence fields flagged
  amber, source shown side-by-side on desktop.

## Risks

- **Better Auth invitation ergonomics are unverified.** The plugin is bound but no
  invitation has ever been issued in this codebase. Milestone A's plan spikes the invite
  round-trip before building UI on top of it.
- **Email deliverability from a home IP is poor.** The console fallback means this never
  blocks the owner, but a relative may never receive an invite from a self-hosted SMTP.
  Documented recommendation: use a relay. Not solvable in code.
- **Multi-arch and unraid template drift.** Templates are copied into the flash drive and
  diverge silently from the repo. Mitigated by keeping them in `deploy/unraid/` and
  documenting re-copy, not by automation.
