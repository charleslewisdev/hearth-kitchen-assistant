import { access } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { join } from 'node:path';
import { createWorker, OEM, PSM } from 'tesseract.js';
import type { Page, Worker } from 'tesseract.js';
import { MAX_IMAGE_BYTES, MAX_IMAGE_IMPORT_BYTES, MAX_IMAGES_PER_IMPORT } from '@hearth/shared';
import { draftFromText } from './from-text';
import { createQueue, QueueFullError } from './one-at-a-time';
import { readingOrderText } from './reading-order';
import type { OcrLine } from './reading-order';
import type { RecipeDraft } from './draft';

/**
 * Reading a recipe off a photograph, with tesseract.js.
 *
 * Like the PDF source, this is a decoder in front of `from-text.ts`: pixels become lines and
 * the heuristics do the rest, so a photo import and a paste meet the same code.
 *
 * D14 makes this the competitive position of the whole milestone: **image import works in the
 * box, with no API key and nothing fetched.** The model tesseract needs is
 * `@tesseract.js-data/eng`, a normal dependency of this package, and `langPath` below points at
 * the copy inside `node_modules`. It is a `dependency` and not a `devDependency` deliberately:
 * a production image that pruned it would leave OCR reaching for the network at run time,
 * which is the trap this repo has already walked into once.
 *
 * D38: nothing here logs, including tesseract's own progress, which carries recognised text.
 */

const requireFromHere = createRequire(import.meta.url);

/**
 * How long to wait for a worker to come up before giving up on it.
 *
 * Generous, because it covers a cold start on a home server rather than anything a person is
 * watching: Task J0 measured worker start at 96-226ms on this machine. It exists as a backstop
 * for a hang with no error attached, not as a normal outcome.
 */
const WORKER_START_TIMEOUT_MS = 30_000;

/**
 * How long to wait for one photo's recognition - both passes (`THRESHOLDINGS`) - before
 * giving up on the worker.
 *
 * Nothing else bounds it. tesseract.js's `startJob` has no timeout of its own, and the
 * `worker.onerror = ...` assignment in `createWorker.js` is dead code on a `worker_threads`
 * Worker - that is an EventEmitter, so only `.on('error')` is heard. If a worker died mid-job
 * instead of rejecting, `recognize` would never settle, the queue below would never advance,
 * and every later import in the process would wait for ever.
 *
 * No input has been found that does that, so this is defence in depth rather than a fix for a
 * reproduction. It is set high on purpose: J0 measured 1176ms for a 12MP photo and 3016ms on
 * the pessimistic non-SIMD path, so a home server four times slower lands near 12 seconds a
 * pass. Reading each photo twice (2026-09-23) made a browser-sized cookbook photo 2.5-7.3s on
 * this machine, so the same server lands near 30 seconds; two minutes is four times that. Its
 * job is to unwedge a queue, not to police slowness.
 */
const RECOGNIZE_TIMEOUT_MS = 120_000;

/**
 * How many times in a row a worker may fail to start before OCR is called unavailable.
 *
 * Not one. A single failure used to latch permanently, which meant one transient WASM
 * allocation failure disabled OCR for the household until somebody restarted the server. Three
 * consecutive failures is a broken install rather than a bad moment, and refusing then is what
 * keeps a `createWorker` that never settles (see `startupLatch` below) from leaking a worker
 * thread per import for ever.
 */
const MAX_CONSECUTIVE_STARTUP_FAILURES = 3;

export type ImageFailureReason =
  | 'too-large'
  | 'unreadable'
  | 'ocr-unavailable'
  | 'timed-out'
  | 'busy'
  | 'no-recipe';

/**
 * `text` is what OCR read, as the parser was given it: kept with the draft so a bad import can
 * be studied, and the parser re-run over it, without reading the photos again.
 */
export type ImageResult =
  | { ok: true; draft: RecipeDraft; text: string }
  /** `text` is set on `no-recipe`: what OCR read, possibly nothing, with no recipe in it. */
  | { ok: false; reason: ImageFailureReason; text?: string };

/** What OCR came back with. A failure is a value here, not a throw. */
export type Recognized =
  | { ok: true; text: string }
  | { ok: false; reason: 'unreadable' | 'ocr-unavailable' | 'timed-out' };

/**
 * How pixels become text.
 *
 * Injectable ONLY so a test can exercise the queue and the caps without paying for a real OCR
 * pass per case; production uses tesseract, and `from-image.test.ts` runs the real one against
 * a real photograph.
 */
export type Recognizer = (bytes: Uint8Array) => Promise<Recognized>;

export interface ImageOptions {
  recognize?: Recognizer;
}

