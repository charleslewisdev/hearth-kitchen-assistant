import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

/**
 * The mailer is a startup singleton (mail/index.ts), so substituting it is a module mock rather
 * than an injection. `importActual` on mail/mailer.ts rather than a hand-rolled fake, because
 * the point of MemoryMailer is that it is the same `Mailer` the real transports implement - a
 * local stub would drift from the interface and still pass.
 */
vi.mock('./mail', async () => {
  const actual = await vi.importActual<typeof import('./mail/mailer')>('./mail/mailer');
  return { mailer: new actual.MemoryMailer() };
});

const { auth } = await import('./auth');
const { publicConfig } = await import('./config');
const { mailer } = await import('./mail');
const { MemoryMailer } = await import('./mail/mailer');
const { deliver } = await import('./auth-mail');
const { resetDb, emailVerifiedFor } = await import('../test/db');
const { bootstrapHeaders, ownerWithHousehold } = await import('../test/session');
const { createLogger } = await import('./log');
const { capture } = await import('../test/logs');

const memory = mailer as InstanceType<typeof MemoryMailer>;

describe('invitation email', () => {
  beforeEach(async () => {
    await resetDb();
    memory.sent.length = 0;
  });

  /**
   * An owner with an empty mailbox.
   *
   * Building the owner sends a real message of its own - that account is uninvited, so it gets a
   * verification email - and clearing it here is what lets the assertions below say "exactly one
   * message" and mean "exactly one message caused by issuing the invitation".
   */
  const ownerReady = async () => {
    const owner = await ownerWithHousehold();
    memory.sent.length = 0;
    return owner;
  };

  it('sends exactly one message, to the invited address, carrying the accept link', async () => {
    const owner = await ownerReady();
    const invite = await auth.api.createInvitation({
      // Mixed case on purpose: Better Auth lowercases before it stores or sends, and the
      // recipient has to be the address the account will later be keyed on.
      body: { email: 'Grandma@Example.COM', role: 'member', organizationId: owner.householdId },
      headers: owner.headers,
    });

    expect(memory.sent).toHaveLength(1);
    const msg = memory.sent[0];
    expect(msg?.to).toBe('grandma@example.com');
    expect(msg?.actionUrl).toBe(`${publicConfig.webOrigin}/accept-invite/${invite.id}`);
    expect(msg?.text).toContain(`/accept-invite/${invite.id}`);
    expect(msg?.html).toContain(`/accept-invite/${invite.id}`);
  });

  /**
   * The link alone would pass with `householdInvitation({ inviterName: '', householdName: '' })`,
   * which renders a perfectly valid message that tells the recipient nothing about who is
   * asking. This is what pins that the real fields off `data.inviter` and `data.organization`
   * were the ones passed.
   */
  it('names the inviter and the household', async () => {
    const owner = await ownerReady();
    await auth.api.createInvitation({
      body: { email: 'grandma@example.com', role: 'member', organizationId: owner.householdId },
      headers: owner.headers,
    });

    const msg = memory.sent[0];
    expect(msg?.subject).toContain(owner.name);
    expect(msg?.subject).toContain('The Test Kitchen');
  });

  /**
   * What a failing relay must NOT do.
   *
   * Better Auth calls `sendInvitationEmail` through `runInBackgroundOrAwait`, which catches
   * whatever escapes and hands it to ITS logger as `console.error("Failed to run background
   * task:", err)`. That line bypasses pino entirely - no redaction, no `serializeError` - and
   * prints the error's own message, which for an SMTP rejection is `550 ... <someone@x.com>`:
   * the recipient's address, in a log, which is exactly what D38 and D40 exist to prevent.
   *
   * So the requirement is not merely "does not crash". It is that nothing escapes at all, and
   * `console.error` is the assertion that says so: it is called if and only if the rethrow this
   * code deliberately does not do is reintroduced.
   */
  it('does not let a relay failure escape into the Better Auth console logger', async () => {
    const owner = await ownerReady();
    const send = vi.spyOn(memory, 'send').mockRejectedValueOnce(new Error('550 mailbox full'));
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});

    try {
      await expect(
        auth.api.createInvitation({
          body: { email: 'grandma@example.com', role: 'member', organizationId: owner.householdId },
          headers: owner.headers,
        }),
      ).resolves.toBeDefined();
      expect(send).toHaveBeenCalledTimes(1);
      expect(consoleError).not.toHaveBeenCalled();
    } finally {
      consoleError.mockRestore();
      send.mockRestore();
    }
  });
});

