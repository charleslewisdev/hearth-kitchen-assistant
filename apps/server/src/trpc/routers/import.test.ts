import { describe, it, expect, beforeEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import { importFailuresRoot } from '../../import-failures';
import { TRPCError } from '@trpc/server';
import { getHTTPStatusCodeFromError } from '@trpc/server/http';
import type { FetchPageResult } from '@hearth/enrichment';
import { MAX_URL_LENGTH } from '@hearth/enrichment';
import { base64Length, MAX_PDF_BYTES, MAX_TEXT_LENGTH } from '@hearth/shared';
import {
  createImportRouter,
  IMAGE_FAILURE_MESSAGES,
  IMPORT_FAILURE_MESSAGES,
  KEPT_REASONS,
  NO_RECIPE_IN_TEXT_MESSAGE,
  NO_RECIPE_MESSAGE,
  PDF_FAILURE_MESSAGES,
  UNREADABLE_UPLOAD_MESSAGE,
} from './import';
import { appRouter } from './index';
import { recipeRouter } from './recipe';
import { router } from '../trpc';
import { createLogger } from '../../log';
import { resetDb } from '../../../test/db';
import { asc } from 'drizzle-orm';
import { db, householdWithOwner } from '../../../test/factories';
import { importDraft } from '../../db/schema';
import { testContext } from '../../../test/trpc';
import { capture } from '../../../test/logs';

const RECIPE_URL = 'https://recipes.example.com/everyday-banana-loaf-2886';

function fixturePath(name: string): string {
  return fileURLToPath(
    new URL(`../../../../../packages/enrichment/test/fixtures/${name}`, import.meta.url),
  );
}

function fixture(name: string): string {
  return readFileSync(fixturePath(name), 'utf8');
}

/** A binary fixture as the browser sends one: base64 in a JSON body. */
function upload(name: string): string {
  return readFileSync(fixturePath(name)).toString('base64');
}

/**
 * A caller over the real import router, with no fetcher stub, in a fresh household, signed in as
 * its owner: a photo or PDF import records who ran it on the draft it keeps.
 */
async function uploadCaller() {
  const { householdId, ownerId } = await householdWithOwner();
  return routerWith(async () => ({ ok: false, reason: 'unreachable' })).createCaller(
    testContext({ householdId, session: { user: { id: ownerId } } as never }),
  );
}

/** The import drafts kept, read as the table owner, past RLS. */
const keptDrafts = () => db.select().from(importDraft).orderBy(asc(importDraft.createdAt));

/**
 * The app router with the import fetcher swapped for a stub, so the suite never opens a socket.
 *
 * `recipe` is mounted alongside because one test asserts that importing writes nothing through
 * it, and that assertion is only worth anything if it is asking the real recipe router.
 */
function routerWith(fetch: () => Promise<FetchPageResult>) {
  return router({ import: createImportRouter(fetch), recipe: recipeRouter });
}

/** A caller over that router, in a fresh household. */
async function callerFor(result: FetchPageResult, over: Parameters<typeof testContext>[0] = {}) {
  const { householdId } = await householdWithOwner();
  return routerWith(async () => result).createCaller(
    testContext({ householdId, session: { userId: 'u' } as never, ...over }),
  );
}

const page = (name: string): FetchPageResult => ({
  ok: true,
  html: fixture(name),
  finalUrl: RECIPE_URL,
});

describe('import.fromUrl', () => {
  beforeEach(resetDb);

  it('turns a real recipe page into a draft', async () => {
    const caller = await callerFor(page('ld-plain-object-banana-loaf.html'));
    const draft = await caller.import.fromUrl({ url: RECIPE_URL });

    expect(draft.title.value).toBe('Everyday Banana Loaf');
    expect(draft.title.confidence).toBe('high');
    expect(draft.servings.value).toBe(10);
    expect(draft.ingredientLines.value).toHaveLength(8);
    expect(draft.steps.value).toHaveLength(10);
  });

  it('records the URL the fetch actually ended on, not the one that was pasted', async () => {
    // A site that redirects to its canonical URL should leave the draft pointing at where the
    // recipe really is, which is what the review screen links back to.
    const caller = await callerFor({
      ok: true,
      html: fixture('ld-plain-object-banana-loaf.html'),
      finalUrl: 'https://recipes.example.com/everyday-banana-loaf-2886?after=redirect',
    });
    const draft = await caller.import.fromUrl({ url: RECIPE_URL });
    expect(draft.source).toEqual({
      kind: 'url',
      url: 'https://recipes.example.com/everyday-banana-loaf-2886?after=redirect',
    });
  });

  it('writes nothing to the recipe tables', async () => {
    const caller = await callerFor(page('ld-plain-object-banana-loaf.html'));
    const draft = await caller.import.fromUrl({ url: RECIPE_URL });
    // Import produces a draft. Only `recipe.create`, called from the review screen, writes.
    expect(await caller.recipe.list()).toEqual([]);
    // A page's draft is not kept: the page is still there to be fetched again.
    expect(draft.importDraftId).toBeNull();
    expect(await keptDrafts()).toEqual([]);
  });
});

describe('import.fromUrl: the failures a cook will actually hit', () => {
  beforeEach(resetDb);

  const cases = [
    ['blocked-address', IMPORT_FAILURE_MESSAGES['blocked-address']],
    ['timeout', IMPORT_FAILURE_MESSAGES['timeout']],
    ['too-large', IMPORT_FAILURE_MESSAGES['too-large']],
    ['too-many-redirects', IMPORT_FAILURE_MESSAGES['too-many-redirects']],
    ['bad-scheme', IMPORT_FAILURE_MESSAGES['bad-scheme']],
    ['bad-url', IMPORT_FAILURE_MESSAGES['bad-url']],
    ['unreachable', IMPORT_FAILURE_MESSAGES['unreachable']],
  ] as const;

  it.each(cases)('answers %s with its own plain sentence, not a 500', async (reason, message) => {
    const caller = await callerFor({ ok: false, reason } as FetchPageResult);
    await expect(caller.import.fromUrl({ url: RECIPE_URL })).rejects.toThrow(message);

    // The point of the message is that it is distinct. Every one of these is different.
    expect(new Set(cases.map(([, m]) => m)).size).toBe(cases.length);
  });

  it.each(cases)('%s is a client error, so it never reaches the 500 path', async (reason) => {
    const caller = await callerFor({ ok: false, reason } as FetchPageResult);
    const error = await caller.import.fromUrl({ url: RECIPE_URL }).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(TRPCError);
    expect(getHTTPStatusCodeFromError(error as TRPCError)).toBeLessThan(500);
  });

  it('says so when the page loaded but had no recipe on it', async () => {
    const caller = await callerFor(page('no-recipe-blog-post.html'));
    await expect(caller.import.fromUrl({ url: 'https://example.com/pepper' })).rejects.toThrow(
      NO_RECIPE_MESSAGE,
    );
  });

  it('passes the site status through when the site answered with an error', async () => {
    const caller = await callerFor({ ok: false, reason: 'http-error', status: 404 });
    await expect(caller.import.fromUrl({ url: RECIPE_URL })).rejects.toThrow('404');
  });

  it('refuses a URL longer than the cap at the input, before any fetch', async () => {
    let fetched = false;
    const { householdId } = await householdWithOwner();
    const caller = routerWith(async () => {
      fetched = true;
      return { ok: false, reason: 'unreachable' };
    }).createCaller(testContext({ householdId, session: { userId: 'u' } as never }));
    await expect(
      caller.import.fromUrl({ url: `https://example.com/${'a'.repeat(MAX_URL_LENGTH)}` }),
    ).rejects.toThrow();
    expect(fetched).toBe(false);
  });
});

describe('import.fromUrl: who may call it', () => {
  beforeEach(resetDb);

  it('refuses a caller with no session', async () => {
    const caller = routerWith(async () => page('ld-plain-object-banana-loaf.html')).createCaller(
      testContext(),
    );
    const error = await caller.import.fromUrl({ url: RECIPE_URL }).catch((e: unknown) => e);
    expect((error as TRPCError).code).toBe('UNAUTHORIZED');
  });

  it('refuses a session with no household', async () => {
    const caller = routerWith(async () => page('ld-plain-object-banana-loaf.html')).createCaller(
      testContext({ session: { userId: 'u' } as never, householdId: null }),
    );
    const error = await caller.import.fromUrl({ url: RECIPE_URL }).catch((e: unknown) => e);
    expect((error as TRPCError).code).toBe('FORBIDDEN');
  });
});

describe('import.fromUrl: D38, ids only', () => {
  beforeEach(resetDb);

  it('logs no URL, no title and no ingredient text', async () => {
    const { sink, lines } = capture();
    const caller = await callerFor(page('ld-plain-object-banana-loaf.html'), {
      log: createLogger({ level: 'debug', pretty: false, destination: sink }),
    });
    await caller.import.fromUrl({ url: RECIPE_URL });

    const written = JSON.stringify(lines());
    expect(written).not.toContain('recipes.example.com');
    expect(written).not.toContain('Everyday Banana Loaf');
    expect(written).not.toContain('banana');
    // The middleware's own line is still there: procedure, type, duration, outcome.
    expect(lines().some((l) => l['path'] === 'import.fromUrl')).toBe(true);
  });

  it('logs no URL when the fetch was refused either', async () => {
    const { sink, lines } = capture();
    const caller = await callerFor(
      { ok: false, reason: 'blocked-address' },
      {
        log: createLogger({ level: 'debug', pretty: false, destination: sink }),
      },
    );
    await caller.import.fromUrl({ url: 'http://192.168.1.1/admin' }).catch(() => undefined);
    expect(JSON.stringify(lines())).not.toContain('192.168.1.1');
  });
});

describe('the router that is actually wired up', () => {
  beforeEach(resetDb);

  it('uses the SSRF-safe fetcher by default', async () => {
    // No injection: `appRouter` is what the server serves, and this proves its import path
    // refuses a LAN address rather than fetching it.
    const { householdId } = await householdWithOwner();
    const caller = appRouter.createCaller(
      testContext({ householdId, session: { userId: 'u' } as never }),
    );
    await expect(caller.import.fromUrl({ url: 'http://127.0.0.1:5432/' })).rejects.toThrow(
      IMPORT_FAILURE_MESSAGES['blocked-address'],
    );
  });
});

describe('import.fromText', () => {
  beforeEach(resetDb);

  const PASTED = `Weeknight Lentil Soup

Serves 4

2 Tbsp olive oil
1 onion, diced
1 cup brown lentils
4 cups vegetable stock

Soften the onion in the oil, add the lentils and the stock, and simmer for half an hour.`;

  it('turns a pasted recipe into a draft', async () => {
    const caller = await uploadCaller();
    const draft = await caller.import.fromText({ text: PASTED });

    expect(draft.title.value).toBe('Weeknight Lentil Soup');
    expect(draft.servings.value).toBe(4);
    expect(draft.ingredientLines.value).toHaveLength(4);
    expect(draft.steps.value).toHaveLength(1);
    expect(draft.source).toEqual({ kind: 'text' });
  });

  it('flags everything, because a paste states nothing', async () => {
    const caller = await uploadCaller();
    const draft = await caller.import.fromText({ text: PASTED });
    // The whole point of routing a blob through the same review screen: an unearned `high` on
    // the steps is exactly the thing the amber flags exist to catch.
    expect(draft.steps.confidence).toBe('low');
    expect(draft.ingredientLines.confidence).toBe('low');
  });

  it('says so when the text had no recipe in it', async () => {
    const caller = await uploadCaller();
    await expect(
      caller.import.fromText({ text: 'It goes stale. That is the whole post.' }),
    ).rejects.toThrow(NO_RECIPE_IN_TEXT_MESSAGE);
  });

  it('refuses text longer than the cap, and refuses an empty box', async () => {
    const caller = await uploadCaller();
    await expect(
      caller.import.fromText({ text: 'a'.repeat(MAX_TEXT_LENGTH + 1) }),
    ).rejects.toThrow();
    await expect(caller.import.fromText({ text: '' })).rejects.toThrow();
  });

  it('writes nothing to the recipe tables, and keeps no draft', async () => {
    const caller = await uploadCaller();
    const draft = await caller.import.fromText({ text: PASTED });
    expect(await caller.recipe.list()).toEqual([]);
    expect(draft.importDraftId).toBeNull();
    expect(await keptDrafts()).toEqual([]);
  });
});

describe('import.fromPdf', () => {
  beforeEach(resetDb);

  it('turns an uploaded PDF into a draft', async () => {
    const caller = await uploadCaller();
    const draft = await caller.import.fromPdf({ fileBase64: upload('cookbook-page.pdf') });

    expect(draft.title.value).toBe('Skillet Cornbread');
    expect(draft.ingredientLines.value).toHaveLength(9);
    expect(draft.steps.value).toHaveLength(5);
    expect(draft.source).toEqual({ kind: 'pdf' });
  });

  it('keeps what it read off the text layer, and hands back the id to save it with', async () => {
    const caller = await uploadCaller();
    const draft = await caller.import.fromPdf({ fileBase64: upload('cookbook-page.pdf') });

    const [kept] = await keptDrafts();
    expect(draft.importDraftId).toBe(kept!.id);
    expect(kept).toMatchObject({ reading: 'pdf_text', title: 'Skillet Cornbread', recipeId: null });
    expect(kept!.sourceText).toContain('Skillet Cornbread');

    const saved = await caller.recipe.create({
      title: 'Skillet Cornbread',
      importDraftId: draft.importDraftId!,
    });
    const [linked] = await keptDrafts();
    expect(linked).toMatchObject({ recipeId: saved.id, createdBy: expect.any(String) });
  });

  it('reads a scanned PDF by OCR, and keeps the PDF as its source', async () => {
    const caller = await uploadCaller();
    const draft = await caller.import.fromPdf({ fileBase64: upload('scanned-cookbook.pdf') });

    expect(draft.title.value).toBe('Skillet Cornbread');
    expect(draft.ingredientLines.value).toHaveLength(9);
    expect(draft.source).toEqual({ kind: 'pdf' });
    const [kept] = await keptDrafts();
    expect(kept).toMatchObject({ id: draft.importDraftId, reading: 'pdf_ocr' });
  }, 60_000);

  it('sends a PDF with nothing to read to the photo tile rather than calling it empty', async () => {
    const caller = await uploadCaller();
    await expect(
      caller.import.fromPdf({ fileBase64: upload('scanned-tiny-image.pdf') }),
    ).rejects.toThrow(PDF_FAILURE_MESSAGES['no-text-layer']);
  });

  it('answers a scan longer than one import with its own sentence', async () => {
    const caller = await uploadCaller();
    await expect(
      caller.import.fromPdf({ fileBase64: upload('scanned-five-pages.pdf') }),
    ).rejects.toThrow(PDF_FAILURE_MESSAGES['scan-too-long']);
  });

  it('has a different sentence for every PDF failure', () => {
    const messages = Object.values(PDF_FAILURE_MESSAGES);
    expect(new Set(messages).size).toBe(messages.length);
  });

  it('keeps a PDF with no recipe in it, with the text it read', async () => {
    const { householdId } = await householdWithOwner();
    const { sink, lines } = capture();
    const caller = routerWith(async () => ({ ok: false, reason: 'unreachable' })).createCaller(
      testContext({
        householdId,
        session: { userId: 'u' } as never,
        log: createLogger({ level: 'info', pretty: false, destination: sink }),
      }),
    );
    await expect(
      caller.import.fromPdf({ fileBase64: upload('no-recipe-article.pdf') }),
    ).rejects.toThrow(PDF_FAILURE_MESSAGES['no-recipe']);

    const warned = lines().find((l) => l.msg === 'import failed; upload kept');
    expect(warned).toMatchObject({ kind: 'pdf', reason: 'no-recipe' });
    if (!warned) return;
    const dir = join(importFailuresRoot(), householdId, warned.failureId as string);
    expect(readFileSync(join(dir, 'text.txt'), 'utf8').length).toBeGreaterThan(0);
  });

  it('keeps a scan that held no recipe, which is a finding about the parser', () => {
    // The router's own OCR cannot be stubbed, so this pins the list the scan failure goes through.
    expect(KEPT_REASONS.has('no-recipe-in-scan')).toBe(true);
    expect(KEPT_REASONS.has('busy')).toBe(false);
  });

  it('answers a malformed PDF with a sentence rather than a 500', async () => {
    const caller = await uploadCaller();
    const error = await caller.import
      .fromPdf({ fileBase64: Buffer.from('not a pdf').toString('base64') })
      .catch((e: unknown) => e);
    expect((error as TRPCError).message).toBe(PDF_FAILURE_MESSAGES.malformed);
    expect(getHTTPStatusCodeFromError(error as TRPCError)).toBeLessThan(500);
  });

  it('answers a PDF with too many pages in it', async () => {
    const caller = await uploadCaller();
    await expect(caller.import.fromPdf({ fileBase64: upload('many-pages.pdf') })).rejects.toThrow(
      PDF_FAILURE_MESSAGES['too-many-pages'],
    );
  });

  it('refuses an upload over the size cap at the input, before decoding it', async () => {
    // The cap on the INPUT is the encoded length, because that is what can be checked before
    // several megabytes are turned into a Buffer.
    const caller = await uploadCaller();
    const tooLong = 'A'.repeat(base64Length(MAX_PDF_BYTES) + 4);
    const error = await caller.import.fromPdf({ fileBase64: tooLong }).catch((e: unknown) => e);
    expect((error as TRPCError).code).toBe('BAD_REQUEST');
    expect((error as TRPCError).message).not.toBe(PDF_FAILURE_MESSAGES['too-large']);
  });

  it('refuses an upload that is not base64 at all', async () => {
    const caller = await uploadCaller();
    await expect(caller.import.fromPdf({ fileBase64: 'not base64!!' })).rejects.toThrow(
      UNREADABLE_UPLOAD_MESSAGE,
    );
  });
});

describe('import.fromImage', () => {
  beforeEach(resetDb);

  it('turns a photograph of a page into a draft', async () => {
    const caller = await uploadCaller();
    const draft = await caller.import.fromImage({ fileBase64: upload('cookbook-page.jpg') });

    expect(draft.title.value).toBe('Skillet Cornbread');
    expect(draft.ingredientLines.value).toHaveLength(9);
    expect(draft.source).toEqual({ kind: 'image' });
    const [kept] = await keptDrafts();
    expect(kept).toMatchObject({ id: draft.importDraftId, reading: 'photo_ocr' });
    expect(kept!.sourceText).toMatch(/cornbread/i);
  }, 60_000);

  it('answers a file that is not an image with a sentence rather than a 500', async () => {
    const caller = await uploadCaller();
    const error = await caller.import
      .fromImage({ fileBase64: Buffer.from('prose, not a photo').toString('base64') })
      .catch((e: unknown) => e);
    expect((error as TRPCError).message).toBe(IMAGE_FAILURE_MESSAGES.unreadable);
    expect(getHTTPStatusCodeFromError(error as TRPCError)).toBeLessThan(500);
  }, 60_000);

  it('keeps a photo it could not read, with why, for studying the parser later', async () => {
    const { householdId } = await householdWithOwner();
    const { sink, lines } = capture();
    const caller = routerWith(async () => ({ ok: false, reason: 'unreachable' })).createCaller(
      testContext({
        householdId,
        session: { userId: 'u' } as never,
        log: createLogger({ level: 'info', pretty: false, destination: sink }),
      }),
    );
    const bytes = Buffer.from('prose, not a photo');
    await caller.import.fromImage({ fileBase64: bytes.toString('base64') }).catch(() => {});

    const warned = lines().find((l) => l.msg === 'import failed; upload kept')!;
    expect(warned).toMatchObject({ kind: 'image', reason: 'unreadable', pages: 1 });
    const dir = join(importFailuresRoot(), householdId, warned.failureId as string);
    expect(readFileSync(join(dir, 'page-1.jpg')).equals(bytes)).toBe(true);
    expect(JSON.parse(readFileSync(join(dir, 'meta.json'), 'utf8'))).toMatchObject({
      kind: 'image',
      reason: 'unreadable',
    });
  }, 60_000);

  it('reads a recipe sent as a list of pages', async () => {
    const caller = await uploadCaller();
    const draft = await caller.import.fromImage({ pagesBase64: [upload('cookbook-page.jpg')] });
    expect(draft.title.value).toBe('Skillet Cornbread');
  }, 60_000);

  it('refuses both shapes at once, neither, and more pages than a recipe spans', async () => {
    const caller = await uploadCaller();
    const page = Buffer.from('x').toString('base64');
    const codeOf = (p: Promise<unknown>) =>
      p.then(
        () => null,
        (e: TRPCError) => e.code,
      );
    expect(await codeOf(caller.import.fromImage({ fileBase64: page, pagesBase64: [page] }))).toBe(
      'BAD_REQUEST',
    );
    expect(await codeOf(caller.import.fromImage({}))).toBe('BAD_REQUEST');
    expect(
      await codeOf(caller.import.fromImage({ pagesBase64: [page, page, page, page, page] })),
    ).toBe('BAD_REQUEST');
  });

  it('writes nothing to the recipe tables', async () => {
    const caller = await uploadCaller();
    await caller.import.fromImage({ fileBase64: upload('cookbook-page.jpg') });
    expect(await caller.recipe.list()).toEqual([]);
  }, 60_000);
});

describe('the other sources: who may call them, and what is logged', () => {
  beforeEach(resetDb);

  it.each(['fromText', 'fromPdf', 'fromImage'] as const)(
    '%s refuses a caller with no session',
    async (procedure) => {
      const caller = routerWith(async () => ({ ok: false, reason: 'unreachable' })).createCaller(
        testContext(),
      );
      const input = procedure === 'fromText' ? { text: 'x' } : { fileBase64: 'AAAA' };
      const error = await caller.import[procedure](input as never).catch((e: unknown) => e);
      expect((error as TRPCError).code).toBe('UNAUTHORIZED');
    },
  );

  it('logs no pasted text and no recipe title', async () => {
    const { sink, lines } = capture();
    const { householdId } = await householdWithOwner();
    const caller = routerWith(async () => ({ ok: false, reason: 'unreachable' })).createCaller(
      testContext({
        householdId,
        session: { userId: 'u' } as never,
        log: createLogger({ level: 'debug', pretty: false, destination: sink }),
      }),
    );
    await caller.import.fromText({
      text: 'Nanas Rhubarb Fool\n\n2 cups rhubarb\n1 cup cream\n3 Tbsp sugar\n\nFold it together.',
    });

    const written = JSON.stringify(lines());
    expect(written).not.toContain('Rhubarb');
    expect(written).not.toContain('rhubarb');
    expect(written).not.toContain('cream');
    expect(lines().some((l) => l['path'] === 'import.fromText')).toBe(true);
  });
});

describe('D38 for the sources that carry a file, and for their failures', () => {
  beforeEach(resetDb);

  /** A caller whose log this test can read. */
  async function loggedCaller() {
    const { sink, lines } = capture();
    const { householdId } = await householdWithOwner();
    const caller = routerWith(async () => ({ ok: false, reason: 'unreachable' })).createCaller(
      testContext({
        householdId,
        session: { userId: 'u' } as never,
        log: createLogger({ level: 'debug', pretty: false, destination: sink }),
      }),
    );
    return { caller, lines };
  }

  it('logs nothing off a PDF it read', async () => {
    const { caller, lines } = await loggedCaller();
    await caller.import.fromPdf({ fileBase64: upload('cookbook-page.pdf') });

    const written = JSON.stringify(lines());
    expect(written).not.toContain('Cornbread');
    expect(written).not.toContain('cornmeal');
    expect(written).not.toContain('buttermilk');
    expect(lines().some((l) => l['path'] === 'import.fromPdf')).toBe(true);
  });

  it('logs nothing off a photograph it read', async () => {
    const { caller, lines } = await loggedCaller();
    await caller.import.fromImage({ fileBase64: upload('cookbook-page.jpg') });

    const written = JSON.stringify(lines());
    expect(written).not.toContain('Cornbread');
    expect(written).not.toContain('cornmeal');
    expect(lines().some((l) => l['path'] === 'import.fromImage')).toBe(true);
  });

  it('logs no upload when the file was refused, either', async () => {
    // The failure paths are the tempting ones: a refusal is exactly when somebody reaches for
    // "just log what it was". The base64 IS the file, so none of it may appear.
    const { caller, lines } = await loggedCaller();
    const notAPdf = Buffer.from('Nanas Rhubarb Fool, 2 cups rhubarb').toString('base64');
    await caller.import.fromPdf({ fileBase64: notAPdf }).catch(() => undefined);
    await caller.import.fromImage({ fileBase64: notAPdf }).catch(() => undefined);

    const written = JSON.stringify(lines());
    expect(written).not.toContain('Rhubarb');
    expect(written).not.toContain('rhubarb');
    expect(written).not.toContain(notAPdf);
    expect(written).not.toContain(notAPdf.slice(0, 16));
  }, 60_000);
});
