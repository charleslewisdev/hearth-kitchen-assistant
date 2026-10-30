# Hearth — Capability Map

> **Living doc.** The full feature surface, organized and priority-tiered. Priorities are an opening proposal — the deep feature brainstorm will confirm/adjust each, and decisions land in [DECISION_LOG.md](DECISION_LOG.md).

_Last updated: 2026-09-10 (P1 and P2 complete: cook mode, search, and all four import sources)_

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
| A4 | Cook mode (no screen timeout, step-by-step) | Core | **✅ 2026-09-10.** Focus screen, Wake Lock (degrades silently where absent), tap-to-check, stacking timer tray with an audible alarm, ingredient peek at scaled servings. Cannot reach a cook whose tab is backgrounded without a notification permission prompt, deliberately not added. |
| A5 | Per-ingredient metadata (scaling behavior, dept label, etc.) | Core | Feeds scaling + shopping-list grouping. |

### B. Import pipeline
| # | Capability | Tier | Notes |
|---|---|---|---|
| B1 | Import from URL (structured-data scrape) | MVP | **✅ 2026-09-10.** schema.org JSON-LD, then microdata, then B4's heuristics over the article text, all over an SSRF-safe fetcher: resolved-IP checks in IPv4 and IPv6, re-checked after every redirect, DNS rebinding closed by pinning the checked address. Produces a draft the review screen edits and saves through the existing `recipe.create`, so nothing is written until the cook accepts it. A page with none of the three rungs on it is refused rather than guessed at. The saved recipe keeps the URL it came from. |
| B2 | Import from image (OCR) | Differentiator | **✅ 2026-09-10.** tesseract.js, with the English model vendored as a normal dependency: no API key, and nothing fetched. That is tested rather than asserted - a child process preloaded to refuse every socket and every name lookup recognises the photo fixture anyway. About 900ms for a 1700x2200 photograph on this machine, one recognition at a time process-wide, and the browser reduces a phone photo to a 2200px long edge before uploading it. No LLM provider was built (scope decision 1): the baseline reads a rotated, unevenly lit, blurred, JPEG-compressed page without one. |
| B3 | Import from PDF | Core | **✅ 2026-09-10.** The text layer is rebuilt from pdfjs text items and their positions, because `unpdf`'s own `extractText` returns the whole document with no line break in it and the heuristics find blocks by line shape. Byte and page caps; malformed, truncated and empty files are answers rather than exceptions. **A scanned PDF is OCR'd (2026-09-24)**: with no text layer, each page's largest embedded image is taken from pdfjs's operator list (no canvas, which J0 excluded), turned into a greyscale PNG by a small in-package encoder, and read by the photo path's OCR. Up to 4 pages; a PDF with neither text nor a page-sized image still sends the cook to Photo. |
| B4 | Import from plain text | Core | **✅ 2026-09-10.** Ingredient and step blocks found by shape - a run of amount-leading lines, then prose - with headings used where a source names them. `parseIngredientLine` is what decides whether a line leads with an amount, so there is one amount vocabulary rather than two. Everything it produces is low confidence by definition, which is what puts it in front of the cook. **`.doc` is not supported and is not planned**: pasting the text works today, and neither `.doc` nor `.docx` is a format worth a parser for this. |
| B5 | Normalize all imports to the canonical format | MVP | **✅ 2026-09-10.** All four sources produce one `RecipeDraft`, and the review screen saves it through the existing `recipe.create` - so there is one write path into the recipe tables, one ingredient parser, and no half-imported rows. |

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
| F1 | Search by word | MVP | **✅ 2026-09-10.** Postgres FTS via `websearch_to_tsquery`, plus a relational tag match, since a generated column cannot reach `recipe_tags`. See [D43](DECISION_LOG.md): RLS forecloses the GIN index, accepted. |
| F2 | Filter by ingredient | Core | **✅ 2026-09-10.** D30's `contains {ingredient}` token, over the canonical Food entity. |
| F3 | Filter by meal-of-day | Core | **✅ 2026-09-10.** Quick chips. |
| F4 | Other filters (tags, time, cuisine, source…) | Core/Later | **Tags ✅ 2026-09-10** with counts behind the chips. Time, cuisine and source deferred per D16 as additive predicates. |

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
