import { getDocumentProxy } from 'unpdf';
import { MAX_IMAGES_PER_IMPORT, MAX_PDF_BYTES, MAX_TEXT_LENGTH } from '@hearth/shared';
import { draftFromImages } from './from-image';
import { draftFromText } from './from-text';
import { createQueue, QueueFullError } from './one-at-a-time';
import {
  imageClaims,
  MAX_SCAN_PIXELS,
  MAX_SCAN_PIXELS_PER_PDF,
  readScannedPages,
} from './scan-pages';
import type { ImageFailureReason, ImageOptions } from './from-image';
import type { RecipeDraft } from './draft';

/**
 * Reading a recipe out of a PDF's text layer, or off its scanned pages.
 *
 * A PDF is a decoder in front of `from-text.ts`, not a source of its own: the text layer comes
 * out as lines and the heuristics do the rest, so a PDF import and a paste go through exactly
 * the same code once the bytes are behind us. A PDF with no text layer is a scan, and its page
 * images go through `scan-pages.ts` to the photo path's OCR instead.
 *
 * `unpdf` only. `pdfjs-dist` must NOT be added alongside it: unpdf bundles its own copy of
 * pdfjs, and with both installed pnpm's layout lets the standalone one become the worker, which
 * fails with `The API version "4.10.38" does not match the Worker version "4.6.82"`. That was
 * measured during the Task J0 spike, and it is the reason this file and `scan-pages.ts` import
 * pdfjs through unpdf and nothing else.
 *
 * D38: nothing here logs. A PDF's text is a recipe, and a recipe is user content.
 */

/**
 * The most pages worth reading.
 *
 * Twenty is twenty times the length of a printed recipe. The byte cap that goes with it is
 * `MAX_PDF_BYTES` in `@hearth/shared`, where the browser can see it too; this one is only ever
 * checkable here, because nothing knows how many pages a PDF has until it is parsed.
 */
export const MAX_PDF_PAGES = 20;

/**
 * One PDF at a time, with a short queue.
 *
 * pdfjs runs in this process and on this thread: the reviewer's worst case was 2,684ms and
 * 429MB of heap for a single call, and nothing was serialising concurrent ones. The image path
 * has had this since K3; the PDF path had neither a queue nor a bound, which was the gap.
 */
const pdfQueue = createQueue(2);

type PdfDocument = Awaited<ReturnType<typeof getDocumentProxy>>;

/**
 * Below this many characters, there is no text layer and the file is a scan.
 *
 * Measured on the fixtures: the scanned page returns exactly 0 characters, and
 * `cookbook-page.pdf` - which is TWO pages, ingredients then method - returns 900 across them.
 * The threshold sits well above 0 rather than at it, because a scan whose only text layer is a
 * page number or an OCR watermark is still a scan.
 */
const MIN_TEXT_LAYER_CHARS = 40;

/**
 * How far apart two text items' baselines may be and still be one line.
 *
 * In PDF user space, so 3/72 of an inch. Items on one visual line share a baseline exactly in
 * every fixture here; the tolerance is for the superscript and the inline size change that a
 * real document has in the middle of a line.
 */
const LINE_TOLERANCE = 3;

/** A horizontal gap this wide between two items on a line is a space that was not encoded. */
const SPACE_GAP = 1;

/**
 * Why a PDF did not become a draft.
 *
 * The last four are a scan's: `no-text-layer` is now the PDF with neither text nor a page-sized
 * image in it, and the others are what OCR can answer about one that had images.
 */
export type PdfFailureReason =
  | 'too-large'
  | 'too-many-pages'
  | 'too-much-content'
  | 'busy'
  | 'malformed'
  | 'no-text-layer'
  | 'no-recipe'
  | 'scan-too-long'
  | 'ocr-unavailable'
  | 'timed-out'
  | 'no-recipe-in-scan';

/**
 * `text` is what the parser was given, from the text layer or, when `scanned`, from OCR of the
 * page images. Kept with the draft for the same reason as a photo's (`ImageResult`).
 */
export type PdfResult =
  | { ok: true; draft: RecipeDraft; text: string; scanned: boolean }
  /** `text` is what was read, set on `no-recipe` and `no-recipe-in-scan`; it may be empty. */
  | { ok: false; reason: PdfFailureReason; text?: string };

