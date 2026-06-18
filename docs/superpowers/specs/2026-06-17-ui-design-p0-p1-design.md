# Hearth — UI/UX Design Spec: Key Screens (P0/P1)

> **Design spec** for the five highest-priority screens, plus the shared design
> system and app shell. Produced in the 2026-06-17 visual brainstorm session.
> Decisions here are logged as Decisions 24–30 in [DECISION_LOG.md](../../DECISION_LOG.md).
> Implementation plans are derived from this spec via the writing-plans workflow.

_Last updated: 2026-06-17_

## Scope

This spec covers the **visual design language**, the **responsive app shell**, and
the layout/interaction design of the five priority screens:

1. Recipe view + cook mode (P1)
2. Meal planner (P3)
3. Shopping list (P3)
4. Import flow (P2)
5. Recipe library / search + filters (P1)

It is a **design** spec (layout, interaction, states), not a component-library or
token-value spec — exact hex ramps, spacing scales, and component APIs are settled
during implementation, constrained by the principles below. Screens were validated
as interactive HTML mockups in the visual companion (`.superpowers/brainstorm/`,
git-ignored, ephemeral).

## Design principles (applied throughout)

These follow from [PRODUCT_VISION.md](../../PRODUCT_VISION.md):

- **Mobile-first.** Every screen is designed for a phone first, then adapted up. The
  responsive rule is uniform: **single column + bottom tab bar on phone → content +
  left sidebar rail on desktop.** Same destinations, same primary action, rotated.
- **Non-technical-first.** Prefer explicit and discoverable over clever and minimal.
  Big tap targets, plain language, value before configuration. No jargon.
- **Deterministic-first, AI-optional, visible.** Where AI is optional (import,
  receipts), the UI states plainly that things work offline with no key, and treats
  AI as a sharpening enhancement.
- **Calm by default, depth on tap.** Smart defaults are invisible (scaling rules,
  Food→department mapping); power lives one tap deeper (Filters sheet, per-ingredient
  scaling edit, food merge), never crowding the primary path.

---

## 0. Design system

### Theming = semantic design tokens

All color, spacing, radius, and typographic values are exposed as **semantic CSS
custom properties** (e.g. `--color-surface`, `--color-text`, `--color-text-muted`,
`--color-accent`, `--color-accent-soft`, `--color-border`, `--radius`). Components
**never** reference raw hex — only tokens.

- **A theme is a token set.** The default light theme is **"Fresh Market"**. Additional
  themes (e.g. "Warm Hearth", "Cozy Editorial" from the brainstorm) ship later as
  alternate token sets with **zero component changes**.
- **Dark mode is a parallel token set**, selected by `data-theme` on the root.
  Respects `prefers-color-scheme` by default with a manual override in Settings
  (light / dark / system).
- This is a P0 architectural commitment (cheap now, painful to retrofit) even though
  only the light Fresh Market theme ships first.

### Fresh Market — default theme (reference values)

Indicative, not binding — the token *roles* are what matter:

| Role | Token | Light value (ref) |
|---|---|---|
| App background | `--color-bg` | `#F7F9F8` |
| Surface / card | `--color-surface` | `#FFFFFF` |
| Subtle surface | `--color-surface-2` | `#F0F4F2` |
| Border | `--color-border` | `#E3E8E5` |
| Text | `--color-text` | `#1F2937` |
| Muted text | `--color-text-muted` | `#6B7280` |
| Accent (primary) | `--color-accent` | `#2E9E5B` |
| Accent soft (bg) | `--color-accent-soft` | `#E6F4EC` |
| Accent soft (text) | `--color-accent-soft-text` | `#1D7A45` |

**Semantic status colors** (reused across screens — keep consistent):

- **Leftover** = amber (`--color-leftover`, bg `#FBEFD9` / text `#9A6212`)
- **Frozen** = blue (`--color-frozen`, bg `#E3EEF8` / text `#2C6CA8`)
- **Cook fresh** = accent green
- **Needs attention / low-confidence** = warm amber flag (bg `#FCF3DD` / border
  `#EBD08A` / text `#9A6212`) — used in import review and reused later in receipt review.

**Typography:** clean modern sans throughout (system sans is acceptable for v1).
Recipe titles are weighted (800), body copy comfortable for kitchen reading.

### Shared components

Bottom-sheet (slot picker, ingredient peek), card, pill/chip, segmented toggle,
stepper, checkbox-row, department/section header, progress bar, sticky CTA bar, sticky
running-timer tray. Built once, reused across screens.

---

## 1. App shell & navigation

**Mobile:** fixed **bottom tab bar** with four destinations — **Recipes · Plan ·
Shop · More** — and a **floating "+"** for Add/Import (the headline onboarding action,
deliberately impossible to miss). "More" houses Pantry, Budget, Sales, Settings as
those features land.

