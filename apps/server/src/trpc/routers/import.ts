import { z } from 'zod';
import {
  draftFromHtml,
  draftFromImages,
  draftFromPdf,
  draftFromText,
  fetchPage,
  MAX_PDF_PAGES,
  MAX_URL_LENGTH,
} from '@hearth/enrichment';
import type {
  FetchFailureReason,
  FetchPageResult,
  ImageFailureReason,
  PdfFailureReason,
  RecipeDraft,
} from '@hearth/enrichment';
import {
  base64Length,
  MAX_IMAGE_BYTES,
  MAX_IMAGE_IMPORT_BYTES,
  MAX_IMAGES_PER_IMPORT,
  MAX_PDF_BYTES,
  MAX_TEXT_LENGTH,
} from '@hearth/shared';
import { TRPCError } from '@trpc/server';
import { keepFailedImport } from '../../import-failures';
import { keepImportDraft, type ImportReading } from '../../repo/import-drafts';
import { router, protectedProcedure } from '../trpc';

/**
 * Importing a recipe from a link, a paste, a PDF or a photograph.
 *
 * This router does not write the recipe tables. It fetches, extracts, and hands back a
 * `RecipeDraft`; the review screen edits it and submits it through the existing `recipe.create`.
 * That is what keeps import from having a second write path into the recipe tables, and what
 * makes an imported recipe inherit every guarantee `recipe.create` already has. What it does
 * write is for studying the parser: a photo or PDF's draft (`import_draft`, D51) and a failed
 * upload (`import-failures.ts`).
 *
 * D38: the URL, the title and the ingredient lines are all user content, and nothing here logs
 * any of them. The tRPC middleware already records procedure, type, duration and outcome, which
 * is what a support question actually needs.
 */

/**
 * The slice of the fetcher this router depends on, so a test can substitute one.
 *
 * Narrow on purpose, and for the same reason `MailTransport` is: a wider seam invites a test to
 * exercise the fetcher instead of this module, and the one thing the suite must never do is
 * open a socket. `import.test.ts` still covers the real wiring - it calls `appRouter` with a
 * loopback URL and watches it get refused.
 */
export type PageFetcher = (url: string) => Promise<FetchPageResult>;

/**
 * What a cook is told when a fetch does not produce a page.
 *
 * Every one of these is an expected input rather than a fault: a blocked address, a site that
 * is down, a link that was really a PDF. They are phrased as something that happened and, where
 * there is one, what to do instead - not as an error code, and never as a stack trace.
 *
 * Typed against `FetchFailureReason` so a reason added to the fetcher without a sentence here
 * is a compile error rather than an `undefined` in front of somebody.
 */
export const IMPORT_FAILURE_MESSAGES: Record<Exclude<FetchFailureReason, 'http-error'>, string> = {
  'bad-url': 'That does not look like a web address. Paste the link to the recipe page.',
  'bad-scheme': 'Recipe links have to start with http:// or https://.',
  'blocked-address':
    'That link points into this server’s own network rather than out to the web, so Hearth will not open it.',
  'too-many-redirects': 'That link kept redirecting, so Hearth stopped following it.',
  'too-large': 'That page is too large to import. Try the printable version of the recipe.',
  timeout: 'That site took too long to answer. Try again in a moment.',
  unreachable: 'That site could not be reached.',
};

/** What a cook is told when the page loaded fine and simply had no recipe on it. */
export const NO_RECIPE_MESSAGE =
  'No recipe was found on that page. If it is behind a paywall or drawn by a script, copying the text in is the way through.';

/** What a cook is told when a paste turned out not to have a recipe in it. */
export const NO_RECIPE_IN_TEXT_MESSAGE =
  'No recipe was found in that text. An ingredient list with amounts on it is what Hearth looks for.';

/**
 * What a cook is told about a PDF that did not become a recipe.
 *
 * A scanned PDF is read by OCR, so the scan's own failures are the photo path's, said about a
 * scan. `no-text-layer` is what is left: a PDF with no text and no page-sized image in it, such
 * as one drawn only in vectors, where the useful thing to say is which other tile to press.
 */
export const PDF_FAILURE_MESSAGES: Record<PdfFailureReason, string> = {
  'too-large': 'That PDF is too large to import. Try saving just the recipe pages.',
  'too-many-pages': `That PDF has more than ${MAX_PDF_PAGES} pages in it. Try saving just the recipe.`,
  'too-much-content':
    'There is far more text in that PDF than a recipe has. Try saving just the recipe pages.',
  busy: 'Hearth is reading another file. Try again in a moment.',
  malformed: 'Hearth could not read that PDF. It may be damaged, or protected with a password.',
  'no-text-layer':
    'That PDF has no text in it and no scanned page Hearth can read. Photograph the page and use Photo instead.',
  'no-recipe': 'No recipe was found in that PDF.',
  'scan-too-long': `That PDF is a scan of more than ${MAX_IMAGES_PER_IMPORT} pages. Try saving just the recipe pages.`,
  'ocr-unavailable':
    'That PDF is a scan, and reading text from scans is not working on this server. Its language data is missing.',
  'timed-out':
    'Reading that scan took too long, so Hearth stopped. Try saving just the recipe pages.',
  'no-recipe-in-scan':
    'No recipe was found in that scan. A straight, sharp scan of just the recipe usually reads better.',
};

