import { describe, it, expect, beforeAll } from 'vitest';
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { MAX_IMAGE_BYTES, MAX_IMAGES_PER_IMPORT } from '@hearth/shared';
import {
  createStartupLatch,
  draftFromImage,
  draftFromImages,
  englishLanguageData,
  ocrWorkerOptions,
} from './from-image';
import type { ImageResult, Recognized } from './from-image';

/** A path beside this file, as an absolute one. */
const here = (relative: string) => fileURLToPath(new URL(relative, import.meta.url));

/**
 * OCR, against a real photograph, with no network and no key.
 *
 * `cookbook-page.jpg` is the only image fixture, and this is its header, because a JPEG cannot
 * carry one. Made on 2026-09-10 on this machine, by Pillow: the Skillet Cornbread recipe
 * (written for this repo, not taken from a book) set in DejaVu Serif on a 1700x2200 page, then
 * rotated 0.7 degrees, multiplied by a blurred top-to-bottom light gradient, blurred by 0.8
 * pixels and saved as JPEG at quality 80.
 *
 * The abuse is the point. A clean render of text is not evidence about photographs, and each of
 * those steps is something a phone does to a cookbook page: it is never square, the light is
 * never even, the focus is never perfect, and the file is always a JPEG.
 *
 * The suite runs the REAL recogniser here rather than a stub, because "image import works in
 * the box with no API key" (D14) is a promise about tesseract actually running and a stub would
 * prove nothing about it. A read is two tesseract passes (`THRESHOLDINGS` in `from-image.ts`),
 * so the photo is read once for the whole block below rather than once per assertion.
 *
 * Expect `Error in pixReadStream: Unknown format` and friends on stderr while this file runs.
 * That is leptonica, inside the WASM, complaining about the deliberately-not-an-image uploads
 * further down. It is the library's own output, not a failure, and there is no option exposed
 * to quieten it.
 *
 * Worth saying plainly, because it is not only a test-time nuisance: leptonica writes those
 * straight to the process's stderr IN PRODUCTION TOO, outside pino, where no redaction or
 * serializer can reach them. D38 survives that, but by luck rather than by construction - what
 * leptonica prints is a complaint about a file format ("Unknown format: no pix returned",
 * "Premature end of JPEG file") and the only filename in it is `/input`, tesseract's own
 * in-memory name for whatever it was handed. None of it is the recipe. If a future version
 * started echoing content, nothing here would catch it.
 */
function fixture(name: string): Uint8Array {
  return new Uint8Array(readFileSync(here(`../test/fixtures/${name}`)));
}