/** Only the recogniser is injectable, for the same reason as on the photo path. */
export type PdfOptions = ImageOptions;

/**
 * An OCR failure as a PDF one.
 *
 * `unreadable` means tesseract could not decode the image it was handed. Here that image is a PNG
 * this package wrote, so if it ever happens the PDF is what was wrong with it.
 */
const SCAN_FAILURES: Record<ImageFailureReason, PdfFailureReason> = {
  'too-large': 'too-large',
  unreadable: 'malformed',
  'ocr-unavailable': 'ocr-unavailable',
  'timed-out': 'timed-out',
  busy: 'busy',
  'no-recipe': 'no-recipe-in-scan',
};

/** One piece of text pdfjs found, and where on the page it put it. */
interface PlacedText {
  text: string;
  x: number;
  y: number;
  width: number;
}

/**
 * How many vertical strips a page is cut into when looking for the gap between two columns.
 *
 * A fixed count rather than one strip per point, because a PDF's coordinates are whatever its
 * author wrote: a page a million points wide would otherwise allocate a million counters. On a
 * letter page this makes each strip about 2.4pt, and the narrowest gutter in the fixtures (a
 * Delish print, 13pt) is five of them.
 */
const GUTTER_STRIPS = 256;

/**
 * The share of rows allowed to cross a gutter and still leave it a gutter.
 *
 * The rows that cross are the ones that span the page: the title, a byline, the print header and
 * footer. Measured on the two-column fixture: 4 rows of 41 cross the gap between its columns,
 * and every row of a single-column page does.
 */
const GUTTER_CROSSING_SHARE = 0.15;

/** A column narrower than this share of the text is a column of amounts, not of prose. */
const MIN_COLUMN_SHARE = 0.2;

/** How many rows each side needs before the page counts as two columns. */
const MIN_COLUMN_ROWS = 3;

/** Two copies of the same text this close together are one piece drawn twice. */
const OVERPRINT_TOLERANCE = 2;

/** The page's items as rows, top to bottom, each row left to right, overprints removed. */
function rowsOfPage(items: PlacedText[]): PlacedText[][] {
  const placed = [...items].sort((a, b) => b.y - a.y);

  const rows: PlacedText[][] = [];
  let current: PlacedText[] = [];
  let baseline = 0;
  for (const item of placed) {
    if (current.length > 0 && Math.abs(baseline - item.y) > LINE_TOLERANCE) {
      rows.push(current);
      current = [];
    }
    if (current.length === 0) baseline = item.y;
    current.push(item);
  }
  if (current.length > 0) rows.push(current);

  // Sorted across only once a row is settled. Sorting the whole page by y and then x, as this
  // used to, put a row whose items differ in y by a fraction of a point in y order, not x order.
  //
  // A heading printed as fake bold is the same run drawn four times a fraction of a point apart
  // (measured on a Delish print: "FOR THE" at x 61, 62, 62 and 62). Unremoved, it reads as
  // "F O R T H EF O R T H E...".
  return rows.map((row) => {
    const sorted = [...row].sort((a, b) => a.x - b.x);
    const kept: PlacedText[] = [];
    // The last copy kept of each text. The row is sorted by x, so that copy is the nearest one
    // to the left, and checking it alone keeps this linear in a row of any size.
    const lastOf = new Map<string, PlacedText>();
    for (const item of sorted) {
      const other = lastOf.get(item.text);
      const overprint =
        other !== undefined &&
        Math.abs(other.x - item.x) < OVERPRINT_TOLERANCE &&
        Math.abs(other.y - item.y) < OVERPRINT_TOLERANCE;
      if (overprint) continue;
      kept.push(item);
      lastOf.set(item.text, item);
    }
    return kept;
  });
}

/** One row's items as a line of text, spaced where the gaps between them say to. */
function joinRow(items: PlacedText[]): string {
  let line = '';
  let cursor = 0;
  for (const item of items) {
    const needsSpace = line !== '' && item.x - cursor > SPACE_GAP;
    line += needsSpace ? ` ${item.text}` : item.text;
    cursor = item.x + item.width;
  }
  return line.replace(/\s+/g, ' ').trim();
}

