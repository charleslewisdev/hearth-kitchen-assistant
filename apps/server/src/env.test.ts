import { describe, it, expect } from 'vitest';
import { DEFAULT_SMTP_FROM, envSchema } from './env';

/**
 * The variables a deployment must set - one, now that the origin-shaped pair is retired.
 * Everything else in these tests is the value under test, so a case reads as "this one input,
 * and defaults for the rest".
 *
 * `PUBLIC_URL` is deliberately absent: `derivePublicConfig`, not this schema, is what refuses
 * a deployment with no public identity, and it is tested in config.test.ts.
 */
const REQUIRED = {
  DATABASE_URL: 'postgres://hearth:hearth@localhost:5432/hearth',
};

const parse = (extra: Record<string, string>) => envSchema.parse({ ...REQUIRED, ...extra });

/**
 * Container platforms cannot express "unset". `${VAR:-}` in a compose file and an untouched
 * field in an unraid template both arrive as '', and an operator who clears a field leaves a
 * space behind about as often as not. Every one of these cases would otherwise parse as a
 * VALUE, and the numeric ones are the dangerous kind: '' coerces to 0.
 */
describe('env schema: blank means absent', () => {
  // The default is 0 as well now (D46), so this can no longer tell absent from 0; what it still
  // pins is that a blank field parses as the default rather than being refused as a bad list.
  it.each(['', ' ', '\t', '\n'])('reads TRUST_PROXY=%j as absent', (blank) => {
    expect(parse({ TRUST_PROXY: blank }).TRUST_PROXY).toBe(0);
  });

  // The one that bites hardest: `app.listen({ port: 0 })` binds a random ephemeral port, the
  // container healthcheck on :3000 fails, and nothing in the logs says why.
  it.each(['', ' '])('reads PORT=%j as absent, not as port 0', (blank) => {
    expect(parse({ PORT: blank }).PORT).toBe(3000);
  });

  it.each(['', ' '])('reads DATA_DIR=%j as absent, not as the working directory', (blank) => {
    expect(parse({ DATA_DIR: blank }).DATA_DIR).toBe('./.data');
  });

  it.each(['', ' '])('reads BETTER_AUTH_SECRET=%j as absent, so one is generated', (blank) => {
    expect(parse({ BETTER_AUTH_SECRET: blank }).BETTER_AUTH_SECRET).toBeUndefined();
  });

  it.each(['', ' '])('reads PUBLIC_URL=%j as absent, so the fallback applies', (blank) => {
    expect(parse({ PUBLIC_URL: blank }).PUBLIC_URL).toBeUndefined();
  });

  /**
   * The one that decides whether mail leaves the box at all. Read as a VALUE, a blank host
   * selects the SMTP transport and points it at an empty string, so a zero-config install stops
   * printing invitation links to the log and starts failing to send them somewhere invisible.
   */
  it.each(['', ' ', '\t'])('reads SMTP_HOST=%j as absent, so console mail is chosen', (blank) => {
    expect(parse({ SMTP_HOST: blank }).SMTP_HOST).toBeUndefined();
  });

  // Same trap as PORT: z.coerce.number() reads '' as 0, and port 0 is not a port.
  it.each(['', ' '])('reads SMTP_PORT=%j as absent, not as port 0', (blank) => {
    expect(parse({ SMTP_PORT: blank }).SMTP_PORT).toBe(587);
  });

  it.each(['', ' '])('reads SMTP_SECURE=%j as absent, so the default applies', (blank) => {
    expect(parse({ SMTP_SECURE: blank }).SMTP_SECURE).toBe(false);
  });

  it.each(['', ' '])('reads SMTP_FROM=%j as absent, so the default applies', (blank) => {
    expect(parse({ SMTP_FROM: blank }).SMTP_FROM).toBe(DEFAULT_SMTP_FROM);
  });

  it.each(['', ' '])('reads blank SMTP credentials as absent, so no auth is attempted', (blank) => {
    const parsed = parse({ SMTP_USER: blank, SMTP_PASS: blank });
    expect(parsed.SMTP_USER).toBeUndefined();
    expect(parsed.SMTP_PASS).toBeUndefined();
  });

  // The other half of the rule, and the one a naive "falsy means absent" gets wrong: 0 is a
  // real setting (a directly exposed instance), and it must survive.
  it('keeps an explicit TRUST_PROXY=0, which is not the same as absent', () => {
    expect(parse({ TRUST_PROXY: '0' }).TRUST_PROXY).toBe(0);
  });

  it('keeps a real value that merely has whitespace around it', () => {
    expect(parse({ DATA_DIR: ' /data ' }).DATA_DIR).toBe(' /data ');
  });
});