/** Where the English model is, as the data package itself reports it. */
export interface LanguageData {
  code: string;
  gzip: boolean;
  langPath: string;
}

/** The English model's location, from `@tesseract.js-data/eng`'s own manifest. */
export function englishLanguageData(): LanguageData {
  return requireFromHere('@tesseract.js-data/eng') as LanguageData;
}

/** Where the model comes from, and where a copy of it does not go. */
export interface OcrWorkerOptions {
  langPath: string;
  gzip: boolean;
  cacheMethod: 'none';
}

/**
 * What tesseract is told about its model, and the whole of D14's offline promise.
 *
 * `langPath` at the installed data package is what stops it fetching the model from
 * `tessdata.projectnaptha.com`, and `cacheMethod: 'none'` is what stops it writing a copy back
 * out - the default cache path is the working directory, which for this server is the
 * repository.
 *
 * Exported so `from-image.test.ts` can hand exactly these options to a child process that has
 * been made incapable of opening a socket, and watch a page be recognised anyway. That is the
 * only way to test it: the model is loaded inside a worker thread with its own module registry,
 * which the test's own process cannot reach.
 */
export function ocrWorkerOptions(language: LanguageData = englishLanguageData()): OcrWorkerOptions {
  return { langPath: language.langPath, gzip: language.gzip, cacheMethod: 'none' };
}

/**
 * Counts consecutive failures to START a worker, and gives up after enough of them.
 *
 * The thing being counted is a specific shape in tesseract.js 5.1.1, measured rather than read.
 * When the model fails to load, the worker reports it with `action: 'initialize'`; the promise
 * `createWorker` returned is only rejected for `action: 'load'`, and the tail of `createWorker`
 * is `.catch(() => {})`. So for anything but `load`, `createWorker` NEITHER RESOLVES NOR
 * REJECTS - a spike with a corrupt `eng.traineddata.gz` sat there until it was killed 60
 * seconds later, with the only signal being `errorHandler` firing at 52ms. The
 * `worker_threads` Worker it started is unreachable from here and stays alive, so without a
 * limit that is one orphaned thread per import, for ever.
 *
 * Counting rather than latching on the first one, because the same signal arrives for a
 * transient failure, and one bad moment should not disable OCR for the household until
 * somebody restarts the server. A success resets the count.
 *
 * A factory, and exported, so the rule can be tested without a broken tesseract install.
 */
export function createStartupLatch(limit: number) {
  let consecutive = 0;
  return {
    /** Whether it is still worth starting a worker at all. */
    worthTrying: () => consecutive < limit,
    failed: () => {
      consecutive += 1;
    },
    succeeded: () => {
      consecutive = 0;
    },
    /** For tests, and for nothing else. */
    consecutiveFailures: () => consecutive,
  };
}

const startupLatch = createStartupLatch(MAX_CONSECUTIVE_STARTUP_FAILURES);

/**
 * How the page is turned into black and white before it is read, one pass each.
 *
 * Measured on the owner's pilot photos (2026-09-23), neither wins everywhere. Otsu, one
 * threshold for the whole page and tesseract's default, lost a whole cookbook page to a dark
 * sidebar, a thumb and a speckled worktop: its layout analysis called the entire page a picture
 * and returned 6 lines. Sauvola, a threshold per neighbourhood, read that page whole, but it
 * hollows out large bold type and lost the title of a printed King Arthur recipe that Otsu read
 * perfectly. Reading twice and keeping the better (`confidentLetters`) got every photo its
 * better pass, for twice the time.
 */
const THRESHOLDINGS = [
  { thresholding_method: '0' }, // Otsu
  { thresholding_method: '2' }, // Sauvola
] as const;

/**
 * A word tesseract is at least this sure of counts toward a pass's score. What separates a
 * pass that read the page from one that did not is how much text it is SURE of: a failed pass
 * still returns plenty of words, at confidences in the teens and twenties.
 */
const CONFIDENT_WORD = 80;

/** How much of a page a pass read with confidence: the letters in its confident words. */
function confidentLetters(page: Page): number {
  let letters = 0;
  for (const block of page.blocks ?? []) {
    for (const paragraph of block.paragraphs) {
      for (const line of paragraph.lines) {
        for (const word of line.words) {
          if (word.confidence >= CONFIDENT_WORD) letters += word.text.length;
        }
      }
    }
  }
  return letters;
}

/** tesseract's lines, as the geometry `reading-order.ts` orders. */
function linesOf(page: Page): OcrLine[] {
  const lines: OcrLine[] = [];
  for (const block of page.blocks ?? []) {
    for (const paragraph of block.paragraphs) {
      for (const line of paragraph.lines) {
        lines.push({
          words: line.words.map((word) => ({
            text: word.text,
            confidence: word.confidence,
            bbox: word.bbox,
          })),
        });
      }
    }
  }
  return lines;
}

