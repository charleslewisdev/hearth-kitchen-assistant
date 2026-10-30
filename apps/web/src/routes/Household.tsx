import { useEffect, useRef, useState, type FormEvent } from 'react';
import { NOT_A_MEMBER_MESSAGE } from '@hearth/server/src/messages';
import { authClient } from '../lib/auth';
import { trpc } from '../lib/trpc';
import { WeekStartSetting } from './WeekStartSetting';
import styles from './Household.module.css';
import { useDocumentTitle } from '../lib/useDocumentTitle';

// One member as `household.members` returns them (the router's `toMemberView`). `userId` is the
// account, `id` is the membership row, and only the second is what `removeMember` takes.
type Member = {
  id: string;
  userId: string;
  name: string;
  email: string;
  role: string;
  /** ISO string: the router converts its Dates, since there is no superjson transformer. */
  joinedAt: string;
};

// One pending invitation as `household.invitations` returns them (`toInvitationView`).
type Invitation = {
  id: string;
  email: string;
  role: string;
  expiresAt: string;
};

/**
 * The role that may invite, revoke and remove, spelled here as the literal the server sends.
 *
 * `householdRole` normalises every stored role to `owner` or `member` before it leaves the
 * router, so this comparison is against a closed set. It is a string on both sides and nothing
 * makes the two agree at compile time; what makes that safe is the direction it fails in, since
 * an unrecognised role hides the controls rather than showing them. The server checks the role
 * again on every one of the three mutations, so this decides what is drawn and not what is
 * allowed.
 */
const OWNER = 'owner';

function roleLabel(role: string): string {
  return role === OWNER ? 'Owner' : 'Member';
}

function formatDay(iso: string): string {
  return new Date(iso).toLocaleDateString(undefined, { dateStyle: 'medium' });
}