interface Gutter {
  from: number;
  to: number;
}

/**
 * The empty vertical strip between two columns, or null for a one-column page.
 *
 * Read off how many rows cover each strip of the page's width. A strip few rows touch, in the
 * middle of the text, with enough rows on both sides of it and neither side a sliver, is a
 * gutter. The sliver rule is what keeps a table of amounts ("1 cup" | "flour") in one piece:
 * its left column is a tenth of the text, not a fifth.
 */
function findGutter(rows: PlacedText[][]): Gutter | null {
  let left = Infinity;
  let right = -Infinity;
  for (const row of rows) {
    for (const item of row) {
      left = Math.min(left, item.x);
      right = Math.max(right, item.x + item.width);
    }
  }
  const span = right - left;
  if (!Number.isFinite(span) || span <= 0) return null;

  const strip = span / GUTTER_STRIPS;
  const stripOf = (x: number) =>
    Math.min(GUTTER_STRIPS - 1, Math.max(0, Math.floor((x - left) / strip)));

  // A difference array per row, so the cost is items plus strips rather than their product.
  const covered = new Array<number>(GUTTER_STRIPS).fill(0);
  for (const row of rows) {
    const marks = new Array<number>(GUTTER_STRIPS + 1).fill(0);
    for (const item of row) {
      marks[stripOf(item.x)]! += 1;
      marks[stripOf(item.x + item.width) + 1]! -= 1;
    }
    let running = 0;
    for (let i = 0; i < GUTTER_STRIPS; i++) {
      running += marks[i]!;
      if (running > 0) covered[i]! += 1;
    }
  }

  const allowed = Math.floor(rows.length * GUTTER_CROSSING_SHARE);
  const lowest = Math.floor(GUTTER_STRIPS * MIN_COLUMN_SHARE);
  const highest = GUTTER_STRIPS - lowest;

  // Every open run, widest first. The widest is not always the gutter: the ragged right edge of
  // a method column, which only its longest lines reach, is often wider than the gap between the
  // columns (measured on a Food Network print: 21 strips of margin against 11 of gutter). What
  // tells them apart is that a gutter has text starting on its far side.
  const runs: Gutter[] = [];
  let runStart = -1;
  for (let i = lowest; i <= highest; i++) {
    const open = i < highest && covered[i]! <= allowed;
    if (open && runStart === -1) runStart = i;
    if (!open && runStart !== -1) {
      if (i - runStart >= 2) runs.push({ from: left + runStart * strip, to: left + i * strip });
      runStart = -1;
    }
  }
  runs.sort((a, b) => b.to - b.from - (a.to - a.from));

  for (const gutter of runs) {
    let leftRows = 0;
    let rightRows = 0;
    for (const row of rows) {
      if (row.some((item) => item.x + item.width <= gutter.from)) leftRows += 1;
      if (row.some((item) => item.x >= gutter.to)) rightRows += 1;
    }
    if (leftRows >= MIN_COLUMN_ROWS && rightRows >= MIN_COLUMN_ROWS) return gutter;
  }
  return null;
}

/**
 * The lines of one page, rebuilt from where pdfjs says each piece of text sits.
 *
 * unpdf's own `extractText` joins every item with a single space and emits no newlines at all
 * (measured on `cookbook-page.pdf`: 900 characters, no line break in any of them), which loses
 * the only thing the heuristics downstream read - an ingredient list is a list because it is on
 * separate lines. So the items are grouped into rows down the page, and a change in baseline
 * beyond `LINE_TOLERANCE` starts a new one.
 *
 * A two-column page is read a column at a time. Rows alone would interleave it, because the two
 * columns sit side by side: a recipe page printed from the web puts its ingredients in a sidebar
 * next to the method more often than not (two of the six PDFs in the first real import test).
 * The page is cut into bands at every row that crosses the gutter - the title, a byline, the
 * print header - and each band gives its left column and then its right.
 */