/**
 * One photograph as text, in reading order.
 *
 * Page segmentation is tesseract's automatic mode (PSM 3) rather than tesseract.js's default of
 * a single uniform block (PSM 6). A single block reads straight across a page, so a cookbook's
 * narrow ingredient column and the method beside it came out a line of each at a time: on the
 * pilot photos, four of nine failed or interleaved that way. Automatic mode finds the columns;
 * the order it emits them in is then fixed by `readingOrderText`, which also turns a page shot
 * sideways back upright (tesseract reads the vertical lines on its own).
 */
async function readPage(worker: Worker, image: Buffer): Promise<string> {
  let best: Page | null = null;
  let bestScore = -1;
  for (const thresholding of THRESHOLDINGS) {
    await worker.setParameters({ tessedit_pageseg_mode: PSM.AUTO, ...thresholding });
    const { data } = await worker.recognize(
      image,
      {},
      // `blocks` is the geometry; hOCR and TSV are tesseract.js defaults nothing here reads.
      { text: true, blocks: true, hocr: false, tsv: false },
    );
    const score = confidentLetters(data);
    if (score > bestScore) {
      best = data;
      bestScore = score;
    }
  }
  return readingOrderText(linesOf(best!)) ?? best!.text;
}

/**
 * OCR through tesseract.js.
 *
 * `cacheMethod: 'none'` because `langPath` already points at a file on disk: the default writes
 * a copy of the model into the working directory, which for this server is the repository.
 */
async function tesseractRecognize(bytes: Uint8Array): Promise<Recognized> {
  if (!startupLatch.worthTrying()) return { ok: false, reason: 'ocr-unavailable' };

  const language = englishLanguageData();
  const model = join(
    language.langPath,
    `${language.code}.traineddata${language.gzip ? '.gz' : ''}`,
  );
  try {
    // Checked before a worker is started rather than after, because a worker that cannot find
    // its model is the hang described above. This is the failure a pruned image produces, and
    // catching it here means that one never forks a thread at all.
    //
    // Deliberately NOT counted as a startup failure: nothing was started, so nothing leaked,
    // and an operator who drops the missing file into place gets a working importer without
    // restarting the server.
    await access(model);
  } catch {
    return { ok: false, reason: 'ocr-unavailable' };
  }

  let starting = true;
  let reportStartupFailure: (result: Recognized) => void = () => undefined;
  const startupFailed = new Promise<Recognized>((resolve) => {
    reportStartupFailure = resolve;
  });
  const startupTimedOut = new Promise<Recognized>((resolve) => {
    // `unref` so a race won by the worker does not hold the process open for the rest of it.
    setTimeout(
      () => resolve({ ok: false, reason: 'ocr-unavailable' }),
      WORKER_START_TIMEOUT_MS,
    ).unref();
  });

  const starts = createWorker(language.code, OEM.LSTM_ONLY, {
    ...ocrWorkerOptions(language),
    logger: () => undefined,
    errorHandler: () => {
      // Supplying this is not optional: with no handler, tesseract.js THROWS from inside its
      // own message listener - which runs on THIS thread, not in the worker - and that becomes
      // an uncaught exception that takes the server down.
      //
      // It hears one thing only: a `status: 'reject'` message the worker sent. It is not a
      // general worker-failure hook, and a worker that dies without sending one is not covered
      // by it - that is what `RECOGNIZE_TIMEOUT_MS` is for.
      //
      // Only heeded while the worker is coming up. Afterwards the only job is `recognize`,
      // whose own promise rejects with the real reason, and treating a photograph tesseract
      // could not read as a broken install would take OCR out for the whole household on the
      // first cook who picked the wrong file.
      if (!starting) return;
      reportStartupFailure({ ok: false, reason: 'ocr-unavailable' });
    },
  }).then((worker) => ({ worker }));

  let outcome;
  try {
    outcome = await Promise.race([starts, startupFailed, startupTimedOut]);
  } catch {
    // `createWorker` DOES reject, for one action: `load`, which is the WASM core rather than the
    // language. Without this catch that rejection travelled all the way out of the router as an
    // unhandled error and became a 500 - the one outcome this module exists to avoid, and the
    // only install-integrity failure that was not already an `ocr-unavailable`.
    starting = false;
    startupLatch.failed();
    return { ok: false, reason: 'ocr-unavailable' };
  }
  starting = false;

  if (!('worker' in outcome)) {
    startupLatch.failed();
    // The timeout can lose this race to a worker that turns up a moment later. Close that one
    // rather than leave a thread running with nothing to do. (The never-settling path cannot
    // reach here with a worker on the way, which is what the failure count is for.)
    void starts.then(({ worker }) => worker.terminate()).catch(() => undefined);
    return outcome;
  }
  startupLatch.succeeded();

  try {
    // A Buffer VIEW over the same bytes rather than a copy of them: `ImageLike` names Buffer,
    // and tesseract's own loader copies once already.
    const image = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    const recognised = await Promise.race([
      readPage(outcome.worker, image).then((text) => ({ text })),
      new Promise<{ timedOut: true }>((resolve) => {
        setTimeout(() => resolve({ timedOut: true }), RECOGNIZE_TIMEOUT_MS).unref();
      }),
    ]);
    if ('timedOut' in recognised) return { ok: false, reason: 'timed-out' };
    return { ok: true, text: recognised.text };
  } catch {
    // Not an image, a truncated one, or a format leptonica does not know. All of them are files
    // a cook picked, so none of them is an exception.
    return { ok: false, reason: 'unreadable' };
  } finally {
    /*
      Started and terminated per import rather than pooled.

      The reason recorded here before was wrong, and saying so is cheaper than leaving it: it
      claimed a truncated JPEG aborts the WASM module and poisons the worker. `Aborted(-1)` does
      appear on stderr, but five corruptions were then re-tested - a 20-byte JPEG header, prose,
      zero bytes, a 4KB truncation and a 100KB truncation of the real photo - and after every one
      the SAME worker read the full cookbook page correctly, 828 characters, title intact.

      The real reason is memory. Measured: this process is 87MB before a worker exists, 242MB
      with one started and 267MB after a recognition, falling back to 149MB once it is
      terminated. Holding 150MB resident on a box that also runs Postgres, so that a rare
      operation can skip a 207ms start, is the wrong way round.
    */
    await outcome.worker.terminate().catch(() => undefined);
  }
}

