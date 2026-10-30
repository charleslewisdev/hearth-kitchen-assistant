# Milestone C — Recipe Import: Design

> **Slice design.** Creates `packages/enrichment`, the package [D23](../DECISION_LOG.md) reserved
> in June and never built. Implements capability area **B** of the
> [Capability Map](../CAPABILITY_MAP.md).

_Authored: 2026-09-10_

## What this is for

The owner's recipes live in four places: web pages, photos of cookbook pages, PDFs, and pasted
text. Manual entry already works. This milestone makes the other four paths produce recipes
**indistinguishable from hand-entered ones**, because everything downstream - scaling, shopping
lists, search, and one day sale-matching and budget - reads the structured core, not the source.

## What the decisions already settle

Not up for re-litigation:

- **[D14]** The core stays 100% deterministic. Import gets a **deterministic baseline** - JSON-LD
  scrape, tesseract.js OCR, PDF/text heuristics - **plus an optional BYO-key LLM provider** for
  messy or handwritten input. **Image import must work in the box with no API key.** That last
  clause is a deliberate competitive position against Mealie, which requires OpenAI for it.
- **[D23]** `packages/enrichment` holds the providers. **No Python sidecar**: tesseract.js, JS
  scrapers and JS PDF parsing keep this single-language, which matters because a self-hoster
  operates it.
- **[D29]** Import is a **source-tile entry** (Paste link · Photo · PDF · Text · From an app · By
  hand) leading to a **confidence-driven review**: a fully editable draft with only low-confidence
  fields flagged amber, and the source shown side-by-side on desktop. A persistent "works offline,
  no API key" reassurance sits on the entry screen.
- **[D9, D10]** Everything normalizes to the structured core and the canonical Food entity.

## Scope decisions taken this session

1. **Build the provider interface and the deterministic baseline. Do not build an LLM provider
   yet.** D14 makes the LLM optional and makes OCR in-the-box mandatory, so tesseract.js satisfies
   the promise on its own. Shipping a provider nobody has asked for, against an API that will have
   moved by the time it is wanted, is the kind of speculative work the roadmap has avoided so far.
   The interface exists so it can be added without disturbing anything; the moment there is a real
   photo the baseline mangles, that is the evidence to build it.

2. **Enrichment runs on the server, synchronously.** All four sources produce a draft through one
   pipeline, which is what keeps the review screen source-agnostic. On a self-hosted box the server
   is the same trust domain as the browser, so there is no privacy argument for doing OCR client
   side. **This is the decision most likely to be wrong**, and the thing that would overturn it is
   measurement: if OCR on a cookbook photo takes tens of seconds on the owner's hardware, holding
   an HTTP request that long is unacceptable and the answer is a persisted `import_job` row the
   review screen polls. **The plan must measure before committing.**

3. **A draft is never written to the recipe tables until the cook accepts it.** Import produces a
   `RecipeDraft` that the review screen edits and then submits through the **existing**
   `recipe.create`. No second write path into the recipe tables, and no half-imported rows to clean
   up. This also means import inherits every guarantee `recipe.create` already has.

4. **Confidence is binary per field, not a score.** `high` or `low`. The UI distinguishes flagged
   from not flagged, and a float invites false precision that no source can actually justify -
   tesseract's per-word confidence is not commensurable with "this JSON-LD had no `recipeYield`".

5. **Ingredient lines go through the existing `parseIngredientLine`.** Every source. That is what
   makes an imported recipe indistinguishable from a typed one, and it means import gets the
   parser's whole test suite for free rather than growing a second, worse parser.

## The interface

`packages/enrichment` exports one shape, and each source is an implementation:

```
ImportSource  ->  RecipeDraft
```

A `RecipeDraft` is the fields `recipe.create` takes, each wrapped with its confidence and the
source's own words. Keeping the raw text alongside the parsed value is what lets the review screen
show the cook what it read, and what it made of it, side by side.

