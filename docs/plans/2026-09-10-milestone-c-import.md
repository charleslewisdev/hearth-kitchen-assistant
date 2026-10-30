# Milestone C — Recipe Import: Implementation Plan

**Goal:** A cook can import a recipe from a URL, a photo, a PDF or pasted text, and the result is indistinguishable from one typed by hand.

**Architecture:** A new `packages/enrichment` with one interface and four sources that fall back into each other, so there is exactly one heuristic implementation reached three ways. Every source produces a `RecipeDraft`; the review screen is source-agnostic; the draft is saved through the **existing** `recipe.create`, so import gets no second write path into the recipe tables.

**Tech Stack:** schema.org JSON-LD + microdata · tesseract.js (OCR, no API key) · a JS PDF text extractor · the existing `parseIngredientLine` from `packages/shared`.

**Design:** [Milestone C design](../specs/2026-09-10-milestone-c-import-design.md). Decisions **D9/D10** (structured core, canonical Food), **D14** (deterministic baseline, optional BYO-key LLM, **image import works with no API key**), **D23** (`packages/enrichment`, no Python sidecar), **D29** (source tiles, confidence-driven review).

---

## Read this before Task 1

**1. Verify every library before planning against it.** The previous milestone shipped six planning errors that came from writing down library behaviour without running it - a dependency in the wrong section, a Caddy directive that does not parse where it was put, a header that turned out not to do what the comment said. **Task J0 is a spike**: confirm the PDF extractor and tesseract.js versions, that they run under Node in this workspace, and what they actually return. If something does not work as this plan assumes, stop and say so rather than building around it.

**2. SSRF is the real risk in this milestone, and it is not theoretical.** URL import makes the server fetch a URL a person pasted. That server also runs Postgres and sits on a LAN with an unraid web UI on it. Every rule in the design's security section is non-negotiable, and **each one needs a test that fails when the rule is removed**. The post-redirect re-check is the one most easily written so that it passes vacuously: a test whose fixture never redirects proves nothing about redirect handling.

**3. Everything goes through `parseIngredientLine`.** Every source, no exceptions. That is what makes imported recipes indistinguishable from typed ones and what stops a second, worse parser growing inside the import path.

**4. A draft is not a recipe.** Import never writes to `recipe`, `recipe_ingredient`, `recipe_step` or `recipe_tags`. It produces a draft, the review screen edits it, and `recipe.create` saves it. No half-imported rows, and import inherits `recipe.create`'s existing guarantees for free.

**5. D38 applies hard here.** A recipe title, an ingredient line and a source URL are all user content, and an import pipeline is the most tempting place in the codebase to debug by logging the thing it just parsed. Ids only. The tRPC middleware already logs procedure and duration; do not add the input.

**Repo conventions:** tests beside the code; server tests hit real Postgres in a single fork and reset via `resetDb()`; web tests follow `ShoppingList.test.tsx`; `noUncheckedIndexedAccess` is on; comments explain *why* and must be exact. No em-dashes. Commit per task. Postgres on 5433.

---

## Phase J — the interface and URL import (C1)

### Task J0: spike the dependencies ✅ DONE 2026-09-10 — results below

> **Measured, not read. These numbers decide Phase K's shape, so they live here rather than in a
> transcript.**
>
> **OCR (tesseract.js 5.1.1, Node 22, synthetic cookbook page with lighting gradient, rotation,
> blur and JPEG noise):**
>
> | case | median |
> |---|---|
> | 1700x2200, SIMD | 722 ms |
> | **3024x4032 (12 MP phone photo), SIMD** | **1176 ms** |
> | 12 MP pinned to one core | 1201 ms - **unchanged, so OCR is single-threaded** |
> | 12 MP, non-SIMD WASM core (worst case) | **3016 ms** |
>
> Worker init 96-226 ms. **Decision: synchronous enrichment stands; do NOT build `import_job`.**
> Even the pessimistic path is ~3 s, and a home server 4x slower lands near 12 s worst case with
> the realistic path at ~1.2 s. The design flagged this as the choice most likely to be wrong; it
> survived measurement.
>
> Because OCR is **single-threaded**, K3's concurrency bound is about stopping N simultaneous
> imports from eating N cores, not about any one import being slow. A semaphore of 1-2 suffices.
> Downscale uploads first: 12 MP costs 1.6x a 3.7 MP image for identical text.
>
> **PDF: use `unpdf` 0.12.2. Do NOT also install `pdfjs-dist`.** Both together break everything -
> `The API version "4.10.38" does not match the Worker version "4.6.82"`, because unpdf bundles its
> own pdfjs and pnpm's layout lets it become the worker. unpdf needs no worker config, no `canvas`,
> no font path. Text-layer PDF: 576 chars in 39 ms. Scanned PDF: **0 chars**, which is the
> fall-through-to-OCR signal. Malformed: a catchable `InvalidPDFException`.
>
> **tesseract language data is vendorable and offline operation is proven.** Only `eng.traineddata`
> fetches; the core WASM ships inside `tesseract.js-core`. Add **`@tesseract.js-data/eng` as a
> normal `dependency`** (not devDependency - that is the pruned-image trap) and point `langPath` at
> its directory with `gzip: true`. Proven by sabotaging `node-fetch` so any network call throws:
> with an empty cache and no `langPath` it **fails**; with `langPath` it **succeeds**. The first
> attempt at that test passed for the wrong reason, a leftover cache, which is the vacuous-test
> trap this repo keeps finding.
>
> **A tesseract language-load failure surfaces as an uncaught exception in the worker thread**, not
> a rejected promise. Wrap it.

