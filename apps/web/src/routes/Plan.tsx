import { useEffect, useRef, useState, type FormEvent, type ReactNode } from 'react';
import { Link } from 'react-router-dom';
import { addDays, PLAN_MEALS, weekDates, type PlanMeal } from '@hearth/shared';
import { trpc } from '../lib/trpc';
import styles from './Plan.module.css';
import { useDocumentTitle } from '../lib/useDocumentTitle';
import { formatDay, localToday } from '../lib/dates';
import { CookLogForm } from './CookLog';

// One entry as `plan.week` returns it (repo/plan.ts `PlanEntry`).
type Entry = {
  id: string;
  date: string;
  meal: string;
  servings: number;
  onList: boolean;
  recipe: { id: string; slug: string; title: string; servings: number };
};

type Slot = { date: string; meal: PlanMeal };

const MEAL_LABEL: Record<PlanMeal, string> = {
  breakfast: 'Breakfast',
  lunch: 'Lunch',
  dinner: 'Dinner',
};

// Kept exported from here as well, where the planner's tests and PlanThisRecipe find it.
export { localToday };

function weekLabel(start: string): string {
  const end = addDays(start, 6);
  return `${formatDay(start, { month: 'short', day: 'numeric' })} – ${formatDay(end, {
    month: 'short',
    day: 'numeric',
  })}`;
}

export function Plan() {
  useDocumentTitle('Plan');
  const today = localToday();
  const [anchor, setAnchor] = useState(today);
  const [picking, setPicking] = useState<Slot | null>(null);
  const [moving, setMoving] = useState<Entry | null>(null);
  // A planned meal being logged as cooked, and the last one that was, for the status line.
  const [logging, setLogging] = useState<Entry | null>(null);
  const [logged, setLogged] = useState<string | null>(null);
  const [built, setBuilt] = useState<number | null>(null);

  const utils = trpc.useUtils();
  const invalidate = () => utils.plan.week.invalidate();
  const week = trpc.plan.week.useQuery(
    { date: anchor },
    { placeholderData: (previous) => previous },
  );
  const update = trpc.plan.update.useMutation({ onSuccess: invalidate });
  const remove = trpc.plan.remove.useMutation({ onSuccess: invalidate });
  const build = trpc.plan.buildList.useMutation({
    onSuccess: (result) => {
      setBuilt(result.added);
      void invalidate();
      void utils.shoppingList.get.invalidate();
    },
  });

  // On a phone the week is a column of seven cards, and today is often below the fold. Bring it
  // into view once per visit to the current week, not on every refetch after an edit.
  const todayCard = useRef<HTMLElement | null>(null);
  const scrolledFor = useRef<string | null>(null);
  const loadedStart = week.data?.start;
  useEffect(() => {
    if (!loadedStart || scrolledFor.current === loadedStart || !todayCard.current) return;
    scrolledFor.current = loadedStart;
    todayCard.current.scrollIntoView?.({ block: 'start', behavior: 'smooth' });
  }, [loadedStart]);

  if (week.isLoading) {
    return (
      <section className={styles.screen}>
        <h1 className={styles.title}>Plan</h1>
        <p className={styles.status}>Loading your week…</p>
      </section>
    );
  }
  if (week.isError || !week.data) {
    return (
      <section className={styles.screen}>
        <h1 className={styles.title}>Plan</h1>
        <p className={styles.error} role="alert">
          Couldn’t load your plan. Please try again.
        </p>
      </section>
    );
  }

  const { start } = week.data;
  const entries: Entry[] = week.data.entries;
  const pending = entries.filter((e) => !e.onList).length;
  const days = weekDates(start);

  function go(date: string) {
    setAnchor(date);
    setBuilt(null);
  }

  return (
    <section className={styles.screen}>
      <header className={styles.header}>
        <div className={styles.headRow}>
          <h1 className={styles.title}>Plan</h1>
          <span className={styles.range}>{weekLabel(start)}</span>
        </div>
        <div className={styles.headRow}>
          <nav className={styles.weekNav} aria-label="Week">
            <button
              type="button"
              className={styles.navButton}
              onClick={() => go(addDays(start, -7))}
            >
              ‹ Prev
            </button>
            <button
              type="button"
              className={styles.navButton}
              onClick={() => go(today)}
              disabled={days.includes(today)}
            >
              This week
            </button>
            <button
              type="button"
              className={styles.navButton}
              onClick={() => go(addDays(start, 7))}
            >
              Next ›
            </button>
          </nav>
          <button
            type="button"
            className={styles.build}
            disabled={pending === 0 || build.isPending}
            onClick={() => build.mutate({ start })}
          >
            Build shopping list{pending > 0 ? ` (${pending} new)` : ''}
          </button>
        </div>
        {built !== null && (
          <p className={styles.built} role="status">
            {built === 0
              ? 'Everything this week is already on your list.'
              : `Added ${built} ${built === 1 ? 'meal' : 'meals'} to your list.`}{' '}
            <Link to="/shop">Open the list</Link>
          </p>
        )}
      </header>

      <div className={styles.days}>
        {days.map((date) => (
          <article
            key={date}
            ref={date === today ? todayCard : undefined}
            className={date === today ? `${styles.day} ${styles.today}` : styles.day}
            aria-label={formatDay(date, { weekday: 'long', month: 'long', day: 'numeric' })}
          >
            <h2 className={styles.dayTitle}>
              {formatDay(date, { weekday: 'short', month: 'short', day: 'numeric' })}
              {date === today && <span className={styles.todayMark}>Today</span>}
            </h2>
            {PLAN_MEALS.map((meal) => {
              const inSlot = entries.filter((e) => e.date === date && e.meal === meal);
              // A meal with nothing planned is one small pill in the row below, not a row of its
              // own: an empty week was 21 "+ Add" rows (D49).
              if (inSlot.length === 0) return null;
              return (
                <div key={meal} className={styles.slot}>
                  <div className={styles.slotHead}>
                    <h3 className={styles.mealName}>{MEAL_LABEL[meal]}</h3>
                    <button
                      type="button"
                      className={styles.addButton}
                      onClick={() => setPicking({ date, meal })}
                      aria-label={`Add to ${formatDay(date, { weekday: 'long' })} ${MEAL_LABEL[meal]}`}
                    >
                      + Add
                    </button>
                  </div>
                  <ul className={styles.entries}>
                    {inSlot.map((entry) => (
                      <EntryRow
                        key={entry.id}
                        entry={entry}
                        onServings={(servings) => update.mutate({ id: entry.id, servings })}
                        onMove={() => setMoving(entry)}
                        onRemove={() => remove.mutate({ id: entry.id })}
                        // Today's and earlier meals only: a meal cannot have been cooked yet.
                        {...(entry.date <= today
                          ? {
                              onCooked: () => {
                                setLogged(null);
                                setLogging(entry);
                              },
                            }
                          : {})}
                      />
                    ))}
                  </ul>
                </div>
              );
            })}
            {PLAN_MEALS.some(
              (meal) => !entries.some((e) => e.date === date && e.meal === meal),
            ) && (
              <div className={styles.emptyMeals}>
                {PLAN_MEALS.filter(
                  (meal) => !entries.some((e) => e.date === date && e.meal === meal),
                ).map((meal) => (
                  <button
                    key={meal}
                    type="button"
                    className={styles.mealPill}
                    onClick={() => setPicking({ date, meal })}
                    aria-label={`Add to ${formatDay(date, { weekday: 'long' })} ${MEAL_LABEL[meal]}`}
                  >
                    + {MEAL_LABEL[meal]}
                  </button>
                ))}
              </div>
            )}
          </article>
        ))}
      </div>

      {picking && (
        <RecipePicker
          slot={picking}
          onClose={() => setPicking(null)}
          onAdded={() => {
            setPicking(null);
            setBuilt(null);
            void invalidate();
          }}
        />
      )}
      {logged && (
        <p className={styles.logged} role="status">
          Logged {logged}. It’s in the recipe’s Cooked it history.
        </p>
      )}

      {logging && (
        <Sheet title={`Cooked ${logging.recipe.title}`} onClose={() => setLogging(null)}>
          <CookLogForm
            recipeId={logging.recipe.id}
            defaults={{ cookedOn: logging.date, servings: logging.servings }}
            onDone={() => {
              setLogged(logging.recipe.title);
              setLogging(null);
            }}
            onCancel={() => setLogging(null)}
          />
        </Sheet>
      )}

      {moving && (
        <MoveSheet
          entry={moving}
          days={days}
          onClose={() => setMoving(null)}
          onMove={(date, meal) => {
            update.mutate({ id: moving.id, date, meal }, { onSuccess: () => setMoving(null) });
          }}
        />
      )}
    </section>
  );
}