The LLM provider, when it exists, is a **decorator** over a baseline extractor: same input, same
output type, invoked only for fields the baseline marked `low`. That shape is what keeps D14's
"never a required dependency" true in code rather than in prose.

## The sources

**C1 — URL.** Fetch, parse schema.org **JSON-LD** `Recipe`, fall back to **microdata**, then to the
paste heuristics on the article text. JSON-LD is the high-confidence path and covers most modern
recipe sites, because they want the search-result rich card.

**C2 — paste text**, then **PDF**, then **image**. Paste heuristics find the ingredient block and
the step block by shape - short lines with leading quantities, then longer prose. PDFs with a text
layer extract deterministically and reuse the paste heuristics; a scanned PDF has no text layer and
falls through to OCR. Images go to **tesseract.js**, then the same heuristics.

The ordering is deliberate: each source falls back into the one below it, so there is exactly one
heuristic implementation and three ways to reach it.

## The security problem this milestone introduces

**URL import makes the server fetch an arbitrary attacker-chosen URL. That is server-side request
forgery, and it is the single most important thing in this milestone.**

Hearth is about to run on a home server, on a LAN, behind a router that also serves an unraid web
UI, a Postgres instance, and whatever else the owner runs. A household member pasting
`http://192.168.1.1/`, `http://127.0.0.1:5432/`, or a cloud metadata address turns Hearth into a
proxy into that network. The invite-only work means everyone with an account is trusted, which
lowers but does not remove this: a recipe URL is exactly the kind of thing someone forwards without
looking.

The baseline this needs, and the plan must treat every line as non-negotiable:

- **Resolve the hostname first and check the resolved IP**, not the string. A DNS name can point at
  `127.0.0.1`, and a blocklist of hostname patterns catches none of it.
- **Reject loopback, private, link-local, unique-local and multicast ranges**, in both IPv4 and
  IPv6. `169.254.169.254` is the cloud metadata address and deserves naming in a comment.
- **Re-check after every redirect.** A public URL that 302s to a private one defeats a check done
  only on the input. Cap redirects.
- **`http` and `https` only.** `file://`, `gopher://` and friends are not recipe sources.
- **Cap the response size and set a timeout**, so a slow loris or a 2 GB response cannot hold a
  worker.
- **The fetch runs with no ambient credentials.** No cookies, no auth headers, no forwarding of
  anything from the caller's request.

**A DNS-rebinding gap remains** even with all of that: the address checked and the address connected
to can differ. Closing it properly means resolving once and connecting to the pinned IP with the
`Host` header set. State whether that is done or accepted, and do not let a comment imply it is
handled if it is not.

## What can go wrong with the other sources

- **PDF and image parsing are attack surface too**, in a way pasted text is not. Cap the file size,
  cap page count, and treat a malformed file as an expected input rather than an exception that
  reaches a 500.
- **OCR is slow and CPU-hungry.** It shares a box with Postgres and the app. Bound its concurrency;
  one import must not make the household's shopping list unresponsive.
- **D38 applies throughout.** A recipe title, an ingredient line and a source URL are all user
  content, and an import pipeline is unusually tempting to debug by logging the thing it just
  parsed. Ids only.

## Testing posture

Per **D11**, the deterministic core is test-first with thorough unit suites and **no network**.
Fixtures are checked-in HTML, PDF and image files, invented but in the markup shapes real sites emit,
so the suite never depends on a third party being up or on their markup this week. Every SSRF rule
gets a test that fails when the rule is removed, including the post-redirect re-check, which is the
one most easily written so that it passes vacuously.

## Explicitly out of scope

Each defers additively:

- The LLM provider itself (scope decision 1).
- **App-to-app importers** (Mealie, Tandoor, Paprika) - flagged in the Capability Map as a switcher
  onramp, but this milestone is about the owner's own sources.
- Bulk or folder import. One recipe at a time until one at a time is pleasant.
- Re-import or sync from a source URL. Import is a one-way normalization, not a subscription.
- Receipt parsing, which reuses this interface but belongs to P7.
