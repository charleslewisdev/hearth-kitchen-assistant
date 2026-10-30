import { describe, it, expect } from 'vitest';
import { Socket } from 'node:net';
import {
  ConsoleMailer,
  MemoryMailer,
  SmtpMailer,
  createMailer,
  smtpTransportOptions,
  type MailMessage,
  type MailTransport,
} from './mailer';
import { DEFAULT_SMTP_FROM } from '../env';
import { createLogger } from '../log';
import { capture } from '../../test/logs';

/**
 * Markers that exist ONLY in the body, so "the body is never logged" can be asserted without
 * tripping over the action link, which every body also contains and which console mode is
 * required to print.
 */
const TEXT_ONLY = 'PROSE-THAT-LIVES-ONLY-IN-THE-TEXT-BODY';
const HTML_ONLY = 'PROSE-THAT-LIVES-ONLY-IN-THE-HTML-BODY';
const ACCEPT_URL = 'https://hearth.example.com/invite/accept/LIVE-BEARER-TOKEN';

const INVITE: MailMessage = {
  to: 'relative@example.com',
  subject: 'Join the Lewis household on Hearth',
  text: `${TEXT_ONLY} ${ACCEPT_URL}`,
  html: `<p>${HTML_ONLY} <a href="${ACCEPT_URL}">Accept</a></p>`,
  actionUrl: ACCEPT_URL,
};

function loggerOverSink(level: 'debug' | 'warn' = 'debug'): {
  log: ReturnType<typeof createLogger>;
  lines: () => Record<string, unknown>[];
} {
  const { sink, lines } = capture();
  // debug by default, not info: a line this layer emits at debug is still a line that must not
  // carry an address or a body, and a quieter logger would hide it from these assertions. The
  // 'warn' setting exists for the one case that has to run at the level an operator chose.
  return { log: createLogger({ level, pretty: false, destination: sink }), lines };
}

/**
 * How many TCP connections were opened while `fn` ran AND for a short while afterwards.
 *
 * `net.Socket.prototype.connect` is the single funnel: `net.connect` builds a Socket and calls
 * it, and `tls.connect` builds a TLSSocket, which inherits this method rather than overriding
 * it. So one patch covers both the plain and the implicit-TLS paths nodemailer can take.
 *
 * The wait is the part that took a mutation to find. A first version unpatched as soon as `fn`
 * returned, and so only ever proved that construction does not dial SYNCHRONOUSLY: a mutant
 * that called `transporter.verify()` - which does dial - still counted zero, because nodemailer
 * reaches the socket a tick later.
 *
 * 50ms is calibrated to nodemailer, not to the general case: it comfortably covers the tick or
 * two this library takes to reach a socket, and it would NOT see something that waited 120ms
 * before dialling. Two positive controls below keep both halves honest - one dials
 * synchronously, one on a later tick, and the second is what fails if the wait is ever shortened
 * or deleted.
 */
async function countConnections(fn: () => void): Promise<number> {
  type Connect = typeof Socket.prototype.connect;
  const original: Connect = Socket.prototype.connect;
  let opened = 0;
  Socket.prototype.connect = function patched(this: Socket, ...args: unknown[]): Socket {
    opened += 1;
    return (original as unknown as (...a: unknown[]) => Socket).apply(this, args);
  } as unknown as Connect;
  try {
    fn();
    await new Promise((resolve) => setTimeout(resolve, 50));
  } finally {
    Socket.prototype.connect = original;
  }
  return opened;
}

/** A transport that records what it was handed and never touches a socket. */
function fakeTransport(): { transport: MailTransport; calls: Record<string, unknown>[] } {
  const calls: Record<string, unknown>[] = [];
  return {
    calls,
    transport: {
      sendMail: (options) => {
        calls.push({ ...options });
        return Promise.resolve({ messageId: '<generated@hearth>' });
      },
    },
  };
}

