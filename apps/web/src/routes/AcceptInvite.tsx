import { useEffect, useState, type FormEvent } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { authClient } from '../lib/auth';
import styles from './Entry.module.css';
import { useDocumentTitle } from '../lib/useDocumentTitle';

/**
 * What `/organization/get-invitation` said about this invitation.
 *
 * It can only be asked with a session: the endpoint answers 401 without one, and refuses anyone
 * but the recipient. That refusal is the useful part, because it tells the three signed-in cases
 * apart in one request - the recipient (200), somebody else's account (403), and an invitation
 * that is expired, withdrawn or already used (400, all three, deliberately indistinguishable).
 */
type Lookup =
  | { state: 'loading' }
  | { state: 'ready'; householdName: string }
  | { state: 'wrongAccount' }
  | { state: 'unusable' }
  | { state: 'failed' };

/** Better Auth's client returns `{ data, error }`; only the status is acted on here. */
function statusOf(error: unknown): number | undefined {
  const status = (error as { status?: unknown } | null | undefined)?.status;
  return typeof status === 'number' ? status : undefined;
}

/**
 * The screen an emailed invitation link opens.
 *
 * It lives outside the session gate in `App.tsx`, which is the whole point of it: the invitee has
 * no account yet, and an owner who left has an account with no household, which is the state the
 * gate answers with `<Onboarding />`. Neither would ever reach this route from inside the gate.
 *
 * Two ways in, because the server has two. A new account signs up, and the sign-up hook consumes
 * the invitation and writes the membership in the same request. An account that already exists
 * cannot use that hook at all, so it accepts the invitation explicitly - that is the retry path
 * when auto-accept failed, and the only way back in for an owner who left.
 */