/** What a cook is told about a photograph that did not become a recipe. */
export const IMAGE_FAILURE_MESSAGES: Record<ImageFailureReason, string> = {
  'too-large': 'That photo is too large to import. Take it again at a smaller size.',
  unreadable: 'That file could not be read as an image.',
  'ocr-unavailable':
    'Reading text from photos is not working on this server. Its language data is missing.',
  'timed-out': 'Reading that photo took too long, so Hearth stopped. Try a smaller one.',
  busy: 'Hearth is reading another photo. Try again in a moment.',
  'no-recipe':
    'No recipe was found in that photo. A flatter, better lit shot of the page usually reads better.',
};

/**
 * An upload as bytes, or `null` when the string was not base64.
 *
 * The character check is not decoration: `Buffer.from(s, 'base64')` silently discards anything
 * outside the alphabet, so without it a JPEG that arrived corrupted, or a string that was never
 * base64 at all, becomes a shorter buffer of plausible-looking bytes and the failure surfaces
 * much further downstream as "that is not an image".
 */
/** One photograph as it travels: base64, capped before anything is decoded. */
const imageUpload = z.string().min(1).max(base64Length(MAX_IMAGE_BYTES));

function decodeUpload(encoded: string): Uint8Array | null {
  if (!/^[A-Za-z0-9+/]*={0,2}$/.test(encoded)) return null;
  const bytes = Buffer.from(encoded, 'base64');
  return bytes.byteLength === 0 ? null : new Uint8Array(bytes);
}

/** What a cook is told when the upload was not base64 at all, which is a bug, not a bad file. */
export const UNREADABLE_UPLOAD_MESSAGE = 'That file could not be read. Try choosing it again.';

function refuse(message: string): never {
  // BAD_REQUEST, not INTERNAL_SERVER_ERROR: none of these is a fault in Hearth, and a 500 would
  // be logged at `error` by the middleware and would reach Fastify's error handler. They are
  // answers to a question the cook asked.
  throw new TRPCError({ code: 'BAD_REQUEST', message });
}

/**
 * The import router, over a given fetcher.
 *
 * A factory rather than a bare router so the fetcher can be substituted in tests; `importRouter`
 * below is the one the app serves, and it is built over the real, SSRF-safe fetcher.
 */
/**
 * The failures worth keeping the upload for: the ones that say something about the file. A
 * busy OCR queue, missing language data or an oversized upload says nothing about the page.
 */
export const KEPT_REASONS: ReadonlySet<string> = new Set([
  'no-recipe',
  'no-recipe-in-scan',
  'unreadable',
  'timed-out',
  'malformed',
  'no-text-layer',
  'too-much-content',
  'scan-too-long',
]);

/**
 * Keep a failed photo or PDF import for studying the parser (`import-failures.ts`). Best
 * effort: the cook is told about the failure either way, and a full disk must not turn a
 * "no recipe found" into a 500.
 */
async function keepForStudy(
  ctx: { householdId: string; log: { warn: (obj: object, msg: string) => void } },
  kind: 'image' | 'pdf',
  reason: string,
  files: Uint8Array[],
  text?: string,
): Promise<void> {
  if (!KEPT_REASONS.has(reason)) return;
  try {
    const failureId = await keepFailedImport(ctx.householdId, { kind, reason, files, text });
    ctx.log.warn({ failureId, kind, reason, pages: files.length }, 'import failed; upload kept');
  } catch {
    ctx.log.warn({ kind, reason }, 'import failed; upload could not be kept');
  }
}

/**
 * What every import procedure hands back: the draft, and for a photo or PDF the id of the copy
 * kept for studying the parser (`repo/import-drafts.ts`), which `recipe.create` links on save.
 * Null for a link or a paste, and when the copy could not be kept.
 */
export type ImportedDraft = RecipeDraft & { importDraftId: string | null };

/**
 * Keep the parser's draft of a photo or PDF. Best effort, like `keepForStudy`: a failed write
 * costs the study copy, never the import.
 */
async function keepDraft(
  ctx: {
    householdId: string;
    session: { user: { id: string } };
    log: { warn: (obj: object, msg: string) => void };
  },
  draft: RecipeDraft,
  text: string,
  reading: ImportReading,
): Promise<ImportedDraft> {
  try {
    const importDraftId = await keepImportDraft(ctx.householdId, ctx.session.user.id, {
      draft,
      text,
      reading,
    });
    return { ...draft, importDraftId };
  } catch {
    ctx.log.warn({ reading }, 'import draft could not be kept');
    return { ...draft, importDraftId: null };
  }
}