describe('env schema: values it must refuse', () => {
  it.each([
    ['a hop count that is not a number', { TRUST_PROXY: 'yes' }],
    ['a negative hop count', { TRUST_PROXY: '-1' }],
    ['a fractional hop count', { TRUST_PROXY: '1.5' }],
    ['a proxy list with a name in it', { TRUST_PROXY: '192.168.1.1, pfsense.lan' }],
    ['a proxy range with too many bits', { TRUST_PROXY: '10.0.0.0/33' }],
    ['a proxy range with no bits', { TRUST_PROXY: '10.0.0.0/' }],
    ['a secret too short to be one', { BETTER_AUTH_SECRET: 'short' }],
    [
      'the template password placeholder',
      { DATABASE_URL: 'postgres://hearth:CHANGE_ME@hearth-db:5432/hearth' },
    ],
    ['a PUBLIC_URL that is not a URL', { PUBLIC_URL: 'hearth.example.com' }],
    ['an unknown NODE_ENV', { NODE_ENV: 'staging' }],
    ['an unknown LOG_LEVEL', { LOG_LEVEL: 'verbose' }],
  ])('rejects %s', (_name, extra) => {
    expect(() => parse(extra)).toThrow();
  });

  it('rejects a missing DATABASE_URL rather than starting without a database', () => {
    expect(() => envSchema.parse({})).toThrow();
  });
});

/**
 * D35 made the public identity one value. The pair it replaced took two more milestones to
 * retire, and until this task an operator following PUBLIC_URL-only docs was refused at boot
 * with `BETTER_AUTH_URL: Required` - naming a variable nothing had read since D35.
 */
describe('env schema: the retired origin pair', () => {
  it('starts on PUBLIC_URL alone, with neither of the old pair set', () => {
    const parsed = parse({ PUBLIC_URL: 'https://hearth.example.com' });
    expect(parsed.PUBLIC_URL).toBe('https://hearth.example.com');
    expect(parsed.WEB_ORIGIN).toBeUndefined();
  });

  // The fallback config.ts reads, and the reason WEB_ORIGIN is still in the schema at all.
  it('keeps WEB_ORIGIN when it is the only origin set, so `pnpm dev` still resolves one', () => {
    expect(parse({ WEB_ORIGIN: 'http://localhost:5173' }).WEB_ORIGIN).toBe('http://localhost:5173');
  });

  it('starts with no origin at all, leaving the refusal to derivePublicConfig', () => {
    const parsed = parse({});
    expect(parsed.PUBLIC_URL).toBeUndefined();
    expect(parsed.WEB_ORIGIN).toBeUndefined();
  });

  // Not merely unused: absent from the schema, so zod strips it. An operator who still sets it
  // is neither validated nor warned, and a bad value cannot keep the server from booting.
  it('ignores BETTER_AUTH_URL entirely, including a value that is not a URL', () => {
    expect(parse({ BETTER_AUTH_URL: 'not-a-url' })).not.toHaveProperty('BETTER_AUTH_URL');
  });
});

