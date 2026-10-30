import { Fragment, useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { Link, useParams, useSearchParams } from 'react-router-dom';
import { findStepDurations } from '@hearth/shared';
import { TimerTray, useCookTimers } from '../cook/TimerTray';
import {
  clearCookSession,
  loadCookSession,
  saveCookSession,
  sweepStaleCookSessions,
} from '../cook/cookSession';
import { trpc } from '../lib/trpc';
import { amountText, hasSecondMeasure, useMeasureSystem } from '../lib/measure-system';
import styles from './CookMode.module.css';
import { useDocumentTitle } from '../lib/useDocumentTitle';

/**
 * Keep the screen on while cook mode is open.
 *
 * Three things about the Screen Wake Lock API drive the shape of this:
 *
 *  - It is absent in Firefox and on any insecure origin other than localhost, so the guard
 *    below is a real branch rather than defensive padding. Hearth is self-hosted and reaching
 *    an instance over plain http on a LAN address is an ordinary way to run it.
 *  - `request()` rejects when the document is hidden, and can be refused outright.
 *  - The browser releases the lock when the tab is hidden and does NOT restore it, so coming
 *    back to the tab has to ask again.
 *
 * Every failure here is silent by design: the screen dims, which is the behaviour cook mode had
 * before this existed, and nothing on the screen depends on holding a lock.
 */
function useScreenWakeLock(): void {
  useEffect(() => {
    // lib.dom types this as always present; it is not.
    const api: WakeLock | undefined = navigator.wakeLock;
    if (!api) return;

    let sentinel: WakeLockSentinel | null = null;
    let requestInFlight = false;
    let leftScreen = false;

    async function acquire(): Promise<void> {
      // `api` is re-checked because TypeScript does not carry the narrowing above into this
      // closure, not because it can become undefined after the fact.
      if (leftScreen || api === undefined) return;
      // A lock we hold, or one already on its way, does not need asking for again. Without the
      // in-flight half, a visibilitychange arriving before the first request resolves starts a
      // second one, and the sentinel the second overwrites is never released: the screen then
      // stays awake after the cook leaves cook mode.
      if (requestInFlight) return;
      if (sentinel !== null && !sentinel.released) return;
      requestInFlight = true;
      try {
        const next = await api.request('screen');
        if (leftScreen) {
          void next.release().catch(() => {});
          return;
        }
        sentinel = next;
      } catch {
        // Refused, or asked for while hidden. The screen dims; nothing else changes.
      } finally {
        requestInFlight = false;
      }
    }

    function handleVisibilityChange(): void {
      if (document.visibilityState === 'visible') void acquire();
    }

    void acquire();
    document.addEventListener('visibilitychange', handleVisibilityChange);

    return () => {
      leftScreen = true;
      document.removeEventListener('visibilitychange', handleVisibilityChange);
      void sentinel?.release().catch(() => {});
      sentinel = null;
    };
  }, []);
}

/**
 * A step's text, with every duration it mentions turned into a button that starts that timer.
 *
 * The spans come from `findStepDurations` in packages/shared, so only the phrase itself is
 * interactive: a cook aiming at "20 minutes" with a wet thumb should not have to avoid the rest
 * of the sentence, and the rest of the sentence should not look tappable.
 */
function StepText({
  text,
  stepNumber,
  onStartTimer,
}: {
  text: string;
  stepNumber: number;
  onStartTimer: (label: string, seconds: number) => void;
}) {
  const durations = useMemo(() => findStepDurations(text), [text]);
  const parts: ReactNode[] = [];
  let cursor = 0;

  durations.forEach((duration, index) => {
    if (duration.start > cursor) {
      parts.push(<Fragment key={`text-${index}`}>{text.slice(cursor, duration.start)}</Fragment>);
    }
    const phrase = text.slice(duration.start, duration.end);
    parts.push(
      <button
        key={`timer-${index}`}
        type="button"
        className={styles.timerPhrase}
        onClick={() => onStartTimer(`Step ${stepNumber} · ${phrase}`, duration.seconds)}
        aria-label={`Start a timer for ${phrase}, step ${stepNumber}`}
      >
        {phrase}
      </button>,
    );
    cursor = duration.end;
  });

  if (cursor < text.length) parts.push(<Fragment key="text-tail">{text.slice(cursor)}</Fragment>);
  return <>{parts}</>;
}

/** One ingredient as the peek shows it. Mirrors what `recipe.get` returns. */
interface PeekIngredient {
  id: string;
  position: number;
  quantity: number | null;
  unit: string | null;
  altQuantity: number | null;
  altUnit: string | null;
  note: string | null;
  scalingMode: string;
  foodName: string | null;
  linkedRecipe: { slug: string; title: string } | null;
}

/**
 * The ingredients bottom sheet (D26): what is in the pan, at the servings the cook chose.
 *
 * The amounts are scaled HERE by the same `amountText()` the recipe screen uses, from the servings
 * carried in the URL. Nothing about the peek re-derives what the cook picked.
 *
 * Keyboard: Escape closes it, focus moves to the close button when it opens and returns to the
 * trigger when it shuts. Tab can still walk out of the sheet into the steps behind it, and it
 * carries no `aria-modal`, because that would tell a screen reader the rest of the screen is
 * unavailable while leaving it reachable. A peek is not a modal, and the timer tray below it
 * has to stay usable while it is open.
 */
function IngredientPeek({
  ingredients,
  baseServings,
  servings,
  onClose,
}: {
  ingredients: PeekIngredient[];
  baseServings: number;
  servings: number;
  onClose: () => void;
}) {
  const closeRef = useRef<HTMLButtonElement>(null);
  // The system picked on the recipe screen, read here and switchable here too.
  const [system, setSystem] = useMeasureSystem();

  useEffect(() => {
    closeRef.current?.focus();
  }, []);

  useEffect(() => {
    function handleKeyDown(event: KeyboardEvent): void {
      if (event.key === 'Escape') onClose();
    }
    document.addEventListener('keydown', handleKeyDown);
    return () => document.removeEventListener('keydown', handleKeyDown);
  }, [onClose]);

  return (
    <div className={styles.sheet} role="dialog" aria-labelledby="peek-title">
      <div className={styles.sheetBar}>
        <h2 id="peek-title" className={styles.sheetTitle}>
          Ingredients · {servings} {servings === 1 ? 'serving' : 'servings'}
        </h2>
        {hasSecondMeasure(ingredients) && (
          <button
            type="button"
            className={styles.sheetClose}
            onClick={() => setSystem(system === 'us' ? 'metric' : 'us')}
            aria-label={system === 'us' ? 'Show metric measures' : 'Show US measures'}
          >
            {system === 'us' ? 'Metric' : 'US'}
          </button>
        )}
        <button type="button" ref={closeRef} className={styles.sheetClose} onClick={onClose}>
          Close
        </button>
      </div>
      <ul className={styles.peekList}>
        {[...ingredients]
          .sort((a, b) => a.position - b.position)
          .map((ingredient) => {
            const amount = amountText(ingredient, system, { from: baseServings, to: servings });
            return (
              <li key={ingredient.id} className={styles.peekItem}>
                {amount !== null && <span className={styles.peekAmount}>{amount}</span>}
                <span className={styles.peekFood}>
                  {ingredient.foodName ?? ingredient.linkedRecipe?.title}
                </span>
                {ingredient.note && <span className={styles.peekNote}>{ingredient.note}</span>}
                {ingredient.linkedRecipe && (
                  <Link to={`/recipes/${ingredient.linkedRecipe.slug}`} className={styles.peekLink}>
                    → {ingredient.linkedRecipe.title}
                  </Link>
                )}
              </li>
            );
          })}
      </ul>
    </div>
  );
}

/**
 * The servings the cook scaled to on the recipe screen, read from the URL.
 *
 * A query parameter rather than router location state, because location state does not survive
 * a reload or a link sent to the person actually doing the cooking, and both of those are
 * ordinary here: a phone propped against a bowl gets reloaded. Anything unusable - absent,
 * not a number, zero, negative, fractional - falls back to the recipe's own servings rather
 * than showing amounts nobody asked for.
 *
 * The shape is matched before the value is read, because `Number()` alone would take `0x10` as
 * 16, `1e3` as 1000 and `1e15` as a scale factor that turns every amount into scientific
 * notation. Nothing this app links to produces those; a URL somebody edited or forwarded can.
 *
 * No D38 concern: the server's request-log serializer strips query strings, so this never
 * reaches a log line.
 */
function servingsFromUrl(raw: string | null, baseServings: number): number {
  if (raw === null || !/^\d{1,3}$/.test(raw)) return baseServings;
  const parsed = Number(raw);
  return parsed >= 1 ? parsed : baseServings;
}

/** The recipe as cook mode uses it. Mirrors what `recipe.get` returns. */
interface CookRecipe {
  id: string;
  title: string;
  servings: number;
  steps: { id: string; position: number; text: string }[];
  ingredients: PeekIngredient[];
}

/**
 * Cook mode: the full-screen Focus view from D26, rendered OUTSIDE AppShell (never a tab, D25).
 *
 * This part loads the recipe and holds the wake lock; `CookSession` below is the screen itself.
 */
export function CookMode() {
  const { slug } = useParams();
  const [searchParams] = useSearchParams();
  const recipeQuery = trpc.recipe.get.useQuery({ idOrSlug: slug ?? '' });
  useDocumentTitle(recipeQuery.data ? `Cooking ${recipeQuery.data.title}` : null);

  useScreenWakeLock();

  const backTo = `/recipes/${slug ?? ''}`;

  if (recipeQuery.isLoading) {
    return (
      <div className={styles.screen}>
        <p className={styles.status}>Loading recipe…</p>
      </div>
    );
  }

  const recipe = recipeQuery.isError ? null : recipeQuery.data;
  if (!recipe) {
    return (
      <div className={styles.screen}>
        <p className={styles.status}>Recipe not found.</p>
        <p>
          <Link to={backTo} className={styles.back}>
            ← Back to recipe
          </Link>
        </p>
      </div>
    );
  }

  // Keyed by id, so the saved progress it reads on mount is always this recipe's.
  return (
    <CookSession
      key={recipe.id}
      recipe={recipe}
      servings={servingsFromUrl(searchParams.get('servings'), recipe.servings)}
      backTo={backTo}
    />
  );
}

/**
 * One scroll of steps, the current one enlarged and the done ones dimmed, struck through and
 * ticked, so checked state survives being read at arm's length in a bright kitchen and does not
 * rest on colour alone.
 *
 * Which steps are done, and the running timers, are client state (D26): never a database write.
 * They are kept in this device's storage per recipe (`cookSession.ts`), so a reload, a tab the
 * phone evicted, or a trip back to the recipe picks up where the cook was, with timers that kept
 * counting while the page was gone. Once every step is done and no timer is left, the saved
 * session is cleared and the next visit starts fresh.
 */
function CookSession({
  recipe,
  servings,
  backTo,
}: {
  recipe: CookRecipe;
  servings: number;
  backTo: string;
}) {
  const steps = [...recipe.steps].sort((a, b) => a.position - b.position);
  // Read once, on mount.
  const [saved] = useState(() => {
    const now = Date.now();
    sweepStaleCookSessions(now);
    return loadCookSession(recipe.id, now);
  });
  // A ticked step the recipe no longer has, after an edit, is dropped.
  const [doneStepIds, setDoneStepIds] = useState<ReadonlySet<string>>(() => {
    const known = new Set(recipe.steps.map((step) => step.id));
    return new Set(saved?.doneStepIds.filter((id) => known.has(id)));
  });
  const { timers, start: startTimer, cancel: cancelTimer } = useCookTimers(saved?.timers);
  const [peekOpen, setPeekOpen] = useState(false);
  const peekTriggerRef = useRef<HTMLButtonElement>(null);
  const currentStepRef = useRef<HTMLLIElement>(null);
  const currentToggleRef = useRef<HTMLButtonElement>(null);

  // Written on each change to what is ticked or timed, and only then: the half-second tick
  // redraws the tray without touching either, so it does not write.
  const allStepsDone = steps.every((step) => doneStepIds.has(step.id));
  useEffect(() => {
    if (timers.length === 0 && (doneStepIds.size === 0 || allStepsDone)) {
      clearCookSession(recipe.id);
    } else {
      saveCookSession(recipe.id, { doneStepIds: [...doneStepIds], timers }, Date.now());
    }
  }, [recipe.id, doneStepIds, timers, allStepsDone]);

  // Stable, because the peek subscribes to `keydown` on it: a new identity every render would
  // tear that listener down and re-add it twice a second while a timer runs.
  const closePeek = useCallback(() => {
    setPeekOpen(false);
    peekTriggerRef.current?.focus();
  }, []);

  // The current step is the first one not yet ticked; -1 once they all are.
  const currentIndex = steps.findIndex((step) => !doneStepIds.has(step.id));

  // Land on the step the cook is up to, once, when the session opens. The recipe screen's
  // "Start cooking" sits in a sticky bar, so the press usually comes from far down the page,
  // and without this the steps opened at that same scroll offset, past step 1. A fresh session
  // goes to the very top so the title and progress line show; a resumed one centres its step.
  // Focus follows for a keyboard or screen-reader cook, without a second scroll.
  useEffect(() => {
    const step = currentStepRef.current;
    if (step && step !== step.parentElement?.firstElementChild) {
      step.scrollIntoView?.({ block: 'center' });
    } else {
      window.scrollTo({ top: 0 });
    }
    currentToggleRef.current?.focus({ preventScroll: true });
  }, []);

  function toggleStep(id: string): void {
    setDoneStepIds((previous) => {
      const next = new Set(previous);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  return (
    <div className={styles.screen}>
      <header className={styles.bar}>
        <Link to={backTo} className={styles.back} aria-label="Back to recipe">
          ←<span className={styles.backWord}>Back</span>
        </Link>
        <div className={styles.heading}>
          <h1 className={styles.title}>{recipe.title}</h1>
          <p className={styles.progress} role="status">
            {currentIndex === -1
              ? `All ${steps.length} steps done`
              : `Step ${currentIndex + 1} of ${steps.length}`}
          </p>
        </div>
        <button
          type="button"
          ref={peekTriggerRef}
          className={styles.peekButton}
          onClick={() => setPeekOpen(true)}
          aria-haspopup="dialog"
          aria-expanded={peekOpen}
        >
          Ingredients
        </button>
      </header>

      <ol className={styles.steps}>
        {steps.map((step, index) => {
          const done = doneStepIds.has(step.id);
          const current = index === currentIndex;
          const labelId = `${step.id}-label`;
          const textId = `${step.id}-text`;
          return (
            <li
              key={step.id}
              ref={current ? currentStepRef : undefined}
              className={done ? styles.stepDone : current ? styles.stepCurrent : styles.step}
              aria-current={current ? 'step' : undefined}
            >
              {/*
                The whole row is the tap target: this button carries a stretched ::after that
                covers the card, and the step text above it does not take pointer events. Hands
                are messy and the phone is at arm's length, so a 48px circle alone is too small
                a thing to have to hit.
              */}
              <button
                type="button"
                role="checkbox"
                aria-checked={done}
                aria-labelledby={`${labelId} ${textId}`}
                ref={current ? currentToggleRef : undefined}
                className={styles.toggle}
                onClick={() => toggleStep(step.id)}
              >
                <span aria-hidden="true">{done ? '✓' : index + 1}</span>
                <span id={labelId} className={styles.srOnly}>
                  Step {index + 1}
                </span>
              </button>
              <div id={textId} className={styles.stepText}>
                <StepText text={step.text} stepNumber={index + 1} onStartTimer={startTimer} />
              </div>
            </li>
          );
        })}
      </ol>

      {peekOpen && <div className={styles.scrim} onClick={closePeek} aria-hidden="true" />}

      {/*
        The peek and the tray stack in ONE bottom dock rather than overlapping as two fixed
        layers. A sheet drawn over the tray would put a firing timer's Stop button behind it,
        which is the one thing the tray exists to keep reachable.
      */}
      <div className={styles.dock}>
        {peekOpen && (
          <IngredientPeek
            ingredients={recipe.ingredients}
            baseServings={recipe.servings}
            servings={servings}
            onClose={closePeek}
          />
        )}
        <TimerTray timers={timers} onCancel={cancelTimer} />
      </div>
    </div>
  );
}
