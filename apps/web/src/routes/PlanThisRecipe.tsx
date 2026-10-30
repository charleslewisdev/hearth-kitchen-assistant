import { useState, type FormEvent } from 'react';
import { Link } from 'react-router-dom';
import { addDays, PLAN_MEALS, type PlanMeal } from '@hearth/shared';
import { trpc } from '../lib/trpc';
import { localToday } from './Plan';
import styles from './RecipeView.module.css';

/** How far ahead the recipe screen offers days. The Plan tab reaches any week. */
const DAYS_AHEAD = 14;

const MEAL_LABEL: Record<PlanMeal, string> = {
  breakfast: 'Breakfast',
  lunch: 'Lunch',
  dinner: 'Dinner',
};

function dayLabel(date: string, today: string): string {
  if (date === today) return 'Today';
  if (date === addDays(today, 1)) return 'Tomorrow';
  return new Date(`${date}T00:00:00Z`).toLocaleDateString(undefined, {
    weekday: 'long',
    month: 'short',
    day: 'numeric',
    timeZone: 'UTC',
  });
}

/**
 * "Add to plan" from the recipe itself, for planning while browsing. The servings start at
 * whatever the cook scaled the recipe to on this screen.
 */
export function PlanThisRecipe({ recipeId, servings }: { recipeId: string; servings: number }) {
  const today = localToday();
  const [open, setOpen] = useState(false);
  const [date, setDate] = useState(today);
  const [meal, setMeal] = useState<PlanMeal>('dinner');
  const [planned, setPlanned] = useState<string | null>(null);
  const utils = trpc.useUtils();
  const add = trpc.plan.add.useMutation({
    onSuccess: () => {
      void utils.plan.week.invalidate();
      setPlanned(`${dayLabel(date, today)} · ${MEAL_LABEL[meal]}`);
      setOpen(false);
    },
  });

  function submit(e: FormEvent) {
    e.preventDefault();
    if (add.isPending) return;
    add.mutate({ date, meal, recipeId, servings });
  }

  if (!open) {
    return (
      <div className={styles.planThis}>
        <button
          type="button"
          className={styles.addButton}
          onClick={() => {
            setPlanned(null);
            setOpen(true);
          }}
        >
          Add to plan
        </button>
        {planned && (
          <p className={styles.confirmation} role="status">
            Planned for {planned} ({servings} servings). <Link to="/plan">Open the plan</Link>
          </p>
        )}
      </div>
    );
  }

  const days = Array.from({ length: DAYS_AHEAD }, (_, i) => addDays(today, i));
  return (
    <form className={styles.planForm} onSubmit={submit} aria-label="Add to plan">
      <label>
        Day
        <select value={date} onChange={(e) => setDate(e.target.value)}>
          {days.map((d) => (
            <option key={d} value={d}>
              {dayLabel(d, today)}
            </option>
          ))}
        </select>
      </label>
      <label>
        Meal
        <select value={meal} onChange={(e) => setMeal(e.target.value as PlanMeal)}>
          {PLAN_MEALS.map((m) => (
            <option key={m} value={m}>
              {MEAL_LABEL[m]}
            </option>
          ))}
        </select>
      </label>
      <div className={styles.confirmActions}>
        <button type="button" className={styles.secondaryButton} onClick={() => setOpen(false)}>
          Cancel
        </button>
        <button type="submit" className={styles.addButton} disabled={add.isPending}>
          Plan {servings} servings
        </button>
      </div>
      {add.isError && (
        <p className={styles.error} role="alert">
          Couldn’t add this to the plan. Please try again.
        </p>
      )}
    </form>
  );
}
