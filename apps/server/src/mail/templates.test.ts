import { describe, it, expect } from 'vitest';
import { NAME_LIMIT, emailVerification, householdInvitation } from './templates';

const INVITE = {
  inviterName: 'Charles',
  householdName: 'The Lewis Kitchen',
  acceptUrl: 'https://hearth.example.com/invite/accept/TOKEN123',
} as const;

describe('householdInvitation', () => {
  it('puts the accept link in the text and the html, because that link is the whole message', () => {
    const mail = householdInvitation(INVITE);
    expect(mail.text).toContain(INVITE.acceptUrl);
    expect(mail.html).toContain(INVITE.acceptUrl);
    // In the html it has to be reachable as a link, not merely present as prose.
    expect(mail.html).toContain(`href="${INVITE.acceptUrl}"`);
  });

  // The field ConsoleMailer prints has to be the same link the body offers, or console mode
  // hands the operator a URL that leads somewhere else.
  it('reports the accept link as its action url', () => {
    expect(householdInvitation(INVITE).actionUrl).toBe(INVITE.acceptUrl);
  });

  it('names the household and the inviter in the subject', () => {
    const { subject } = householdInvitation(INVITE);
    expect(subject).toContain('The Lewis Kitchen');
    expect(subject).toContain('Charles');
  });

  it('escapes html in a household name, so a name cannot become markup', () => {
    const mail = householdInvitation({ ...INVITE, householdName: '<script>alert(1)</script>' });
    expect(mail.html).not.toContain('<script>');
    expect(mail.html).toContain('&lt;script&gt;');
  });

  it('escapes html in an inviter name too', () => {
    const mail = householdInvitation({ ...INVITE, inviterName: '<img src=x onerror=1>' });
    expect(mail.html).not.toContain('<img');
    expect(mail.html).toContain('&lt;img');
  });

  // A quote in an interpolated value would otherwise close the href and let the rest of the
  // value become attributes.
  it('escapes a quote in the link, so an attribute cannot be broken out of', () => {
    const mail = householdInvitation({
      ...INVITE,
      acceptUrl: 'https://hearth.example.com/a"onmouseover="alert(1)',
    });
    expect(mail.html).not.toContain('"onmouseover="');
    expect(mail.html).toContain('&quot;');
  });

  // Escaping belongs to the html twin only. A plain-text body that showed `&amp;` would be a
  // link the recipient cannot paste into a browser.
  it('leaves the text body unescaped, ampersands and all', () => {
    const url = 'https://hearth.example.com/accept?token=A&household=B';
    const mail = householdInvitation({ ...INVITE, acceptUrl: url, householdName: 'Ben & Jo' });
    expect(mail.text).toContain(url);
    expect(mail.text).toContain('Ben & Jo');
    expect(mail.html).toContain('token=A&amp;household=B');
    expect(mail.html).toContain('Ben &amp; Jo');
  });

  /**
   * Header injection, driven over BOTH interpolated names.
   *
   * These three cases used to poison `householdName` only, and deleting the flattening of
   * `inviterName` passed all sixteen tests: an inviter display name is exactly as
   * user-controlled as a household name, and it lands in the same header.
   */
  describe.each(['inviterName', 'householdName'] as const)('with a poisoned %s', (field) => {
    const render = (value: string) => householdInvitation({ ...INVITE, [field]: value });

    it('refuses to let a newline become a second header', () => {
      const mail = render('Kitchen\r\nBcc: attacker@example.com');
      expect(mail.subject).not.toContain('\r');
      expect(mail.subject).not.toContain('\n');
      expect(mail.subject.split(/\r|\n/)).toHaveLength(1);
      // Kept as text, so the test cannot pass by dropping the value outright.
      expect(mail.subject).toContain('Bcc: attacker@example.com');
    });

    /**
     * Written from what a mail header cares about rather than from the implementation's own
     * character class. Asserting with a copy of `HEADER_BREAKERS` would catch its deletion and
     * never its incompleteness, which is the failure mode that matters for a defence like this.
     */
    it.each([
      ['carriage return', '\r'],
      ['line feed', '\n'],
      ['null', '\u0000'],
      ['vertical tab', '\u000b'],
      ['form feed', '\u000c'],
      ['delete', '\u007f'],
      ['line separator', '\u2028'],
      ['paragraph separator', '\u2029'],
    ])('strips a %s', (_name, char) => {
      const mail = render(`Kit${char}chen`);
      expect(mail.subject).not.toContain(char);
      expect(mail.subject).toContain('Kit chen');
    });

    it('bounds an unbounded name', () => {
      const mail = render('x'.repeat(5000));
      expect(mail.subject.length).toBeLessThan(NAME_LIMIT * 2 + 100);
      // Asserted on the name itself rather than on the rendered length, so the constant chrome
      // around it cannot absorb the difference between "truncated" and "not".
      expect(mail.html).not.toContain('x'.repeat(NAME_LIMIT + 1));
      expect(mail.text).not.toContain('x'.repeat(NAME_LIMIT + 1));
    });
  });

  /**
   * The scheme is the template's business because this is where the value becomes an href, and
   * escaping does not look at schemes. Phase D makes it live: Better Auth's verification url
   * embeds a client-supplied `callbackURL`.
   */
  it.each([
    ['javascript', 'javascript:alert(1)'],
    ['data', 'data:text/html,<script>alert(1)</script>'],
    ['protocol-relative', '//evil.example.com/accept'],
    ['a bare path', '/invite/accept/TOKEN'],
  ])('refuses a %s action url rather than rendering it as a link', (_name, url) => {
    expect(() => householdInvitation({ ...INVITE, acceptUrl: url })).toThrow(/http/);
  });

  it('accepts http as well as https, since a LAN instance has no TLS', () => {
    expect(() =>
      householdInvitation({ ...INVITE, acceptUrl: 'http://hearth.local:8080/invite/accept/T' }),
    ).not.toThrow();
  });

  // Truncation counts code points, so a name that is exactly at the bound followed by an emoji
  // cannot leave half a surrogate pair in a mail header.
  it('does not split a surrogate pair when bounding a name', () => {
    const mail = householdInvitation({
      ...INVITE,
      householdName: 'x'.repeat(NAME_LIMIT - 1) + '\u{1F525}',
    });
    // A LONE surrogate, not any surrogate: the emoji is itself a well-formed pair, so a
    // naive /[\uD800-\uDFFF]/ would match the correct output too.
    expect(mail.subject).not.toMatch(
      /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/,
    );
    expect(mail.subject).toContain('\u{1F525}');
  });

  it('is pure: the same input renders the same message', () => {
    expect(householdInvitation(INVITE)).toEqual(householdInvitation(INVITE));
  });
});

