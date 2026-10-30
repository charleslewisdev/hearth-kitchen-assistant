import { describe, it, expect, beforeAll } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { MAX_IMAGES_PER_IMPORT, MAX_PDF_BYTES } from '@hearth/shared';
import { draftFromPdf, MAX_PDF_PAGES } from './from-pdf';
import type { PdfResult } from './from-pdf';
import type { Recognizer } from './from-image';

/**
 * The PDF fixtures, and where each one came from.
 *
 * They are binary, so they cannot carry the header the HTML fixtures carry. This is that
 * header, and every one of them is reproducible from what is written here.
 *
 * All four were made on 2026-09-10 on this machine. None is trimmed or edited: each is the
 * generating tool's output byte for byte.
 *
 *  - `cookbook-page.pdf` - the Skillet Cornbread recipe (written for this repo, not taken from
 *    a book), laid out in HTML with a page break before the method, then printed by
 *    `google-chrome --headless --no-pdf-header-footer --print-to-pdf`. TWO pages on purpose:
 *    the ingredients are on page 1 and the method is on page 2, so a test that finds both has
 *    proved the pages are read in order and joined.
 *  - `no-recipe-article.pdf` - the same printer over the text of
 *    `no-recipe-blog-post.html`, so the "a PDF with a text layer and no recipe in it" case is
 *    the same prose the HTML suite uses for it.
 *  - `many-pages.pdf` - thirty near-empty pages from the same printer, for the page cap.
 *  - `scanned-page.pdf` - `cookbook-page.jpg` (see `from-image.test.ts` for how that was made)
 *    resized to 850x1100 and saved as a one-page PDF by Pillow, which writes the image and
 *    nothing else. That is what a scan is: pixels, with no text layer under them.
 *  - `scanned-cookbook.pdf`, `scanned-tiny-image.pdf`, `scanned-huge-claim.pdf` and
 *    `scanned-five-pages.pdf` - made 2026-09-24 by `test/make-scanned-pdfs.mjs`, which writes
 *    every object by hand and says what each file is. Rerunning it rewrites the same bytes.
 *  - `pinned-text-items.pdf` - HOSTILE, and hand-built for this suite rather than printed. One
 *    page whose content stream is 200,000 copies of `1 0 0 1 100 700 Tm (\() Tj`: every text
 *    item is pinned to the same text matrix, so pdfjs reports the same x for all of them and
 *    `linesOfPage` joins them with no separator into one 200,000-character "line". See the
 *    describe block at the bottom of this file for what that used to cost.
 *  - `repeated-heavy-pages.pdf` - HOSTILE. Twenty page objects that all point at ONE content
 *    stream of 150,000 pinned items, so the file is 13KB and pdfjs is asked to build 3,000,000
 *    text items across it. Page one alone blows the character budget, so this is what shows
 *    that the budget is spent BETWEEN pages rather than at the end.
 *  - `two-column-print.pdf` - made 2026-09-22 from `two-column-print.source.html` (written for
 *    this repo), served from `python3 -m http.server 8765` so the printed footer carries a
 *    neutral address, and printed by `google-chrome --headless --print-to-pdf` WITH the default
 *    header and footer. It is the layout of a web recipe printed from a browser: the title across
 *    the page, then the ingredients in a sidebar beside the method, with the date, the page
 *    title, the address and "1/1" printed around it.
 *  - `overprinted-headings.pdf` - hand-built on 2026-09-22 (a Python script writing the objects
 *    and xref by hand). The title and the METHOD heading are each drawn four times, 0.4pt
 *    apart, which is how a print driver fakes bold: measured on a Delish print, "FOR THE" came
 *    out as four items at x 61, 62, 62 and 62.
 *
 * No network, at any point, in any of it.
 */
function fixture(name: string): Uint8Array {
  return new Uint8Array(
    readFileSync(fileURLToPath(new URL(`../test/fixtures/${name}`, import.meta.url))),
  );
}