function linesOfPage(items: PlacedText[]): string[] {
  const rows = rowsOfPage(items);
  const gutter = findGutter(rows);

  const lines: string[] = [];
  const push = (text: string) => {
    if (text !== '') lines.push(text);
  };
  if (!gutter) {
    for (const row of rows) push(joinRow(row));
    return lines;
  }

  let leftColumn: string[] = [];
  let rightColumn: string[] = [];
  const flushBand = () => {
    for (const text of [...leftColumn, ...rightColumn]) push(text);
    leftColumn = [];
    rightColumn = [];
  };
  for (const row of rows) {
    const crosses = row.some((item) => item.x < gutter.from && item.x + item.width > gutter.to);
    if (crosses) {
      flushBand();
      push(joinRow(row));
      continue;
    }
    // By where an item STARTS. The gutter found is wherever few rows reach, so the longest line
    // of the left column can end a few points inside it: "Kosher salt and freshly ground black
    // pepper" did, on a Food Network print, and was read as part of the method.
    const leftPart = row.filter((item) => item.x < gutter.from);
    const rightPart = row.filter((item) => item.x >= gutter.from);
    if (leftPart.length > 0) leftColumn.push(joinRow(leftPart));
    if (rightPart.length > 0) rightColumn.push(joinRow(rightPart));
  }
  flushBand();
  return lines;
}

/**
 * Every page's text, in order, with a blank line between pages.
 *
 * A blank line rather than a plain one because `from-text` groups an UNNUMBERED method into
 * steps on blank lines, so a page break that is not one would run the last paragraph of one
 * page into the first paragraph of the next. Reasoned, not measured: no fixture here is both
 * two pages long and unnumbered, and removing the second `\n` fails no test in this file. What
 * IS measured is that the pages are joined at all - `cookbook-page.pdf` keeps its method on
 * page two, so a test that finds five steps has read both pages.
 */
async function readTextLayer(doc: PdfDocument): Promise<string | { reason: PdfFailureReason }> {
  /*
    The character budget, spent as the pages are read.

    `MAX_TEXT_LENGTH` would refuse this document at the end anyway; checking it BETWEEN pages
    is what stops the work. A 6MiB PDF holds twenty pages of hundreds of thousands of text
    items each - PDF content streams compress at better than 300:1 - and pdfjs builds every
    item of every page it is asked for. Measured on one page of the hostile fixture: 200,000
    items cost 610ms and 82MB of heap inside pdfjs alone, and 1,000,000 items cost 1,930ms and
    265MB. Stopping at the first page that blows the budget turns twenty of those into one.

    An item cap was tried here first and removed: every item pdfjs reports contributes at
    least one character (it drops whitespace-only runs itself, measured), so a cap on items can
    never fire before a cap on characters, and having both would be one guard wearing two
    names.

    What remains unbounded is ONE page's `getTextContent`, because the count is only knowable
    after it returns. `MAX_PDF_BYTES` and `pdfQueue` are what bound that.
  */
  const pages: string[] = [];
  let characters = 0;
  for (let number = 1; number <= doc.numPages; number++) {
    const page = await doc.getPage(number);
    const content = await page.getTextContent();

    const placed: PlacedText[] = [];
    for (const item of content.items) {
      if (!('str' in item) || typeof item.str !== 'string' || item.str.trim() === '') continue;
      placed.push({
        text: item.str,
        x: item.transform[4] ?? 0,
        y: item.transform[5] ?? 0,
        width: item.width ?? 0,
      });
    }
    // Counted on what pdfjs handed over rather than on the assembled lines, because assembly
    // drops overprinted copies: a page of 200,000 copies of one character assembles to one
    // character, and counting that would read all twenty such pages instead of stopping.
    for (const item of placed) characters += item.text.length;
    const assembled = linesOfPage(placed).join('\n');
    if (characters > MAX_TEXT_LENGTH) return { reason: 'too-much-content' };
    pages.push(assembled);
  }
  return pages.join('\n\n');
}

/**
 * A draft from a PDF, or the reason there is not one.
 *
 * A PDF with a text layer is read as a paste. One without is a scan, and its page images go to
 * OCR - AFTER this PDF's turn in `pdfQueue` is over. The two queues are separate, so OCR inside
 * the PDF job would not deadlock, but it would hold the PDF queue for the seconds a recognition
 * takes while every text-layer PDF behind it waited for no reason; the test that imports a PDF
 * from inside the recogniser is what pins the order.
 *
 * `no-text-layer` is now the PDF with neither: no text and no page-sized image, such as one drawn
 * only in vectors. Everything here is an expected input - a malformed file, a 400-page cookbook,
 * a PDF of an article - and none of them is an exception.
 */
