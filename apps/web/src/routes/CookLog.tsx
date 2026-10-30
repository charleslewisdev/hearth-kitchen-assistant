import { useState, type FormEvent } from 'react';
import { trpc } from '../lib/trpc';
import { daysAgo, formatDay, localToday } from '../lib/dates';
import { fileUrl } from '../lib/photo-upload';
import { usePhotoUpload } from './RecipePhotos';
import { StarRating } from './StarRating';
import styles from './CookLog.module.css';

/** One entry as `cookLog.list` returns it. */
export interface CookLogEntry {
  id: string;
  cookedOn: string;
  loggedBy: string | null;
  servings: number | null;
  rating: number | null;
  notes: string | null;
  photoIds: string[];
}

/**
 * Log one cook, or change one: the day, how many it fed, how it went, what to do next time, and
 * photos of it. Shared by the recipe screen and the planner's "Cooked it".
 */
export function CookLogForm({
  recipeId,
  entry,
  defaults,
  onDone,
  onCancel,
}: {
  recipeId: string;
  /** The entry being changed, or none for a new one. */
  entry?: CookLogEntry;
  defaults?: { cookedOn?: string; servings?: number };
  onDone: () => void;
  onCancel: () => void;
}) {
  const utils = trpc.useUtils();
  const add = trpc.cookLog.add.useMutation();
  const update = trpc.cookLog.update.useMutation();
  const { addPhotos, busy, problem } = usePhotoUpload(recipeId);
  const [cookedOn, setCookedOn] = useState(entry?.cookedOn ?? defaults?.cookedOn ?? localToday());
  const [servingsText, setServingsText] = useState(
    String(entry?.servings ?? defaults?.servings ?? ''),
  );
  const [rating, setRating] = useState<number | null>(entry?.rating ?? null);
  const [notes, setNotes] = useState(entry?.notes ?? '');
  const [photos, setPhotos] = useState<File[]>([]);
  const [failed, setFailed] = useState(false);

  const saving = add.isPending || update.isPending || busy > 0;
  const servings = Number.parseInt(servingsText, 10);

  async function save(e: FormEvent) {
    e.preventDefault();
    if (saving || !/^\d{4}-\d{2}-\d{2}$/.test(cookedOn)) return;
    setFailed(false);
    const fields = {
      cookedOn,
      servings: Number.isNaN(servings) || servings < 1 ? null : servings,
      rating,
      notes: notes.trim() || null,
    };
    try {
      const id = entry
        ? (await update.mutateAsync({ id: entry.id, ...fields }), entry.id)
        : (await add.mutateAsync({ recipeId, ...fields })).id;
      if (photos.length > 0) await addPhotos(photos, id);
      await Promise.all([utils.cookLog.list.invalidate(), utils.recipe.list.invalidate()]);
      onDone();
    } catch {
      setFailed(true);
    }
  }

  return (
    <form className={styles.form} onSubmit={(e) => void save(e)}>
      <div className={styles.row}>
        <label className={styles.field}>
          <span className={styles.label}>Cooked on</span>
          <input
            type="date"
            className={styles.input}
            value={cookedOn}
            max={localToday()}
            onChange={(e) => setCookedOn(e.target.value)}
            required
          />
        </label>
        <label className={styles.field}>
          <span className={styles.label}>Servings</span>
          <input
            type="number"
            min={1}
            inputMode="numeric"
            className={styles.input}
            value={servingsText}
            onChange={(e) => setServingsText(e.target.value)}
          />
        </label>
      </div>
      <div className={styles.field}>
        <span className={styles.label} id={`rating-${entry?.id ?? 'new'}`}>
          How did it go?
        </span>
        <StarRating value={rating} onChange={setRating} label="How did it go?" size="large" />
      </div>
      <label className={styles.field}>
        <span className={styles.label}>Notes</span>
        <textarea
          className={styles.input}
          rows={3}
          maxLength={5000}
          value={notes}
          onChange={(e) => setNotes(e.target.value)}
          placeholder="What worked, what to change next time"
        />
      </label>
      <label className={styles.photoPick}>
        {photos.length > 0
          ? `${photos.length} ${photos.length === 1 ? 'photo' : 'photos'} to add`
          : '+ Add photos of it'}
        <input
          type="file"
          accept="image/*"
          multiple
          className={styles.fileInput}
          onChange={(e) => setPhotos(Array.from(e.target.files ?? []))}
        />
      </label>
      {(failed || problem) && (
        <p className={styles.problem} role="alert">
          {problem ?? 'Couldn’t save this. Please try again.'}
        </p>
      )}
      <div className={styles.actions}>
        <button type="button" className={styles.secondary} onClick={onCancel}>
          Cancel
        </button>
        <button type="submit" className={styles.primary} disabled={saving}>
          {busy > 0 ? 'Adding photos…' : saving ? 'Saving…' : entry ? 'Save changes' : 'Log it'}
        </button>
      </div>
    </form>
  );
}

