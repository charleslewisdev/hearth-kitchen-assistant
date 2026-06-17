# Hearth — Product Vision

> **North-star doc.** Stable across the life of the project. Change it deliberately; log changes in [DECISION_LOG.md](DECISION_LOG.md).

_Last updated: 2026-06-17_

## The human problem

Planning meals, shopping for them, and cooking is a near-universal weekly chore. For most households it is a recurring tax on **time** (hours of planning, list-making, store navigation), **money** (impulse buys, waste, missed sales, restaurant defaults when planning fails), and **health** (poor planning pushes people toward convenience food). The idea is "basic" enough to be a common programming exercise, yet no free product does it *well end to end* — the hard, integration-heavy parts (freshness-aware planning, accurate scaling, sale alignment, spend analytics) are exactly where the FOSS landscape is empty.

**Hearth exists to give that time back** — to help people eat better, waste less, spend less, and enjoy life instead of grinding through logistics. An excellent free product here is a genuine public good, especially for households trying to eat well on a budget.

## Who it's for

- **Primary: everyone who buys groceries and cooks.** Assume **non-technical**. The default experience must deliver value with no configuration and no jargon.
- **Secondary: homelab / self-hosting power users.** Respected but never the design center — they get optional depth (OIDC/SSO, advanced config, raw data access) without complicating the primary path.

## Principles

1. **Ownership & privacy first.** Your recipes and data are yours: self-hosted, fully exportable, no lock-in. We never hold data hostage.
2. **Deterministic-first, AI-optional.** Every core flow works offline with zero AI. LLM/OCR is an *enhancement* you opt into (bring your own key), never a requirement and never a silent dependency.
3. **Non-technical-friendly.** One-command install, sane defaults, value before any configuration. If a grocery shopper can't use it, it's broken.
4. **Mobile-first cooking.** The kitchen is a phone/tablet context: responsive, mobile-first, a cook mode that won't time out the screen.
5. **Save real money.** Sale alignment and budget analytics are headline differentiators, designed in from the start — not bolted on.
6. **Open source as a public good.** Built to be shared, inspected, and trusted.

## What success looks like

A non-technical user can, within ~30 minutes of first install:

- Stand up Hearth with a single command (or a hosted account, later).
- Import a week's worth of recipes from the sources they already have (URLs, photos of cookbook pages, PDFs).
- Plan meals across the coming days, accounting for leftovers and freshness.
- Walk into their store with an organized, check-off-able shopping list grouped by department.

Over time, the same user can **see their grocery spend trend down** because Hearth helped them plan around sales, waste less, and understand where their money goes.

## Non-goals (initial — YAGNI)

These are explicitly **out of scope for now** to keep focus. Revisit only with evidence of need:

- Social network / recipe-sharing community feed (sharing is point-to-point via links/export, not a social graph).
- Restaurant discovery, delivery, or reservation features.
- Prescriptive diet / calorie coaching or medical nutrition guidance.
- Nutritionist-grade macro tracking (basic nutrition display may come later; *prescription* never).
- Native mobile apps at launch (PWA first; native is a later question if PWA proves insufficient).

## The strategic bet

The FOSS landscape (see the "FOSS Meal Planning — Landscape Research" report in the author's notes) has good recipe/meal-planning apps (Mealie, Tandoor, Grocy, KitchenOwl, Cooklang) but **no single end-to-end product**, and **nothing** covers the four hardest features: per-ingredient non-linear scaling, freezer/stored-meal tracking as plan options, sale-ad integration, and receipt→budget analytics tied to planning. Hearth's bet is to **fold the best ideas from each project into one coherent app** (learning from their solutions, not copying their code) and then **own the empty quadrant** those projects never filled.