export function createImportRouter(fetch: PageFetcher = fetchPage) {
  return router({
    /**
     * Fetch a page and hand back a draft of the recipe on it.
     *
     * A mutation rather than a query: it makes the server open an outbound connection, which is
     * not something a cache or a retry should be free to repeat, and a cook reaches it by
     * pressing a button rather than by looking at a screen.
     *
     * The length cap is `MAX_URL_LENGTH`, the same constant the fetcher enforces, so there is
     * one number rather than a looser second one here - the mistake `MAX_SEARCH_LENGTH` was
     * exported to avoid.
     */
    fromUrl: protectedProcedure
      .input(z.object({ url: z.string().min(1).max(MAX_URL_LENGTH) }))
      .mutation(async ({ input }): Promise<ImportedDraft> => {
        const fetched = await fetch(input.url);

        if (!fetched.ok) {
          if (fetched.reason === 'http-error') {
            refuse(`That page could not be read: the site answered ${fetched.status}.`);
          }
          refuse(IMPORT_FAILURE_MESSAGES[fetched.reason]);
        }

        // The URL the fetch ENDED on, so a draft points at where the recipe really lives rather
        // than at the shortener or the tracking link it was shared through.
        const draft = draftFromHtml(fetched.html, fetched.finalUrl);
        if (!draft) refuse(NO_RECIPE_MESSAGE);
        return { ...draft, importDraftId: null };
      }),

    /**
     * Read a recipe out of text a cook pasted.
     *
     * The only source with no decoder in front of it, and the one that always works: it is what
     * a paywalled page, a screenshot's caption, or an email from a relative comes in as.
     */
    fromText: protectedProcedure
      .input(z.object({ text: z.string().min(1).max(MAX_TEXT_LENGTH) }))
      .mutation(({ input }): ImportedDraft => {
        const draft = draftFromText(input.text, { kind: 'text' });
        if (!draft) refuse(NO_RECIPE_IN_TEXT_MESSAGE);
        return { ...draft, importDraftId: null };
      }),

    /**
     * Read a recipe out of an uploaded PDF.
     *
     * The upload arrives as base64 in the JSON body, which is why the cap on the input is
     * `base64Length(MAX_PDF_BYTES)`: it refuses an oversized upload at the edge, before a
     * megabyte of it is decoded. `draftFromPdf` checks the decoded length again, because the
     * two numbers are about different things and only the second one is the real bound.
     *
     * A scanned PDF is OCR'd inside `draftFromPdf`, so it takes seconds like a photo does
     * (measured: 3.4s for a one-page 2040x2048 scan) and waits in the same OCR queue.
     */
    fromPdf: protectedProcedure
      .input(z.object({ fileBase64: z.string().min(1).max(base64Length(MAX_PDF_BYTES)) }))
      .mutation(async ({ ctx, input }): Promise<ImportedDraft> => {
        const bytes = decodeUpload(input.fileBase64);
        if (!bytes) refuse(UNREADABLE_UPLOAD_MESSAGE);

        const result = await draftFromPdf(bytes);
        if (!result.ok) {
          await keepForStudy(ctx, 'pdf', result.reason, [bytes], result.text);
          refuse(PDF_FAILURE_MESSAGES[result.reason]);
        }
        return keepDraft(ctx, result.draft, result.text, result.scanned ? 'pdf_ocr' : 'pdf_text');
      }),

    /**
     * Read a recipe off a photograph of a page.
     *
     * Slow by the standards of everything else here - about a second for a page, measured in
     * Task J0 - and synchronous anyway, because a second is not long enough to be worth a job
     * table, a poll, and a new household-scoped table with RLS on it. The concurrency bound
     * lives in `draftFromImage`, where it can queue the recognitions rather than the requests.
     */
    //
    // A recipe over a page turn arrives as `pagesBase64`, in page order. `fileBase64` is the one
    // photo the procedure always took, kept so a tab opened before an upgrade still imports.
    fromImage: protectedProcedure
      .input(
        z
          .object({
            fileBase64: imageUpload.optional(),
            pagesBase64: z.array(imageUpload).min(1).max(MAX_IMAGES_PER_IMPORT).optional(),
          })
          .refine((v) => (v.fileBase64 === undefined) !== (v.pagesBase64 === undefined), {
            message: 'Send one photo or a list of pages.',
          })
          .refine(
            (v) =>
              (v.pagesBase64 ?? []).reduce((n, page) => n + page.length, 0) <=
              base64Length(MAX_IMAGE_IMPORT_BYTES),
            { message: 'Those photos are too large together.' },
          ),
      )
      .mutation(async ({ ctx, input }): Promise<ImportedDraft> => {
        const pages: Uint8Array[] = [];
        for (const encoded of input.pagesBase64 ?? [input.fileBase64!]) {
          const bytes = decodeUpload(encoded);
          if (!bytes) refuse(UNREADABLE_UPLOAD_MESSAGE);
          pages.push(bytes);
        }

        const result = await draftFromImages(pages);
        if (!result.ok) {
          await keepForStudy(ctx, 'image', result.reason, pages, result.text);
          refuse(IMAGE_FAILURE_MESSAGES[result.reason]);
        }
        return keepDraft(ctx, result.draft, result.text, 'photo_ocr');
      }),
  });
}

export const importRouter = createImportRouter();