function EntryRow({
  entry,
  onServings,
  onMove,
  onRemove,
  onCooked,
}: {
  entry: Entry;
  onServings: (servings: number) => void;
  onMove: () => void;
  onRemove: () => void;
  onCooked?: () => void;
}) {
  const title = entry.recipe.title;
  return (
    <li className={styles.entry}>
      <div className={styles.entryMain}>
        <Link to={`/recipes/${entry.recipe.slug}`} className={styles.entryTitle}>
          {title}
        </Link>
        {entry.onList && <span className={styles.onList}>On list</span>}
      </div>
      <div className={styles.entryControls}>
        <div className={styles.stepper}>
          <button
            type="button"
            onClick={() => onServings(entry.servings - 1)}
            disabled={entry.servings <= 1}
            aria-label={`Fewer servings of ${title}`}
          >
            −
          </button>
          <span aria-label={`${entry.servings} servings`}>{entry.servings}</span>
          <button
            type="button"
            onClick={() => onServings(entry.servings + 1)}
            aria-label={`More servings of ${title}`}
          >
            +
          </button>
        </div>
        {onCooked && (
          <button
            type="button"
            className={styles.textButton}
            onClick={onCooked}
            aria-label={`Cooked ${title}`}
          >
            Cooked it
          </button>
        )}
        <button type="button" className={styles.textButton} onClick={onMove}>
          Move
        </button>
        <button
          type="button"
          className={styles.remove}
          onClick={onRemove}
          aria-label={`Remove ${title}`}
        >
          ×
        </button>
      </div>
    </li>
  );
}