describe('createMailer: which transport a deployment gets', () => {
  it('falls back to the console when SMTP_HOST is unset, so a zero-config install can invite', () => {
    const { log } = loggerOverSink();
    expect(createMailer({ env: {}, logger: log }).kind).toBe('console');
  });

  // The unraid failure mode from phase B: an untouched template field arrives as '', and an
  // operator who clears one by hand leaves a space. Read as a value it selects SMTP against an
  // empty host, and mail silently never leaves the box.
  it.each(['', ' ', '\t'])('reads SMTP_HOST=%j as unset, not as an empty host', (blank) => {
    const { log } = loggerOverSink();
    expect(createMailer({ env: { SMTP_HOST: blank }, logger: log }).kind).toBe('console');
  });

  it('uses SMTP when a host is configured', () => {
    const { log } = loggerOverSink();
    expect(createMailer({ env: { SMTP_HOST: 'smtp.example.com' }, logger: log }).kind).toBe('smtp');
  });

  // The other half of the blank rule, matching env.ts: whitespace-only is absent, whitespace
  // AROUND a value is not, because trimming a real value is a second decision made silently.
  // Asserted through the startup line, because `kind` is 'smtp' whether the value was trimmed
  // or not: the first version of this test checked only `kind` and passed against a mutant that
  // trimmed. The logged host is the one place the padding is observable, which is also the
  // argument for not trimming it.
  it('keeps a host that merely has whitespace around it, rather than trimming it', () => {
    const { log, lines } = loggerOverSink();
    const mailer = createMailer({ env: { SMTP_HOST: ' smtp.example.com ' }, logger: log });
    expect(mailer.kind).toBe('smtp');
    expect(lines()[0]?.host).toBe(' smtp.example.com ');
  });

  // Pins the wiring rather than the class: SmtpMailer takes a `from`, and nothing else proves
  // selectMailer hands it the configured one instead of the placeholder.
  it('builds the SMTP mailer with the configured From address', () => {
    const { log } = loggerOverSink();
    const mailer = createMailer({
      env: { SMTP_HOST: 'smtp.example.com', SMTP_FROM: 'hearth@example.com' },
      logger: log,
    });
    expect(mailer).toBeInstanceOf(SmtpMailer);
    expect((mailer as SmtpMailer).from).toBe('hearth@example.com');
  });

  it('falls back to the placeholder From when none is configured', () => {
    const { log } = loggerOverSink();
    const mailer = createMailer({ env: { SMTP_HOST: 'smtp.example.com' }, logger: log });
    expect((mailer as SmtpMailer).from).toBe(DEFAULT_SMTP_FROM);
  });
});

describe('createMailer: the startup line a self-hoster reads', () => {
  // The console fallback prints live invitation links. That is the deal it makes, and the deal
  // has to be stated where an operator sees it before they ship their logs somewhere.
  it('warns, not merely informs, that console mode puts live links in the log', () => {
    const { log, lines } = loggerOverSink();
    createMailer({ env: {}, logger: log });
    const [line] = lines();
    // 40 is pino's `warn`: it survives an operator who has turned the level down to warn,
    // which `info` would not.
    expect(line?.level).toBe(40);
    expect(String(line?.msg)).toMatch(/SMTP_HOST/);
    expect(String(line?.msg)).toMatch(/anyone who can read/i);
    expect(line?.kind).toBe('console');
  });

  it('reports the SMTP endpoint at info and never its credentials', () => {
    const { log, lines } = loggerOverSink();
    createMailer({
      env: {
        SMTP_HOST: 'smtp.example.com',
        SMTP_PORT: 465,
        SMTP_SECURE: true,
        SMTP_USER: 'SMTP-USER-NAME',
        SMTP_PASS: 'SMTP-PASS-WORD',
        SMTP_FROM: 'hearth@example.com',
      },
      logger: log,
    });
    const [line] = lines();
    expect(line?.level).toBe(30);
    expect(line).toMatchObject({ kind: 'smtp', host: 'smtp.example.com', port: 465, secure: true });
    const rendered = JSON.stringify(lines());
    expect(rendered).not.toContain('SMTP-USER-NAME');
    expect(rendered).not.toContain('SMTP-PASS-WORD');
    // Not just absent as values: absent as fields, so this cannot pass merely because
    // redaction happened to censor them.
    for (const key of ['user', 'pass', 'auth', 'SMTP_USER', 'SMTP_PASS']) {
      expect(Object.keys(line ?? {})).not.toContain(key);
    }
  });

  // `hearth@localhost` is not a routable address; a real relay answers with a 5xx at send time,
  // which is the hardest failure to trace back to a Hearth setting. Said at boot instead.
  it('warns when SMTP is configured but the From address is still the unroutable default', () => {
    const { log, lines } = loggerOverSink();
    createMailer({
      env: { SMTP_HOST: 'smtp.example.com', SMTP_FROM: DEFAULT_SMTP_FROM },
      logger: log,
    });
    const warnings = lines().filter((l) => l.level === 40);
    expect(warnings).toHaveLength(1);
    expect(String(warnings[0]?.msg)).toMatch(/SMTP_FROM/);
  });

  it('warns when only half of the SMTP credential pair is configured', () => {
    const { log, lines } = loggerOverSink();
    createMailer({
      env: { SMTP_HOST: 'smtp.example.com', SMTP_FROM: 'h@example.com', SMTP_USER: 'postmaster' },
      logger: log,
    });
    const warnings = lines().filter((l) => l.level === 40);
    expect(warnings).toHaveLength(1);
    expect(String(warnings[0]?.msg)).toMatch(/SMTP_PASS/);
  });

  it.each([
    ['implicit TLS on the submission port', 587, true],
    ['STARTTLS on the implicit-TLS port', 465, false],
  ])('warns about %s, which hangs rather than reporting', (_name, port, secure) => {
    const { log, lines } = loggerOverSink();
    createMailer({
      env: { SMTP_HOST: 'h', SMTP_FROM: 'h@example.com', SMTP_PORT: port, SMTP_SECURE: secure },
      logger: log,
    });
    const warnings = lines().filter((l) => l.level === 40);
    expect(warnings).toHaveLength(1);
    expect(String(warnings[0]?.msg)).toMatch(/SMTP_PORT and SMTP_SECURE/);
  });

  it.each([
    ['STARTTLS on the submission port', 587, false],
    ['implicit TLS on its own port', 465, true],
    ['plain on port 25', 25, false],
  ])('says nothing about %s, which is a normal pairing', (_name, port, secure) => {
    const { log, lines } = loggerOverSink();
    createMailer({
      env: { SMTP_HOST: 'h', SMTP_FROM: 'h@example.com', SMTP_PORT: port, SMTP_SECURE: secure },
      logger: log,
    });
    expect(lines().filter((l) => l.level === 40)).toHaveLength(0);
  });

  it('says nothing about the From address once it has been set', () => {
    const { log, lines } = loggerOverSink();
    createMailer({
      env: { SMTP_HOST: 'smtp.example.com', SMTP_FROM: 'hearth@example.com' },
      logger: log,
    });
    expect(lines().filter((l) => l.level === 40)).toHaveLength(0);
  });

  // In console mode the From address is never used, so warning about it would be noise beside
  // the warning that actually matters.
  it('does not warn about the From address in console mode', () => {
    const { log, lines } = loggerOverSink();
    createMailer({ env: { SMTP_FROM: DEFAULT_SMTP_FROM }, logger: log });
    const warnings = lines().filter((l) => l.level === 40);
    expect(warnings).toHaveLength(1);
    expect(String(warnings[0]?.msg)).not.toMatch(/SMTP_FROM/);
  });
});