/**
 * `deliver` is unit-tested rather than reached through the endpoint because the shared logger is
 * silent under NODE_ENV=test (log.ts), so the line it writes is only observable over a sink the
 * test builds itself.
 */
describe('deliver', () => {
  const message = {
    to: 'grandma@example.com',
    subject: 'Subject',
    text: 'body',
    html: '<p>body</p>',
    actionUrl: 'https://hearth.example.com/accept-invite/abc',
  };
  const render = () => message;

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('reports a failure through our own logger and swallows it', async () => {
    const { sink, lines } = capture();
    const log = createLogger({ level: 'info', pretty: false, destination: sink });
    const failing = {
      kind: 'memory' as const,
      send: () => Promise.reject(new Error('550 no mailbox for <grandma@example.com>')),
    };

    await expect(
      deliver({ mailer: failing, log, kind: 'invitation', render }),
    ).resolves.toBeUndefined();

    const [line] = lines();
    expect(line?.msg).toBe('could not send an email');
    expect(line?.kind).toBe('invitation');
    // D38 and D40 together: neither the recipient nor the relay's own text may appear anywhere
    // on the line, and the relay quotes the address back at us inside the message.
    expect(JSON.stringify(line)).not.toContain('grandma@example.com');
    expect(JSON.stringify(line)).not.toContain('no mailbox');
  });

  /**
   * Rendering is inside the same guard as sending, and this is what says so.
   *
   * It is not hypothetical: `linkHtml` throws unless the action URL is http(s), and the
   * verification URL's tail is a client-supplied `callbackURL`. A render that threw OUTSIDE the
   * guard would escape into Better Auth's own console logger, which is the one place a message
   * reaches a log unredacted.
   */
  it('reports a render failure the same way, and sends nothing', async () => {
    const { sink, lines } = capture();
    const log = createLogger({ level: 'info', pretty: false, destination: sink });
    const ok = new MemoryMailer();

    await expect(
      deliver({
        mailer: ok,
        log,
        kind: 'verification',
        render: () => {
          throw new Error('action url must be http(s)');
        },
      }),
    ).resolves.toBeUndefined();

    expect(ok.sent).toHaveLength(0);
    expect(lines()[0]?.msg).toBe('could not send an email');
    expect(lines()[0]?.kind).toBe('verification');
  });

  it('says nothing at all when the send succeeds', async () => {
    const { sink, lines } = capture();
    const log = createLogger({ level: 'info', pretty: false, destination: sink });
    const ok = new MemoryMailer();

    await deliver({ mailer: ok, log, kind: 'invitation', render });

    expect(ok.sent).toEqual([message]);
    expect(lines()).toHaveLength(0);
  });
});

/**
 * Verification, and the one decision worth restating: a user who arrived through an invitation
 * has already proved control of the address, because the invitation was mailed to it and it is
 * the only thing that let them sign up at all (D36). So they are marked verified on creation and
 * the second email is not sent.
 */