describe('a PDF with a text layer', () => {
  it('reads the recipe off it', async () => {
    const result = await draftFromPdf(fixture('cookbook-page.pdf'));
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect(result.draft.title.value).toBe('Skillet Cornbread');
    expect(result.draft.servings.value).toBe(8);
    expect(result.draft.source).toEqual({ kind: 'pdf' });
    // The text layer as the parser read it, marked as not a scan.
    expect(result.scanned).toBe(false);
    expect(result.text).toContain('Skillet Cornbread');
  });

  it('recovers the line structure the extractor throws away', async () => {
    /*
      The reason this module reads text items and their positions rather than calling unpdf's
      `extractText`: measured on this fixture, `extractText` returns all 900 characters joined
      with single spaces and no newline anywhere in it, so every ingredient and every step
      arrives as one line. The heuristics see no list in that at all - they find blocks by line
      shape - so nine ingredients on nine lines is the whole point of the reconstruction.
    */
    const result = await draftFromPdf(fixture('cookbook-page.pdf'));
    if (!result.ok) throw new Error(`expected a draft, got ${result.reason}`);

    expect(result.draft.ingredientLines.value).toEqual([
      '1 1/2 cups yellow cornmeal',
      '1/2 cup all-purpose flour',
      '2 tsp baking powder',
      '1 tsp fine sea salt',
      '1 1/4 cups buttermilk',
      '2 large eggs',
      '4 Tbsp unsalted butter, melted',
      '2 Tbsp honey',
      'Flaky salt, for serving',
    ]);
  });

  it('joins the pages, so a method on page two is still found', async () => {
    const result = await draftFromPdf(fixture('cookbook-page.pdf'));
    if (!result.ok) throw new Error(`expected a draft, got ${result.reason}`);

    expect(result.draft.steps.value).toHaveLength(5);
    expect(result.draft.steps.value[0]).toContain('Heat the oven to 425F');
    expect(result.draft.steps.value[4]).toContain('serve warm');
  });

  it('stops the method at the notes heading on the last page', async () => {
    const result = await draftFromPdf(fixture('cookbook-page.pdf'));
    if (!result.ok) throw new Error(`expected a draft, got ${result.reason}`);
    expect(result.draft.steps.value.join(' ')).not.toContain('Keeps two days');
  });

  it('flags every field, because a PDF states nothing', async () => {
    const result = await draftFromPdf(fixture('cookbook-page.pdf'));
    if (!result.ok) throw new Error(`expected a draft, got ${result.reason}`);
    expect(result.draft.ingredientLines.confidence).toBe('low');
    expect(result.draft.steps.confidence).toBe('low');
    expect(result.draft.title.confidence).toBe('low');
  });
});

describe('a page printed from a browser', () => {
  it('reads the sidebar and the method a column at a time rather than interleaved', async () => {
    const result = await draftFromPdf(fixture('two-column-print.pdf'));
    if (!result.ok) throw new Error(result.reason);
    expect(result.draft.ingredientLines.value).toEqual([
      '2 tablespoons olive oil',
      '1 large onion, chopped',
      '3 cloves garlic, minced',
      '1 tablespoon harissa',
      '2 cans chickpeas, drained',
      '1 can crushed tomatoes',
      '2 cups vegetable stock',
      '4 cups baby spinach',
      'Salt and pepper',
    ]);
    expect(result.draft.steps.value).toHaveLength(1);
    expect(result.draft.steps.value[0]).toMatch(/^Warm the oil in a heavy pot/);
    expect(result.draft.steps.value[0]).toMatch(/season with salt and pepper and serve\.$/);
  });

  it('keeps the printed date, address and page count out of the recipe', async () => {
    const result = await draftFromPdf(fixture('two-column-print.pdf'));
    if (!result.ok) throw new Error(result.reason);
    const everything = [
      result.draft.title.value,
      ...result.draft.ingredientLines.value,
      ...result.draft.steps.value,
    ].join('\n');
    expect(everything).not.toMatch(/localhost|1\/1|\d{1,2}:\d{2} ?[AP]M/);
    expect(result.draft.servings.value).toBe(4);
  });

  it('reads a heading drawn four times over as one heading', async () => {
    const result = await draftFromPdf(fixture('overprinted-headings.pdf'));
    if (!result.ok) throw new Error(result.reason);
    expect(result.draft.title.value).toBe('Overprint Soup');
    expect(result.draft.ingredientLines.value).toEqual([
      '2 cups stock',
      '1 tsp salt',
      '1 onion, chopped',
    ]);
    expect(result.draft.steps.value).toEqual(['Simmer everything for twenty minutes.']);
  });
});

