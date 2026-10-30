import { useState, type FormEvent } from 'react';
import { INVITE_ONLY_MESSAGE, SETUP_TOKEN_HEADER } from '@hearth/server/src/messages';
import { authClient } from '../lib/auth';
import styles from './Entry.module.css';
import { useDocumentTitle } from '../lib/useDocumentTitle';

/**
 * Sign in, and nothing else.
 *
 * There is no create-account affordance because there is no self-service account: an invitation
 * is the only route to one, and the sentence saying so is the server's own, so a stranger who
 * lands on this URL learns why there is no button before looking for one.
 *
 * The exception is below, and it is a real one: on a fresh install there is nobody to invite the
 * first account, so it is exempt - gated on a token written to DATA_DIR and printed to the server
 * log on first boot.
 */
/**
 * Where a verification link sends the browser once it has been followed. Better Auth appends
 * `&error=CODE` to it when the link was bad, so the sign-in screen can say which happened.
 */
export const VERIFIED_CALLBACK = '/?verified=1';

/** What a followed verification link came back with, read from the address bar. */
export function verificationOutcome(search: string): 'verified' | 'expired' | 'invalid' | null {
  const params = new URLSearchParams(search);
  const error = params.get('error');
  if (error === 'TOKEN_EXPIRED') return 'expired';
  if (error) return 'invalid';
  return params.get('verified') === '1' ? 'verified' : null;
}

const OUTCOME_MESSAGE = {
  verified: 'Your email address is verified. Sign in below.',
  expired:
    'That verification link has expired. Sign in with your password and Hearth will send a new one.',
  invalid:
    'That verification link did not work. Sign in with your password and Hearth will send a new one.',
} as const;

export function SignIn() {
  useDocumentTitle('Sign in');
  const [outcome] = useState(() => verificationOutcome(window.location.search));
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function submit(e: FormEvent) {
    e.preventDefault();
    if (busy) return;
    setError(null);
    setBusy(true);
    /*
      One attempt per press, and no retry on failure. The auth limiter allows 25 sign-ins per
      900 seconds keyed on the client address, and a household behind one NAT address shares
      that budget - so a client that retried by itself would spend somebody else's allowance on
      a password this one already got wrong.
    */
    const res = await authClient.signIn.email({
      email: email.trim(),
      password,
      callbackURL: VERIFIED_CALLBACK,
    });
    setBusy(false);
    if (!res.error) return;
    // The server mailed a fresh link just now (`sendOnSignIn`), so say so rather than leaving
    // the owner with a bare "not verified" and no way forward.
    if (res.error.code === 'EMAIL_NOT_VERIFIED') {
      setError(
        'This email address is not verified yet. Hearth just sent a new link. Without email set up, it is in the server log.',
      );
      return;
    }
    setError(res.error.message ?? 'Could not sign in. Please try again.');
  }

  return (
    <main className={styles.screen}>
      <h1 className={styles.title}>Sign in to Hearth</h1>

      {outcome && (
        <p className={outcome === 'verified' ? styles.notice : styles.error} role="status">
          {OUTCOME_MESSAGE[outcome]}
        </p>
      )}

      <form className={styles.form} onSubmit={(e) => void submit(e)}>
        <div className={styles.field}>
          <label className={styles.label} htmlFor="signin-email">
            Email address
          </label>
          <input
            id="signin-email"
            className={styles.input}
            type="email"
            autoComplete="email"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
          />
        </div>

        <div className={styles.field}>
          <label className={styles.label} htmlFor="signin-password">
            Password
          </label>
          <input
            id="signin-password"
            className={styles.input}
            type="password"
            autoComplete="current-password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
          />
        </div>

        <button
          type="submit"
          className={styles.primary}
          disabled={busy || email.trim() === '' || password === ''}
        >
          Sign in
        </button>
      </form>

      {error && (
        <p className={styles.error} role="alert">
          {error}
        </p>
      )}

      <ForgotPassword />

      <p className={styles.notice}>{INVITE_ONLY_MESSAGE}</p>

      <FirstBoot />
    </main>
  );
}

/** Where a reset link sends the browser, with `?token=` or `?error=` on the end. */
export const RESET_PASSWORD_PATH = '/reset-password';

/**
 * Ask for a reset link. The answer is the same whether or not the address has an account, so
 * the form cannot be used to learn who is in the household.
 */