describe('email verification', () => {
  /** Better Auth's verify-email endpoint, which is what a verification message links to. */
  const verificationMessages = () =>
    memory.sent.filter((m) => m.actionUrl.includes('/verify-email'));

  beforeEach(async () => {
    await resetDb();
    memory.sent.length = 0;
  });

  it('sends a verification email to an uninvited first account, which stays unverified', async () => {
    await auth.api.signUpEmail({
      body: { email: 'owner@example.com', password: 'password1234', name: 'Owner' },
      headers: new Headers(bootstrapHeaders()),
    });

    expect(await emailVerifiedFor('owner@example.com')).toBe(false);
    expect(verificationMessages()).toHaveLength(1);
    expect(verificationMessages()[0]?.to).toBe('owner@example.com');
  });

  it('marks an invited account verified and sends it no verification email', async () => {
    const owner = await ownerWithHousehold();
    await auth.api.createInvitation({
      body: { email: 'grandma@example.com', role: 'member', organizationId: owner.householdId },
      headers: owner.headers,
    });
    memory.sent.length = 0;

    await auth.api.signUpEmail({
      body: { email: 'grandma@example.com', password: 'password1234', name: 'Grandma' },
    });

    // Both halves. The first alone would pass with the email still going out; the second alone
    // would pass with verification never wired up at all.
    expect(await emailVerifiedFor('grandma@example.com')).toBe(true);
    expect(verificationMessages()).toHaveLength(0);
  });

  it('refuses sign-in until an account is verified', async () => {
    await auth.api.signUpEmail({
      body: { email: 'owner@example.com', password: 'password1234', name: 'Owner' },
      headers: new Headers(bootstrapHeaders()),
    });

    await expect(
      auth.api.signInEmail({ body: { email: 'owner@example.com', password: 'password1234' } }),
    ).rejects.toThrow(/verif/i);
  });

  /**
   * The first account's link lasts an hour and there was no way to ask for another, so an owner
   * who came back the next day was locked out of their own server. Signing in with the right
   * password now mails a fresh one; the password is what stops this being a way to mail anyone.
   */
  it('sends a fresh link when an unverified account signs in with the right password', async () => {
    await auth.api.signUpEmail({
      body: { email: 'owner@example.com', password: 'password1234', name: 'Owner' },
      headers: new Headers(bootstrapHeaders()),
    });
    memory.sent.length = 0;

    await expect(
      auth.api.signInEmail({ body: { email: 'owner@example.com', password: 'password1234' } }),
    ).rejects.toThrow(/verif/i);
    expect(verificationMessages()).toHaveLength(1);
    expect(verificationMessages()[0]?.to).toBe('owner@example.com');
  });

  it('sends nothing for a wrong password', async () => {
    await auth.api.signUpEmail({
      body: { email: 'owner@example.com', password: 'password1234', name: 'Owner' },
      headers: new Headers(bootstrapHeaders()),
    });
    memory.sent.length = 0;

    await expect(
      auth.api.signInEmail({ body: { email: 'owner@example.com', password: 'wrong-password' } }),
    ).rejects.toThrow();
    expect(verificationMessages()).toHaveLength(0);
  });

  it('lets an invited account sign in immediately', async () => {
    const owner = await ownerWithHousehold();
    await auth.api.createInvitation({
      body: { email: 'grandma@example.com', role: 'member', organizationId: owner.householdId },
      headers: owner.headers,
    });
    await auth.api.signUpEmail({
      body: { email: 'grandma@example.com', password: 'password1234', name: 'Grandma' },
    });

    await expect(
      auth.api.signInEmail({ body: { email: 'grandma@example.com', password: 'password1234' } }),
    ).resolves.toBeDefined();
  });

  const signUpWithCallback = (callbackURL: string) =>
    auth.api.signUpEmail({
      body: { email: 'owner@example.com', password: 'password1234', name: 'Owner', callbackURL },
      headers: new Headers(bootstrapHeaders()),
    });

  /**
   * The live obligation Phase C left behind, discharged.
   *
   * `linkHtml` throws unless the action URL is http(s), and the URL Better Auth hands
   * `sendVerificationEmail` is `${baseURL}/verify-email?token=...&callbackURL=<client value>`,
   * whose tail the client writes. Two things keep it safe, and neither is this codebase's, so
   * both are pinned rather than assumed: `PUBLIC_URL` is refused at boot unless its scheme is
   * http or https (config.ts), which fixes the head; and Better Auth percent-encodes the
   * callbackURL, which stops the tail from escaping the query string. What arrives is therefore
   * always a live http link, never a throw on the sign-up path, and never markup in the body.
   */
  it.each([
    ['html injection', '"><img src=x onerror=alert(1)>'],
    ['a javascript scheme', 'javascript:alert(1)'],
    ['a scheme-relative host', '//evil.example.com/steal'],
  ])('survives a hostile callbackURL: %s', async (_name, callbackURL) => {
    await expect(signUpWithCallback(callbackURL)).resolves.toBeDefined();

    const msg = verificationMessages()[0];
    expect(msg).toBeDefined();
    expect(msg?.actionUrl).toMatch(/^https?:\/\//);
    // The anchor in the body is built from that URL, so nothing off the callbackURL may reach
    // the document as markup.
    expect(msg?.html).not.toContain('<img');
    expect(msg?.html).not.toContain('onerror=');
    expect(msg?.html).not.toContain('javascript:');
  });

  /**
   * The second half of the defence, tested on its own because the first half hides it.
   *
   * The cases above all pass with `linkHtml`'s `escapeHtml` deleted, because percent-encoding
   * already removed every character escaping would have caught - so on their own they pin the
   * encoding and quietly assume the escaping. `encodeURIComponent` leaves `'` alone, which is
   * exactly the gap: it reaches the template raw, and only `escapeHtml` turns it into `&#39;`.
   */
  it('escapes what percent-encoding leaves behind', async () => {
    await signUpWithCallback("/next'page");

    const url = verificationMessages()[0]?.actionUrl ?? '';
    const html = verificationMessages()[0]?.html ?? '';
    // `&` first, the order escapeHtml uses, or the replacement would re-escape its own output.
    const escaped = url.replaceAll('&', '&amp;').replaceAll("'", '&#39;');

    expect(url).toContain("'");
    expect(html).not.toContain(url);
    expect(html).toContain(escaped);
  });
});

/**
 * Password reset. Before this a forgotten password meant editing the database by hand. The link
 * travels like every other Hearth message: by mail with SMTP, into the log without it.
 */
describe('password reset', () => {
  const resetMessages = () => memory.sent.filter((m) => m.actionUrl.includes('/reset-password/'));

  beforeEach(async () => {
    await resetDb();
    memory.sent.length = 0;
  });

  it('mails a reset link to an account that exists, and nothing for one that does not', async () => {
    await ownerWithHousehold();
    memory.sent.length = 0;

    await auth.api.requestPasswordReset({
      body: { email: 'owner@example.com', redirectTo: '/reset-password' },
    });
    expect(resetMessages()).toHaveLength(1);
    expect(resetMessages()[0]?.to).toBe('owner@example.com');
    expect(resetMessages()[0]?.subject).toMatch(/reset/i);

    // Same answer either way, so the form cannot be used to learn who has an account.
    const unknown = await auth.api.requestPasswordReset({
      body: { email: 'stranger@example.com', redirectTo: '/reset-password' },
    });
    expect(unknown).toMatchObject({ status: true });
    expect(resetMessages()).toHaveLength(1);
  });

  it('sets the new password, retires the old one, and signs out every session', async () => {
    const owner = await ownerWithHousehold();
    memory.sent.length = 0;
    await auth.api.requestPasswordReset({
      body: { email: 'owner@example.com', redirectTo: '/reset-password' },
    });
    const token = resetMessages()[0]?.actionUrl.match(/\/reset-password\/([^?]+)/)?.[1];
    expect(token).toBeTruthy();

    await auth.api.resetPassword({ body: { newPassword: 'a-brand-new-one', token: token! } });

    await expect(
      auth.api.signInEmail({ body: { email: 'owner@example.com', password: 'password1234' } }),
    ).rejects.toThrow();
    await expect(
      auth.api.signInEmail({ body: { email: 'owner@example.com', password: 'a-brand-new-one' } }),
    ).resolves.toBeDefined();
    // The session the owner had before the reset no longer works.
    expect(await auth.api.getSession({ headers: owner.headers })).toBeNull();
  });
});