function Sheet({
  title,
  onClose,
  children,
}: {
  title: string;
  onClose: () => void;
  children: ReactNode;
}) {
  return (
    <>
      <div className={styles.scrim} onClick={onClose} />
      <div className={styles.sheet} role="dialog" aria-modal="true" aria-label={title}>
        <div className={styles.sheetBar}>
          <h2 className={styles.sheetTitle}>{title}</h2>
          <button type="button" className={styles.textButton} onClick={onClose}>
            Close
          </button>
        </div>
        <div className={styles.sheetBody}>{children}</div>
      </div>
    </>
  );
}

function RecipePicker({
  slot,
  onClose,
  onAdded,
}: {
  slot: Slot;
  onClose: () => void;
  onAdded: () => void;
}) {
  const [text, setText] = useState('');
  const [chosen, setChosen] = useState<{ id: string; title: string; servings: number } | null>(
    null,
  );
  const [servings, setServings] = useState(1);
  const recipes = trpc.recipe.list.useQuery(text.trim() ? { text: text.trim() } : undefined, {
    placeholderData: (previous) => previous,
  });
  const add = trpc.plan.add.useMutation({ onSuccess: onAdded });

  const title = `Add to ${formatDay(slot.date, { weekday: 'short' })} · ${MEAL_LABEL[slot.meal]}`;

  function submit(e: FormEvent) {
    e.preventDefault();
    if (!chosen || add.isPending) return;
    add.mutate({ date: slot.date, meal: slot.meal, recipeId: chosen.id, servings });
  }

  if (chosen) {
    return (
      <Sheet title={title} onClose={onClose}>
        <form className={styles.chosen} onSubmit={submit}>
          <p className={styles.chosenTitle}>{chosen.title}</p>
          <label className={styles.servingsField}>
            Servings
            <input
              type="number"
              min={1}
              max={100}
              value={servings}
              onChange={(e) => setServings(Math.max(1, Math.min(100, Number(e.target.value) || 1)))}
            />
          </label>
          <div className={styles.chosenActions}>
            <button type="button" className={styles.textButton} onClick={() => setChosen(null)}>
              Back
            </button>
            <button type="submit" className={styles.build} disabled={add.isPending}>
              Add to plan
            </button>
          </div>
          {add.isError && (
            <p className={styles.error} role="alert">
              Couldn’t add that. Please try again.
            </p>
          )}
        </form>
      </Sheet>
    );
  }

  const cards = recipes.data ?? [];
  return (
    <Sheet title={title} onClose={onClose}>
      <input
        className={styles.search}
        type="search"
        value={text}
        onChange={(e) => setText(e.target.value)}
        placeholder="Search your recipes"
        aria-label="Search your recipes"
        autoFocus
      />
      {recipes.isLoading && <p className={styles.status}>Loading recipes…</p>}
      {!recipes.isLoading && cards.length === 0 && (
        <p className={styles.status}>
          {text.trim() ? 'No recipes match.' : 'No recipes yet. Add or import one first.'}
        </p>
      )}
      <ul className={styles.results}>
        {cards.map((card) => (
          <li key={card.id}>
            <button
              type="button"
              className={styles.result}
              onClick={() => {
                setChosen({ id: card.id, title: card.title, servings: card.servings });
                setServings(card.servings);
              }}
            >
              <span>{card.title}</span>
              <span className={styles.resultMeta}>serves {card.servings}</span>
            </button>
          </li>
        ))}
      </ul>
    </Sheet>
  );
}

function MoveSheet({
  entry,
  days,
  onClose,
  onMove,
}: {
  entry: Entry;
  days: string[];
  onClose: () => void;
  onMove: (date: string, meal: PlanMeal) => void;
}) {
  const [date, setDate] = useState(entry.date);
  const [meal, setMeal] = useState<PlanMeal>(
    (PLAN_MEALS as readonly string[]).includes(entry.meal) ? (entry.meal as PlanMeal) : 'dinner',
  );
  return (
    <Sheet title={`Move ${entry.recipe.title}`} onClose={onClose}>
      <form
        className={styles.chosen}
        onSubmit={(e) => {
          e.preventDefault();
          onMove(date, meal);
        }}
      >
        <label className={styles.servingsField}>
          Day
          <select value={date} onChange={(e) => setDate(e.target.value)}>
            {days.map((d) => (
              <option key={d} value={d}>
                {formatDay(d, { weekday: 'long', month: 'short', day: 'numeric' })}
              </option>
            ))}
          </select>
        </label>
        <label className={styles.servingsField}>
          Meal
          <select value={meal} onChange={(e) => setMeal(e.target.value as PlanMeal)}>
            {PLAN_MEALS.map((m) => (
              <option key={m} value={m}>
                {MEAL_LABEL[m]}
              </option>
            ))}
          </select>
        </label>
        <div className={styles.chosenActions}>
          <button type="submit" className={styles.build}>
            Move
          </button>
        </div>
      </form>
    </Sheet>
  );
}
