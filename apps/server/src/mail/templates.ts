import { singleLineHeader, type MailMessage } from './mailer';

/**
 * A rendered message, minus the recipient. Defined against MailMessage rather than beside it so
 * that a field added there fails to compile here, and so a call site can write
 * `mailer.send({ to, ...householdInvitation(...) })` with nothing left to remember.
 *
 * `html` is narrowed to required: MailMessage allows a text-only message, but every template
 * here renders both.
 */
export type MailContent = Omit<MailMessage, 'to'> & { html: string };

/**
 * How much of a user-supplied name is rendered.
 *
 * The same reasoning as MAX_FRAMES and MAX_ISSUES in log.ts, applied to a different unbounded
 * string: a household name is `text` in the database with no length limit, and it is
 * interpolated into a mail header. 100 characters is far past any real kitchen's name and far
 * short of a problem.
 *
 * This deliberately no longer says "and into a log line in console mode". It used to, and that
 * was true of an earlier ConsoleMailer which logged the subject; that line now carries only the
 * recipient and the action URL, so no name reaches a log at all.
 */
export const NAME_LIMIT = 100;

/**
 * A user-supplied name reduced to something safe to interpolate into a subject.
 *
 * The flattening itself is singleLineHeader's, in mailer.ts, so the rule lives at the boundary
 * the value actually crosses rather than only here: a caller can build a MailMessage by hand
 * without going through a template, and the defence has to survive that. What this adds is the
 * length bound, which is a rendering concern and belongs with the rendering.
 */
function singleLine(value: string): string {
  const flattened = singleLineHeader(value);
  // Sliced by code point, not by UTF-16 unit: `'x'.repeat(99) + emoji` would otherwise be cut
  // through the middle of a surrogate pair and leave a lone surrogate in a mail header. The
  // bounds in log.ts this is modelled on count array entries, so they cannot do this.
  const points = [...flattened];
  return points.length > NAME_LIMIT ? `${points.slice(0, NAME_LIMIT).join('')}...` : flattened;
}

/**
 * The five characters that change meaning inside HTML text or inside a quoted attribute.
 *
 * `&` goes first, or it would re-escape the escapes. Both quote styles are covered because the
 * links below sit in `href="..."`, and a value that could close that attribute could add
 * attributes of its own - an `onmouseover` next to a URL the recipient is being asked to click.
 * The text twin is deliberately NOT escaped: a plain-text body showing `&amp;` in a URL is one
 * the recipient cannot paste into a browser.
 */
function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/**
 * One link, rendered as both a button-ish anchor and a pasteable URL.
 *
 * Both, because mail clients disagree about anchors and because a link the recipient can read
 * before clicking is a link they can check.
 *
 * The scheme is CHECKED rather than assumed. An earlier version of this comment asserted the URL
 * was app-generated and so could not carry a `javascript:` or `data:` scheme - which was a
 * caller obligation written down as a fact, in an exported pure function that validates nothing.
 * Escaping does not look at schemes, so both of those render as perfectly live anchors. Phase D
 * is exactly where it stops being theoretical: Better Auth's `sendVerificationEmail` hands over
 * a url whose tail embeds a client-supplied `callbackURL`.
 *
 * It throws rather than dropping the link, for the same reason the mailer flattens headers at
 * the boundary: a caller cannot route around it, and a message whose one action is missing is
 * not a message worth sending.
 */
function linkHtml(url: string, label: string): string {
  if (!/^https?:\/\//i.test(url)) {
    // The url itself is not quoted into the message: it is the untrusted half, and D40 keeps
    // it out of the log this would otherwise reach.
    throw new Error('action url must be http(s)');
  }
  const safe = escapeHtml(url);
  return `<p><a href="${safe}">${escapeHtml(label)}</a></p>\n<p>Or paste this into your browser:<br>${safe}</p>`;
}

/**
 * "Come and join my household." The invitee has no account yet, so this link is the only route
 * to one (D36), which is also why it is bearer authority and says so.
 */
export function householdInvitation(opts: {
  inviterName: string;
  householdName: string;
  acceptUrl: string;
}): MailContent {
  const inviter = singleLine(opts.inviterName);
  const household = singleLine(opts.householdName);
  const { acceptUrl } = opts;
  const caution =
    'Anyone who has this link can join the household, so keep it to yourself. If you were not ' +
    'expecting this invitation, you can ignore this email.';

  return {
    subject: `${inviter} invited you to join ${household} on Hearth`,
    text: [
      `${inviter} invited you to join ${household} on Hearth, a shared kitchen for recipes, meal plans and shopping lists.`,
      '',
      'Accept the invitation:',
      acceptUrl,
      '',
      caution,
      '',
    ].join('\n'),
    html: [
      `<p>${escapeHtml(inviter)} invited you to join <strong>${escapeHtml(household)}</strong> on Hearth, a shared kitchen for recipes, meal plans and shopping lists.</p>`,
      linkHtml(acceptUrl, 'Accept the invitation'),
      `<p>${escapeHtml(caution)}</p>`,
      '',
    ].join('\n'),
    actionUrl: acceptUrl,
  };
}

/** "Confirm this is really your address," sent after an invitation has been accepted. */
export function emailVerification(opts: { verifyUrl: string }): MailContent {
  const { verifyUrl } = opts;
  const caution = 'If you did not create a Hearth account, you can ignore this email.';

  return {
    subject: 'Verify your email address for Hearth',
    text: [
      'Confirm this address so Hearth can use it for your account.',
      '',
      'Verify your email address:',
      verifyUrl,
      '',
      caution,
      '',
    ].join('\n'),
    html: [
      '<p>Confirm this address so Hearth can use it for your account.</p>',
      linkHtml(verifyUrl, 'Verify your email address'),
      `<p>${escapeHtml(caution)}</p>`,
      '',
    ].join('\n'),
    actionUrl: verifyUrl,
  };
}

/** "Here is how to choose a new password." Asked for from the sign-in screen. */
export function passwordReset(opts: { resetUrl: string }): MailContent {
  const { resetUrl } = opts;
  const caution =
    'The link works once and for one hour. If you did not ask to reset your password, you can ' +
    'ignore this email; your password has not changed.';

  return {
    subject: 'Reset your Hearth password',
    text: [
      'Someone, hopefully you, asked to reset the password for this Hearth account.',
      '',
      'Choose a new password:',
      resetUrl,
      '',
      caution,
      '',
    ].join('\n'),
    html: [
      '<p>Someone, hopefully you, asked to reset the password for this Hearth account.</p>',
      linkHtml(resetUrl, 'Choose a new password'),
      `<p>${escapeHtml(caution)}</p>`,
      '',
    ].join('\n'),
    actionUrl: resetUrl,
  };
}