/**
 * One OCR pass at a time, with a short queue behind it.
 *
 * Depth one because J0 measured tesseract as single-threaded: what is worth bounding is not how
 * long one import takes but how many cores several at once take away from Postgres and the
 * household's shopping list. A waiting room of two because each waiting import holds its upload
 * - up to `MAX_IMAGE_BYTES` of it - for as long as it waits, and nothing here learns that the
 * browser which asked has gone away. "Hearth is reading another photo, try again in a moment"
 * is an honest answer; growing without bound is not.
 */
const ocrQueue = createQueue(2);

/**
 * A draft from a photograph, or the reason there is not one.
 *
 * Every failure here is an expected input: a file that is not an image, one too big to bother
 * with, a photograph of something that is not a recipe.
 */
export async function draftFromImage(
  bytes: Uint8Array,
  options: ImageOptions = {},
): Promise<ImageResult> {
  return draftFromImages([bytes], options);
}

/**
 * Read one recipe off several photographs, in the order given: a recipe that runs over a page
 * turn. Each page is recognised on its own through the same depth-one queue as a single photo,
 * one after another, and the texts are joined with a blank line before being read as a paste.
 *
 * Every size is checked before any OCR starts, so an oversized set costs nothing. A page that
 * cannot be read fails the whole import with that page's reason: a recipe missing its method
 * is worse than being told to retake one photo.
 */
export async function draftFromImages(
  pages: Uint8Array[],
  options: ImageOptions = {},
): Promise<ImageResult> {
  if (pages.length === 0) return { ok: false, reason: 'unreadable' };
  if (pages.length > MAX_IMAGES_PER_IMPORT) return { ok: false, reason: 'too-large' };
  let total = 0;
  for (const page of pages) {
    if (page.byteLength > MAX_IMAGE_BYTES) return { ok: false, reason: 'too-large' };
    total += page.byteLength;
  }
  if (total > MAX_IMAGE_IMPORT_BYTES) return { ok: false, reason: 'too-large' };

  const recognize = options.recognize ?? tesseractRecognize;
  const texts: string[] = [];
  for (const page of pages) {
    let recognized: Recognized;
    try {
      recognized = await ocrQueue.run(() => recognize(page));
    } catch (error) {
      if (error instanceof QueueFullError) return { ok: false, reason: 'busy' };
      throw error;
    }
    if (!recognized.ok) return { ok: false, reason: recognized.reason };
    texts.push(recognized.text);
  }

  const text = texts.join('\n\n');
  const draft = draftFromText(text, { kind: 'image' });
  return draft ? { ok: true, draft, text } : { ok: false, reason: 'no-recipe', text };
}