describe('the PDFs a cook will hand over by mistake', () => {
  it('says a PDF with neither text nor a page image has no text layer, not no recipe', async () => {
    // The distinction is the whole of it: "there is no recipe in this" is wrong and unhelpful,
    // and "there is nothing here to read" tells the cook to use the Photo option instead. An
    // image too small to be a scanned page - a logo - is not something to OCR.
    const result = await draftFromPdf(fixture('scanned-tiny-image.pdf'));
    expect(result).toEqual({ ok: false, reason: 'no-text-layer' });
  });

  it('says so when a readable PDF simply has no recipe in it', async () => {
    const result = await draftFromPdf(fixture('no-recipe-article.pdf'));
    expect(result).toMatchObject({ ok: false, reason: 'no-recipe' });
    // With the text layer it read, for studying the failure.
    expect(result.ok === false && result.text).toBeTruthy();
  });

  it('treats a file that is not a PDF as an answer, not an exception', async () => {
    const result = await draftFromPdf(new TextEncoder().encode('this is not a PDF at all'));
    expect(result).toEqual({ ok: false, reason: 'malformed' });
  });

  it('treats a truncated PDF the same way', async () => {
    // The header is right and the body is gone, which is what a half-finished download is.
    const truncated = fixture('cookbook-page.pdf').slice(0, 400);
    const result = await draftFromPdf(truncated);
    expect(result).toEqual({ ok: false, reason: 'malformed' });
  });

  it('treats an empty upload the same way', async () => {
    expect(await draftFromPdf(new Uint8Array(0))).toEqual({ ok: false, reason: 'malformed' });
  });
});

describe('the caps', () => {
  it('refuses a file over the size cap without parsing it', async () => {
    // The bytes are nonsense, so reaching the parser would answer `malformed`. Answering
    // `too-large` is what proves the size was checked first.
    const oversized = new Uint8Array(MAX_PDF_BYTES + 1);
    expect(await draftFromPdf(oversized)).toEqual({ ok: false, reason: 'too-large' });
  });

  it('refuses a PDF with more pages than the cap', async () => {
    expect(MAX_PDF_PAGES).toBeLessThan(30);
    expect(await draftFromPdf(fixture('many-pages.pdf'))).toEqual({
      ok: false,
      reason: 'too-many-pages',
    });
  });
});

describe('a PDF built to be expensive rather than to be a recipe', () => {
  /*
    The shape of the attack, and why three separate bounds now stop it.

    `linesOfPage` joins items that share an x position with no separator, so 200,000 items
    became one 200,000-character line. `from-text`'s word cap counted space-separated tokens, so
    a line with no spaces in it was one "word" and passed. `parseIngredientLine`'s parenthetical
    rule was unanchored and quadratic on a run of `(` with no `)`.

    Measured end to end through `draftFromPdf`, with an HTTP server answering /health in the
    same process to show what "blocked" means:

      | file                          | before   | server unavailable for | after  |
      | ----------------------------- | -------- | ---------------------- | ------ |
      | 2,217 bytes,  25,000 items    |   489 ms |                 332 ms | 306 ms |
      | 7,122 bytes, 100,000 items    | 3,372 ms |               3,376 ms | 212 ms |
      | 13,681 bytes, 200,000 items   | 12,952 ms|              12,952 ms | 394 ms |

    The 6MiB byte cap admits roughly 450 times the 13,681-byte file, and the coarse rate limiter
    allows 300 requests a minute, so this was sustainable indefinitely by anyone with an account.
  */
  it('refuses it for what it is, rather than spending twelve seconds on it', async () => {
    const started = Date.now();
    const result = await draftFromPdf(fixture('pinned-text-items.pdf'));
    // Generous by two orders of magnitude against the 12,952ms this used to take, and loose
    // enough not to care what else the machine is doing.
    expect(Date.now() - started).toBeLessThan(3000);
    expect(result).toEqual({ ok: false, reason: 'too-much-content' });
  }, 30_000);

  it("does not consume the caller's bytes", async () => {
    // pdfjs TRANSFERS the ArrayBuffer it is handed, which detaches it. Reading the same upload
    // twice - a retry, or a future fall-through to OCR - would otherwise see zero bytes.
    const bytes = fixture('cookbook-page.pdf');
    const before = bytes.byteLength;
    await draftFromPdf(bytes);
    expect(bytes.byteLength).toBe(before);
  });
});