describe('smtpTransportOptions: what nodemailer is actually handed', () => {
  it('passes the host, port and handshake through', () => {
    expect(
      smtpTransportOptions({ SMTP_HOST: 'smtp.example.com', SMTP_PORT: 465, SMTP_SECURE: true }),
    ).toEqual({ host: 'smtp.example.com', port: 465, secure: true });
  });

  it('defaults to the submission port and STARTTLS', () => {
    expect(smtpTransportOptions({ SMTP_HOST: 'smtp.example.com' })).toEqual({
      host: 'smtp.example.com',
      port: 587,
      secure: false,
    });
  });

  // A relay on the LAN that wants no credentials must not be offered an empty AUTH.
  it('omits auth entirely when no credentials are configured', () => {
    expect(smtpTransportOptions({ SMTP_HOST: 'smtp.example.com' })).not.toHaveProperty('auth');
  });

  it('passes both credentials when both are set', () => {
    expect(
      smtpTransportOptions({ SMTP_HOST: 'h', SMTP_USER: 'postmaster', SMTP_PASS: 'secret' }),
    ).toMatchObject({ auth: { user: 'postmaster', pass: 'secret' } });
  });

  /**
   * The unraid shape again: SMTP_USER filled in, SMTP_PASS left as the template's blank, which
   * the schema reads as absent. Half a credential pair would otherwise become
   * `auth: { user, pass: undefined }` and fail inside an AUTH exchange, which is a long way
   * from the field that is actually empty.
   */
  it.each([
    ['only a user', { SMTP_USER: 'postmaster' }],
    ['only a password', { SMTP_PASS: 'secret' }],
  ])('omits auth given %s, rather than sending half a credential', (_name, half) => {
    expect(smtpTransportOptions({ SMTP_HOST: 'smtp.example.com', ...half })).not.toHaveProperty(
      'auth',
    );
  });
});