export async function draftFromPdf(
  bytes: Uint8Array,
  options: PdfOptions = {},
): Promise<PdfResult> {
  if (bytes.byteLength > MAX_PDF_BYTES) return { ok: false, reason: 'too-large' };

  let read: PdfResult | ScannedPages;
  try {
    read = await pdfQueue.run(() => readOnePdf(bytes));
  } catch (error) {
    if (error instanceof QueueFullError) return { ok: false, reason: 'busy' };
    throw error;
  }
  if (!('scannedPages' in read)) return read;

  const result = await draftFromImages(read.scannedPages, options);
  if (!result.ok) return { ok: false, reason: SCAN_FAILURES[result.reason], text: result.text };
  // OCR names the draft an image's; the review screen words its notes by the source.
  return {
    ok: true,
    draft: { ...result.draft, source: { kind: 'pdf' } },
    text: result.text,
    scanned: true,
  };
}

/** A scan's pages as PNGs, handed out of the PDF queue for OCR. */
interface ScannedPages {
  scannedPages: Uint8Array[];
}

/** One PDF, inside the queue. Everything pdfjs does is on this side of it. */
async function readOnePdf(bytes: Uint8Array): Promise<PdfResult | ScannedPages> {
  let doc: PdfDocument;
  try {
    // A copy, because pdfjs TRANSFERS the ArrayBuffer it is given, so the caller's view would
    // be detached and read as zero-length afterwards; "the bytes I passed in are still mine"
    // should hold for anyone adding a retry.
    //
    // `verbosity: 0` because pdfjs otherwise writes its own warnings to the console for any
    // document it has to repair, and a recipe's text would be next to them.
    //
    // `maxImageSize` is the scan path's memory bound: pdfjs refuses to decode an image claiming
    // more pixels than this, before allocating it. Nothing on the text-layer path decodes images.
    doc = await getDocumentProxy(new Uint8Array(bytes), {
      verbosity: 0,
      maxImageSize: MAX_SCAN_PIXELS,
    });
  } catch {
    // Not a PDF, truncated, encrypted, or structurally broken. All of them are a file the cook
    // chose and all of them get the same answer: this one cannot be read.
    return { ok: false, reason: 'malformed' };
  }

  try {
    if (doc.numPages > MAX_PDF_PAGES) return { ok: false, reason: 'too-many-pages' };

    const text = await readTextLayer(doc);
    if (typeof text !== 'string') return { ok: false, reason: text.reason };

    if (text.replace(/\s/g, '').length >= MIN_TEXT_LAYER_CHARS) {
      const draft = draftFromText(text, { kind: 'pdf' });
      return draft
        ? { ok: true, draft, text, scanned: false }
        : { ok: false, reason: 'no-recipe', text };
    }

    /*
      A scan. Refused past the photo path's page cap rather than cut to it: a recipe missing its
      method is worse than being told to save just the recipe's pages, which is the same call
      `draftFromImages` makes about a page it cannot read. Counted before any image is decoded,
      so a long scan costs its text-layer pass and nothing more.
    */
    if (doc.numPages > MAX_IMAGES_PER_IMPORT) return { ok: false, reason: 'scan-too-long' };
    // pdfjs decodes all of a page's images at once and cannot be stopped, so what they claim
    // is added up first. Read off the caller's bytes: pdfjs has been handed a copy.
    const claims = imageClaims(bytes);
    if (claims.pixels > MAX_SCAN_PIXELS_PER_PDF) return { ok: false, reason: 'too-large' };

    const scannedPages = await readScannedPages(doc);
    if (scannedPages.length > 0) return { scannedPages };
    // A page image pdfjs dropped for its size is a scan at too high a resolution, which is
    // worth saying rather than that there is nothing here to read.
    return { ok: false, reason: claims.oversized ? 'too-large' : 'no-text-layer' };
  } catch {
    return { ok: false, reason: 'malformed' };
  } finally {
    // pdfjs holds the parsed document until it is told not to.
    await doc.destroy().catch(() => undefined);
  }
}
