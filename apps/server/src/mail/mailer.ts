import { createTransport } from 'nodemailer';
import type { Logger } from 'pino';
import { DEFAULT_SMTP_FROM, type Env } from '../env';

/**
 * One message. `to`, `subject`, `text` and `html` are the ordinary parts; `actionUrl` is not.
 *
 * Every email Hearth sends exists to deliver exactly one link - accept an invitation, verify an
 * address - so the link is carried as its own field rather than left buried in the body. That is
 * what lets ConsoleMailer print something an operator can act on WITHOUT printing the body, and
 * it is required rather than optional so a call site cannot quietly produce a console line that
 * says an invitation was sent and gives no way to complete it. The day a mail with no single
 * action exists, this type changes deliberately; that is the point of it being required.
 */
export type MailMessage = {
  to: string;
  subject: string;
  text: string;
  html?: string;
  /** The one link the message exists to deliver. Must also appear in `text`/`html`. */
  actionUrl: string;
};

export type Mailer = {
  kind: 'smtp' | 'console' | 'memory';
  send(msg: MailMessage): Promise<void>;
};

/**
 * The slice of nodemailer this code depends on, so tests can substitute one. Narrow on purpose:
 * a wider seam would invite a test to exercise nodemailer instead of this module, and the one
 * thing the suite must never do is open a socket.
 */
export type MailTransport = {
  sendMail(options: {
    from: string;
    to: string;
    subject: string;
    text: string;
    html?: string;
  }): Promise<{ messageId?: string }>;
};

/** What this module needs from a logger. Narrowed so a test can pass anything shaped like one. */
type MailLogger = Pick<Logger, 'debug' | 'info' | 'warn' | 'error'>;

/**
 * Characters that must not reach a mail header, and CR and LF are the whole point of the list.
 *
 * A header ends at a newline, so a subject carrying `"\r\nBcc: attacker@example.com"` appends a
 * header of the sender's choosing and copies the message to an address they picked. The rest of
 * the C0 range plus DEL go with them because none of them belong in a subject either, and
 * U+2028/U+2029 because they are line terminators to a JavaScript reader even though SMTP does
 * not treat them as one.
 */
// eslint-disable-next-line no-control-regex
const HEADER_BREAKERS = /[\u0000-\u001f\u007f\u2028\u2029]/g;

/**
 * A value flattened to something that cannot terminate or extend a mail header.
 *
 * This lives HERE, next to the transport, rather than only in templates.ts, because this is the
 * boundary the value actually crosses. templates.ts argues that depending on nodemailer's own
 * header encoding is "a good reason to expect it to hold and a bad reason to depend on it" - and
 * that argument only pays if the check is somewhere a call site cannot route around. `subject` on
 * a MailMessage is a bare string, so a caller that builds one by hand instead of spreading a
 * template would otherwise bypass the defence entirely.
 *
 * Replaced with a space rather than deleted, so two words separated by a newline do not silently
 * become one word.
 */
export function singleLineHeader(value: string): string {
  return value.replace(HEADER_BREAKERS, ' ').replace(/\s+/g, ' ').trim();
}

/**
 * The SMTP settings, derived from the schema rather than mirrored by hand.
 *
 * A hand-written copy would drift silently: `createMailer({ env, logger })` passes a non-literal
 * object, so structural typing accepts it, and renaming SMTP_PORT in env.ts would leave this
 * type valid while the mailer quietly fell back to 587.
 *
 * `Partial` because tests construct these directly, and because every field except the host has
 * a default the schema has already applied by the time the real env arrives.
 */
export type MailEnv = Partial<
  Pick<Env, 'SMTP_HOST' | 'SMTP_PORT' | 'SMTP_USER' | 'SMTP_PASS' | 'SMTP_SECURE' | 'SMTP_FROM'>
>;

/**
 * Real delivery. The address and the body go into the envelope and never into a log line, which
 * is the entire reason configuring a relay is worth doing.
 */