Not committed as product code. Confirm, by running them:

- Which PDF text extractor works under Node in this pnpm workspace, and what it returns for a text-layer PDF and for a scanned one (the second should yield little or nothing, which is the signal to fall through to OCR).
- That tesseract.js runs under Node here, where its language data comes from, whether that download can be vendored so a self-hosted box works offline, and **how long a realistic cookbook-page photo takes on this hardware**.

**That timing decides scope decision 2 of the design.** If OCR is a few seconds, synchronous is fine. If it is tens of seconds, holding an HTTP request is not acceptable and the answer is a persisted `import_job` row the review screen polls - which is a new household-scoped table, so it needs RLS and the guard test will enforce that. **Report the number and the recommendation before building either.**

### Task J1: `packages/enrichment` and the draft type

**Files:** create `packages/enrichment/` (package.json, tsconfig, src) · `packages/shared` stays untouched

The `RecipeDraft` shape: the fields `recipe.create` takes, each carrying its value, a binary confidence (`high` | `low`), and the source's own words for that field. Keeping the raw text alongside the parsed value is what lets the review screen show the cook what it read and what it made of it.

Wire the package into the workspace, `tsconfig.base.json` paths, and vitest. Add it to CI the same way `packages/shared` is.

**Tests:** the draft type round-trips through `recipe.create`'s input schema, so a drift between them is a compile error rather than a runtime surprise.

### Task J2: the SSRF-safe fetcher

**Files:** create `packages/enrichment/src/fetch-page.ts` and its test

This is the security core of the milestone. From the design, all mandatory:

- Resolve the hostname and check the **resolved IP**, not the string.
- Reject loopback, private, link-local, unique-local and multicast, in **both** IPv4 and IPv6. Name `169.254.169.254` in a comment as the cloud metadata address.
- Re-check **after every redirect**; cap the redirect count.
- `http` and `https` only.
- Cap response size; set a timeout.
- No cookies, no auth headers, nothing forwarded from the caller's request.

**Then state plainly, in a comment, whether the DNS-rebinding gap is closed** (resolve once, connect to the pinned IP with the `Host` header set) **or accepted.** Do not let a comment imply it is handled if it is not - that exact failure has been corrected five times in this repo.

**Tests, each failing when its rule is removed:** every blocked range, IPv4 and IPv6; a public URL that redirects to a private one; a redirect chain longer than the cap; a non-http scheme; an over-large response; a timeout. **No network** - bind a local server for the redirect and size cases.

### Task J3: JSON-LD and microdata extraction

**Files:** create `packages/enrichment/src/from-html.ts` and its test · fixtures under `packages/enrichment/test/fixtures/`

Parse schema.org **JSON-LD** `Recipe` first, fall back to **microdata**, then to Task K1's paste heuristics on the article text. Handle the shapes real sites actually emit: `@graph` arrays, a `Recipe` nested among other types, `recipeIngredient` as string or array, `recipeInstructions` as strings, `HowToStep` objects, or a single blob needing splitting.

Confidence: `high` for what JSON-LD gave, `low` for anything derived or absent.

**Fixtures are checked-in HTML saved from real recipe sites.** The suite must never touch the network, and must not depend on someone's markup this week.

### Task J4: the `import` router

**Files:** create `apps/server/src/trpc/routers/import.ts` and its test · modify `routers/index.ts`

`import.fromUrl({ url })` → `RecipeDraft`. `protectedProcedure`, household-scoped. Reuse `MAX_SEARCH_LENGTH`'s sibling for the URL cap rather than adding a second constant.