describe('env schema: TRUST_PROXY as a list of proxies', () => {
  it('reads addresses and ranges, trimmed, in order', () => {
    expect(parse({ TRUST_PROXY: ' 192.168.1.1 , 10.0.0.0/8,fd00::/8 ' }).TRUST_PROXY).toEqual([
      '192.168.1.1',
      '10.0.0.0/8',
      'fd00::/8',
    ]);
  });

  it('still reads a bare number as a hop count', () => {
    expect(parse({ TRUST_PROXY: '2' }).TRUST_PROXY).toBe(2);
  });
});

describe('env schema: defaults', () => {
  it('defaults to trusting no proxy, JSON logs off, and info level', () => {
    const parsed = parse({});
    expect(parsed.TRUST_PROXY).toBe(0);
    expect(parsed.PORT).toBe(3000);
    expect(parsed.DATA_DIR).toBe('./.data');
    expect(parsed.NODE_ENV).toBe('development');
    expect(parsed.LOG_LEVEL).toBe('info');
  });

  it('takes configured values over its defaults', () => {
    const parsed = parse({ TRUST_PROXY: '1', PORT: '8080', NODE_ENV: 'production' });
    expect(parsed.TRUST_PROXY).toBe(1);
    expect(parsed.PORT).toBe(8080);
    expect(parsed.NODE_ENV).toBe('production');
  });
});

/**
 * `z.coerce.boolean()` is `Boolean(value)`, so EVERY non-empty string is true - 'false' and '0'
 * included. Using it here would have made `SMTP_SECURE=false` mean implicit TLS on a port that
 * expects STARTTLS, i.e. a handshake that hangs, configured by an operator who wrote the word
 * "false" and was ignored. The parse is therefore by word, and an unrecognised word is refused
 * rather than guessed at, so neither direction can be silently inverted.
 */
describe('env schema: SMTP_SECURE is boolean-ish, not Boolean()', () => {
  it.each(['false', 'FALSE', 'False', '0', 'no', 'off'])('reads %j as false', (word) => {
    expect(parse({ SMTP_SECURE: word }).SMTP_SECURE).toBe(false);
  });

  it.each(['true', 'TRUE', '1', 'yes', 'on'])('reads %j as true', (word) => {
    expect(parse({ SMTP_SECURE: word }).SMTP_SECURE).toBe(true);
  });

  it('tolerates whitespace around a real value, as the rest of the schema does', () => {
    expect(parse({ SMTP_SECURE: ' true ' }).SMTP_SECURE).toBe(true);
  });

  it.each(['ssl', 'tls', 'maybe', 'enabled'])('refuses %j rather than guessing', (word) => {
    expect(() => parse({ SMTP_SECURE: word })).toThrow();
  });

  // A word-to-boolean map written as a plain object would answer this one with
  // `Object.prototype.constructor`, which is not undefined and would be returned as the value.
  it('refuses a word that names something on Object.prototype', () => {
    expect(() => parse({ SMTP_SECURE: 'constructor' })).toThrow();
    expect(() => parse({ SMTP_SECURE: 'toString' })).toThrow();
  });
});

describe('env schema: SMTP defaults and bounds', () => {
  it('defaults to submission port 587, STARTTLS, and the placeholder From address', () => {
    const parsed = parse({});
    expect(parsed.SMTP_HOST).toBeUndefined();
    expect(parsed.SMTP_PORT).toBe(587);
    expect(parsed.SMTP_SECURE).toBe(false);
    expect(parsed.SMTP_FROM).toBe(DEFAULT_SMTP_FROM);
  });

  it('takes a configured port over the default', () => {
    expect(parse({ SMTP_PORT: '2525' }).SMTP_PORT).toBe(2525);
  });

  it.each([
    ['a port that is not a number', '25a'],
    ['port zero', '0'],
    ['a negative port', '-1'],
    ['a fractional port', '587.5'],
    ['a port above the 16-bit range', '65536'],
  ])('rejects %s', (_name, port) => {
    expect(() => parse({ SMTP_PORT: port })).toThrow();
  });
});
