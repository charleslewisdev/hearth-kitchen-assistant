import { useState, type FormEvent } from 'react';
import { Link } from 'react-router-dom';
import { authClient } from '../lib/auth';
import styles from './Entry.module.css';
import { useDocumentTitle } from '../lib/useDocumentTitle';

/** The shortest password Better Auth accepts, stated so the form can say so before sending. */
const MIN_PASSWORD = 8;

/**
 * Choose a new password, from the link a reset request sent.
 *
 * Outside the session gate, like accepting an invitation: the person here is by definition not
 * signed in. The link lands with `?token=` when it is good and `?error=INVALID_TOKEN` when it is
 * used or more than an hour old.
 */
export function ResetPassword() {
  useDocumentTitle('Reset password');
  const [params] = useState(() => new URLSearchParams(window.location.search));
  const token = params.get('token');
  const [password, setPassword] = useState('');
  const [confirm, setConfirm] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState(false);
  const [busy, setBusy] = useState(false);

  if (!token || params.get('error')) {
    return (
      <main className={styles.screen}>
        <h1 className={styles.title}>Reset your password</h1>
        <p className={styles.error} role="alert">
          That reset link has expired or was already used. Ask for a new one from the sign-in
          screen.
        </p>
        <Link to="/">Back to sign in</Link>
      </main>
    );
  }

  async function submit(e: FormEvent) {
    e.preventDefault();
    if (busy) return;
    if (password.length < MIN_PASSWORD) {
      setError(`Use at least ${MIN_PASSWORD} characters.`);
      return;
    }
    if (password !== confirm) {
      setError('The two passwords do not match.');
      return;
    }
    setBusy(true);
    setError(null);
    const res = await authClient.resetPassword({ newPassword: password, token: token! });
    setBusy(false);
    if (res.error) {
      setError(
        res.error.code === 'INVALID_TOKEN'
          ? 'That reset link has expired or was already used. Ask for a new one.'
          : (res.error.message ?? 'Could not reset your password. Please try again.'),
      );
      return;
    }
    setDone(true);
  }

  if (done) {
    return (
      <main className={styles.screen}>
        <h1 className={styles.title}>Password changed</h1>
        <p className={styles.notice} role="status">
          Your new password is set, and every device that was signed in has been signed out.
        </p>
        <Link to="/">Sign in</Link>
      </main>
    );
  }

  return (
    <main className={styles.screen}>
      <h1 className={styles.title}>Choose a new password</h1>
      <form className={styles.form} onSubmit={(e) => void submit(e)}>
        <div className={styles.field}>
          <label className={styles.label} htmlFor="new-password">
            New password
          </label>
          <input
            id="new-password"
            className={styles.input}
            type="password"
            autoComplete="new-password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
          />
        </div>
        <div className={styles.field}>
          <label className={styles.label} htmlFor="confirm-password">
            The same again
          </label>
          <input
            id="confirm-password"
            className={styles.input}
            type="password"
            autoComplete="new-password"
            value={confirm}
            onChange={(e) => setConfirm(e.target.value)}
          />
        </div>
        <button
          type="submit"
          className={styles.primary}
          disabled={busy || password === '' || confirm === ''}
        >
          Set new password
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