describe('SmtpMailer: construction is offline', () => {
  /**
   * A positive control for the counter itself. Without it the socket test below would pass just
   * as happily if the patch never took effect - which is the exact shape of vacuous test this
   * codebase keeps producing. A unix path that does not exist is used rather than a TCP address,
   * so the control counts a connect() without touching the network at all.
   */
  /**
   * The control for the WAIT specifically. Without it, shrinking the window to zero or deleting
   * the `await` outright passes every test in this file, because the only other control opens
   * its socket synchronously and so never needs the window at all. That is the same shape of
   * gap the window was added to close.
   */
  it('counts a connection opened a tick later, so the wait is load-bearing', async () => {
    const opened = await countConnections(() => {
      setTimeout(() => {
        const socket = new Socket();
        socket.on('error', () => {});
        socket.connect('/nonexistent/hearth-must-not-exist.sock');
        socket.destroy();
        // 10ms, not 0: a zero-delay dial is a macrotask queued before the window's own timer,
        // so it would still be counted by a zero-length window and shrinking the wait would go
        // unnoticed. This has to be a delay a shortened window would actually miss.
      }, 10);
    });
    expect(opened).toBe(1);
  });

  it('counts a connection that really happens, so a zero below means something', async () => {
    const opened = await countConnections(() => {
      const socket = new Socket();
      socket.on('error', () => {});
      socket.connect('/nonexistent/hearth-must-not-exist.sock');
      socket.destroy();
    });
    expect(opened).toBe(1);
  });

  // The suite must never need a live relay, and a transport that dialled on construction would
  // make every test that builds a server depend on one. nodemailer connects lazily; this pins
  // that, and pins that nothing here calls `verify()`, which does dial.
  it.each([
    ['plain', false],
    ['implicit TLS', true],
  ])('opens no socket when built for %s', async (_name, secure) => {
    const { log } = loggerOverSink();
    // TEST-NET-1 (RFC 5737): guaranteed not routable, so a connection attempt cannot succeed
    // by accident on a developer's machine.
    const opened = await countConnections(() => {
      createMailer({
        env: { SMTP_HOST: '192.0.2.1', SMTP_PORT: 25, SMTP_SECURE: secure },
        logger: log,
      });
    });
    expect(opened).toBe(0);
  });
});

describe('MemoryMailer', () => {
  it('captures what it was asked to send', async () => {
    const mailer = new MemoryMailer();
    expect(mailer.kind).toBe('memory');
    await mailer.send(INVITE);
    expect(mailer.sent).toHaveLength(1);
    expect(mailer.sent[0]?.to).toBe('relative@example.com');
    expect(mailer.sent[0]?.actionUrl).toBe(ACCEPT_URL);
  });
});

describe('ConsoleMailer', () => {
  /**
   * The deliberate exception to D38, and the only one. Console mode exists so a self-hoster
   * with no relay can still invite their spouse, and a line they cannot act on would defeat
   * that entirely. So the link is printed in full, and the recipient with it, because handing
   * the wrong link to the wrong relative is a household breach of its own.
   */
  it('prints the recipient and the live link, because a link nobody can act on is useless', async () => {
    const { log, lines } = loggerOverSink();
    await new ConsoleMailer(log).send(INVITE);
    const [line] = lines();
    expect(line?.to).toBe('relative@example.com');
    expect(line?.actionUrl).toBe(ACCEPT_URL);
  });

  /**
   * LOG_LEVEL=warn is a supported setting, and the startup line is at `warn` precisely so it
   * survives one. At `info` this line would not, so the boot line would promise links that
   * never appear and - an invitation being the only route to an account (D36) - the install
   * could onboard nobody, with the only diagnostic on screen saying the opposite.
   */
  it('survives LOG_LEVEL=warn, which the startup line promises it does', async () => {
    const { log, lines } = loggerOverSink('warn');
    await new ConsoleMailer(log).send(INVITE);
    expect(lines()).toHaveLength(1);
    expect(lines()[0]?.actionUrl).toBe(ACCEPT_URL);
  });

  /**
   * The subject is built from the inviter's name and the household's name, both user-supplied,
   * so logging it put user content on every send while buying the operator nothing: the action
   * URL already distinguishes an invitation from a verification. The D38 exception claims to be
   * exhaustive, so it has to be.
   */
  it('prints no user content beyond the address: no subject, no names', async () => {
    const { log, lines } = loggerOverSink();
    await new ConsoleMailer(log).send({
      ...INVITE,
      subject: 'SUBJECT-CARRYING-A-HOUSEHOLD-NAME',
    });
    const [line] = lines();
    expect(JSON.stringify(lines())).not.toContain('SUBJECT-CARRYING-A-HOUSEHOLD-NAME');
    expect(Object.keys(line ?? {})).not.toContain('subject');
    // Exhaustively: these two fields and nothing else of the message.
    expect(line?.to).toBe('relative@example.com');
    expect(line?.actionUrl).toBe(ACCEPT_URL);
  });

  it('still never prints the body, in either format', async () => {
    const { log, lines } = loggerOverSink();
    await new ConsoleMailer(log).send(INVITE);
    const rendered = JSON.stringify(lines());
    expect(rendered).not.toContain(TEXT_ONLY);
    expect(rendered).not.toContain(HTML_ONLY);
  });

  it('says on the line itself that the link is a credential', async () => {
    const { log, lines } = loggerOverSink();
    await new ConsoleMailer(log).send(INVITE);
    expect(String(lines()[0]?.msg)).toMatch(/anyone who can read/i);
  });
});