**Desktop:** the bottom bar becomes a **persistent left sidebar rail** — same four
destinations, brand at top, a full-width **"+ Add / Import"** button at the top of the
rail, household/account at the bottom. Content fills the remaining width.

**Cook mode is never a tab** — it is a full-screen mode launched from a recipe and
exited back to it.

**Responsive rule (universal):** phone = one column + bottom bar; desktop = content +
left rail. Every screen below follows this.

---

## 2. Recipe view + cook mode

### 2a. Recipe view (segmented)

Mobile-first, single recipe. Structure:

- **Hero image** with back + save (favorite) affordances.
- **Title + source attribution** (e.g. "Imported from cooking.nytimes.com").
- **Meta pills:** time, servings, tags (meal-of-day, dietary).
- **Servings scaler** — prominent `− N +` stepper. Changing it recomputes all
  quantities. Per-ingredient non-linear rules (Decision 12) are **invisible**: "to
  taste" items never scale, sublinear items scale correctly — the user only ever sees
  right numbers.
- **Segmented toggle: Ingredients ⇄ Steps.** Each is one tap; on long recipes the user
  never scrolls past 20 ingredients to recheck a step. (Chosen over single-scroll.)
- **Sticky bottom bar:** a quick-action row (Plan · List · Share · Edit) above a
  full-width primary **▶ Start Cooking** button.
- **Inline step timers:** durations in step text render as tappable chips — the bridge
  into cook mode's timer system.

**Desktop:** two-column — media/meta/ingredients left, steps right — but the segmented
toggle and scaler behave identically; nothing exclusive to one breakpoint.

### 2b. Cook mode (single-scroll, Focus)

Full-screen, launched from Start Cooking. Optimized for messy hands at arm's length.

- **Screen stays on** via the Wake Lock API, with a visible **"🔆 Screen on"**
  indicator. Released on exit.
- **Single-scroll, Focus styling:** all steps in one scroll, but the **current step is
  enlarged and tinted**; completed steps dim and strike; upcoming steps preview small.
  Answers "where am I?" in a half-second glance without losing scrollability.
- **Tap a step** to mark it done (advances the visual "current").
- **Tappable timers:** tapping a step's `⏱ 15:00` chip starts a timer that **docks into
  a sticky dark running-timer tray** at the bottom. Multiple timers stack ("+2 more");
  a timer rings even after its step scrolls off screen. Tray timers support pause/stop.
- **Ingredients peek:** a sticky **"🧺 Ingredients (n)"** button opens a bottom-sheet
  showing the **scaled** amounts, so the user never leaves cook mode to recheck a quantity.
- **Exit (✕)** returns to the recipe view.

---

## 3. Meal planner

### 3a. Week view

- **Mobile — week agenda:** all 7 days as **stacked day cards** the user scrolls. Each
  card shows its B/L/D slots; today is highlighted. Seeing the whole week's shape (gaps,
  balance) is the point of planning, so the full week is visible by scroll. (Chosen over
  a single-day-focus layout.)
- **Desktop — 7-column grid:** columns = days, rows = meals. **Drag a meal** to move it
  between slots/days. Today's column is outlined.
- **Meal slots:** **Breakfast / Lunch / Dinner by default**, household-configurable
  later (add Snacks, rename). Not configurable in MVP.

### 3b. Source coding (the portion-ledger payoff)

A filled slot is **color-coded by source everywhere it appears** (agenda, grid, and any
summary): **● Cook fresh** (green) · **● Leftover** (amber) · **● Frozen** (blue), via
the semantic status tokens. This makes Decision 15's portion ledger *visible*: Monday's
soup surfaces as a Tuesday-lunch "Leftover" automatically; a frozen meal is a one-tap
plan option.

### 3c. Slot picker

Tapping an empty slot opens a bottom-sheet: **"Add to {Day} · {Meal}"**. Ordering is
deliberate and is the differentiator:

1. **🧺 Use what you have** — available **leftovers** and **frozen** meals first, each
   with portion counts from the ledger (e.g. "From Mon dinner · 2 portions").
2. **📖 From your recipes** — searchable recipe library below.

This nudges eat-what-you-have before cook-something-new (waste ↓, spend ↓).

### 3d. Generate shopping list

A sticky **"🛒 Build shopping list"** action turns the week's plan into the shopping
list (screen 3), aggregating quantities via the shared domain package.

---

## 4. Shopping list

In-store experience: one-handed, big targets, fast check-off.

- **Department-grouped** sections (perimeter/interior default; Foods map to departments
  per Decision 17). **Drag a section header (≡) to reorder** departments to match the
  user's store; order persists per household.
- **Aggregated quantities** from the shared package — "onion ×1" (soup) + "onion ×2"
  (tacos) → **"Onions ×3"**, with a subtle provenance subtext ("soup + tacos").