export class SmtpMailer implements Mailer {
  readonly kind = 'smtp' as const;
  /**
   * Public so that the wiring in selectMailer can be asserted on. Everything else it is built
   * with is either private or a credential; an envelope From is neither, and leaving it
   * unreadable would mean the only way to check it was picked up is to send a message.
   */
  readonly from: string;
  private readonly log: MailLogger;
  private readonly transport: MailTransport;

  constructor(opts: { from: string; logger: MailLogger; transport: MailTransport }) {
    this.from = opts.from;
    this.log = opts.logger;
    this.transport = opts.transport;
  }

  async send(msg: MailMessage): Promise<void> {
    try {
      const info = await this.transport.sendMail({
        // Flattened for the same reason `subject` is, and on the same line of the message:
        // SMTP_FROM comes off the environment, where the schema accepts a CRLF happily.
        from: singleLineHeader(this.from),
        to: msg.to,
        // Flattened here and not merely in the template, because this is where the value becomes
        // a header. `html` is passed straight through: nodemailer accepts an absent one, and the
        // conditional spread this replaced was a branch nothing could reach.
        subject: singleLineHeader(msg.subject),
        text: msg.text,
        html: msg.html,
      });
      // The relay's own id and nothing else: it is what ties this send to a line in the relay's
      // log, and it names neither the recipient nor the content. At debug because a working
      // relay should be silent.
      this.log.debug({ messageId: info.messageId }, 'mail handed to the relay');
    } catch (err) {
      // Logged here as well as rethrown, because the code is the one thing that tells a
      // self-hoster which knob is wrong (EAUTH is a password, ECONNECTION is a firewall) and
      // the caller sees only that sending failed. serializeError keeps `code` and the frames
      // and drops the message, which for a relay rejection is `550 ... <relative@example.com>`
      // - the address quoted back at us, i.e. exactly what D40 exists to keep out of a log.
      this.log.error({ err }, 'smtp delivery failed');
      throw err;
    }
  }
}

/**
 * No relay configured: the link goes to the log instead of to an inbox.
 *
 * THIS IS A DELIBERATE, NARROW EXCEPTION TO D38, and the reasoning matters more than the code.
 *
 * D38 says never log email bodies or addresses. This class logs an address and a live
 * invitation link, which is bearer authority to create an account inside a household and read
 * everything in it. The two rules genuinely conflict, and the conflict cannot be engineered
 * away: Principle #2 says every core flow works with zero external services, D36 makes an
 * invitation the ONLY route to an account, and `docker compose up` ships with no SMTP. Without
 * this, a fresh install cannot onboard a single person. A masked link, or a line that only says
 * an invitation was issued, would satisfy D38 and leave the operator with nothing to act on,
 * which is a worse outcome dressed as a safer one.
 *
 * So the exception is made where it buys something, and nowhere else. Exhaustively, the line
 * carries two fields:
 *   - the ACTION URL, because that link IS the delivery mechanism here;
 *   - the RECIPIENT, unmasked, because with two invitations outstanding a masked address
 *     (`g***@gmail.com` for both grandparents) is how the wrong person gets a link bound to
 *     someone else's address. Partial masking inside a line that already carries a credential
 *     buys no safety and costs the operator accuracy.
 *
 * And deliberately NOT:
 *   - the BODY, in either format, because nothing in it is needed to act;
 *   - the SUBJECT, which is the one an earlier version got wrong. A subject reads like metadata
 *     and is not: `householdInvitation` builds it out of the inviter's name and the household's
 *     name, both user-supplied, so logging it put two pieces of user content on every send. It
 *     buys the operator nothing either, because the action URL already says which kind of
 *     message this is - `/invite/accept/` or `/verify/`.
 *
 * Logged at `warn`, not `info`, and that is not cosmetic. `LOG_LEVEL=warn` is a supported
 * setting, the startup line below is at `warn` precisely so it survives one, and it tells the
 * operator that links are being written to the log. At `info` this line would not survive, so
 * that promise would be false and - since an invitation is the only route to an account (D36) -
 * a `LOG_LEVEL=warn` install could onboard nobody at all, with the sole diagnostic on screen
 * actively saying otherwise. A line carrying a live credential is warn-worthy on its own terms
 * anyway.
 *
 * What cannot be fixed in code is that anyone who can read the logs can accept the invitation.
 * That is inherent to printing a credential. It is therefore stated at three places an operator
 * actually looks: on this line, on the startup line, and in `.env.example` - so that someone
 * shipping logs to a third-party collector learns it before doing so and not after. Console
 * mode is not refused under NODE_ENV=production: see selectMailer.
 */
