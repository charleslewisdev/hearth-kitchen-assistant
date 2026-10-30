import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import {
  MAX_IMAGE_BYTES,
  MAX_IMAGE_IMPORT_BYTES,
  MAX_IMAGES_PER_IMPORT,
  MAX_PDF_BYTES,
  MAX_TEXT_LENGTH,
} from '@hearth/shared';
import { trpc } from '../lib/trpc';
import { downscaleForOcr, toBase64 } from '../lib/image-upload';
import { ImportReview, type SourceFiles } from './ImportReview';
import styles from './Import.module.css';
import { useDocumentTitle } from '../lib/useDocumentTitle';

/**
 * Where a recipe comes in from (D29).
 *
 * Source tiles rather than one box, because the cook already knows which of these they have -
 * a link, a photo of a cookbook page, a PDF, some pasted text - and picking is faster than
 * being asked to explain. The link and text tiles open their field inline rather than
 * navigating, so choosing wrong costs nothing; the two file tiles are labels over a file input,
 * so pressing one opens the picker straight away.
 *
 * The reassurance line is permanent and is a competitive position, not decoration (D14): image
 * import works in the box with no API key, which is the thing Mealie asks OpenAI for.
 *
 * Every tile ends in the same place. All four procedures return the same `RecipeDraft`, which
 * is what lets one review screen serve all of them.
 */

/** Which inline field, if any, is open. The two file tiles never open one. */
type OpenField = 'link' | 'text' | null;

/**
 * What a file bigger than the server will take is called on this screen.
 *
 * The caps are the server's own, from `@hearth/shared`, so the browser cannot promise something
 * the server then refuses. Checking here is a courtesy - it saves uploading eight megabytes to
 * be told no - and the server enforces them again on the bytes it received, because a browser
 * is not a boundary.
 */
const TOO_LARGE = {
  pdf: 'That PDF is too large to import. Try saving just the recipe pages.',
  image: 'That photo is too large to import. Take it again at a smaller size.',
} as const;

const TOO_MANY_PHOTOS = `Choose up to ${MAX_IMAGES_PER_IMPORT} photos for one recipe.`;
const PHOTOS_TOO_LARGE = 'Those photos are too large together. Try fewer, or retake them smaller.';

/**
 * The order the Pages step first shows several photos in, before the cook checks it.
 *
 * By file name, counted the way a person counts (`IMG_2` before `IMG_10`), because a phone
 * camera numbers its files in the order it took them. Not by `lastModified`: copying, sharing
 * or downloading a photo rewrites that, and page 3 once came first because of it. When the
 * names repeat - iOS hands every photo over as `image.jpg` - a name says nothing, so the order
 * the picker gave is kept. Either way it is only a starting point; the cook has the last word.
 */
export function defaultPageOrder(files: File[]): File[] {
  const names = new Set(files.map((file) => file.name));
  if (names.size !== files.length) return [...files];
  return [...files].sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true }));
}

/** One photo in the Pages step. The id keeps React's identity for it as it moves. */
interface ChosenPage {
  id: number;
  file: File;
}

let nextPageId = 0;

/**
 * A small preview of one page, so the cook can tell the pages apart by more than a file name.
 *
 * The object URL belongs to this thumbnail: made when it mounts and handed back when it goes,
 * which covers every way a page leaves - removed, cancelled, or the screen unmounting.
 */
function PageThumb({ file }: { file: File }) {
  const [src, setSrc] = useState<string | null>(null);
  useEffect(() => {
    const url = URL.createObjectURL(file);
    setSrc(url);
    return () => URL.revokeObjectURL(url);
  }, [file]);
  return src ? (
    <img className={styles.thumb} src={src} alt="" />
  ) : (
    <span className={styles.thumb} aria-hidden="true" />
  );
}