- **Keep-style check-off**, **persisted server-side and synced live** across devices
  (shared household list).
- **Check-off behavior — "sink away" (default):** checked items drop into a collapsed
  **"Done (n)"** group at the bottom so the active list **shrinks as you shop**. A
  per-household setting offers **"check in place"** (dim + strike, stays in section) for
  users who prefer no reflow. Default = sink away.
- **Free-form add bar** ("＋ Add an item…") at the top; active list = plan-generated +
  free-form adds.
- **Progress** indicator ("8 of 20 · 12 to go") and a **print** action.

**Desktop:** left rail + a wider single/two-column list; identical behavior.

---

## 5. Import flow

A mini-flow: **enter source → parse → review & fix → save.** Headline onboarding moment
and a competitive edge (image import works in-the-box, no API key — Decision 14).

### 5a. Entry — source tiles

A **grid of labelled source tiles**, explicit and discoverable (chosen over a single
auto-detecting box): **Paste a link · Take a photo · Upload PDF · Paste text · From an
app (Mealie/Paprika…) · Enter by hand.** Each tile carries a one-line hint. The "Paste a
link" tile **expands inline into a fast paste-and-go field** so power users keep the
quick path. App-migration is given a visible home (onboarding lever).

A persistent reassurance line: **"🔒 Works offline, no API key. Add an AI key in
settings for messy handwriting & photos."**

### 5b. Parse

Deterministic baseline runs (JSON-LD scrape for URLs, tesseract.js OCR for images,
PDF/text heuristics). If a household has configured an optional LLM/vision provider, it
sharpens messy inputs. Progress is shown; the path never blocks on AI.

### 5c. Review & fix — confidence-driven

The parsed recipe returns **fully editable**, but correction effort is proportional to
input quality:

- A banner sets the tone: **"We pulled this in. 2 things to double-check are
  highlighted — everything else looks good."**
- Fields the parser is **unsure about are flagged amber** ("tsp or Tbsp?", "add
  amount"); confident fields stay calm with a quiet ✓.
- Title, image, meta (time/servings/yield), ingredients (structured qty/unit/food), and
  steps are all editable in place.
- **Food→department auto-mapping (Decision 10) happens invisibly** in the background; no
  catalog UI on the primary path.
- A clean URL import is effectively **one tap to Save**; a messy photo asks for a few
  fixes. The amber-flag language is reused later for receipt review (Decision 19).

**Desktop:** the **original source (photo/PDF/page) shows side-by-side** with the parsed
form, so photo imports verify against the original at a glance.

---

## 6. Recipe library / search + filters

The "Recipes" tab — effectively the home screen.

- **2-up card grid** (more columns on desktop), each card: image, title, time, meal.
- **Search over Postgres full-text** (Decision 16) — no external search service.
- **Quick filter chips** along the top for common filters (meal-of-day, Quick,
  dietary), one-tap, no typing — the approachable default for non-technical users. Active
  filters show as removable chips with a result count.
- **Filters sheet** behind a **⚙ Filters** button for the fuller set: by ingredient,
  meal-of-day, tag/category (MVP set), with time/cuisine/dietary/source deferred to Core.
- **Smart-search tokens (merged in):** typing in the search bar offers suggestions that
  become **removable filter tokens** — notably **"contains {ingredient}"**, which leans on
  the canonical Food model (the differentiator) — alongside live recipe-title matches and
  tag suggestions. This gives the no-typing browse path *and* the powerful ingredient
  path from one surface.

---

## 7. Cross-cutting

- **Responsive:** the single rule in §1 governs all five screens; no screen has
  breakpoint-exclusive capability.
- **Offline (PWA):** recipe view, cook mode, and the shopping list must function offline
  (service worker + local cache), syncing on reconnect. Cook mode especially must never
  depend on connectivity.
- **Empty / first-run states:** every screen needs a designed empty state that points to
  the primary action (empty library → Import; empty plan → add a meal; empty list → plan
  a week or add an item). First-run should route a new user toward Import.
- **Accessibility:** sufficient contrast in both themes, large touch targets (kitchen +
  store contexts), respects reduced-motion, screen-reader labels on icon-only controls.

## 8. Open questions (deferred to implementation / later specs)

- Exact token ramps, spacing scale, and dark-theme values.
- Drag-and-drop library/interaction details (touch long-press vs handle) for planner and
  shopping-list reorder.
- Snacks / configurable meal rows UI (post-MVP).
- Multi-store named layouts for shopping-list department order (deferred per Decision 17).
- Receipt-review screen (reuses the amber-confidence pattern) — its own spec at P7.

## 9. Mockup reference

Interactive HTML mockups for all five screens (plus visual direction, nav shell, and
desktop adaptations) were produced and validated in the visual companion under
`.superpowers/brainstorm/` (git-ignored). This spec is the durable record; regenerate
mockups from it as needed during implementation.