export class ConsoleMailer implements Mailer {
  readonly kind = 'console' as const;

  constructor(private readonly log: MailLogger) {}

  send(msg: MailMessage): Promise<void> {
    this.log.warn(
      { to: msg.to, actionUrl: msg.actionUrl },
      'no SMTP configured, so this log line IS the email: anyone who can read it can use the link',
    );
    return Promise.resolve();
  }
}

/** Captures instead of sending, so tests can assert on what a flow tried to deliver. */
export class MemoryMailer implements Mailer {
  readonly kind = 'memory' as const;
  readonly sent: MailMessage[] = [];

  send(msg: MailMessage): Promise<void> {
    this.sent.push(msg);
    return Promise.resolve();
  }
}

/**
 * Blank means absent here as it does in the env schema (see env.ts), and for the same reason:
 * an untouched unraid template field and a `${SMTP_HOST:-}` in a compose file both arrive as
 * ''. The schema already applies the rule, but this selector is separately reachable - it takes
 * a plain object, and the consequence of getting it wrong is not a crash but an SMTP transport
 * pointed at an empty host, i.e. mail that silently never leaves the box.
 *
 * A non-blank value is returned VERBATIM, padding included, which is the same bargain env.ts
 * strikes: whitespace-only is absent, whitespace around a real value is not, because trimming a
 * real value would be a second decision made silently. A padded hostname is not lost either
 * way - the startup line below prints `host` as JSON, where the stray space is visible.
 */
function configuredHost(env: MailEnv): string | undefined {
  const host = env.SMTP_HOST;
  return typeof host === 'string' && host.trim() !== '' ? host : undefined;
}

/**
 * Whether to refuse console mode in production, which is the obvious parallel to the dev-secret
 * refusal in secret.ts. It is not drawn, and the difference is worth stating.
 *
 * The dev secret has no legitimate production use whatsoever - it is published in this
 * repository, so running on it is an authentication bypass open to the entire internet, and it
 * fails silently and permanently. Console mail is none of those. It is the DOCUMENTED fallback
 * for a home server with no relay (design A3), `docker compose up` sets NODE_ENV=production, so
 * a refusal would break the shipped one-command install for the exact deployment this milestone
 * was written for; its exposure is to whoever can read the logs, who on a default self-hosted
 * box is the operator - someone who already owns the database; and the links expire.
 *
 * An `ALLOW_CONSOLE_MAIL=true` escape hatch is worse than either alternative. Every zero-config
 * user would set it, because its name would be in the first error message they hit, after which
 * it is permanently on and conveys nothing. That manufactures consent once and then makes the
 * state invisible - the dev-secret refusal means something precisely BECAUSE it has no opt-out.
 *
 * The failure a refusal would actually prevent - an operator who meant to configure SMTP and
 * whose variable did not land - is prevented just as well by a startup `warn` that names the
 * cause and the consequence, on every boot, at a level that survives LOG_LEVEL=warn. And the
 * harm that matters, logs shipped to a third-party collector, is not a state this process can
 * observe, so it cannot be gated on. It can only be told, in advance, which is what this does.
 */
