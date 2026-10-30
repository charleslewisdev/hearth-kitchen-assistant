# Hearth — Inspiration & "Borrow From" Map

> What to learn from each FOSS project in this space. **Borrow patterns and ideas — write our own implementation.** We do not copy code (especially from AGPL projects); we study their solutions and build Hearth's own, informed versions. See [Decision 1](DECISION_LOG.md).

_Last updated: 2026-06-17_

## How to read this

Two columns of value per project: **Pattern/idea to borrow** (architecture, data model, behavior) and **UI/UX inspiration** (what feels good to use). The UI column feeds the design sessions.

---

## Mealie — the all-rounder

**Borrow (pattern/idea):**
- Multi-strategy recipe scraper: try structured data (Schema.org/JSON-LD) first, fall back to heuristics, then optional AI. → Hearth's import pipeline mirrors this layering (Decision 14).
- Per-food **Labels** driving shopping-list sections. → We extend this: Hearth allows a food to carry a department *and* a customizable household ordering (improves on Mealie's one-label-per-food limit).
- "Plan rules" (auto-suggest recipes by tag/category/meal-type/day). → A nice later enhancement for plan generation.

**UI/UX inspiration:**
- Clean weekly **meal-planner calendar** with drag-and-drop. Study its layout for our planner.
- Recipe page readability; the overall "approachable, not cluttered" feel is a good north star for non-technical users.

**Avoid / improve on:** image import now requires an OpenAI key — Hearth keeps a no-key local OCR baseline. One-label-per-food granularity limit.

---

## Tandoor — the import/power-user benchmark

**Borrow (pattern/idea):**
- **Food + Unit + Supermarket-category** entity model and the on-the-fly food creation with later **merge**. → This is essentially Hearth's canonical Food model (Decision 10); Tandoor proves it works.
- Breadth of **app-to-app import formats** (Paprika, Mealie, Nextcloud, RecipeSage, Mela, etc.). → Hearth should ship importers for the big ones to make switching painless (onboarding lever).
- Multiple meals per day in the plan; shopping list from plan *or* recipe.

**UI/UX inspiration:**
- Powerful but dense. Good reference for the *power-user* surfaces (food management, merge tools) that we keep out of the default path.

**Avoid / improve on:** density/complexity can overwhelm non-technical users — Hearth defaults must be simpler; advanced tools tucked away.

---

## Grocy — the inventory/freshness brain

**Borrow (pattern/idea):**
- **"Due Score"** — surface recipes that use up soon-to-expire stock. → Hearth's freshness advisories (Decision 15) apply this idea to *cook order* and the portion ledger.
- Stock/inventory model with shelf-life. → Informs the lightweight opt-in pantry (Decision 20) and per-Food `shelfLifeDays`.
- One-click "add missing ingredients to shopping list."

**UI/UX inspiration:**
- The at-a-glance stock/availability indicators are a good model for "what do I have / what's expiring."

**Avoid / improve on:** Grocy is heavy and power-user-first (barcode, exact stock). Hearth keeps inventory optional and light by default.

---

## KitchenOwl — the mobile-first shopper

**Borrow (pattern/idea):**
- Tight **meal-plan ↔ shopping-list sync** and "add recipe directly to list."
- Lightweight, focused scope — does a few things smoothly.

**UI/UX inspiration:**
- **Mobile-first** Flutter UX is the strongest reference for our PWA shopping + cooking surfaces. Study its check-off interaction and on-the-go ergonomics.

**Avoid / improve on:** import is web-scrape only; export is JSON not Markdown. Hearth's import breadth and Markdown round-trip are differentiators.

---

## Cooklang — the format/parsing toolchain

**Borrow (pattern/idea):**
- Inline ingredient/timer markup (`@onion{1}`, `~{10%min}`) that yields text **and** structure. → Support **Cooklang as an import/export format** (Decision 9); consider its markup for our cook-mode timers.
- URL/text/image import normalization flow.

**UI/UX inspiration:**
- **Cook mode** with embedded, tappable timers parsed from steps. Excellent model for our no-screen-timeout cooking view.

**Avoid / improve on:** Cooklang as *canonical storage* can't natively express non-linear scaling or department/sale layers — which is exactly why Hearth stores structured and treats `.cook` as interchange.

---

## Receipt Wrangler — the receipt pipeline

**Borrow (pattern/idea):**
- OCR/AI receipt scanning with a **local Tesseract default + optional LLM** providers. → Directly mirrors Hearth's receipt enrichment approach (Decision 19).
- Email/web upload ingestion paths.

**UI/UX inspiration:**
- Receipt review/correction UI (confirm parsed line items) — we need this for the learned per-store Food alias mapping.

---

## Paprika & commercial apps (reference only, closed-source)

**Borrow (idea, from observed behavior — not code):**
- Frictionless **single-field recipe capture** (paste a URL, get a clean recipe) sets the UX bar for import.
- Pantry + grocery + recipe in one smooth consumer package — the integrated feel Hearth is aiming for, but open and self-hosted.

---

## Synthesis: Hearth's distinct position

Hearth = **Mealie's approachability** + **Tandoor's Food model & import breadth** + **Grocy's freshness/inventory brain** + **KitchenOwl's mobile shopping ergonomics** + **Cooklang's parse-friendly format & cook mode** + **Receipt Wrangler's receipt pipeline** — unified into one non-technical-first product, and then extended into the **empty quadrant nobody covers**: per-ingredient scaling, the portion ledger (leftovers/freezer/freshness), sale-aligned planning, and the receipt→budget→price-aware-planning loop.
