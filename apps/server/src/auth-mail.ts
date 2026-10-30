import type { Logger } from 'pino';
import { publicConfig } from './config';
import type { Mailer, MailMessage } from './mail/mailer';

/** What this module needs from a logger, narrowed so a test can build one over a sink. */
type MailLogger = Pick<Logger, 'error'>;

/** Which of the two messages a line is about. An enum-shaped value, never free text (D40). */
export type MailKind = 'invitation' | 'verification' | 'password-reset';

/**
 * Where an invitation link points.
 *
 * The web origin and not the auth URL: this is a route in the SPA (Phase F's
 * `/accept-invite/:id`), not a Better Auth endpoint. Today `publicConfig` derives both from one
 * value so they are the same string, which is exactly why naming the right one matters - the
 * day they differ, the wrong one fails as a 404 on a link that has already been emailed.
 *
 * The id is percent-encoded even though Better Auth generates it out of an alphanumeric
 * alphabet. It is a database value being spliced into a URL path, and the cost of not assuming
 * that is one function call.
 */
export function acceptInviteUrl(invitationId: string): string {
  return `${publicConfig.webOrigin}/accept-invite/${encodeURIComponent(invitationId)}`;
}

/**
 * Send a message, and never let a failure escape.
 *
 * The swallow is the point, and it is not laziness about errors. Better Auth invokes both mail
 * callbacks through `runInBackgroundOrAwait`, which catches anything that escapes and hands it
 * to ITS logger as `console.error('Failed to run background task:', err)`. That line goes
 * straight to stdout: it never passes through pino, so no redaction and no `serializeError`
 * apply, and it prints the error's own message. For a relay rejection that message is
 * `550 ... <someone@example.com>` - the recipient's address written into the logs, which is
 * precisely what D38 and D40 exist to prevent. Rethrowing would therefore trade a clean,
 * ids-only line for a raw one, and would not make the caller's request fail either: Better
 * Auth has already committed the invitation and answers 200 regardless.
 *
 * So the failure is reported here, once, through the logger that obeys the rules. `err` is what
 * `serializeError` reduces to a type, a code and stack frames; `kind` says which email it was;
 * the recipient is not on the line, because knowing which address failed is not worth writing
 * every address that succeeds into a file that outlives the request.
 */
export async function deliver(opts: {
  mailer: Mailer;
  log: MailLogger;
  kind: MailKind;
  /**
   * A thunk and not a value, so RENDERING is inside the guard too. `linkHtml` throws unless the
   * action URL is http(s), and the verification URL's tail is a client-supplied `callbackURL`:
   * a message built at the call site would throw before this function ever ran, and land in the
   * unredacted console line described above.
   */
  render: () => MailMessage;
}): Promise<void> {
  try {
    await opts.mailer.send(opts.render());
  } catch (err) {
    opts.log.error({ err, kind: opts.kind }, 'could not send an email');
  }
}