/**
 * "Cooked it": the recipe's history, newest first, and the way to add to it. The summary line
 * is what a cook deciding on dinner reads: how often, how lately.
 */
export function CookLog({ recipeId, servings }: { recipeId: string; servings: number }) {
  const log = trpc.cookLog.list.useQuery({ recipeId });
  const utils = trpc.useUtils();
  const remove = trpc.cookLog.remove.useMutation({
    onSuccess: () => Promise.all([utils.cookLog.list.invalidate(), utils.recipe.list.invalidate()]),
  });
  const [adding, setAdding] = useState(false);
  const [editing, setEditing] = useState<string | null>(null);
  const [confirming, setConfirming] = useState<string | null>(null);

  const entries: CookLogEntry[] = log.data ?? [];
  const last = entries[0];

  return (
    <section className={styles.section} aria-label="Cooked it">
      <div className={styles.head}>
        <div>
          <h2 className={styles.heading}>Cooked it</h2>
          <p className={styles.summary}>
            {last
              ? `${entries.length} ${entries.length === 1 ? 'time' : 'times'} · last ${daysAgo(last.cookedOn)}`
              : 'Not logged yet.'}
          </p>
        </div>
        {!adding && (
          <button type="button" className={styles.logButton} onClick={() => setAdding(true)}>
            Log a cook
          </button>
        )}
      </div>

      {adding && (
        <CookLogForm
          recipeId={recipeId}
          defaults={{ servings }}
          onDone={() => setAdding(false)}
          onCancel={() => setAdding(false)}
        />
      )}

      {entries.length > 0 && (
        <ol className={styles.entries}>
          {entries.map((entry) =>
            editing === entry.id ? (
              <li key={entry.id} className={styles.entry}>
                <CookLogForm
                  recipeId={recipeId}
                  entry={entry}
                  onDone={() => setEditing(null)}
                  onCancel={() => setEditing(null)}
                />
              </li>
            ) : (
              <li key={entry.id} className={styles.entry}>
                <div className={styles.entryHead}>
                  <span className={styles.date}>
                    {formatDay(entry.cookedOn, {
                      weekday: 'short',
                      month: 'short',
                      day: 'numeric',
                      year: 'numeric',
                    })}
                  </span>
                  {entry.rating !== null && <StarRating value={entry.rating} size="small" />}
                </div>
                <p className={styles.meta}>
                  {[
                    entry.loggedBy && `Logged by ${entry.loggedBy}`,
                    entry.servings && `served ${entry.servings}`,
                  ]
                    .filter(Boolean)
                    .join(' · ')}
                </p>
                {entry.notes && <p className={styles.notes}>{entry.notes}</p>}
                {entry.photoIds.length > 0 && (
                  <ul className={styles.photos}>
                    {entry.photoIds.map((id) => (
                      <li key={id}>
                        <img
                          className={styles.photo}
                          src={fileUrl(id, 'thumb')}
                          alt=""
                          loading="lazy"
                        />
                      </li>
                    ))}
                  </ul>
                )}
                <div className={styles.entryActions}>
                  <button
                    type="button"
                    className={styles.textButton}
                    onClick={() => setEditing(entry.id)}
                  >
                    Edit
                  </button>
                  {confirming === entry.id ? (
                    <span className={styles.confirm} role="group" aria-label="Confirm delete">
                      Delete this cook?
                      <button
                        type="button"
                        className={styles.textButton}
                        onClick={() => setConfirming(null)}
                      >
                        Keep
                      </button>
                      <button
                        type="button"
                        className={styles.dangerText}
                        onClick={() => remove.mutate({ id: entry.id })}
                      >
                        Yes, delete
                      </button>
                    </span>
                  ) : (
                    <button
                      type="button"
                      className={styles.textButton}
                      onClick={() => setConfirming(entry.id)}
                    >
                      Delete
                    </button>
                  )}
                </div>
              </li>
            ),
          )}
        </ol>
      )}
    </section>
  );
}
