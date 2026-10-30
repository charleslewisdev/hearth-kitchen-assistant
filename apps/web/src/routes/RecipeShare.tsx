import { useEffect, useState } from 'react';
import { createPortal } from 'react-dom';
import { fileUrl } from '../lib/photo-upload';
import {
  byPosition,
  ingredientText,
  recipeMeta,
  recipeText,
  sourceLine,
  type ShareableRecipe,
  type ShareView,
} from '../lib/recipe-text';
import styles from './RecipeShare.module.css';

type Status = 'copied' | 'failed' | null;

/**
 * Share and Print, for sending a recipe to someone outside the household (P5's first cut).
 *
 * Share hands the recipe as plain text to the phone's share sheet, or copies it where there is
 * none. Print prints `PrintSheet` below, which a browser can also save as a PDF. Both read the
 * servings and measures on screen. Nothing leaves the device through Hearth: no link, no page
 * anyone else can open.
 */
export function ShareButtons({
  recipe,
  view,
  waiting = false,
}: {
  recipe: ShareableRecipe;
  view: ShareView;
  /** The linked recipes are still loading: sharing now would send the copy without them. */
  waiting?: boolean;
}) {
  const [status, setStatus] = useState<Status>(null);
  // The bubble clears itself; it says what happened, and the cook has moved on to pasting.
  useEffect(() => {
    if (status === null) return;
    const timer = setTimeout(() => setStatus(null), 4000);
    return () => clearTimeout(timer);
  }, [status]);

  async function share() {
    setStatus(null);
    const text = recipeText(recipe, view);
    if (typeof navigator.share === 'function') {
      try {
        await navigator.share({ title: recipe.title, text });
        return;
      } catch (error) {
        // Closed, or a second tap while the sheet is still open: nothing to say. A refusal to
        // share at all (NotAllowedError, TypeError) falls back to copying.
        if (
          error instanceof DOMException &&
          (error.name === 'AbortError' || error.name === 'InvalidStateError')
        ) {
          return;
        }
      }
    }
    try {
      await navigator.clipboard.writeText(text);
      setStatus('copied');
    } catch {
      setStatus('failed');
    }
  }

  return (
    <div className={styles.share}>
      <div className={styles.buttons}>
        <button
          type="button"
          className={styles.pill}
          disabled={waiting}
          onClick={() => void share()}
        >
          Share
        </button>
        <button
          type="button"
          className={styles.pill}
          disabled={waiting}
          onClick={() => window.print()}
        >
          Print
        </button>
      </div>
      {status === 'copied' && (
        <p className={styles.status} role="status">
          Recipe copied. Paste it into a message or an email.
        </p>
      )}
      {status === 'failed' && (
        <p className={styles.failed} role="alert">
          Couldn’t copy the recipe. Try Print, and save it as a PDF.
        </p>
      )}
    </div>
  );
}

/**
 * The recipe laid out for paper: title, photo, numbers, then every ingredient and every step,
 * which the screen shows one pane at a time. Hidden on screen. Rendered straight into `<body>`,
 * so the print stylesheet can hide everything else there, app chrome included, in one rule.
 */
export function PrintSheet({
  recipe,
  view,
  coverFileId,
}: {
  recipe: ShareableRecipe;
  view: ShareView;
  coverFileId: string | null;
}) {
  // The print stylesheet hides the rest of <body> only while this sheet is mounted, so printing
  // any other screen, such as the shopping list, still prints that screen.
  useEffect(() => {
    document.body.setAttribute('data-printing-recipe', '');
    return () => document.body.removeAttribute('data-printing-recipe');
  }, []);
  return createPortal(
    <article className={styles.sheet} data-print-sheet="" aria-hidden="true">
      <PrintedRecipe recipe={recipe} view={view} coverFileId={coverFileId} main />
      {/* The recipes its lines are made from, each at its own servings, after a rule. */}
      {(recipe.linkedRecipes ?? []).map((linked) => (
        <section key={linked.id} className={styles.linked}>
          <PrintedRecipe
            recipe={linked}
            view={{ servings: linked.servings, system: view.system }}
            coverFileId={null}
          />
        </section>
      ))}
    </article>,
    document.body,
  );
}

/** One recipe on the sheet. The main one takes the page title; a linked one sits a level down. */
function PrintedRecipe({
  recipe,
  view,
  coverFileId,
  main = false,
}: {
  recipe: ShareableRecipe;
  view: ShareView;
  coverFileId: string | null;
  main?: boolean;
}) {
  const Title = main ? 'h1' : 'h2';
  const Heading = main ? 'h2' : 'h3';
  const source = sourceLine(recipe);
  return (
    <>
      <Title className={styles.title}>{recipe.title}</Title>
      <p className={styles.meta}>{recipeMeta(recipe, view)}</p>
      {coverFileId && <img className={styles.cover} src={fileUrl(coverFileId, 'full')} alt="" />}
      {recipe.description && <p className={styles.description}>{recipe.description}</p>}
      {recipe.ingredients.length > 0 && (
        <section>
          <Heading className={styles.heading}>Ingredients</Heading>
          <ul className={styles.ingredients}>
            {byPosition(recipe.ingredients).map((ing) => (
              <li key={ing.id}>{ingredientText(ing, recipe.servings, view)}</li>
            ))}
          </ul>
        </section>
      )}
      {recipe.steps.length > 0 && (
        <section>
          <Heading className={styles.heading}>Steps</Heading>
          <ol className={styles.steps}>
            {byPosition(recipe.steps).map((step) => (
              <li key={step.id}>{step.text}</li>
            ))}
          </ol>
        </section>
      )}
      {source && <p className={styles.source}>Source: {source}</p>}
    </>
  );
}
