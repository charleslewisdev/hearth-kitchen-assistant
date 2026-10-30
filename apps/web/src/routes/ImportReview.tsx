import { useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { parseIngredientLine, RECIPE_TYPES, suggestTags } from '@hearth/shared';
import { trpc } from '../lib/trpc';
import { previewLabel } from '../lib/ingredient-preview';
import { sourceUrlInput } from '../lib/source-url';
import { toBase64 } from '../lib/image-upload';
import { prepareSourcePage } from '../lib/photo-upload';
import { notYetTagged, useTagColors } from '../lib/tags';
import { TagInput } from './TagInput';
import { SourceField } from './SourceField';
import { TagSuggestionChips } from './TagSuggestionChips';
import styles from './ImportReview.module.css';

/**
 * Reviewing an imported draft before it becomes a recipe (D29).
 *
 * Everything is editable, and only the fields the source did not actually state are flagged.
 * That is the whole design: a confident field should look like a normal form field, so the
 * amber ones are worth looking at. Editing a flagged field clears its flag, because the cook
 * has now said what it should be and the guess is no longer the thing on screen.
 *
 * Saving goes through the ordinary `recipe.create`. There is no second write path into the
 * recipe tables, and an imported recipe is created by exactly the code a typed one is.
 *
 * The Food-to-department mapping stays invisible here. It happens server side on save, and a
 * cook reviewing a recipe has no reason to think about which aisle anything is in.
 */

/**
 * The draft, read off `import.fromUrl` rather than imported from `@hearth/enrichment`.
 *
 * Every source produces the SAME `RecipeDraft` - that is what makes this screen
 * source-agnostic - so reading the type off one procedure is not a claim that it belongs to
 * that procedure. `fromText`, `fromPdf` and `fromImage` all return it unchanged. If they ever
 * do diverge, the fix is to widen this into a union rather than to go on pointing at the URL
 * one.
 *
 * `packages/enrichment` reaches `node:dns` and `cheerio` through its imports, so naming it in a
 * browser bundle is the failure `messages.ts` documents - `vite build` fails on it rather than
 * warning. Taking the type from the typed client is erased at compile time, needs no new
 * dependency, and has the better property anyway: it is by construction the shape the server
 * actually returns, so the screen and the procedure cannot drift apart.
 */
export type RecipeDraft = NonNullable<ReturnType<typeof trpc.import.fromUrl.useMutation>['data']>;
type MealType = RecipeDraft['mealTypes']['value'][number];

const MEAL_TYPES: readonly MealType[] = RECIPE_TYPES;

type SourceKind = RecipeDraft['source']['kind'];

/**
 * What the panel beside the form is called, per source.
 *
 * Named rather than "What the source said", because the cook knows which of these they handed
 * over and the panel is where they check the import against it. Only the URL kind has somewhere
 * to link back to; the others are a file that has already been read and forgotten.
 */
const SOURCE_HEADINGS: Record<SourceKind, string> = {
  url: 'What the page said',
  text: 'What you pasted said',
  pdf: 'What the PDF said',
  image: 'What the photo said',
};

/**
 * What to call the source inside a flag.
 *
 * Every amber note names the thing the cook handed over, because "the page did not say how many
 * this serves" is wrong and slightly confusing in front of somebody who uploaded a photograph.
 */
const SOURCE_NOUNS: Record<SourceKind, string> = {
  url: 'page',
  text: 'text',
  pdf: 'PDF',
  image: 'photo',
};

/**
 * A source URL only when it is one this screen is willing to put in an `href`.
 *
 * The fetcher only ever produces http and https - it checks the scheme on every hop - so today
 * this can only refuse something the server would never have sent. It is here because React
 * does not sanitize an `href`, `recipe.create` and `RecipeView` both argue for the second lock
 * by name, and this was the one link in the import screens without it.
 */
function linkableSource(source: RecipeDraft['source']): string | null {
  if (source.kind !== 'url') return null;
  try {
    const parsed = new URL(source.url);
    return parsed.protocol === 'http:' || parsed.protocol === 'https:' ? source.url : null;
  } catch {
    return null;
  }
}

/** One editable field plus whether it is still showing what the import guessed. */
interface Reviewed<T> {
  value: T;
  /** True while the value is the import's own and the source did not state it. */
  flagged: boolean;
  /** What the source said, for the panel that shows the cook where this came from. */
  raw: string | null;
}

function reviewed<T>(f: { value: T; confidence: 'high' | 'low'; raw: string | null }): Reviewed<T> {
  return { value: f.value, flagged: f.confidence === 'low', raw: f.raw };
}

/**
 * The amber note under a flagged field.
 *
 * Text, not colour alone, so the flag survives a bright kitchen and a cook who does not
 * separate those hues. `id` ties it to the field through `aria-describedby`, so a screen
 * reader reads "why this is flagged" on arriving at the input rather than after passing it.
 */
function Flag({ id, children }: { id: string; children: React.ReactNode }) {
  return (
    <p id={id} className={styles.flag}>
      {children}
    </p>
  );
}

/** `aria-describedby` for a field, but only while it actually has a note under it. */
function describedBy(id: string, flagged: boolean): string | undefined {
  return flagged ? id : undefined;
}

function minutesText(minutes: number | null): string {
  return minutes === null ? '' : String(minutes);
}

// An empty or unreadable minutes box means "not given", never 0.
function minutesOrNull(text: string): number | null {
  const n = Number.parseInt(text, 10);
  return Number.isNaN(n) || n < 0 ? null : Math.min(n, 10_000);
}

const LAST_SOURCE_KEY = 'hearth.import.lastSource';

// A per-device convenience only, so storage that is blocked or full just means no prefill.
function readLastSource(): string {
  try {
    return localStorage.getItem(LAST_SOURCE_KEY) ?? '';
  } catch {
    return '';
  }
}

function writeLastSource(value: string) {
  try {
    if (value) localStorage.setItem(LAST_SOURCE_KEY, value);
  } catch {
    // Nothing to do: the next import simply starts blank.
  }
}

/** The page photos or the PDF an import was read from, to keep with the saved recipe. */
export type SourceFiles = { kind: 'pages'; pages: Blob[] } | { kind: 'pdf'; file: Blob };

/**
 * Keep what the recipe was read from, beside it, as "Source pages". Best effort: the recipe is
 * saved already, and a page that fails to upload is not a reason to lose it or to stop the cook.
 */
async function keepSources(
  recipeId: string,
  sources: SourceFiles,
  upload: (input: {
    recipeId: string;
    kind: 'source_page' | 'source_pdf';
    fullBase64: string;
    thumbBase64?: string;
    width?: number;
    height?: number;
  }) => Promise<unknown>,
): Promise<void> {
  if (sources.kind === 'pdf') {
    await upload({ recipeId, kind: 'source_pdf', fullBase64: await toBase64(sources.file) }).catch(
      () => {},
    );
    return;
  }
  for (const page of sources.pages) {
    try {
      const prepared = await prepareSourcePage(page);
      await upload({
        recipeId,
        kind: 'source_page',
        fullBase64: await toBase64(prepared.full),
        thumbBase64: await toBase64(prepared.thumb),
        width: prepared.width,
        height: prepared.height,
      });
    } catch {
      // Keep going: the other pages are still worth having.
    }
  }
}

export function ImportReview({
  draft,
  onCancel,
  sourceFiles = null,
}: {
  draft: RecipeDraft;
  onCancel: () => void;
  sourceFiles?: SourceFiles | null;
}) {
  const navigate = useNavigate();
  const create = trpc.recipe.create.useMutation();
  const uploadFile = trpc.recipeFile.upload.useMutation();
  const [keeping, setKeeping] = useState(false);
  const kind = draft.source.kind;
  const noun = SOURCE_NOUNS[kind];
  const sourceLink = linkableSource(draft.source);

  const [title, setTitle] = useState(() => reviewed(draft.title));
  const [servings, setServings] = useState(() => reviewed(draft.servings));
  const [mealTypes, setMealTypes] = useState(() => reviewed(draft.mealTypes));
  // Tags: only the household's own tags are filled in; a site's keywords are offered, one tap
  // each (`suggestTags`). Held as the box's raw text, so a comma can be typed. `null` until the
  // cook touches it, so the filled-in tags can follow the tag list when it arrives.
  const tagList = trpc.tag.all.useQuery();
  const colorOf = useTagColors();
  const tagSuggestions = useMemo(
    () =>
      suggestTags(
        {
          title: draft.title.value,
          ingredientLines: draft.ingredientLines.value,
          siteTags: draft.tags.value,
        },
        (tagList.data ?? []).map((t) => t.name),
      ),
    [draft, tagList.data],
  );
  const [typedTags, setTypedTags] = useState<string[] | null>(null);
  const tags = typedTags ?? tagSuggestions.chosen;
  const tagsFlagged = typedTags === null && draft.tags.confidence === 'low';
  // A link is its own source. For a photo, PDF or paste, start from the last source typed on
  // this device: a batch from one cookbook then only needs its page number changed.
  const [sourceName, setSourceName] = useState(() =>
    draft.source.kind === 'url' ? '' : readLastSource(),
  );
  // A link for a draft that is not a page: the recipe was pasted because its page would not
  // fetch, or the cook knows where a photographed one lives online. A URL draft has its own.
  const [sourceUrlText, setSourceUrlText] = useState('');
  const typedSourceUrl = sourceUrlInput(sourceUrlText);
  // The page's headnote and times, when it stated them; empty for a photo, PDF or paste.
  const [notes, setNotes] = useState(draft.details.description ?? '');
  const [prepText, setPrepText] = useState(minutesText(draft.details.prepMinutes));
  const [cookText, setCookText] = useState(minutesText(draft.details.cookMinutes));
  const toCheck = new Set(draft.amountsToCheck);
  const [ingredients, setIngredients] = useState(() => ({
    ...reviewed(draft.ingredientLines),
    text: draft.ingredientLines.value.join('\n'),
  }));
  const [steps, setSteps] = useState(() => ({
    ...reviewed(draft.steps),
    text: draft.steps.value.join('\n\n'),
  }));

  const ingredientLines = ingredients.text
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line !== '');
  const stepLines = steps.text
    .split(/\n{2,}/)
    .map((step) => step.trim())
    .filter((step) => step !== '');

  const canSave =
    title.value.trim() !== '' && typedSourceUrl !== 'invalid' && !create.isPending && !keeping;

  async function handleSave() {
    if (!canSave) return;
    const saved = await create.mutateAsync({
      title: title.value.trim(),
      servings: servings.value,
      mealTypes: mealTypes.value,
      tags,
      ingredientLines,
      steps: stepLines,
      sourceName: sourceName.trim() || null,
      description: notes.trim() || null,
      prepMinutes: minutesOrNull(prepText),
      cookMinutes: minutesOrNull(cookText),
      // Provenance, and only when there is somewhere to go back to. Losing it would mean losing
      // the headnote, the comments and the photograph a page has around the recipe, none of
      // which the structured core keeps. A file has no such address, so those drafts send none.
      // A pasted or photographed recipe sends the link the cook typed, if any.
      ...(draft.source.kind === 'url'
        ? { sourceUrl: draft.source.url }
        : typedSourceUrl.url
          ? { sourceUrl: typedSourceUrl.url }
          : {}),
      // A photo or PDF import's kept draft, which the save links to this recipe for study.
      ...(draft.importDraftId ? { importDraftId: draft.importDraftId } : {}),
    });
    if (draft.source.kind !== 'url') writeLastSource(sourceName.trim());
    if (sourceFiles) {
      setKeeping(true);
      await keepSources(saved.id, sourceFiles, uploadFile.mutateAsync);
    }
    navigate(`/recipes/${saved.slug}`);
  }

  const flaggedCount = [
    title.flagged,
    servings.flagged,
    mealTypes.flagged,
    tagsFlagged,
    ingredients.flagged,
    steps.flagged,
  ].filter(Boolean).length;

  return (
    <section className={styles.layout}>
      <div className={styles.form}>
        <h1 className={styles.heading}>Check this over</h1>
        <p className={styles.lede}>
          {flaggedCount === 0
            ? `The ${noun} said all of this outright. Change anything you like, then save it.`
            : `${flaggedCount} ${flaggedCount === 1 ? 'field was' : 'fields were'} worked out rather than stated. Those are marked.`}
        </p>

        <label className={styles.field}>
          <span className={styles.label}>Title</span>
          <input
            className={title.flagged ? styles.inputFlagged : styles.input}
            aria-describedby={describedBy('title-flag', title.flagged)}
            value={title.value}
            onChange={(e) => setTitle({ ...title, value: e.target.value, flagged: false })}
          />
        </label>
        {title.flagged && (
          <Flag id="title-flag">
            {kind === 'url'
              ? 'Taken from the page title, not from the recipe itself.'
              : `Taken from the first line of the ${noun}.`}
          </Flag>
        )}

        <label className={styles.field}>
          <span className={styles.label}>Servings</span>
          <input
            type="number"
            min={1}
            className={servings.flagged ? styles.inputFlagged : styles.input}
            aria-describedby={describedBy('servings-flag', servings.flagged)}
            value={servings.value}
            onChange={(e) =>
              setServings({
                ...servings,
                // An empty or unreadable box falls back to 1 rather than to NaN, which would
                // reach `recipe.create` and be refused after the cook had left the screen.
                value: Number.isFinite(e.target.valueAsNumber)
                  ? Math.max(1, Math.trunc(e.target.valueAsNumber))
                  : 1,
                flagged: false,
              })
            }
          />
        </label>
        {servings.flagged && (
          <Flag id="servings-flag">
            {servings.raw === null
              ? `The ${noun} did not say how many this serves.`
              : kind === 'url'
                ? `The page said “${servings.raw}”, which is a yield rather than a serving count.`
                : `Read out of “${servings.raw}”.`}
          </Flag>
        )}

        <fieldset
          className={styles.field}
          aria-describedby={describedBy('mealtypes-flag', mealTypes.flagged)}
        >
          <legend className={styles.label}>Recipe type</legend>
          <div className={styles.chips}>
            {MEAL_TYPES.map((meal) => (
              <label key={meal} className={styles.chip}>
                <input
                  type="checkbox"
                  checked={mealTypes.value.includes(meal)}
                  onChange={() =>
                    setMealTypes({
                      ...mealTypes,
                      value: mealTypes.value.includes(meal)
                        ? mealTypes.value.filter((m) => m !== meal)
                        : [...mealTypes.value, meal],
                      flagged: false,
                    })
                  }
                />
                {meal}
              </label>
            ))}
          </div>
        </fieldset>
        {mealTypes.flagged && (
          <Flag id="mealtypes-flag">
            {mealTypes.raw
              ? `Worked out from the site's own category, “${mealTypes.raw}”.`
              : `The ${noun} did not say what kind of meal this is.`}
          </Flag>
        )}

        <div className={styles.field}>
          <label className={styles.label} htmlFor="import-tags">
            Tags
          </label>
          <TagInput
            id="import-tags"
            label="Tags"
            value={tags}
            onChange={setTypedTags}
            known={tagList.data ?? []}
            flagged={tagsFlagged}
            describedBy={describedBy('tags-flag', tagsFlagged)}
          />
        </div>
        {tagsFlagged && (
          <Flag id="tags-flag">
            {tagSuggestions.chosen.length > 0
              ? 'Filled in from tags you already use that this recipe mentions.'
              : draft.tags.raw
                ? 'The site’s keywords are below as suggestions; none is added unless you tap it.'
                : `The ${noun} carried no tags. Add your own if you want them.`}
          </Flag>
        )}
        <TagSuggestionChips
          names={notYetTagged(tagSuggestions.offered, tags)}
          colorOf={colorOf}
          onAdd={(name) => setTypedTags([...tags, name])}
        />

        <SourceField
          value={sourceName}
          onChange={setSourceName}
          fieldClassName={styles.field}
          labelClassName={styles.label}
          inputClassName={styles.input}
        />

        {kind !== 'url' && (
          <label className={styles.field}>
            <span className={styles.label}>Source link</span>
            <input
              type="url"
              inputMode="url"
              className={styles.input}
              value={sourceUrlText}
              placeholder="https://… if it lives online"
              onChange={(e) => setSourceUrlText(e.target.value)}
              aria-invalid={typedSourceUrl === 'invalid'}
            />
            {typedSourceUrl === 'invalid' && (
              <span className={styles.error}>That doesn’t look like a web address.</span>
            )}
          </label>
        )}

        <div className={styles.timeRow}>
          <label className={styles.field}>
            <span className={styles.label}>Prep minutes</span>
            <input
              className={styles.input}
              type="number"
              min={0}
              inputMode="numeric"
              value={prepText}
              onChange={(e) => setPrepText(e.target.value)}
            />
          </label>
          <label className={styles.field}>
            <span className={styles.label}>Cook minutes</span>
            <input
              className={styles.input}
              type="number"
              min={0}
              inputMode="numeric"
              value={cookText}
              onChange={(e) => setCookText(e.target.value)}
            />
          </label>
        </div>

        <label className={styles.field}>
          <span className={styles.label}>Notes</span>
          <textarea
            className={styles.input}
            rows={2}
            value={notes}
            maxLength={5000}
            onChange={(e) => setNotes(e.target.value)}
          />
        </label>

        <label className={styles.field}>
          <span className={styles.label}>Ingredients, one per line</span>
          <textarea
            rows={Math.max(6, ingredientLines.length + 1)}
            className={ingredients.flagged ? styles.textareaFlagged : styles.textarea}
            aria-describedby={describedBy('ingredients-flag', ingredients.flagged)}
            value={ingredients.text}
            onChange={(e) =>
              setIngredients({ ...ingredients, text: e.target.value, flagged: false })
            }
          />
        </label>
        {ingredients.flagged && (
          <Flag id="ingredients-flag">
            {`These were worked out from the shape of the ${noun}, not read off a list it labelled.`}
          </Flag>
        )}

        {/*
          The same "here is what I made of that line" preview the recipe form shows, from the
          same parser. It is what tells a cook that "1 Tbsp oil ((or sub water))" came through
          as an amount, a unit and a food before they save it.
        */}
        {ingredientLines.length > 0 && (
          <ul className={styles.preview}>
            {ingredientLines.map((line, index) => (
              <li
                key={`${index}-${line}`}
                className={toCheck.has(line) ? styles.previewItemCheck : styles.previewItem}
              >
                <span className={styles.previewMain}>
                  {previewLabel(parseIngredientLine(line))}
                </span>
                {parseIngredientLine(line).note && (
                  <span className={styles.previewNote}>{parseIngredientLine(line).note}</span>
                )}
                {/*
                  OCR garbled this amount past reading and the importer guessed ("% cup" could be
                  ¼, ½ or ¾). Editing the line is checking it, and the mark goes with the old text.
                */}
                {toCheck.has(line) && (
                  <span className={styles.previewCheck}>check the amount against the page</span>
                )}
              </li>
            ))}
          </ul>
        )}

        <label className={styles.field}>
          <span className={styles.label}>Steps, one per blank line</span>
          <textarea
            rows={Math.max(6, stepLines.length + 2)}
            className={steps.flagged ? styles.textareaFlagged : styles.textarea}
            aria-describedby={describedBy('steps-flag', steps.flagged)}
            value={steps.text}
            onChange={(e) => setSteps({ ...steps, text: e.target.value, flagged: false })}
          />
        </label>
        {steps.flagged && (
          <Flag id="steps-flag">
            {`The split into steps is a guess, worked out from the ${noun}.`}
          </Flag>
        )}

        {create.isError && (
          <p role="alert" className={styles.error}>
            {create.error.message}
          </p>
        )}

        <div className={styles.actions}>
          <button type="button" className={styles.primary} onClick={handleSave} disabled={!canSave}>
            {keeping ? 'Keeping the pages…' : create.isPending ? 'Saving…' : 'Save recipe'}
          </button>
          <button type="button" className={styles.secondary} onClick={onCancel}>
            Start over
          </button>
        </div>
      </div>

      {/*
        Where this came from, beside the form on a wide screen and below it on a phone (D29).
        It shows the source's OWN words per field rather than the page itself: the page is
        hundreds of kilobytes and the useful part is the sentence a given field came out of.
      */}
      <aside className={styles.source} aria-labelledby="source-heading">
        <h2 id="source-heading" className={styles.sourceHeading}>
          {SOURCE_HEADINGS[draft.source.kind]}
        </h2>
        {sourceLink && (
          <a
            className={styles.sourceLink}
            href={sourceLink}
            target="_blank"
            rel="noreferrer noopener"
          >
            {sourceLink}
          </a>
        )}
        <dl className={styles.sourceList}>
          {(
            [
              ['Title', draft.title.raw],
              ['Yield', draft.servings.raw],
              ['Category', draft.mealTypes.raw],
              ['Keywords', draft.tags.raw],
            ] as const
          ).map(([label, value]) => (
            <div key={label} className={styles.sourceRow}>
              <dt className={styles.sourceTerm}>{label}</dt>
              <dd className={styles.sourceValue}>{value ?? <em>not stated</em>}</dd>
            </div>
          ))}
        </dl>
      </aside>
    </section>
  );
}
