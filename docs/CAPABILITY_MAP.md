# Hearth — Capability Map

> **Living doc.** The full feature surface, organized and priority-tiered. Priorities are an opening proposal — the deep feature brainstorm will confirm/adjust each, and decisions land in [DECISION_LOG.md](DECISION_LOG.md).

_Last updated: 2026-06-17_

## Priority tiers

- **MVP** — required for a first genuinely useful release.
- **Core** — expected of a complete product; soon after MVP.
- **Differentiator** — the features that make Hearth special and that no FOSS competitor covers well.
- **Later** — valuable, not urgent.

## Capability areas

### A. Recipe storage & viewing
| # | Capability | Tier | Notes / open questions |
|---|---|---|---|
| A1 | Manual recipe create/edit | MVP | Storage format is the first brainstorm decision. |
| A2 | Consistent normalized format across recipes | MVP | Markdown+frontmatter vs structured vs Cooklang. |
| A3 | Mobile/tablet-friendly viewing, responsive, mobile-first | MVP | |
| A4 | Cook mode (no screen timeout, step-by-step) | Core | Wake Lock API. |
| A5 | Per-ingredient metadata (scaling behavior, dept label, etc.) | Core | Feeds scaling + shopping-list grouping. |

### B. Import pipeline
| # | Capability | Tier | Notes |
|---|---|---|---|
| B1 | Import from URL (structured-data scrape) | MVP | Deterministic baseline. |
| B2 | Import from image (OCR) | Differentiator | Deterministic OCR vs LLM provider. |
| B3 | Import from PDF | Core | Text-PDF deterministic; scanned-PDF via OCR. |
| B4 | Import from plain text / .doc | Core | Parsing heuristics ± LLM. |
| B5 | Normalize all imports to the canonical format | MVP | |

### C. Meal planning
| # | Capability | Tier | Notes |
|---|---|---|---|
| C1 | Plan meals across N days by assigning recipes to days | MVP | |
| C2 | Freshness-aware sequencing of ingredients | Differentiator | Inspired by Grocy "Due Score". |
| C3 | Leftover tracking → cover work lunches | Differentiator | |
| C4 | Frozen/stored-meal tracking as quick plan options | Differentiator | No FOSS competitor does this. |
| C5 | Generate shopping list from the plan | MVP | |

### D. Portions & scaling
| # | Capability | Tier | Notes |
|---|---|---|---|
| D1 | Scale a recipe's portions, ingredients recompute | Core | |
| D2 | Per-ingredient non-linear scaling rules ("don't double the salt") | Differentiator | No FOSS competitor does this. |
| D3 | Do something with extra portions (assign to lunch, freeze) | Differentiator | Links C3/C4. |

### E. Shopping list
| # | Capability | Tier | Notes |
|---|---|---|---|
| E1 | Free-form editable list (add snacks, adjust quantities) | MVP | |
| E2 | Checkbox / Google-Keep-style check-off while shopping | MVP | |
| E3 | Department sorting (perimeter/interior, store-aware) | Core | Mealie does single-label; we want better. |
| E4 | Printing | Core | |
| E5 | Multiple sort/organize modes | Later | |

### F. Search & organization
| # | Capability | Tier | Notes |
|---|---|---|---|
| F1 | Search by word | MVP | |
| F2 | Filter by ingredient | Core | |
| F3 | Filter by meal-of-day | Core | |
| F4 | Other filters (tags, time, cuisine, source…) | Core/Later | Define filter set in brainstorm. |

### G. Sharing & export
| # | Capability | Tier | Notes |
|---|---|---|---|
| G1 | Magic-link share (flat permission: have link = have recipe) | Core | |
| G2 | Markdown export/import between instances | Core | Backs "no lock-in". |
| G3 | PDF export (print-to-PDF acceptable) | Core | |
| G4 | Print a recipe | Core | |

### H. Savings — sale-ad integration (tiered)
| # | Capability | Tier | Notes |
|---|---|---|---|
| H1 | Feed app sale ads in supported formats | Differentiator | Lowest tier — manual/structured upload. |
| H2 | Align recipe selection to current sales | Differentiator | |
| H3 | Nudge toward sale brands / over-stock on sale | Differentiator | |
| H4 | Web-scraping / native store integration | Later | Hardest tier; feasibility TBD. |

### I. Budget & analytics
| # | Capability | Tier | Notes |
|---|---|---|---|
| I1 | Import receipts (image/PDF) | Differentiator | OCR/LLM provider. |
| I2 | Parse/itemize receipts | Differentiator | |
| I3 | Track spend over time | Differentiator | |
| I4 | Spend analysis to find savings | Differentiator | Ties I1–I3 back to planning. |

### J. Platform & cross-cutting
| # | Capability | Tier | Notes |
|---|---|---|---|
| J1 | Auth (Better Auth + optional OIDC) | MVP | |
| J2 | Household model (multi-tenant-ready) | MVP | |
| J3 | Docker one-command deploy | MVP | |
| J4 | Full data export / account portability | Core | |
| J5 | Offline-capable core (PWA) | Core | |
| J6 | Public multi-tenant instance | Later | Only "if I love the product." |

## Candidate features surfaced by research (to discuss)

Not in the original 12; flagged for the brainstorm to accept/reject:

- Pantry/stock **inventory** tracking (Grocy-style) — strongly synergistic with freshness + freezer features.
- **Barcode scanning** for stock-in/out and quick add.
- **Nutrition** display (non-prescriptive).
- **Embedded timers** in cook mode (Cooklang markup pattern).
- **App-to-app migration importers** (import from Mealie/Tandoor/Paprika) — easy onboarding for switchers.
- **Household sharing / roles** (beyond magic links) — who in the home can edit vs view.