Failures a cook will actually hit - a blocked address, a page with no recipe on it, a timeout - are **expected inputs**, not exceptions. Each gets a distinct, plain message. None of them is a 500, and none reaches Fastify's error handler.

### Task J5: import entry and review UI

**Files:** create `apps/web/src/routes/Import.tsx`, `ImportReview.tsx`, CSS modules and tests · modify `App.tsx`

Per **D29**: source tiles (Paste link · Photo · PDF · Text · By hand), the link tile expanding inline to a paste field, and a persistent **"works offline, no API key"** reassurance. Review returns a fully editable draft with **only low-confidence fields flagged amber**; the Food-to-department mapping stays invisible. Desktop shows the source side by side.

Saving calls the existing `recipe.create`. Reuse `servingsFromUrl` from `CookMode.tsx` as the validator pattern if servings ever ride a URL here - not bare `Number()`.

**Tests:** a tile opens its input; a low-confidence field is flagged and a high-confidence one is not; editing a flagged field clears the flag; a blocked URL shows its message rather than a stack trace; save produces exactly one `recipe.create` call.

---

## Phase K — paste, PDF and image (C2)

### Task K1: paste heuristics ✅ DONE 2026-09-10

**Files:** create `packages/enrichment/src/from-text.ts` and its test

Find the ingredient block and the step block by shape: short lines with leading quantities, then longer prose. Handle a heading that names each block, a numbered step list, and a recipe with no headings at all. Everything found goes through `parseIngredientLine`.

Confidence is `low` for everything here by definition - this is inference, and the review screen exists to make that cheap to correct.

### Task K2: PDF text extraction ✅ DONE 2026-09-10

**Files:** create `packages/enrichment/src/from-pdf.ts` and its test · fixtures

Extract the text layer and hand it to K1. A PDF with no text layer is a **scan**: return the signal to fall through to OCR rather than an error. Cap file size and page count. A malformed PDF is an expected input.

### Task K3: image OCR ✅ DONE 2026-09-10

**Files:** create `packages/enrichment/src/from-image.ts` and its test · fixtures

tesseract.js, then K1's heuristics. **Must work with no API key** - that is D14's competitive promise and a hard requirement.

Bound concurrency: OCR shares a box with Postgres and the app, and one import must not make the household's shopping list unresponsive. Implement whatever J0's measurement said.

### Task K4: wire the remaining sources ✅ DONE 2026-09-10

**Files:** modify `routers/import.ts`, `Import.tsx` and tests

`import.fromText`, `import.fromPdf`, `import.fromImage`. Uploads need a size cap enforced **server-side**, not just in the browser.

### Task K5: E2E ✅ DONE 2026-09-10

**Files:** create `e2e/import.spec.ts`

Import a recipe from a checked-in fixture served locally, review it, correct a flagged field, save it, and see it in the library. Run twice against the same database. E2E is not in CI, so the local run is the only evidence.

---

## Definition of done

- [x] Full suite (1074), typecheck, lint, build green; the E2E suite passed twice in a row against the same database, five tests each time
- [x] Every SSRF rule has a test that fails when the rule is removed, including the post-redirect re-check
- [x] The DNS-rebinding position is stated in a comment and is true
- [x] No test touches the network. The OCR offline proof goes further: it runs in a child process preloaded to refuse every socket and every name lookup, which is the only way to reach the worker thread the model is loaded in - a first version of that test patched `net` in the test's own process and passed while the worker was free to download whatever it liked.
- [x] Image import verified to work with no API key
- [x] OCR timing measured and the sync-versus-job decision justified by it (J0, above: synchronous stands)
- [x] `docs/CAPABILITY_MAP.md` area B updated to what actually shipped

## What Phase K did NOT do, and why

- **A scanned PDF is not OCR'd.** It is detected (a scan yields 0 characters of text layer, measured) and the cook is sent to the Photo tile. Rendering a PDF page to a bitmap needs a canvas implementation J0 deliberately excluded, and photographing the page reaches the same code.
- **URL import is not in the E2E run.** The plan's sketch was "a fixture served locally", and the SSRF fetcher refuses exactly that: a locally served page is on a loopback address. The E2E covers PDF and paste, which need no network at all; the URL path is covered against the real `appRouter` in `import.test.ts`, which watches a loopback URL get refused.
- **`sourceUrl` closed, `sourceName` left alone.** The column exists beside it and nothing populates it. Naming a site is a second question - the site's name, or the cook's? - and the link already shows the hostname.
- **No LLM provider** (scope decision 1). The deterministic baseline reads a rotated, unevenly lit, blurred, JPEG-compressed cookbook page without one.