describe('SmtpMailer', () => {
  it('hands the message to the transport with the configured From address', async () => {
    const { log } = loggerOverSink();
    const { transport, calls } = fakeTransport();
    await new SmtpMailer({ from: 'hearth@example.com', logger: log, transport }).send(INVITE);
    expect(calls).toHaveLength(1);
    expect(calls[0]).toEqual({
      from: 'hearth@example.com',
      to: INVITE.to,
      subject: INVITE.subject,
      text: INVITE.text,
      html: INVITE.html,
    });
  });

  // The whole reason SMTP is worth configuring: the address and the body leave the box in the
  // envelope instead of in the log.
  it('logs neither the recipient nor the body when delivery succeeds', async () => {
    const { log, lines } = loggerOverSink();
    const { transport } = fakeTransport();
    await new SmtpMailer({ from: 'hearth@example.com', logger: log, transport }).send(INVITE);
    // Positively, so deleting the line entirely does not satisfy the absence assertions below.
    expect(lines()[0]?.messageId).toBe('<generated@hearth>');
    const rendered = JSON.stringify(lines());
    expect(rendered).not.toContain('relative@example.com');
    expect(rendered).not.toContain(TEXT_ONLY);
    expect(rendered).not.toContain(HTML_ONLY);
    expect(rendered).not.toContain(ACCEPT_URL);
  });

  /**
   * The defence at the boundary rather than in the template. A MailMessage built by hand - which
   * the type permits - would otherwise carry a raw newline straight into a header.
   */
  it('flattens a subject that a caller built without a template', async () => {
    const { log } = loggerOverSink();
    const { transport, calls } = fakeTransport();
    await new SmtpMailer({ from: 'hearth@example.com', logger: log, transport }).send({
      ...INVITE,
      subject: 'Invitation\r\nBcc: attacker@example.com',
    });
    const subject = String(calls[0]?.subject);
    expect(subject).not.toContain('\r');
    expect(subject).not.toContain('\n');
    // Kept, not dropped, so this cannot pass by discarding the value.
    expect(subject).toContain('Bcc: attacker@example.com');
  });

  // `from` becomes a header on the same line as `subject`, and SMTP_FROM comes off the
  // environment, where the schema accepts a CRLF without complaint.
  it('flattens the From address, not just the subject', async () => {
    const { log } = loggerOverSink();
    const { transport, calls } = fakeTransport();
    await new SmtpMailer({
      from: 'hearth@example.com\r\nBcc: attacker@example.com',
      logger: log,
      transport,
    }).send(INVITE);
    const from = String(calls[0]?.from);
    expect(from).not.toMatch(/[\r\n]/);
    expect(from).toContain('Bcc: attacker@example.com');
  });

  // A relay rejection quotes the address back at you, which is exactly the string D40 keeps out
  // of a log. The code survives, because that is what tells an operator whether to fix their
  // password or their firewall.
  it('reports a failure by code, without the address or the error message, and rethrows', async () => {
    const { log, lines } = loggerOverSink();
    const rejection = Object.assign(
      new Error('550 5.1.1 <relative@example.com>: recipient rejected'),
      { code: 'EENVELOPE' },
    );
    const transport: MailTransport = { sendMail: () => Promise.reject(rejection) };
    const mailer = new SmtpMailer({ from: 'hearth@example.com', logger: log, transport });
    await expect(mailer.send(INVITE)).rejects.toBe(rejection);
    const rendered = JSON.stringify(lines());
    expect(rendered).not.toContain('relative@example.com');
    expect(rendered).not.toContain('recipient rejected');
    expect(rendered).toContain('EENVELOPE');
  });
});
