# Hearth

> The warm center of the home kitchen — a self-hosted app that gives people back the time, money, and health that meal planning, grocery shopping, and cooking quietly drain every week.

Hearth is an open-source, self-hostable platform for recipe storage, meal planning, grocery shopping, and grocery-spend savings. It is built **non-technical-first** (anyone who buys groceries and cooks), **deterministic-first** (core flows work with zero AI), and **ownership-first** (your data is yours, fully exportable, no lock-in).

**Status:** Planning / foundation-setting. No application code yet.

## North-star docs

Start here, in order:

1. [Product Vision](docs/PRODUCT_VISION.md) — the *why*, who it's for, principles, success criteria, non-goals.
2. [Capability Map](docs/CAPABILITY_MAP.md) — the full feature surface, organized and priority-tiered.
3. [Architecture & Tech Posture](docs/ARCHITECTURE.md) — stack, auth, multi-tenancy, AI-optional boundary.
4. [Roadmap](docs/ROADMAP.md) — phased milestones, living across sessions.
5. [Decision Log](docs/DECISION_LOG.md) — every locked decision and its rationale.
6. [Inspiration & "Borrow From" Map](docs/INSPIRATION.md) — what to learn from each FOSS project.

Per-slice design specs live in [`docs/superpowers/specs/`](docs/superpowers/specs/).

## At a glance

| | |
|---|---|
| **Stack** | TypeScript full-stack — React (Vite) PWA · Fastify + tRPC · Postgres |
| **Auth** | Better Auth (embedded) + optional OIDC; Organizations = household/tenant |
| **Tenancy** | Single-household first, multi-tenant-ready by design |
| **Deploy** | `docker compose up` (app + Postgres) |
| **License** | AGPL-3.0 (author retains copyright; dual-license-ready) |