describe('emailVerification', () => {
  const verifyUrl = 'https://hearth.example.com/verify/TOKEN456';

  it('puts the verify link in the text and the html', () => {
    const mail = emailVerification({ verifyUrl });
    expect(mail.text).toContain(verifyUrl);
    expect(mail.html).toContain(`href="${verifyUrl}"`);
  });

  it('reports the verify link as its action url', () => {
    expect(emailVerification({ verifyUrl }).actionUrl).toBe(verifyUrl);
  });

  // No single-line assertion here: this subject is a literal with nothing interpolated into
  // it, so such a check would be a property of a constant and could never fail.
  it('names Hearth in the subject', () => {
    expect(emailVerification({ verifyUrl }).subject).toContain('Hearth');
  });

  // The single-quote branch of escapeHtml, which nothing else exercises: deleting that one
  // `.replace` used to pass the whole suite.
  it('escapes a single quote in a name, not just a double one', () => {
    const mail = householdInvitation({ ...INVITE, householdName: "Ben's Kitchen" });
    expect(mail.html).toContain('Ben&#39;s Kitchen');
    expect(mail.html).not.toContain("Ben's Kitchen");
    expect(mail.text).toContain("Ben's Kitchen");
  });

  it('escapes a quote in the link', () => {
    const mail = emailVerification({ verifyUrl: 'https://h.example.com/a"x' });
    expect(mail.html).toContain('&quot;');
    expect(mail.html).not.toContain('/a"x');
  });

  it('is pure: the same input renders the same message', () => {
    expect(emailVerification({ verifyUrl })).toEqual(emailVerification({ verifyUrl }));
  });
});