function ForgotPassword() {
  const [email, setEmail] = useState('');
  const [sent, setSent] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function request(e: FormEvent) {
    e.preventDefault();
    if (busy) return;
    setBusy(true);
    setError(null);
    const res = await authClient.requestPasswordReset({
      email: email.trim(),
      redirectTo: RESET_PASSWORD_PATH,
    });
    setBusy(false);
    if (res.error) setError(res.error.message ?? 'Could not send a reset link. Please try again.');
    else setSent(true);
  }

  return (
    <details className={styles.details}>
      <summary className={styles.summary}>Forgot your password?</summary>
      <div className={styles.detailsBody}>
        {sent ? (
          <p className={styles.notice} role="status">
            If that address has an account, a reset link is on its way. It works once, for an
            hour. Without email set up, it is in the server log: ask whoever runs this Hearth.
          </p>
        ) : (
          <form className={styles.form} onSubmit={(e) => void request(e)}>
            <div className={styles.field}>
              <label className={styles.label} htmlFor="reset-email">
                Email for the account
              </label>
              <input
                id="reset-email"
                className={styles.input}
                type="email"
                autoComplete="email"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
              />
            </div>
            <button
              type="submit"
              className={styles.primary}
              disabled={busy || email.trim() === ''}
            >
              Send a reset link
            </button>
          </form>
        )}
        {error && (
          <p className={styles.error} role="alert">
            {error}
          </p>
        )}
      </div>
    </details>
  );
}

/**
 * The one way an account is created without an invitation: whoever installed this claiming it.
 *
 * Behind a disclosure, closed, and labelled for the person it is for. It is not hidden on a
 * claimed instance, because nothing tells the browser whether this instance is claimed and
 * nothing should: the server deliberately answers an anonymous caller the same way either way,
 * so that a box whose setup token is still live cannot be found by scanning. Making this form
 * appear only on a fresh instance would put that signal back, in the client, where anyone can
 * read it.
 *
 * That is safe because the gate is the token and not the disclosure. Without one this form is
 * refused with the same sentence a stranger sees above; the token is 32 random bytes readable
 * only from the server log or from DATA_DIR, and it stops working the moment a household exists.
 */
function FirstBoot() {
  const [token, setToken] = useState('');
  const [name, setName] = useState('');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [createdFor, setCreatedFor] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const ready = token.trim() !== '' && name.trim() !== '' && email.trim() !== '' && password !== '';

  async function claim(e: FormEvent) {
    e.preventDefault();
    if (busy || !ready) return;
    setError(null);
    setCreatedFor(null);
    setBusy(true);
    const address = email.trim();
    // The token travels as a header, which is why it is not in the body object here: Better
    // Auth types the sign-up body as a closed shape, and this is a deployment credential
    // rather than something about the account being created.
    const created = await authClient.signUp.email(
      { email: address, password, name: name.trim(), callbackURL: VERIFIED_CALLBACK },
      { headers: { [SETUP_TOKEN_HEADER]: token.trim() } },
    );
    setBusy(false);
    if (created.error) {
      setError(created.error.message ?? 'Could not create the first account.');
      return;
    }
    // No sign-in follows, and cannot: this account was not invited, so nothing proves the
    // address yet and this server refuses to sign in an unverified one. The link that proves it
    // has just been sent, and the copy below says where to find it.
    setCreatedFor(address);
    setToken('');
    setPassword('');
  }

  return (
    <details className={styles.details}>
      <summary className={styles.summary}>Setting up this Hearth for the first time?</summary>
      <div className={styles.detailsBody}>
        <p className={styles.hint}>
          The first account needs the setup token this server printed to its log on first boot. It
          is also in the <code>setup-token</code> file inside the server’s data directory. Everyone
          after you gets in by invitation instead.
        </p>

        <form className={styles.form} onSubmit={(e) => void claim(e)}>
          <div className={styles.field}>
            <label className={styles.label} htmlFor="claim-token">
              Setup token
            </label>
            <input
              id="claim-token"
              className={styles.input}
              type="text"
              autoComplete="off"
              spellCheck={false}
              value={token}
              onChange={(e) => setToken(e.target.value)}
            />
          </div>

          <div className={styles.field}>
            <label className={styles.label} htmlFor="claim-name">
              Your name
            </label>
            <input
              id="claim-name"
              className={styles.input}
              type="text"
              autoComplete="name"
              value={name}
              onChange={(e) => setName(e.target.value)}
            />
          </div>

          <div className={styles.field}>
            <label className={styles.label} htmlFor="claim-email">
              Your email address
            </label>
            <input
              id="claim-email"
              className={styles.input}
              type="email"
              autoComplete="email"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
            />
          </div>

          <div className={styles.field}>
            <label className={styles.label} htmlFor="claim-password">
              Choose a password
            </label>
            <input
              id="claim-password"
              className={styles.input}
              type="password"
              autoComplete="new-password"
              minLength={8}
              aria-describedby="claim-password-hint"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
            />
            <p id="claim-password-hint" className={styles.hint}>
              At least 8 characters.
            </p>
          </div>

          <button type="submit" className={styles.primary} disabled={busy || !ready}>
            Create the first account
          </button>
        </form>

        {createdFor && (
          <p className={styles.sent} role="status">
            Account created for {createdFor}. Hearth sent a link to confirm the address. With no
            mail relay configured it is printed in the server log instead. Open it, then sign in
            above and name your household.
          </p>
        )}

        {error && (
          <p className={styles.error} role="alert">
            {error}
          </p>
        )}
      </div>
    </details>
  );
}
