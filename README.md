# Hearth

> The warm center of the home kitchen — a self-hosted app that gives people back the time, money, and health that meal planning, grocery shopping, and cooking quietly drain every week.

Hearth is an open-source, self-hostable platform for recipe storage, meal planning, grocery shopping, and grocery-spend savings. It is built **non-technical-first** (anyone who buys groceries and cooks), **deterministic-first** (core flows work with zero AI), and **ownership-first** (your data is yours, fully exportable, no lock-in).

The app is called Hearth; `hearth-kitchen-assistant` is only the name of this repository.

**Status:** Self-hostable and in daily use by one household, so expect rough edges. A household can
add recipes by hand or import them from a URL, pasted text, a PDF or a photo, cook from them, plan
meals, and turn the plan into a department-grouped shopping list that works in a store with a bad
signal. Accounts are invite-only: the owner claims a fresh instance with a first-boot token and
invites family by email. Pantry, spend tracking and full data export are still to come; the
[Roadmap](docs/ROADMAP.md) has the detail.

## Quick start

You need Docker with Compose.

```sh
git clone https://github.com/charleslewisdev/hearth-kitchen-assistant.git
cd hearth-kitchen-assistant
docker compose up --build -d
docker compose logs hearth | grep setup-token
```

Open <http://localhost:8080> and create the first account with the token from the log, as
[Getting started](docs/user-guide/getting-started.md) describes. The stack binds to loopback only.

To run it for real, on a box other people can reach, read
[`deploy/unraid/README.md`](deploy/unraid/README.md). It is written for unRAID, but its proxy
section applies to any host, and you should read it before exposing an instance to the internet.

## North-star docs

Start here, in order:

1. [Product Vision](docs/PRODUCT_VISION.md) — the *why*, who it's for, principles, success criteria, non-goals.
2. [Capability Map](docs/CAPABILITY_MAP.md) — the full feature surface, organized and priority-tiered.
3. [Architecture & Tech Posture](docs/ARCHITECTURE.md) — stack, auth, multi-tenancy, AI-optional boundary.
4. [Roadmap](docs/ROADMAP.md) — phased milestones, living across sessions.
5. [Decision Log](docs/DECISION_LOG.md) — every locked decision and its rationale.
6. [Inspiration & "Borrow From" Map](docs/INSPIRATION.md) — what to learn from each FOSS project.

Per-slice design specs live in [`docs/specs/`](docs/specs/).

## Email, invitations, and the console fallback

Accounts are invite-only: the household owner invites by email, and an invitation link is the
only route to an account. Hearth sends that mail over SMTP when you set `SMTP_HOST`.

**With no SMTP configured, Hearth writes the invitation link into its own log instead of sending
it.** That is deliberate, so an instance with no mail relay can still add your family. It has one
consequence, and it is worth reading twice:

> Anyone who can read those logs can accept the invitation and join your household, which means
> reading every recipe, meal plan, and shopping list in it.

On a machine only you can log into, that is fine, and it is the intended zero-configuration
setup. It is not fine if you forward logs anywhere else, so configure SMTP before pointing a log
collector at Hearth. The startup line says which mode you are in. See [`.env.example`](.env.example)
for the SMTP settings.

## At a glance

| | |
|---|---|
| **Stack** | TypeScript full-stack — React (Vite) PWA · Fastify + tRPC · Postgres |
| **Auth** | Better Auth (embedded) + optional OIDC; Organizations = household/tenant |
| **Tenancy** | Single-household first, multi-tenant-ready by design |
| **Deploy** | `docker compose up` locally; [unRAID behind a reverse proxy](deploy/unraid/README.md) on a real box |
| **License** | [AGPL-3.0-only](LICENSE) (author retains copyright; dual-license-ready). [Third-party notices](THIRD_PARTY_NOTICES.md) |