export function Import() {
  useDocumentTitle('Add a recipe');
  const [url, setUrl] = useState('');
  const [text, setText] = useState('');
  const [open, setOpen] = useState<OpenField>(null);
  /** A refusal this screen made on its own, before anything was sent. */
  const [fileProblem, setFileProblem] = useState<string | null>(null);
  const [reading, setReading] = useState(false);
  /** Several photos waiting for the cook to confirm their order, or null outside that step. */
  const [pages, setPages] = useState<ChosenPage[] | null>(null);
  /** What a photo or PDF import was read from, kept with the recipe once it is saved. */
  const [sourceFiles, setSourceFiles] = useState<SourceFiles | null>(null);

  const fromUrl = trpc.import.fromUrl.useMutation();
  const fromText = trpc.import.fromText.useMutation();
  const fromPdf = trpc.import.fromPdf.useMutation();
  const fromImage = trpc.import.fromImage.useMutation();
  const sources = [fromUrl, fromText, fromPdf, fromImage];

  // The draft lives here, in memory, and is deliberately not a route of its own: it is unsaved
  // work, and a URL that could be reloaded would either lose it or re-fetch the page.
  const draft = fromUrl.data ?? fromText.data ?? fromPdf.data ?? fromImage.data;
  const busy = reading || sources.some((source) => source.isPending);
  // The server's own sentence, which is written for a cook. Never a stack trace, and never
  // "something went wrong": a blocked address, a scanned PDF and a photo of a signpost are
  // different problems with different things to do about them.
  const serverProblem = sources.find((source) => source.isError)?.error?.message ?? null;
  const problem = fileProblem ?? serverProblem;

  function forget() {
    for (const source of sources) source.reset();
    setFileProblem(null);
  }

  function startOver() {
    forget();
    setPages(null);
    setSourceFiles(null);
    setUrl('');
    setText('');
    setOpen('link');
  }

  function reveal(field: Exclude<OpenField, null>) {
    forget();
    setOpen((current) => (current === field ? null : field));
  }

  /**
   * Read a chosen file and send it.
   *
   * A photo is reduced first (see `image-upload.ts`); a PDF is sent as it is, because there is
   * nothing to reduce in a text layer. The size check happens AFTER the reduction, so a cook is
   * only told a photo is too big when it is still too big once shrunk.
   */
  async function importFile(kind: 'pdf', file: File | undefined) {
    if (!file) return;
    forget();
    setReading(true);
    try {
      if (file.size > MAX_PDF_BYTES) {
        setFileProblem(TOO_LARGE[kind]);
        return;
      }
      setSourceFiles({ kind: 'pdf', file });
      fromPdf.mutate({ fileBase64: await toBase64(file) });
    } catch {
      setFileProblem('That file could not be read. Try choosing it again.');
    } finally {
      setReading(false);
    }
  }

  /**
   * Photos from the picker. One is read straight away; several go to the Pages step first,
   * because no property of a file reliably says which page it is.
   */
  function choosePhotos(chosen: FileList | null) {
    const files = Array.from(chosen ?? []);
    if (files.length === 0) return;
    forget();
    if (files.length > MAX_IMAGES_PER_IMPORT) {
      setFileProblem(TOO_MANY_PHOTOS);
      return;
    }
    if (files.length === 1) {
      void readPhotos(files);
      return;
    }
    setOpen(null);
    setPages(defaultPageOrder(files).map((file) => ({ id: ++nextPageId, file })));
  }

  /** Swap a page with its neighbour `by` places along. */
  function movePage(index: number, by: -1 | 1) {
    setPages((current) => {
      const target = index + by;
      if (!current || target < 0 || target >= current.length) return current;
      const next = [...current];
      [next[index], next[target]] = [next[target]!, next[index]!];
      return next;
    });
  }

  /** Drop a page. Dropping the last one leaves the step, as Cancel would. */
  function removePage(id: number) {
    forget();
    setPages((current) => {
      const next = current?.filter((page) => page.id !== id) ?? [];
      return next.length > 0 ? next : null;
    });
  }

  function cancelPages() {
    forget();
    setPages(null);
  }

  /**
   * One recipe from one photo, or from several pages of it, read in the order given.
   *
   * The Pages step stays on screen while this runs and after a refusal, so the cook can drop
   * the page that was too large and try again without choosing them all afresh.
   */
  async function readPhotos(files: File[]) {
    forget();
    setReading(true);
    try {
      const reduced: Blob[] = [];
      for (const file of files) reduced.push(await downscaleForOcr(file));
      if (reduced.some((page) => page.size > MAX_IMAGE_BYTES)) {
        setFileProblem(TOO_LARGE.image);
        return;
      }
      if (reduced.reduce((n, page) => n + page.size, 0) > MAX_IMAGE_IMPORT_BYTES) {
        setFileProblem(PHOTOS_TOO_LARGE);
        return;
      }
      const pagesBase64: string[] = [];
      for (const page of reduced) pagesBase64.push(await toBase64(page));
      setSourceFiles({ kind: 'pages', pages: reduced });
      fromImage.mutate({ pagesBase64 });
    } catch {
      setFileProblem('That file could not be read. Try choosing it again.');
    } finally {
      setReading(false);
    }
  }

  if (draft) {
    // Only a file import has anything to keep: a link is its own source, and pasted text is
    // already the recipe.
    const keep = draft.source.kind === 'pdf' || draft.source.kind === 'image' ? sourceFiles : null;
    return <ImportReview draft={draft} onCancel={startOver} sourceFiles={keep} />;
  }

  return (
    <section className={styles.page}>
      <h1 className={styles.heading}>Add a recipe</h1>
      <p className={styles.reassurance}>Works offline. No API key, no account with anyone else.</p>

      {pages ? (
        <div className={styles.pagesStep}>
          <h2 className={styles.pagesHeading}>Pages</h2>
          <p className={styles.pagesHint}>
            Put the photos in page order. Page 1 is read first, and its first line becomes the
            title.
          </p>
          <ol className={styles.pageList}>
            {pages.map((page, index) => {
              const n = index + 1;
              return (
                <li
                  key={page.id}
                  className={styles.pageItem}
                  aria-label={`Page ${n}`}
                  data-name={page.file.name}
                >
                  <span className={styles.pageNumber} aria-hidden="true">
                    {n}
                  </span>
                  <PageThumb file={page.file} />
                  <span className={styles.pageName}>{page.file.name}</span>
                  <span className={styles.pageActions}>
                    <button
                      type="button"
                      className={styles.pageButton}
                      aria-label={`Move page ${n} up`}
                      disabled={busy || index === 0}
                      onClick={() => movePage(index, -1)}
                    >
                      ↑
                    </button>
                    <button
                      type="button"
                      className={styles.pageButton}
                      aria-label={`Move page ${n} down`}
                      disabled={busy || index === pages.length - 1}
                      onClick={() => movePage(index, 1)}
                    >
                      ↓
                    </button>
                    <button
                      type="button"
                      className={styles.pageButton}
                      aria-label={`Remove page ${n}`}
                      disabled={busy}
                      onClick={() => removePage(page.id)}
                    >
                      ×
                    </button>
                  </span>
                </li>
              );
            })}
          </ol>
          <div className={styles.pagesButtons}>
            <button
              type="button"
              className={styles.primary}
              disabled={busy}
              onClick={() => void readPhotos(pages.map((page) => page.file))}
            >
              Read {pages.length} {pages.length === 1 ? 'page' : 'pages'}
            </button>
            <button
              type="button"
              className={styles.secondary}
              disabled={busy}
              onClick={cancelPages}
            >
              Cancel
            </button>
          </div>
        </div>
      ) : (
        <ul className={styles.tiles}>
          <li>
            <button
              type="button"
              className={open === 'link' ? styles.tileOpen : styles.tile}
              aria-expanded={open === 'link'}
              onClick={() => reveal('link')}
            >
              <span className={styles.tileLabel}>Paste link</span>
              <span className={styles.tileHint}>From a recipe site</span>
            </button>
          </li>
          <li>
            {/*
            A label wrapping the input, rather than a button that clicks a hidden one. The input
            is the control: it keeps its place in the tab order and a screen reader announces it
            with the tile's own words as its name. `.fileInput` hides it visually without
            `display: none`, which would take it out of the tab order entirely.
          */}
            <label className={styles.tile}>
              <span className={styles.tileLabel}>Photo</span>
              <span className={styles.tileHint}>
                A cookbook page, or up to {MAX_IMAGES_PER_IMPORT} pages of one recipe
              </span>
              <input
                type="file"
                className={styles.fileInput}
                accept="image/*"
                multiple
                disabled={busy}
                onChange={(e) => {
                  choosePhotos(e.target.files);
                  // Cleared so choosing the SAME file again still fires a change event, which is
                  // what a cook does after a photo comes out unreadable.
                  e.target.value = '';
                }}
              />
            </label>
          </li>
          <li>
            <label className={styles.tile}>
              <span className={styles.tileLabel}>PDF</span>
              <span className={styles.tileHint}>A saved recipe</span>
              <input
                type="file"
                className={styles.fileInput}
                accept="application/pdf,.pdf"
                disabled={busy}
                onChange={(e) => {
                  void importFile('pdf', e.target.files?.[0]);
                  e.target.value = '';
                }}
              />
            </label>
          </li>
          <li>
            <button
              type="button"
              className={open === 'text' ? styles.tileOpen : styles.tile}
              aria-expanded={open === 'text'}
              onClick={() => reveal('text')}
            >
              <span className={styles.tileLabel}>Text</span>
              <span className={styles.tileHint}>Paste it in</span>
            </button>
          </li>
          <li>
            <Link to="/recipes/new" className={styles.tile}>
              <span className={styles.tileLabel}>By hand</span>
              <span className={styles.tileHint}>Type it in</span>
            </Link>
          </li>
        </ul>
      )}

      {!pages && open === 'link' && (
        <form
          className={styles.linkForm}
          onSubmit={(e) => {
            e.preventDefault();
            const trimmed = url.trim();
            if (trimmed !== '') fromUrl.mutate({ url: trimmed });
          }}
        >
          <label className={styles.linkLabel} htmlFor="import-url">
            Recipe link
          </label>
          <div className={styles.linkRow}>
            <input
              id="import-url"
              className={styles.linkInput}
              type="url"
              inputMode="url"
              placeholder="https://…"
              value={url}
              onChange={(e) => setUrl(e.target.value)}
            />
            <button type="submit" className={styles.primary} disabled={url.trim() === '' || busy}>
              {fromUrl.isPending ? 'Reading…' : 'Import'}
            </button>
          </div>
        </form>
      )}

      {!pages && open === 'text' && (
        <form
          className={styles.linkForm}
          onSubmit={(e) => {
            e.preventDefault();
            const trimmed = text.trim();
            if (trimmed !== '') fromText.mutate({ text: trimmed });
          }}
        >
          <label className={styles.linkLabel} htmlFor="import-text">
            Recipe text
          </label>
          <textarea
            id="import-text"
            className={styles.textInput}
            rows={10}
            maxLength={MAX_TEXT_LENGTH}
            placeholder={'Title\n\n2 cups flour\n1 tsp salt\n\nMix it, bake it.'}
            value={text}
            onChange={(e) => setText(e.target.value)}
          />
          <div className={styles.linkRow}>
            <button type="submit" className={styles.primary} disabled={text.trim() === '' || busy}>
              {fromText.isPending ? 'Reading…' : 'Import'}
            </button>
          </div>
        </form>
      )}

      {busy && (
        <p className={styles.working} role="status">
          Reading it…
        </p>
      )}

      {problem && (
        <p role="alert" className={styles.error}>
          {problem}
        </p>
      )}
    </section>
  );
}