describe('the character budget is spent between pages, not at the end', () => {
  it('stops at the first page that blows it rather than reading all twenty', async () => {
    /*
      13,064 bytes, twenty pages, 150,000 text items on each of them because they share one
      content stream. Page one is already over the budget.

      Measured: stopping there takes about 385ms. Moving the check to after the loop - which is
      where `MAX_TEXT_LENGTH` alone would apply it, and where `draftFromText` applies it - makes
      the same file take 7,369ms, because pdfjs builds all twenty pages first. The answer is
      identical either way; only the bill differs, which is why this one is timed.
    */
    const started = Date.now();
    const result = await draftFromPdf(fixture('repeated-heavy-pages.pdf'));
    expect(Date.now() - started).toBeLessThan(4000);
    expect(result).toEqual({ ok: false, reason: 'too-much-content' });
  }, 60_000);
});

describe('one PDF at a time', () => {
  it('refuses to queue more than a couple of imports behind the one running', async () => {
    // Deterministic rather than timed: `run` counts a job as waiting synchronously, so the
    // third call in the same tick is over the cap however fast the first two are.
    const bytes = fixture('cookbook-page.pdf');
    const results = await Promise.all([
      draftFromPdf(bytes),
      draftFromPdf(bytes),
      draftFromPdf(bytes),
    ]);
    expect(results.filter((r) => !r.ok && r.reason === 'busy')).toHaveLength(1);
    // And the ones it did accept were answered properly.
    expect(results.filter((r) => r.ok)).toHaveLength(2);
  });
});

/** The width and height a PNG's header states. */
function pngSize(png: Uint8Array): [number, number] {
  const view = Buffer.from(png.buffer, png.byteOffset, png.byteLength);
  return [view.readUInt32BE(16), view.readUInt32BE(20)];
}

const PNG_SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];

describe('a scanned PDF', () => {
  /*
    The real recogniser, once per fixture. `scanned-cookbook.pdf` is `cookbook-page.jpg`
    embedded as the page's only content (see `test/make-scanned-pdfs.mjs`), plus a small logo,
    so it reads the same recipe the photo suite does and shows the logo is passed over.
  */
  let scanned: PdfResult;
  let pillow: PdfResult;

  beforeAll(async () => {
    scanned = await draftFromPdf(fixture('scanned-cookbook.pdf'));
    pillow = await draftFromPdf(fixture('scanned-page.pdf'));
  }, 120_000);

  it('is read by OCR rather than sent to the Photo tile', () => {
    if (!scanned.ok) throw new Error(`expected a draft, got ${scanned.reason}`);
    expect(scanned.draft.title.value).toBe('Skillet Cornbread');
    expect(scanned.draft.ingredientLines.value).toHaveLength(9);
  });

  it('keeps the PDF as its source, so the review screen names the right thing', () => {
    if (!scanned.ok) throw new Error(`expected a draft, got ${scanned.reason}`);
    expect(scanned.draft.source).toEqual({ kind: 'pdf' });
  });

  it('hands back what OCR read, marked as a scan', () => {
    if (!scanned.ok) throw new Error(`expected a draft, got ${scanned.reason}`);
    expect(scanned.scanned).toBe(true);
    expect(scanned.text).toContain('Cornbread');
  });

  it('reads the page Pillow wrote as a scan, at 850x1100, too', () => {
    // The fixture that used to prove a scan was refused. It has a quarter of the pixels of the
    // one above, which is the low end of what a scanner app produces.
    if (!pillow.ok) throw new Error(`expected a draft, got ${pillow.reason}`);
    expect(pillow.draft.title.value).toBe('Skillet Cornbread');
    expect(pillow.draft.source).toEqual({ kind: 'pdf' });
  });
});