export function Household() {
  useDocumentTitle('Household');
  const { data: session } = authClient.useSession();
  const utils = trpc.useUtils();

  const members = trpc.household.members.useQuery();
  const invitations = trpc.household.invitations.useQuery();

  const invalidateMembers = () => utils.household.members.invalidate();
  const invalidateInvitations = () => utils.household.invitations.invalidate();

  const invite = trpc.household.invite.useMutation({ onSuccess: invalidateInvitations });
  const revokeInvitation = trpc.household.revokeInvitation.useMutation({
    onSuccess: invalidateInvitations,
  });
  const removeMember = trpc.household.removeMember.useMutation({ onSuccess: invalidateMembers });
  const householdName = trpc.household.name.useQuery();
  const rename = trpc.household.rename.useMutation({
    onSuccess: () => {
      void utils.household.name.invalidate();
      setRenamed(true);
    },
  });
  // What the owner is typing, or null while the box still shows the saved name.
  const [nameDraft, setNameDraft] = useState<string | null>(null);
  const [renamed, setRenamed] = useState(false);

  const [email, setEmail] = useState('');
  const [sentTo, setSentTo] = useState<string | null>(null);
  const [confirmingRemoval, setConfirmingRemoval] = useState<string | null>(null);
  // The Remove button of the row currently asking for confirmation, so that cancelling puts
  // focus back where the keyboard user left it instead of dropping it on the document.
  const removeToggleRef = useRef<HTMLButtonElement | null>(null);

  /**
   * The tab that was mid-request when its membership ended.
   *
   * Narrow on the server now: a membership that ends clears the household off that person's
   * sessions inside the delete (migration 0006), so the ordinary answer to a removed member is
   * the session gate in App.tsx rather than this message. What still produces it is a household
   * query whose session was resolved a moment before the removal committed.
   *
   * Refetching cannot recover from it and an error screen would simply repeat. Signing out is
   * the one state change that ends it, and it lands them on the sign-in screen, which says why
   * they cannot get back in.
   */
  const lostMembership =
    members.error?.message === NOT_A_MEMBER_MESSAGE ||
    invitations.error?.message === NOT_A_MEMBER_MESSAGE;

  useEffect(() => {
    if (lostMembership) void authClient.signOut();
  }, [lostMembership]);

  const viewerId = session?.user.id;
  const memberList: Member[] = members.data ?? [];
  const isOwner = memberList.some((m) => m.userId === viewerId && m.role === OWNER);

  function handleInvite(e: FormEvent) {
    e.preventDefault();
    // Trimmed here because the server refuses a padded address outright rather than trimming it:
    // the address it stores is the one an invitee's sign-up has to match exactly, so trimming has
    // to happen before it is stored or not at all. A trailing space off an autofill is a typo.
    const address = email.trim();
    if (address === '' || invite.isPending) return;
    setSentTo(null);
    invite.mutate(
      { email: address },
      {
        onSuccess: () => {
          setSentTo(address);
          setEmail('');
        },
      },
    );
  }

  function toggleRemoval(memberId: string, button: HTMLButtonElement) {
    removeToggleRef.current = button;
    setConfirmingRemoval((current) => (current === memberId ? null : memberId));
  }

  function cancelRemoval() {
    // Before the state change, while the button this ref points at is still on screen.
    removeToggleRef.current?.focus();
    setConfirmingRemoval(null);
  }

  if (lostMembership) {
    return (
      <section className={styles.screen}>
        <h1 className={styles.title}>Household</h1>
        <p className={styles.status} role="status">
          You are no longer part of this household. Signing you out…
        </p>
      </section>
    );
  }

  if (members.isLoading || invitations.isLoading) {
    return (
      <section className={styles.screen}>
        <h1 className={styles.title}>Household</h1>
        <p className={styles.status}>Loading your household…</p>
      </section>
    );
  }

  if (members.isError || invitations.isError) {
    return (
      <section className={styles.screen}>
        <h1 className={styles.title}>Household</h1>
        <p className={styles.error} role="alert">
          Couldn’t load your household. Please try again.
        </p>
      </section>
    );
  }

  const pending: Invitation[] = invitations.data ?? [];
  const now = Date.now();
  const anyExpired = pending.some((i) => new Date(i.expiresAt).getTime() <= now);

  return (
    <section className={styles.screen}>
      <h1 className={styles.title}>Household</h1>
      <p className={styles.intro}>
        Everyone here shares the same recipes, plans and shopping list.
      </p>

      <div className={styles.section}>
        <h2 className={styles.sectionTitle}>Household name</h2>
        {isOwner ? (
          <form
            className={styles.inviteForm}
            onSubmit={(e) => {
              e.preventDefault();
              const name = (nameDraft ?? '').trim();
              if (name === '' || rename.isPending) return;
              rename.mutate({ name }, { onSuccess: () => setNameDraft(null) });
            }}
          >
            <label className={styles.label} htmlFor="household-name">
              Name
            </label>
            <div className={styles.inviteRow}>
              <input
                id="household-name"
                className={styles.input}
                value={nameDraft ?? householdName.data?.name ?? ''}
                maxLength={60}
                onChange={(e) => {
                  setRenamed(false);
                  setNameDraft(e.target.value);
                }}
              />
              <button
                type="submit"
                className={styles.primary}
                disabled={
                  rename.isPending ||
                  nameDraft === null ||
                  nameDraft.trim() === '' ||
                  nameDraft.trim() === householdName.data?.name
                }
              >
                Save
              </button>
            </div>
          </form>
        ) : (
          <p className={styles.intro}>{householdName.data?.name}</p>
        )}
        <p className={styles.hint}>Invitations introduce the household by this name.</p>
        {renamed && (
          <p className={styles.sent} role="status">
            Saved.
          </p>
        )}
        {rename.error && (
          <p className={styles.error} role="alert">
            {rename.error.message}
          </p>
        )}
      </div>

      <div className={styles.section}>
        <h2 className={styles.sectionTitle}>Members</h2>
        <ul className={styles.rows}>
          {memberList.map((member) => (
            <li key={member.id} className={styles.row}>
              <div className={styles.who}>
                <span className={styles.name}>
                  {member.name}
                  {member.userId === viewerId && <span className={styles.you}>You</span>}
                </span>
                <span className={styles.detail}>{member.email}</span>
                <span className={styles.detail}>Joined {formatDay(member.joinedAt)}</span>
              </div>
              <span className={styles.badge}>{roleLabel(member.role)}</span>
              {/*
                Never on your own row. Leaving is a reasonable thing to want, but the server
                refuses to remove the last owner, and an invitation can only ever be for a
                member (INVITED_ROLE), so a second owner cannot arise through this app: the
                button would be one that always fails.
              */}
              {isOwner && member.userId !== viewerId && (
                <div className={styles.actions}>
                  <button
                    type="button"
                    className={styles.secondary}
                    aria-expanded={confirmingRemoval === member.id}
                    onClick={(e) => toggleRemoval(member.id, e.currentTarget)}
                    aria-label={`Remove ${member.name}`}
                  >
                    Remove
                  </button>
                  {confirmingRemoval === member.id && (
                    <div className={styles.confirm}>
                      <span className={styles.confirmText}>
                        Remove {member.name} from this household?
                      </span>
                      <button
                        type="button"
                        className={styles.danger}
                        disabled={removeMember.isPending}
                        onClick={() => removeMember.mutate({ memberId: member.id })}
                        aria-label={`Yes, remove ${member.name}`}
                      >
                        Yes, remove
                      </button>
                      <button
                        type="button"
                        className={styles.secondary}
                        onClick={cancelRemoval}
                        aria-label={`Keep ${member.name}`}
                      >
                        Cancel
                      </button>
                    </div>
                  )}
                </div>
              )}
            </li>
          ))}
        </ul>
        {removeMember.error && (
          <p className={styles.error} role="alert">
            {removeMember.error.message}
          </p>
        )}
      </div>

      <div className={styles.section}>
        <h2 className={styles.sectionTitle}>Pending invitations</h2>
        {pending.length === 0 ? (
          <p className={styles.empty}>Nobody is waiting on an invitation.</p>
        ) : (
          <ul className={styles.rows}>
            {pending.map((invitation) => {
              const expiresAt = new Date(invitation.expiresAt);
              const expired = expiresAt.getTime() <= now;
              return (
                <li key={invitation.id} className={styles.row}>
                  <div className={styles.who}>
                    <span className={styles.name}>{invitation.email}</span>
                    {/*
                      Expired invitations are listed on purpose: that row is why someone was told
                      this instance is invite-only, and it is the owner who can act on it.
                    */}
                    <span className={expired ? styles.expired : styles.detail}>
                      {expired
                        ? `Expired ${formatDay(invitation.expiresAt)}`
                        : `Expires ${formatDay(invitation.expiresAt)}`}
                    </span>
                  </div>
                  {isOwner && (
                    <div className={styles.actions}>
                      <button
                        type="button"
                        className={styles.secondary}
                        disabled={revokeInvitation.isPending}
                        onClick={() => revokeInvitation.mutate({ invitationId: invitation.id })}
                        aria-label={`Revoke the invitation for ${invitation.email}`}
                      >
                        Revoke
                      </button>
                    </div>
                  )}
                </li>
              );
            })}
          </ul>
        )}
        {anyExpired && (
          <p className={styles.hint}>
            An expired invitation is not lost: invite the same address again and Hearth will send it
            again.
          </p>
        )}
        {revokeInvitation.error && (
          <p className={styles.error} role="alert">
            {revokeInvitation.error.message}
          </p>
        )}
      </div>

      {isOwner ? (
        <div className={styles.section}>
          <h2 className={styles.sectionTitle}>Invite someone</h2>
          <form className={styles.inviteForm} onSubmit={handleInvite}>
            <label className={styles.label} htmlFor="invite-email">
              Email address
            </label>
            <div className={styles.inviteRow}>
              <input
                id="invite-email"
                className={styles.input}
                type="email"
                autoComplete="email"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                placeholder="gran@example.com"
              />
              <button
                type="submit"
                className={styles.primary}
                disabled={invite.isPending || email.trim() === ''}
              >
                Send invitation
              </button>
            </div>
          </form>
          <p className={styles.hint}>
            They will get an email with a link for setting up their account. Signing up is the only
            way into this Hearth, so nobody can join without one.
          </p>
          {sentTo && (
            <p className={styles.sent} role="status">
              Invitation sent to {sentTo}.
            </p>
          )}
          {invite.error && (
            <p className={styles.error} role="alert">
              {invite.error.message}
            </p>
          )}
        </div>
      ) : (
        <p className={styles.hint}>Only the household owner can invite people or remove them.</p>
      )}

      <WeekStartSetting />

      <div className={styles.section}>
        <button
          type="button"
          className={styles.secondary}
          onClick={() => void authClient.signOut()}
        >
          Sign out
        </button>
      </div>
    </section>
  );
}
