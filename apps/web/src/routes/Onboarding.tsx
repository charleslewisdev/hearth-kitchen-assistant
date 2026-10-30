import { useState, type FormEvent } from 'react';
import { slugify } from '@hearth/shared';
import { ONE_HOUSEHOLD_MESSAGE } from '@hearth/server/src/messages';
import { authClient } from '../lib/auth';
import styles from './Entry.module.css';
import { useDocumentTitle } from '../lib/useDocumentTitle';

/**
 * Shown when a user is signed in but has no active household. Creating the household and setting
 * it active is what makes `protectedProcedure` stop refusing.
 *
 * Two different people reach this screen and only one of them can act on it. The first account on
 * a fresh instance is here to do exactly this. The other is someone whose membership did not
 * land - an invitee whose auto-accept failed, or an owner who left the household - and for them
 * the server refuses to create a second one, because the instance holds exactly one.
 *
 * Nothing distinguishes them before the attempt: no endpoint tells the browser whether this
 * instance already has a household, and the server keeps it that way on purpose. So the form is
 * offered once, and the refusal is what replaces it. A screen that kept the form after that
 * would be one that goes on looking as though it should work.
 */
export function Onboarding() {
  useDocumentTitle('Set up your household');
  const [name, setName] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [claimed, setClaimed] = useState(false);
  const [busy, setBusy] = useState(false);

  async function submit(e: FormEvent) {
    e.preventDefault();
    if (busy) return;
    setError(null);
    setBusy(true);
    const created = await authClient.organization.create({
      name: name.trim(),
      slug: slugify(name.trim()) || 'home',
    });
    if (created.error) {
      setBusy(false);
      if (created.error.message === ONE_HOUSEHOLD_MESSAGE) setClaimed(true);
      else setError(created.error.message ?? 'Could not create your household.');
      return;
    }
    const activated = await authClient.organization.setActive({
      organizationId: created.data.id,
    });
    setBusy(false);
    if (activated.error) {
      setError(activated.error.message ?? 'Could not open your household.');
    }
    // useActiveOrganization() in App re-renders into the app shell on success.
  }

  if (claimed) {
    return (
      <main className={styles.screen}>
        <h1 className={styles.title}>You are not in a household yet</h1>
        <p className={styles.notice}>{ONE_HOUSEHOLD_MESSAGE}</p>
        <p className={styles.body}>
          An invitation arrives by email, and its link is what puts you in. If you had one and it
          did not work, ask the owner to send it again.
        </p>
        <button
          type="button"
          className={styles.secondary}
          onClick={() => void authClient.signOut()}
        >
          Sign out
        </button>
      </main>
    );
  }

  return (
    <main className={styles.screen}>
      <h1 className={styles.title}>Name your household</h1>
      <p className={styles.body}>
        Everything in Hearth - recipes, plans, lists - lives in a household.
      </p>
      <form className={styles.form} onSubmit={(e) => void submit(e)}>
        <div className={styles.field}>
          <label className={styles.label} htmlFor="household-name">
            Household name
          </label>
          <input
            id="household-name"
            className={styles.input}
            type="text"
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="e.g. The Smith Kitchen"
          />
        </div>
        <button type="submit" className={styles.primary} disabled={busy || name.trim() === ''}>
          Create household
        </button>
      </form>
      {error && (
        <p className={styles.error} role="alert">
          {error}
        </p>
      )}
    </main>
  );
}