function selectMailer(env: MailEnv, log: MailLogger): Mailer {
  const host = configuredHost(env);
  if (host === undefined) {
    log.warn(
      { kind: 'console' },
      'SMTP_HOST is unset, so invitation and verification links are written to these logs ' +
        'instead of emailed. Anyone who can read the logs can accept an invitation: do not ship ' +
        'them to a third-party collector. Set SMTP_HOST to deliver mail instead.',
    );
    return new ConsoleMailer(log);
  }

  const options = smtpTransportOptions({ ...env, SMTP_HOST: host });
  const from = env.SMTP_FROM ?? DEFAULT_SMTP_FROM;
  // Endpoint only. The user and the password are deployment credentials and appear on no line,
  // which is a stronger promise than relying on redaction to censor them (see log.ts).
  //
  // Read off the options object rather than recomputed from env, so the line reports what
  // nodemailer was actually handed instead of a second opinion about it.
  log.info(
    { kind: 'smtp', host: options.host, port: options.port, secure: options.secure },
    'mail will be delivered over SMTP',
  );
  if (from === DEFAULT_SMTP_FROM) {
    log.warn(
      'SMTP_FROM is still ' +
        DEFAULT_SMTP_FROM +
        ', which most relays reject because the domain has no MX record. Set it to an address ' +
        'on a domain your relay is authorised to send for.',
    );
  }

  // The classic pairing error, and worth a line because of how it fails: a handshake mismatch
  // hangs until a timeout rather than answering, and D40 drops the error message, so the
  // operator is left with a stall and no text. Only the two unambiguous cases are called out -
  // port 25 with STARTTLS is normal, and an unusual port is nobody's business here.
  const mismatched =
    (options.port === 465 && !options.secure) || (options.port === 587 && options.secure);
  if (mismatched) {
    log.warn(
      { port: options.port, secure: options.secure },
      'SMTP_PORT and SMTP_SECURE disagree: 465 is implicit TLS (SMTP_SECURE=true) and 587 is ' +
        'STARTTLS (SMTP_SECURE=false). A mismatch usually hangs the connection instead of ' +
        'reporting anything.',
    );
  }

  if ((env.SMTP_USER === undefined) !== (env.SMTP_PASS === undefined)) {
    log.warn(
      'Only one of SMTP_USER and SMTP_PASS is set, so Hearth will connect without ' +
        'authenticating. Set both, or neither. A blank field in a container template reads as ' +
        'unset, which is the usual way this happens.',
    );
  }

  return new SmtpMailer({
    from,
    logger: log,
    // Constructs only. nodemailer dials on the first send, not here, which is what keeps the
    // test suite - and a boot with an unreachable relay - off the network.
    transport: createTransport(options),
  });
}

/**
 * The env-to-nodemailer mapping, as its own function because it is the part worth asserting on:
 * `createTransport` swallows its options, so a port or a handshake that never arrived would
 * otherwise only show up against a real relay.
 *
 * `auth` is present only when BOTH halves are, rather than passed half-filled. An
 * `auth: { user, pass: undefined }` makes nodemailer attempt an AUTH exchange it cannot
 * complete, and the resulting failure names the exchange rather than the field that is empty -
 * which, given that a blank container-template field reads as unset, is the likeliest way to
 * arrive here. A relay that wants no credentials at all must equally not be offered an empty
 * one, so the same condition covers both.
 */
export function smtpTransportOptions(env: MailEnv & { SMTP_HOST: string }): {
  host: string;
  port: number;
  secure: boolean;
  auth?: { user: string; pass: string };
} {
  const { SMTP_USER: user, SMTP_PASS: pass } = env;
  return {
    // Required by the parameter type, which rules out `undefined` but NOT ''. The blank guard
    // is configuredHost's, and this function trusts its caller for that one thing; the type is
    // here so a caller cannot omit the host altogether, not so this can claim to validate it.
    host: env.SMTP_HOST,
    port: env.SMTP_PORT ?? 587,
    // Implicit TLS (port 465). `false` still upgrades via STARTTLS when the relay offers it,
    // which is what port 587 expects, so this is a choice of handshake and not of whether the
    // connection is encrypted.
    secure: env.SMTP_SECURE ?? false,
    ...(user !== undefined && pass !== undefined ? { auth: { user, pass } } : {}),
  };
}

/**
 * The one mailer this process uses, chosen once from configuration and announced in the log so
 * a self-hoster can tell from a boot line whether mail will actually leave the box.
 */
export function createMailer(opts: { env: MailEnv; logger: MailLogger }): Mailer {
  return selectMailer(opts.env, opts.logger);
}
