---
paths:
  - "packages/enrichment/**"
  - "apps/server/src/trpc/routers/import.ts"
---
# Recipe import

Everything this package reads is untrusted: pages, pasted text, PDFs and photos.

- Every regex over input text must stay linear: bound the repetition (`[^)]{0,200}`), or put a lookbehind such as `(?<!\d)` in front of a leading `\d+` or `\s+` so a long run cannot restart the match at every character. The yield and title patterns here took 29 and 16 seconds on a 200k run, and the page cap is 4MB. Add a timed hostile-input test for each new pattern, like the ones at the end of `from-html.test.ts`.
- Bound recursion over parsed structures. JSON-LD nested past the call stack once crashed to a 500.
- URLs are fetched only through `fetch-page.ts`: resolve, check every address, pin DNS, re-check after each redirect, and share one deadline across DNS and all hops. Never call `fetch` directly.
- PDF and OCR run through the depth-one queues in `one-at-a-time.ts`, because both are synchronous CPU on the server's only thread.
- Fixtures are checked-in HTML; tests never touch the network.
- A failure returns a reason from a closed set that the router maps to a sentence. Never put page content in a thrown message or a log line (D38).