describe('a scanned PDF, with the recogniser stubbed', () => {
  it('hands OCR one greyscale PNG per page, of the largest image on it', async () => {
    const seen: Uint8Array[] = [];
    const recognize: Recognizer = async (bytes) => {
      seen.push(bytes);
      return { ok: true, text: 'nothing' };
    };
    await draftFromPdf(fixture('scanned-cookbook.pdf'), { recognize });
    expect(seen).toHaveLength(1);
    expect([...seen[0]!.subarray(0, 8)]).toEqual(PNG_SIGNATURE);
    expect(pngSize(seen[0]!)).toEqual([1700, 2200]);
    // Colour type 0: greyscale.
    expect(seen[0]![25]).toBe(0);
  });

  it('leaves the PDF queue before OCR, so another PDF is not held up behind a recognition', async () => {
    // If OCR ran inside the PDF job, this nested import would wait for the job that is waiting
    // for it, and the test would time out rather than fail.
    let nested: PdfResult | undefined;
    const recognize: Recognizer = async () => {
      nested = await draftFromPdf(fixture('cookbook-page.pdf'));
      return { ok: true, text: 'nothing' };
    };
    await draftFromPdf(fixture('scanned-cookbook.pdf'), { recognize });
    expect(nested?.ok).toBe(true);
  }, 20_000);

  it.each([
    ['timed-out', 'timed-out'],
    ['ocr-unavailable', 'ocr-unavailable'],
    ['unreadable', 'malformed'],
  ] as const)('answers an OCR %s as %s', async (ocrReason, pdfReason) => {
    const recognize: Recognizer = async () => ({ ok: false, reason: ocrReason });
    expect(await draftFromPdf(fixture('scanned-cookbook.pdf'), { recognize })).toEqual({
      ok: false,
      reason: pdfReason,
    });
  });

  it('says a scan with no recipe on it is a scan, not a PDF with no text in it', async () => {
    const recognize: Recognizer = async () => ({ ok: true, text: 'A page about the weather.' });
    expect(await draftFromPdf(fixture('scanned-cookbook.pdf'), { recognize })).toEqual({
      ok: false,
      reason: 'no-recipe-in-scan',
      text: 'A page about the weather.',
    });
  });

  it('refuses a scan longer than one import may be, before reading any page of it', async () => {
    let calls = 0;
    const recognize: Recognizer = async () => {
      calls += 1;
      return { ok: true, text: '' };
    };
    expect(MAX_IMAGES_PER_IMPORT).toBeLessThan(5);
    expect(await draftFromPdf(fixture('scanned-five-pages.pdf'), { recognize })).toEqual({
      ok: false,
      reason: 'scan-too-long',
    });
    expect(calls).toBe(0);
  });
});

describe('a scanned PDF built to be expensive', () => {
  it('refuses an image claiming 100000x100000 pixels without decoding it', async () => {
    // Ten gigabytes of grey, claimed by a 708-byte file. pdfjs is told the most pixels an image
    // may have and drops this one before allocating anything. It was a page image, so the answer
    // is that it is too large, not that there is nothing to read.
    let calls = 0;
    const started = Date.now();
    const result = await draftFromPdf(fixture('scanned-huge-claim.pdf'), {
      recognize: async () => {
        calls += 1;
        return { ok: true, text: '' };
      },
    });
    expect(Date.now() - started).toBeLessThan(2000);
    expect(result).toEqual({ ok: false, reason: 'too-large' });
    expect(calls).toBe(0);
  });

  it('refuses an image whose 81 million pixels are really there, before decoding them', async () => {
    // Every side is within bounds and the data deflates to 80KB. Decoded, pdfjs would hold it
    // as 243MB of RGB (measured: 450ms and 650MB of RSS with no bound in place).
    let calls = 0;
    const started = Date.now();
    const result = await draftFromPdf(fixture('scanned-dense-image.pdf'), {
      recognize: async () => {
        calls += 1;
        return { ok: true, text: '' };
      },
    });
    expect(Date.now() - started).toBeLessThan(2000);
    expect(result).toEqual({ ok: false, reason: 'too-large' });
    expect(calls).toBe(0);
  });

  it('refuses a page of many images, each within bounds, before pdfjs decodes any', async () => {
    // pdfjs decodes every image on a page at once, as the page's operator list is built, so a
    // per-image bound alone lets eight of them through: 200 million pixels, 600MB of RGB.
    let calls = 0;
    const started = Date.now();
    const result = await draftFromPdf(fixture('scanned-many-images.pdf'), {
      recognize: async () => {
        calls += 1;
        return { ok: true, text: '' };
      },
    });
    expect(result).toEqual({ ok: false, reason: 'too-large' });
    expect(Date.now() - started).toBeLessThan(2000);
    expect(calls).toBe(0);
  });
});
