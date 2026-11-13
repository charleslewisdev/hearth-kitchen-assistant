import { useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import {
  MAX_IMAGE_BYTES,
  MAX_PDF_BYTES,
  planImport,
  recipeTitleKey,
  splitRecipeLink,
  unlinkRecipeLine,
  type ImportPlan,
  type MarkdownRecipe,
} from '@hearth/shared';
import { trpc } from '../lib/trpc';
import { toBase64 } from '../lib/image-upload';
import { prepareImage, prepareSourcePage } from '../lib/photo-upload';
import { sourceUrlInput } from '../lib/source-url';
import { useScreenWakeLock } from '../lib/useScreenWakeLock';
import {
  NotAZipError,
  readZipFiles,
  readZipRecipes,
  TooManyRecipesError,
  UnsupportedZipError,
  type ZipRecipe,
  type ZipRecipes,
} from '../lib/zip-import';
import styles from './ZipImport.module.css';

/**
 * Importing a whole recipe zip, with its photos and scans (issue #37, D62).
 *
 * No review per recipe (owner decision): the cook sees what will be imported and what will be
 * skipped, presses one button, and the recipes are saved straight in through the ordinary
 * `recipe.create`, one at a time and in link order (`planImport`). Then the zip is read a second
 * time for the files of the recipes that saved, each re-encoded here and sent through
 * `recipeFile.upload` as a photo added by hand would be. A failure is noted and the run goes on;
 * the report at the end names what did not make it, by recipe title and a plain name for the
 * file ("Stew: photo 2"), never by content. A recipe whose create fails takes no other recipe
 * down with it: a later link to it is written back as text, as the plan does for a missing one.
 */

type Kind = 'photo' | 'source_page' | 'source_pdf';

/**
 * How large a zipped image may be before it is re-encoded. Generous, because what is sent is the
 * re-encoded copy, which the server checks against its own cap; this only stops a bomb or a
 * camera original far past anything a recipe keeps.
 */
const IMAGE_ENTRY_CAP = 4 * MAX_IMAGE_BYTES;

const CAPS: Record<Kind, number> = {
  photo: IMAGE_ENTRY_CAP,
  source_page: IMAGE_ENTRY_CAP,
  source_pdf: MAX_PDF_BYTES,
};

/** One file of a saved recipe, as the second pass looks for it. */
interface FileTarget {
  recipeId: string;
  kind: Kind;
  /** What the report calls it: "Stew: photo 2", "Stew: page 1", "Stew: source PDF". */
  label: string;
}

interface SavedRecipe {
  recipeId: string;
  name: string;
  files: NonNullable<MarkdownRecipe['files']> | undefined;
}

interface Report {
  saved: number;
  skipped: string[];
  unlinked: string[];
  failedRecipes: string[];
  failedFiles: string[];
  tooLargeFiles: string[];
}

type Phase =
  | { step: 'reading' }
  | { step: 'unreadable'; message: string }
  | { step: 'summary'; read: ZipRecipes }
  | { step: 'saving'; progress: string }
  | { step: 'report'; report: Report };

const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;

/** Past this many names a list folds behind its heading and count. */
const OPEN_LIST_MAX = 5;

const unique = (names: string[]) => [...new Set(names)];

function unreadableMessage(error: unknown): string {
  if (error instanceof TooManyRecipesError) return error.message;
  if (error instanceof NotAZipError)
    return 'That file is not a zip. Choose the zip Hearth exported.';
  if (error instanceof UnsupportedZipError) {
    return 'This zip cannot be read here. It may be split into parts or saved in an unusual format.';
  }
  return 'That zip could not be read. Try choosing it again.';
}

/** What a recipe is called in a list: its title, or its file when it has none. */
const nameOf = (item: ZipRecipe) => item.recipe.title.trim() || item.path;

/** The fields `recipe.create` takes, from a Markdown recipe, as the Markdown tile sends them. */
function createInput(recipe: MarkdownRecipe, ingredientLines: string[]) {
  const sourceUrl = recipe.sourceUrl === null ? null : sourceUrlInput(recipe.sourceUrl);
  return {
    title: recipe.title.trim(),
    servings: recipe.servings,
    servingsHigh: recipe.servingsHigh,
    mealTypes: recipe.types,
    tags: recipe.tags,
    ingredientLines,
    steps: recipe.steps,
    description: recipe.description,
    sourceName: recipe.sourceName,
    prepMinutes: recipe.prepMinutes,
    cookMinutes: recipe.cookMinutes,
    // A link the review screen would refuse is left out rather than failing the whole recipe.
    ...(sourceUrl !== null && sourceUrl !== 'invalid' && sourceUrl.url
      ? { sourceUrl: sourceUrl.url }
      : {}),
    ...(recipe.rating !== null ? { rating: recipe.rating } : {}),
  };
}

/** How many files the plan's recipes name, for the summary. */
function fileCount(plan: ImportPlan<ZipRecipe>): number {
  let n = 0;
  for (const { item } of plan.create) {
    const files = item.recipe.files;
    if (!files) continue;
    n += files.photos.length + files.sourcePages.length + (files.sourcePdf !== null ? 1 : 0);
  }
  return n;
}

/**
 * A titled list of names, as a region a screen reader can jump to. Nothing when empty. A long
 * list folds into a closed `<details>` with its count, so a phone does not scroll past it to
 * reach what matters; `failure` gives it the error look.
 */
function NameList({
  heading,
  names,
  note,
  failure = false,
}: {
  heading: string;
  names: string[];
  note?: string;
  failure?: boolean;
}) {
  if (names.length === 0) return null;
  const list = (
    <>
      <ul className={styles.names}>
        {names.map((name, i) => (
          <li key={`${i}-${name}`}>{name}</li>
        ))}
      </ul>
      {note && <p className={styles.note}>{note}</p>}
    </>
  );
  return (
    <section className={failure ? styles.failureList : styles.list} aria-label={heading}>
      {names.length > OPEN_LIST_MAX ? (
        <details>
          <summary className={styles.listSummary}>
            {heading} ({names.length})
          </summary>
          {list}
        </details>
      ) : (
        <>
          <h2 className={styles.listHeading}>{heading}</h2>
          {list}
        </>
      )}
    </section>
  );
}

/** Ask the browser to confirm leaving the page while `active`. */
function useConfirmLeave(active: boolean): void {
  useEffect(() => {
    if (!active) return;
    const onBeforeUnload = (event: BeforeUnloadEvent) => {
      event.preventDefault();
      // Older browsers ask only when this is set.
      event.returnValue = '';
    };
    window.addEventListener('beforeunload', onBeforeUnload);
    return () => window.removeEventListener('beforeunload', onBeforeUnload);
  }, [active]);
}

export function ZipImport({ file, onCancel }: { file: File; onCancel: () => void }) {
  const utils = trpc.useUtils();
  const library = trpc.recipe.list.useQuery();
  const create = trpc.recipe.create.useMutation();
  const upload = trpc.recipeFile.upload.useMutation();
  const setCover = trpc.recipeFile.setCover.useMutation();
  const [phase, setPhase] = useState<Phase>({ step: 'reading' });
  const saving = phase.step === 'saving';
  // A long import on a phone: a dimmed screen or a closed tab stops it part way.
  useScreenWakeLock(saving);
  useConfirmLeave(saving);

  // Pass 1, once per file: the Markdown only, nothing saved.
  useEffect(() => {
    let current = true;
    setPhase({ step: 'reading' });
    readZipRecipes(file).then(
      (read) => current && setPhase({ step: 'summary', read }),
      (error: unknown) =>
        current && setPhase({ step: 'unreadable', message: unreadableMessage(error) }),
    );
    return () => {
      current = false;
    };
  }, [file]);

  const read = phase.step === 'summary' ? phase.read : null;
  const plan = useMemo(() => {
    if (!read || !library.data) return null;
    const keys = new Set(library.data.map((r) => recipeTitleKey(r.title)));
    // A recipe with no title goes by its path, so the lists name it and two untitled recipes
    // are not taken for repeats of each other. Its create fails and is reported.
    return planImport(
      read.recipes,
      (item) => ({ title: nameOf(item), ingredientLines: item.recipe.ingredientLines }),
      keys,
    );
  }, [read, library.data]);

  async function run(plan: ImportPlan<ZipRecipe>) {
    const total = plan.create.length;
    const saved: SavedRecipe[] = [];
    const failedRecipes: string[] = [];
    /** Title keys of the recipes whose create failed, so links to them are not left dangling. */
    const failedKeys = new Set<string>();
    const unlinked = [...plan.unlinked];
    for (const [i, { item, ingredientLines }] of plan.create.entries()) {
      setPhase({ step: 'saving', progress: `Saving ${i + 1} of ${total}` });
      const name = nameOf(item);
      let lines = ingredientLines;
      if (failedKeys.size > 0) {
        lines = ingredientLines.map((line) => {
          const { linkTitle } = splitRecipeLink(line);
          return linkTitle !== null && failedKeys.has(recipeTitleKey(linkTitle))
            ? unlinkRecipeLine(line)
            : line;
        });
        if (lines.some((line, n) => line !== ingredientLines[n])) unlinked.push(name);
      }
      try {
        const result = await create.mutateAsync(createInput(item.recipe, lines));
        saved.push({ recipeId: result.id, name, files: item.recipe.files });
      } catch {
        failedRecipes.push(name);
        failedKeys.add(recipeTitleKey(name));
      }
    }

    // Pass 2: the files of the recipes that saved, keyed by their path in the zip. Each recipe's
    // in front-matter order (photos, pages, then the PDF), which is the order they are read in.
    const targets = new Map<string, FileTarget[]>();
    const add = (path: string, target: FileTarget) => {
      const list = targets.get(path);
      if (list) list.push(target);
      else targets.set(path, [target]);
    };
    for (const { recipeId, name, files } of saved) {
      if (!files) continue;
      files.photos.forEach((path, n) =>
        add(path, { recipeId, kind: 'photo', label: `${name}: photo ${n + 1}` }),
      );
      files.sourcePages.forEach((path, n) =>
        add(path, { recipeId, kind: 'source_page', label: `${name}: page ${n + 1}` }),
      );
      if (files.sourcePdf !== null) {
        add(files.sourcePdf, { recipeId, kind: 'source_pdf', label: `${name}: source PDF` });
      }
    }
    const labelsOf = (path: string) => (targets.get(path) ?? []).map((t) => t.label);
    const wanted = new Map<string, number>();
    for (const [path, list] of targets) {
      wanted.set(path, Math.max(...list.map((t) => CAPS[t.kind])));
    }

    const failedFiles: string[] = [];
    const tooLargeFiles: string[] = [];
    const seen = new Set<string>();
    /** The uploaded photo's id, by recipe and path, for setting a cover. */
    const photoIds = new Map<string, string>();
    const fileTotal = [...targets.values()].reduce((n, list) => n + list.length, 0);
    let filesDone = 0;
    const step = () =>
      setPhase({
        step: 'saving',
        progress: `Adding photos and scans: ${Math.min(filesDone + 1, fileTotal)} of ${fileTotal}`,
      });

    async function send(path: string, bytes: Uint8Array, target: FileTarget) {
      const blob = new Blob([bytes as Uint8Array<ArrayBuffer>]);
      if (target.kind === 'source_pdf') {
        const pdf = new Blob([bytes as Uint8Array<ArrayBuffer>], { type: 'application/pdf' });
        await upload.mutateAsync({
          recipeId: target.recipeId,
          kind: 'source_pdf',
          fullBase64: await toBase64(pdf),
        });
        return;
      }
      const prepared =
        target.kind === 'photo' ? await prepareImage(blob) : await prepareSourcePage(blob);
      const view = await upload.mutateAsync({
        recipeId: target.recipeId,
        kind: target.kind,
        fullBase64: await toBase64(prepared.full),
        thumbBase64: await toBase64(prepared.thumb),
        width: prepared.width,
        height: prepared.height,
      });
      if (target.kind === 'photo') photoIds.set(`${target.recipeId}\n${path}`, view.id);
    }

    if (fileTotal > 0) {
      step();
      try {
        await readZipFiles(file, wanted, {
          onFile: async (path, bytes) => {
            seen.add(path);
            for (const target of targets.get(path) ?? []) {
              try {
                await send(path, bytes, target);
              } catch {
                failedFiles.push(target.label);
              }
              filesDone++;
              step();
            }
          },
          onTooLarge: (path) => {
            seen.add(path);
            tooLargeFiles.push(...labelsOf(path));
          },
          onUnreadable: (path) => {
            seen.add(path);
            failedFiles.push(...labelsOf(path));
          },
        });
      } catch {
        // The zip stopped reading part way; whatever it had not reached is listed below.
      }
      // A file the Markdown names but the zip does not hold, or that the read never reached.
      for (const path of wanted.keys()) if (!seen.has(path)) failedFiles.push(...labelsOf(path));
    }

    // Every named cover is set, the first photo too: the first one uploaded becomes the cover on
    // its own, but a zip someone re-made may not list its photos in the order they were added.
    for (const { recipeId, name, files } of saved) {
      if (!files || files.cover === null) continue;
      const fileId = photoIds.get(`${recipeId}\n${files.cover}`);
      if (fileId === undefined) continue;
      try {
        await setCover.mutateAsync({ recipeId, fileId });
      } catch {
        failedFiles.push(`${name}: cover photo`);
      }
    }

    await utils.recipe.list.invalidate();
    setPhase({
      step: 'report',
      report: {
        saved: saved.length,
        skipped: plan.skipped,
        unlinked: unique(unlinked),
        failedRecipes,
        failedFiles: unique(failedFiles),
        tooLargeFiles: unique(tooLargeFiles),
      },
    });
  }

  return (
    <section className={styles.page}>
      <h1 className={styles.heading}>Import a recipe zip</h1>

      {phase.step === 'reading' && (
        <>
          <p className={styles.working} role="status">
            Reading the zip…
          </p>
          <div className={styles.buttons}>
            <button type="button" className={styles.secondary} onClick={onCancel}>
              Cancel
            </button>
          </div>
        </>
      )}

      {phase.step === 'unreadable' && (
        <>
          <p role="alert" className={styles.error}>
            {phase.message}
          </p>
          <div className={styles.buttons}>
            <button type="button" className={styles.secondary} onClick={onCancel}>
              Choose another file
            </button>
          </div>
        </>
      )}

      {phase.step === 'summary' && (
        <>
          {plan === null ? (
            library.isError ? (
              <>
                <p role="alert" className={styles.error}>
                  Your library could not be loaded, so Hearth cannot tell what is already in it.
                </p>
                <div className={styles.buttons}>
                  <button
                    type="button"
                    className={styles.primary}
                    onClick={() => void library.refetch()}
                  >
                    Try again
                  </button>
                  <button type="button" className={styles.secondary} onClick={onCancel}>
                    Cancel
                  </button>
                </div>
              </>
            ) : (
              <>
                <p className={styles.working} role="status">
                  Checking your library…
                </p>
                <div className={styles.buttons}>
                  <button type="button" className={styles.secondary} onClick={onCancel}>
                    Cancel
                  </button>
                </div>
              </>
            )
          ) : (
            <>
              <p className={styles.summary}>
                {plan.create.length === 0
                  ? 'There is nothing new to import.'
                  : `${plural(plan.create.length, 'recipe', 'recipes')}${
                      fileCount(plan) > 0
                        ? `, ${plural(fileCount(plan), 'photo or scan', 'photos and scans')}`
                        : ''
                    }.`}
              </p>
              <div className={styles.buttons}>
                {plan.create.length > 0 && (
                  <button type="button" className={styles.primary} onClick={() => void run(plan)}>
                    Import {plural(plan.create.length, 'recipe', 'recipes')}
                  </button>
                )}
                <button type="button" className={styles.secondary} onClick={onCancel}>
                  Cancel
                </button>
              </div>
              <NameList heading="Already in your library, so skipped" names={plan.skipped} />
              <NameList
                heading="Links to recipes that are not here, saved as text"
                names={plan.unlinked}
              />
            </>
          )}
          <NameList heading="Not Hearth recipes, so skipped" names={phase.read.notRecipes} />
          <NameList heading="Too long to read, so skipped" names={phase.read.tooLarge} />
        </>
      )}

      {phase.step === 'saving' && (
        <>
          <p className={styles.working} role="status">
            {phase.progress}
          </p>
          <p className={styles.hint}>
            Keep the screen on and this page open until it finishes. Anything saved so far stays
            saved.
          </p>
        </>
      )}

      {phase.step === 'report' && <ReportView report={phase.report} onCancel={onCancel} />}
    </section>
  );
}

function ReportView({ report, onCancel }: { report: Report; onCancel: () => void }) {
  const failed =
    report.saved === 0 ||
    report.failedRecipes.length > 0 ||
    report.failedFiles.length > 0 ||
    report.tooLargeFiles.length > 0;
  const byHand = 'Add these by hand from the recipe page.';
  return (
    <>
      <p className={failed ? styles.error : styles.summary} role={failed ? 'alert' : 'status'}>
        Saved {plural(report.saved, 'recipe', 'recipes')}.
        {failed && report.saved > 0 ? ' Some things did not make it; see below.' : ''}{' '}
        <Link to="/" className={styles.link}>
          Open the Library
        </Link>
      </p>
      <NameList heading="Recipes not saved" names={report.failedRecipes} failure={failed} />
      <NameList
        heading="Files not added"
        names={report.failedFiles}
        note={byHand}
        failure={failed}
      />
      <NameList
        heading="Files too large to add"
        names={report.tooLargeFiles}
        note={byHand}
        failure={failed}
      />
      <NameList heading="Links saved as text" names={report.unlinked} />
      <NameList heading="Already in your library, so skipped" names={report.skipped} />
      <div className={styles.buttons}>
        <button type="button" className={styles.secondary} onClick={onCancel}>
          Import something else
        </button>
      </div>
    </>
  );
}