describe('a photograph of a cookbook page', () => {
  let result: ImageResult;

  beforeAll(async () => {
    result = await draftFromImage(fixture('cookbook-page.jpg'));
  }, 60_000);

  const draft = () => {
    if (!result.ok) throw new Error(`expected a draft, got ${result.reason}`);
    return result.draft;
  };

  it('reads the title, the yield and where it came from', () => {
    expect(draft().title.value).toBe('Skillet Cornbread');
    expect(draft().servings.value).toBe(8);
    expect(draft().source).toEqual({ kind: 'image' });
  });

  it('finds every ingredient, and puts nothing from the method among them', () => {
    expect(draft().ingredientLines.value).toEqual([
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

  it('rejoins each numbered step from the lines the page wrapped it across', () => {
    expect(draft().steps.value).toHaveLength(5);
    expect(draft().steps.value[0]).toContain('Heat the oven to 425F');
    expect(draft().steps.value[4]).toContain('Serve it warm');
  });

  it('flags every field, because OCR states nothing', () => {
    expect(draft().ingredientLines.confidence).toBe('low');
    expect(draft().steps.confidence).toBe('low');
    expect(draft().title.confidence).toBe('low');
  });
});

describe('no API key, and nothing fetched', () => {
  it('reads its language data out of the installed package, on disk', () => {
    // `@tesseract.js-data/eng` is a normal dependency rather than a devDependency for exactly
    // this reason: a pruned production image that dropped it would leave OCR reaching for the
    // network at run time.
    const data = englishLanguageData();
    expect(data.langPath).toContain('@tesseract.js-data/eng');
    expect(() => readFileSync(`${data.langPath}/${data.code}.traineddata.gz`)).not.toThrow();
  });

  it('tells tesseract to read the model off disk and to cache nothing', () => {
    const options = ocrWorkerOptions();
    expect(options.langPath).toBe(englishLanguageData().langPath);
    // The default cache path is the working directory, which for this server is the repository.
    expect(options.cacheMethod).toBe('none');
  });

  it('recognises a page in a process that cannot open a socket or resolve a name', async () => {
    /*
      D14's competitive promise, tested rather than asserted, and the only way it can be.

      The model is loaded inside a worker thread, which has a module registry of its own: this
      process patching `net` does nothing to it, and neither does assigning `process.execArgv`
      at run time. Both were measured, and a first version of this test patched `net` here and
      passed while the worker was free to download whatever it liked.

      What DOES reach the worker is `--require` on the command line, because a worker created
      with default options inherits the parent's `execArgv` as it stood at start-up. So the
      recognition runs in a child process preloaded with `block-network.cjs`, and it is handed
      `ocrWorkerOptions()` from the module under test rather than a copy of them.
    */
    const child = spawnSync(
      process.execPath,
      [
        '--require',
        here('../test/block-network.cjs'),
        here('../test/offline-ocr.cjs'),
        JSON.stringify(ocrWorkerOptions()),
        here('../test/fixtures/cookbook-page.jpg'),
      ],
      { encoding: 'utf8', timeout: 90_000 },
    );

    expect(child.stderr).toBe('');
    expect(child.status).toBe(0);
    expect(child.stdout).toContain('Skillet Cornbread');
    expect(child.stdout).toContain('1 1/2 cups yellow cornmeal');
  }, 120_000);
});

describe('the uploads that are not photographs of recipes', () => {
  it('answers unreadable for a file that is not an image', async () => {
    const result = await draftFromImage(new TextEncoder().encode('this is prose, not a JPEG'));
    expect(result).toEqual({ ok: false, reason: 'unreadable' });
  }, 60_000);

  it('answers unreadable for an empty upload', async () => {
    expect(await draftFromImage(new Uint8Array(0))).toEqual({ ok: false, reason: 'unreadable' });
  }, 60_000);

  it('goes on working after an unreadable one, rather than shutting OCR down', async () => {
    // The worker reports a bad image through the same `errorHandler` a broken install reports
    // itself through. Treating the two the same would take OCR out for the household until the
    // next restart, on the first cook who uploaded the wrong file.
    await draftFromImage(new TextEncoder().encode('not an image'));
    const after = await draftFromImage(fixture('cookbook-page.jpg'));
    expect(after.ok).toBe(true);
  }, 60_000);

  it('answers no-recipe for a photograph with no recipe in it', async () => {
    // The heuristics decide this, not tesseract, so a stub recogniser is the honest way to say
    // "OCR worked and what it read was not a recipe".
    const recognize = async (): Promise<Recognized> => ({
      ok: true,
      text: 'A signpost, photographed badly.\nTHE OLD MILL 2 MILES',
    });
    // With what OCR read, so the failure can be studied without reading the photo again.
    expect(await draftFromImage(fixture('cookbook-page.jpg'), { recognize })).toEqual({
      ok: false,
      reason: 'no-recipe',
      text: 'A signpost, photographed badly.\nTHE OLD MILL 2 MILES',
    });
  });
});

describe('the caps and the queue', () => {
  it('refuses a file over the size cap without starting OCR', async () => {
    let started = false;
    const recognize = async (): Promise<Recognized> => {
      started = true;
      return { ok: true, text: '' };
    };
    const result = await draftFromImage(new Uint8Array(MAX_IMAGE_BYTES + 1), { recognize });
    expect(result).toEqual({ ok: false, reason: 'too-large' });
    expect(started).toBe(false);
  });

  it('refuses an import once too many are already waiting, rather than queueing it', async () => {
    // Deterministic rather than timed: the queue counts a job as waiting synchronously, so the
    // fourth call in the same tick is over the cap however fast the first three are. Each
    // waiting import holds its upload, and nothing here hears the browser hang up.
    const recognize = async (): Promise<Recognized> => {
      await new Promise((resolve) => setTimeout(resolve, 5));
      return { ok: true, text: '' };
    };
    const results = await Promise.all([
      draftFromImage(new Uint8Array(8), { recognize }),
      draftFromImage(new Uint8Array(8), { recognize }),
      draftFromImage(new Uint8Array(8), { recognize }),
    ]);
    expect(results.filter((r) => !r.ok && r.reason === 'busy')).toHaveLength(1);
  });

  it('runs one OCR pass at a time, however many imports arrive at once', async () => {
    /*
      Task J0 measured OCR as single-threaded - pinning a 12MP recognition to one core left it
      at 1201ms against 1176ms unpinned - so the thing worth bounding is not how long one import
      takes but how many cores four simultaneous imports take away from Postgres and the app.

      The recogniser is stubbed because what is under test is the queue, and four real passes
      would cost four seconds to prove something about scheduling.
    */
    let running = 0;
    let mostAtOnce = 0;
    const recognize = async (): Promise<Recognized> => {
      running += 1;
      mostAtOnce = Math.max(mostAtOnce, running);
      await new Promise((resolve) => setTimeout(resolve, 5));
      running -= 1;
      return { ok: true, text: '' };
    };

    // Two at once, which is what the waiting room admits; the point here is that they do not
    // overlap, and the case above is the one that pins the cap.
    await Promise.all(
      Array.from({ length: 2 }, () => draftFromImage(new Uint8Array(8), { recognize })),
    );
    expect(mostAtOnce).toBe(1);
  });

  it('lets the next import through after one of them fails', async () => {
    // A queue that only advanced on success would be blocked for good by the first import that
    // went wrong.
    const boom = async (): Promise<Recognized> => {
      throw new Error('the recogniser fell over');
    };
    await expect(draftFromImage(new Uint8Array(8), { recognize: boom })).rejects.toThrow();

    const recognize = async (): Promise<Recognized> => ({ ok: true, text: '' });
    expect(await draftFromImage(new Uint8Array(8), { recognize })).toEqual({
      ok: false,
      reason: 'no-recipe',
      text: '',
    });
  });
});

describe('giving up on a worker that will not start', () => {
  /*
    A single failure used to latch for the life of the process, which meant one transient
    allocation failure took OCR out for the household until somebody restarted the server. What
    it is really guarding is narrower than that: `createWorker` neither resolves nor rejects
    when the model fails to load, and the worker thread it started is unreachable, so without
    SOME limit that is one orphaned thread per import for ever.
  */
  it('keeps trying after a failure, and stops after enough of them in a row', () => {
    const latch = createStartupLatch(3);
    expect(latch.worthTrying()).toBe(true);

    latch.failed();
    latch.failed();
    expect(latch.worthTrying()).toBe(true);

    latch.failed();
    expect(latch.worthTrying()).toBe(false);
  });

  it('forgets the failures as soon as one worker starts', () => {
    const latch = createStartupLatch(3);
    latch.failed();
    latch.failed();
    latch.succeeded();
    expect(latch.consecutiveFailures()).toBe(0);
    latch.failed();
    latch.failed();
    expect(latch.worthTrying()).toBe(true);
  });
});

describe('a recipe over several photographs', () => {
  // Page one has the title and ingredients, page two the method, as a page turn splits them.
  const PAGES = [
    'Tomato Soup\nServes 4\n\n2 cups tomatoes\n1 onion\n2 cloves garlic\n1 cup broth',
    '1. Soften the onion and garlic.\n2. Add the tomatoes and broth and simmer 20 minutes.',
  ];

  it('reads the pages in order and joins them into one recipe', async () => {
    const seen: number[] = [];
    const recognize = async (bytes: Uint8Array): Promise<Recognized> => {
      seen.push(bytes[0]!);
      return { ok: true, text: PAGES[bytes[0]!]! };
    };
    const result = await draftFromImages([Uint8Array.of(0), Uint8Array.of(1)], { recognize });
    expect(seen).toEqual([0, 1]);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.draft.title.value).toBe('Tomato Soup');
    expect(result.draft.ingredientLines.value).toHaveLength(4);
    expect(result.draft.steps.value.join(' ')).toContain('simmer 20 minutes');
  });

  it('hands back the text it read, pages joined as the parser was given them', async () => {
    const recognize = async (bytes: Uint8Array): Promise<Recognized> => ({
      ok: true,
      text: PAGES[bytes[0]!]!,
    });
    const result = await draftFromImages([Uint8Array.of(0), Uint8Array.of(1)], { recognize });
    if (!result.ok) throw new Error(`expected a draft, got ${result.reason}`);
    expect(result.text).toBe(`${PAGES[0]}\n\n${PAGES[1]}`);
  });

  it('fails the whole import when one page cannot be read', async () => {
    const recognize = async (bytes: Uint8Array): Promise<Recognized> =>
      bytes[0] === 1 ? { ok: false, reason: 'unreadable' } : { ok: true, text: PAGES[0]! };
    expect(await draftFromImages([Uint8Array.of(0), Uint8Array.of(1)], { recognize })).toEqual({
      ok: false,
      reason: 'unreadable',
    });
  });

  it('refuses too many pages, or too much in all, before any OCR starts', async () => {
    let started = false;
    const recognize = async (): Promise<Recognized> => {
      started = true;
      return { ok: true, text: '' };
    };
    const five = Array.from({ length: MAX_IMAGES_PER_IMPORT + 1 }, () => Uint8Array.of(0));
    expect(await draftFromImages(five, { recognize })).toEqual({ ok: false, reason: 'too-large' });
    const heavy = [0, 1, 2].map(() => new Uint8Array(MAX_IMAGE_BYTES)); // 18MB in all
    expect(await draftFromImages(heavy, { recognize })).toEqual({ ok: false, reason: 'too-large' });
    expect(await draftFromImages([], { recognize })).toEqual({ ok: false, reason: 'unreadable' });
    expect(started).toBe(false);
  });
});