export function AcceptInvite() {
  useDocumentTitle('Join a household');
  const { invitationId } = useParams();
  const navigate = useNavigate();
  const { data: session, isPending: sessionPending } = authClient.useSession();

  const [email, setEmail] = useState('');
  const [name, setName] = useState('');
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  /** The account has been made, so only the sign-in below is left to retry. */
  const [created, setCreated] = useState(false);
  const [lookup, setLookup] = useState<Lookup>({ state: 'loading' });

  const id = invitationId ?? '';
  const userId = session?.user.id;

  useEffect(() => {
    if (userId === undefined || id === '') return;
    let current = true;
    setLookup({ state: 'loading' });
    void authClient.organization
      .getInvitation({ query: { id } })
      .then((res) => {
        if (!current) return;
        if (res.data) {
          setLookup({ state: 'ready', householdName: res.data.organizationName });
          return;
        }
        const status = statusOf(res.error);
        if (status === 403) setLookup({ state: 'wrongAccount' });
        else if (status === 400) setLookup({ state: 'unusable' });
        else setLookup({ state: 'failed' });
      })
      .catch(() => {
        if (current) setLookup({ state: 'failed' });
      });
    return () => {
      current = false;
    };
  }, [userId, id]);

  async function handleSignUp(e: FormEvent) {
    e.preventDefault();
    if (busy) return;
    setError(null);
    setBusy(true);
    // Trimmed, because the address has to match the invitation exactly: the server lowercases
    // both ends and refuses a padded one rather than trimming it.
    const address = email.trim();

    if (!created) {
      const account = await authClient.signUp.email({
        email: address,
        password,
        name: name.trim(),
      });
      if (account.error) {
        setBusy(false);
        setError(account.error.message ?? 'Could not create your account. Please try again.');
        return;
      }
      /*
        The account exists from here on, and pressing this button again must not try to make it
        twice. Signing up consumed the invitation, so a second attempt for the same address is no
        longer an invited one and would be refused with the sentence that says this instance is
        invite-only - which, to somebody whose account was created seconds ago, says nothing true.
      */
      setCreated(true);
    }

    /*
      Signing in is a separate step, not a fallback. This server requires a verified address, and
      that makes sign-up answer with no session and no cookie - so the account exists and nobody
      is signed in to it. The account was invited, which is proof enough of the address, so the
      server marks it verified as it writes it and this sign-in succeeds immediately.

      The membership is already there by now: the sign-up hook consumed the invitation in the same
      request. If that failed, the invitation is still pending and this same link, followed again,
      lands on the accept button below.
    */
    const signedIn = await authClient.signIn.email({ email: address, password });
    setBusy(false);
    if (signedIn.error) {
      setError(signedIn.error.message ?? 'Your account was created, but signing in failed.');
      return;
    }
    navigate('/', { replace: true });
  }

  async function handleAccept() {
    if (busy) return;
    setError(null);
    setBusy(true);
    const accepted = await authClient.organization.acceptInvitation({ invitationId: id });
    setBusy(false);
    if (accepted.error) {
      setError(accepted.error.message ?? 'Could not accept this invitation. Please try again.');
      return;
    }
    // Accepting sets the household on the session and tells the auth client's own stores to
    // refetch, so the gate in App.tsx has the household by the time this lands.
    navigate('/', { replace: true });
  }

  if (sessionPending) {
    return (
      <main className={styles.screen}>
        <p className={styles.hint}>Checking…</p>
      </main>
    );
  }

  if (session) {
    return (
      <main className={styles.screen}>
        {lookup.state === 'loading' && <p className={styles.hint}>Checking this invitation…</p>}

        {lookup.state === 'ready' && (
          <>
            <h1 className={styles.title}>Join {lookup.householdName}</h1>
            <p className={styles.body}>
              You have been invited to this household. Accepting shares its recipes, plans and
              shopping list with you.
            </p>
            <button
              type="button"
              className={styles.primary}
              onClick={() => void handleAccept()}
              disabled={busy}
            >
              Accept invitation
            </button>
          </>
        )}

        {lookup.state === 'wrongAccount' && (
          <>
            <h1 className={styles.title}>This invitation is for someone else</h1>
            <p className={styles.body}>
              You are signed in as {session.user.email}, and this invitation was sent to a different
              address. Sign out and open the link again to use it.
            </p>
            <button
              type="button"
              className={styles.secondary}
              onClick={() => void authClient.signOut()}
            >
              Sign out
            </button>
          </>
        )}

        {lookup.state === 'unusable' && (
          <>
            <h1 className={styles.title}>This invitation can’t be used</h1>
            <p className={styles.body}>
              It may have expired, been withdrawn, or already been used. Ask the household owner to
              send you a new one.
            </p>
            <Link to="/" className={styles.link}>
              Go to Hearth
            </Link>
          </>
        )}

        {lookup.state === 'failed' && (
          <>
            <h1 className={styles.title}>Couldn’t check this invitation</h1>
            <p className={styles.body}>Something went wrong on the way. Please try again.</p>
          </>
        )}

        {error && (
          <p className={styles.error} role="alert">
            {error}
          </p>
        )}
      </main>
    );
  }

  return (
    <main className={styles.screen}>
      <h1 className={styles.title}>Join this Hearth</h1>
      {/*
        Stated as a condition, because nothing here has looked this invitation up. The endpoint
        that could answers 401 without a session (see Lookup above), so this form is what a
        signed-out visitor gets for ANY invitation id, including one that expired, was withdrawn,
        or never existed. Submitting is the first moment anyone finds out, and the refusal lands
        in the alert below. The signed-in copy above may promise what it promises because there
        the lookup answered 200.

        The reason is not named either, and that is the same rule applied twice: the refusal is
        INVITE_ONLY_MESSAGE, one sentence for every way an address can fail to have an invitation,
        deliberately (see messages.ts). Copy that promised to say WHICH would be the overclaim
        this replaced, one step further along.
      */}
      <p className={styles.body}>
        Set up your account to use this invitation. Hearth checks it when you continue, and tells
        you if it can’t be used.
      </p>
      <form className={styles.form} onSubmit={(e) => void handleSignUp(e)}>
        <div className={styles.field}>
          <label className={styles.label} htmlFor="invite-email">
            Email address
          </label>
          <input
            id="invite-email"
            className={styles.input}
            type="email"
            autoComplete="email"
            aria-describedby="invite-email-hint"
            disabled={created}
            value={email}
            onChange={(e) => setEmail(e.target.value)}
          />
          <p id="invite-email-hint" className={styles.hint}>
            The address this invitation was sent to.
          </p>
        </div>

        <div className={styles.field}>
          <label className={styles.label} htmlFor="invite-name">
            Your name
          </label>
          <input
            id="invite-name"
            className={styles.input}
            type="text"
            autoComplete="name"
            disabled={created}
            value={name}
            onChange={(e) => setName(e.target.value)}
          />
        </div>

        <div className={styles.field}>
          <label className={styles.label} htmlFor="invite-password">
            Password
          </label>
          <input
            id="invite-password"
            className={styles.input}
            type="password"
            autoComplete="new-password"
            minLength={8}
            aria-describedby="invite-password-hint"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
          />
          <p id="invite-password-hint" className={styles.hint}>
            At least 8 characters.
          </p>
        </div>

        <button
          type="submit"
          className={styles.primary}
          disabled={busy || email.trim() === '' || name.trim() === '' || password === ''}
        >
          {created ? 'Sign in and join' : 'Create account and join'}
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
