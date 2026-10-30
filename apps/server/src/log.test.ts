import { describe, it, expect } from 'vitest';
import {
  createLogger,
  noQuieterThan,
  serializeError,
  MISSING_MESSAGE,
  REDACT_PATHS,
  SECRET_KEYS,
} from './log';
import type { LevelWithSilent } from 'pino';
import { capture } from '../test/logs';

/** An error message that quotes a person, which is exactly what D38 keeps out of a log. */
const LEAKED = 'invite for relative@example.com failed';

/** Every case below builds its own logger over its own sink. */
function loggerOverSink(): {
  log: ReturnType<typeof createLogger>;
  lines: () => Record<string, unknown>[];
} {
  const { sink, lines } = capture();
  return { log: createLogger({ level: 'info', pretty: false, destination: sink }), lines };
}

describe('createLogger', () => {
  // Asserted through `headers` and `res`, not `req`: the req serializer runs first and drops
  // headers outright, so the `req.headers.*` paths can no longer be exercised. The next test
  // covers what protects `req` now.
  it('redacts cookie, authorization, and set-cookie headers', () => {
    const { sink, lines } = capture();
    const log = createLogger({ level: 'info', pretty: false, destination: sink });
    log.info(
      {
        headers: { cookie: 'better-auth.session_token=SECRET', authorization: 'Bearer SECRET' },
        res: { headers: { 'set-cookie': 'better-auth.session_token=SECRET; Path=/' } },
      },
      'request',
    );
    const line = lines()[0]!;
    const headers = line.headers as Record<string, unknown>;
    const res = (line.res as { headers: Record<string, unknown> }).headers;
    expect(headers.cookie).toBe('[Redacted]');
    expect(headers.authorization).toBe('[Redacted]');
    // Bracket-notation path, the one most likely to silently stop matching.
    expect(res['set-cookie']).toBe('[Redacted]');
    expect(JSON.stringify(line)).not.toContain('SECRET');
  });

  // Serializers run before redaction, so this, not REDACT_PATHS, is what keeps request content
  // out of the logs. The url matters most: a tRPC GET carries the recipe slug in `?input=`.
  it('reduces a logged request to method, path, and remote address', () => {
    const { sink, lines } = capture();
    const log = createLogger({ level: 'info', pretty: false, destination: sink });
    log.info(
      {
        req: {
          method: 'GET',
          url: '/trpc/recipe.get?input=%22grandmas-secret-chili%22',
          ip: '203.0.113.7',
          host: 'hearth.example',
          headers: { cookie: 'better-auth.session_token=SECRET' },
        },
      },
      'incoming request',
    );
    const line = lines()[0]!;
    expect(line.req).toEqual({
      method: 'GET',
      url: '/trpc/recipe.get',
      remoteAddress: '203.0.113.7',
    });
    expect(JSON.stringify(line)).not.toContain('grandmas-secret-chili');
    expect(JSON.stringify(line)).not.toContain('SECRET');
  });

  // Pino walks only the paths it is given, so the guarantee is top level plus one level
  // down (`body.password`), not arbitrary depth. Deep payloads stay safe by not being
  // logged at all: D38's ids-only rule is the real defense, redaction is the backstop.
  it('redacts password and token fields at the top level and one level deep', () => {
    const { sink, lines } = capture();
    const log = createLogger({ level: 'info', pretty: false, destination: sink });
    log.info({ body: { email: 'a@b.c', password: 'hunter2' }, token: 'abc123' }, 'signup');
    const line = lines()[0]!;
    expect(JSON.stringify(line)).not.toContain('hunter2');
    expect(JSON.stringify(line)).not.toContain('abc123');
  });

  it('honors the configured level', () => {
    const { sink, lines } = capture();
    const log = createLogger({ level: 'warn', pretty: false, destination: sink });
    log.info('dropped');
    log.warn('kept');
    expect(lines()).toHaveLength(1);
    expect(lines()[0]!.msg).toBe('kept');
  });

  // The pairing invariant behind REDACT_PATHS: a key listed in SECRET_KEYS is covered at
  // BOTH depths pino can reach. A derivation that emitted only one spelling would leak the
  // other silently, and A3 (SMTP_PASS) and A4 (invitation tokens) are about to add keys.
  it('redacts every secret key at both covered depths', () => {
    const { sink, lines } = capture();
    const log = createLogger({ level: 'info', pretty: false, destination: sink });
    for (const key of SECRET_KEYS) {
      log.info({ [key]: 'TOPLEVELSECRET', body: { [key]: 'NESTEDSECRET' } }, key);
    }
    expect(lines()).toHaveLength(SECRET_KEYS.length);
    const out = JSON.stringify(lines());
    expect(out).not.toContain('TOPLEVELSECRET');
    expect(out).not.toContain('NESTEDSECRET');
    expect(REDACT_PATHS).toContain('req.headers.cookie');
  });

  /**
   * A key is only redacted under the exact spelling it is listed with: pino matches literally,
   * case included. So an SMTP password needs BOTH spellings it actually occurs in - `pass`, as
   * nodemailer's transport options write it, and `SMTP_PASS`, as the env object does. Listing
   * only `pass` would leave a logged config object leaking the password in full.
   */
  it('redacts an SMTP password under the nodemailer spelling and the env one', () => {
    const { sink, lines } = capture();
    const log = createLogger({ level: 'info', pretty: false, destination: sink });
    log.info({ auth: { user: 'postmaster', pass: 'NODEMAILER-SPELLING' } }, 'transport');
    log.info({ env: { SMTP_HOST: 'smtp.example.com', SMTP_PASS: 'ENV-SPELLING' } }, 'config');
    log.info({ SMTP_PASS: 'TOP-LEVEL-SPELLING' }, 'config');
    // The shape `smtpTransportOptions` actually returns, logged under a key - which is the
    // natural thing to do when a relay will not connect. `*.pass` does not reach this depth.
    log.info({ options: { host: 'smtp.example.com', auth: { pass: 'TRANSPORT-OPTIONS' } } }, 'x');
    const out = JSON.stringify(lines());
    expect(out).not.toContain('NODEMAILER-SPELLING');
    expect(out).not.toContain('ENV-SPELLING');
    expect(out).not.toContain('TOP-LEVEL-SPELLING');
    expect(out).not.toContain('TRANSPORT-OPTIONS');
    // The non-secret fields beside them survive, so this cannot pass by dropping the object.
    expect(out).toContain('smtp.example.com');
  });

  // The same hole, for the key that signs every session cookie: `secret` does not match
  // `BETTER_AUTH_SECRET`, so the env spelling needs its own entry too.
  it('redacts the auth secret under its env spelling', () => {
    const { sink, lines } = capture();
    const log = createLogger({ level: 'info', pretty: false, destination: sink });
    log.info({ env: { BETTER_AUTH_SECRET: 'SIGNING-KEY' }, NODE_ENV: 'production' }, 'config');
    const out = JSON.stringify(lines());
    expect(out).not.toContain('SIGNING-KEY');
    expect(out).toContain('production');
  });

  // The pretty branch resolves pino-pretty in a worker thread at construction, so a missing
  // or misnamed dependency fails here rather than on a deployed box's first log line.
  it('builds the development pretty logger', () => {
    const log = createLogger({ level: 'info', pretty: true });
    expect(typeof log.info).toBe('function');
    expect(log.level).toBe('info');
  });

  // The serializer is only a guarantee if the logger actually installs it, and pino reaches an
  // error by two different routes.
  it('shapes an error whether it is logged as `err` or as the first argument', () => {
    const { sink, lines } = capture();
    const log = createLogger({ level: 'info', pretty: false, destination: sink });
    log.error({ err: new Error('LEAKY') }, 'as a key');
    log.error(new Error('LEAKY'), 'as the first argument');
    log.child({ userId: 'u1' }).error({ err: new Error('LEAKY') }, 'through a child');

    expect(lines()).toHaveLength(3);
    for (const line of lines()) expect((line.err as { type: string }).type).toBe('Error');
    expect(JSON.stringify(lines())).not.toContain('LEAKY');
  });
});

/**
 * The other half of the D38 error leak, and the half no serializer can reach.
 *
 * pino's `write` copies `err.message` straight into `msg` whenever a call passes no message
 * string - `log.error(err)` and `log.error({ err })` both - while `err` itself is reduced
 * correctly. The line then LOOKS redacted and is not, which is worse than an obvious leak.
 * So the logger supplies a message rather than letting pino reach for that one.
 */
describe('createLogger: a message is mandatory beside an error', () => {
  type Emit = (log: ReturnType<typeof createLogger>) => void;

  it.each<[string, Emit]>([
    ['a bare Error', (log) => log.error(new Error(LEAKED))],
    ['{ err } with no message', (log) => log.error({ err: new Error(LEAKED) })],
    ['an explicit undefined message', (log) => log.error({ err: new Error(LEAKED) }, undefined)],
    // Blank is missing. pino writes `"msg":""` here rather than leaking, so this one is about
    // the claim the comment makes: every line carrying an error carries a label too.
    ['an empty message', (log) => log.error({ err: new Error(LEAKED) }, '')],
    ['a whitespace-only message', (log) => log.error({ err: new Error(LEAKED) }, '   ')],
    ['another level entirely', (log) => log.warn({ err: new Error(LEAKED) })],
  ])('supplies one when the call site passes none (%s)', (_name, emit) => {
    const { log, lines } = loggerOverSink();
    emit(log);
    const line = lines()[0]!;
    expect(JSON.stringify(line)).not.toContain(LEAKED);
    // Still a usable line: the error is reduced, not dropped, and the placeholder names the
    // real defect so it can be grepped for and fixed at the call site.
    expect((line.err as { type: string }).type).toBe('Error');
    expect(line.msg).toBe(MISSING_MESSAGE);
  });

  // The hook only stands in for a message pino would have taken from the error. A call site
  // that labelled its own line keeps that label, wherever it put it.
  it.each<[string, Emit, string | undefined]>([
    [
      'a message inside the merging object, which pino honours',
      (log) => log.error({ err: new Error(LEAKED), msg: 'saving the recipe failed' }),
      'saving the recipe failed',
    ],
    [
      'a message in its own argument',
      (log) => log.error({ err: new Error(LEAKED) }, 'saving the recipe failed'),
      'saving the recipe failed',
    ],
    // Nothing pino would have leaked, so nothing to stand in for: a null or non-error `err`
    // has no message to copy, and a spurious placeholder would just be noise.
    ['a null err', (log) => log.error({ err: null }), undefined],
    ['a non-error err', (log) => log.error({ err: 'a reason, as a string' }), undefined],
    ['no error at all', (log) => log.info({ userId: 'u1' }), undefined],
    // An error with nothing to say lends nothing, so pino labels the line with its empty
    // message and this stays out of it. There is no content to keep out of `msg` here, and
    // inventing a label for a line pino already handles is not this hook's job.
    ['an error whose own message is empty', (log) => log.error({ err: new Error('') }), ''],
    ['an err object with no message at all', (log) => log.error({ err: { code: 'X' } }), undefined],
  ])('leaves %s alone', (_name, emit, expected) => {
    const { log, lines } = loggerOverSink();
    emit(log);
    const line = lines()[0]!;
    expect(line.msg).toBe(expected);
    expect(JSON.stringify(line)).not.toContain(LEAKED);
  });
});

/**
 * D38 at the point it is hardest to hold: an error's own text. The reasoning for dropping the
 * message, and what is kept instead so a production failure is still diagnosable, is on
 * serializeError itself.
 */
describe('serializeError', () => {
  it('keeps the type, the code and the frames, and drops the message', () => {
    const err = Object.assign(new Error('failed to parse ingredient "2 cups white beans"'), {
      code: 'ECONNREFUSED',
    });
    const out = serializeError(err);

    expect(out.type).toBe('Error');
    expect(out.code).toBe('ECONNREFUSED');
    expect(out.frames?.[0]).toMatch(/^at /);
    expect(Object.keys(out)).not.toContain('message');
    expect(JSON.stringify(out)).not.toContain('white beans');
  });

  // The header is removed by measuring it, not by recognising the frames, and these are the
  // cases that force that. A message's last line sits directly against the real frames, so any
  // rule of the form "a frame-shaped line is a frame" admits content: every message below ends
  // in a line the frame pattern accepts, and each one is a recipe.
  it.each([
    [
      'a parenthesised line',
      'Import failed:\nat 350 degrees (Grandmas Secret Chili)',
      ['Grandmas Secret Chili'],
    ],
    ['a line ending in :n:n', 'bad:\nat Grandmas Secret Chili line 4:12:9', ['Grandmas Secret']],
    [
      'a run of them',
      'parse failure:\nat step one (add 2 cups white beans)\nat step two (simmer the chili)',
      ['white beans', 'simmer the chili'],
    ],
    // Structural rather than pattern-based: a blank line inside the message must not be able to
    // change where the header is judged to end.
    ['one followed by a blank line', 'x:\nat a (secret-ingredient)\n', ['secret-ingredient']],
  ])('drops a multi-line message that ends in %s', (_name, message, forbidden) => {
    const out = serializeError(new Error(message));

    expect(out.frames?.length).toBeGreaterThan(0);
    for (const content of forbidden) expect(JSON.stringify(out)).not.toContain(content);
  });

  it('drops a multi-line message without letting a line of it pass as a frame', () => {
    const out = serializeError(new Error('bad step:\n  "Bake the loaf"\n  at 350F for 20 minutes'));

    expect(out.frames?.length).toBeGreaterThan(0);
    for (const frame of out.frames ?? []) expect(frame).toMatch(/:\d+:\d+\)?$|\(native\)$/);
    expect(JSON.stringify(out)).not.toContain('350F');
    expect(JSON.stringify(out)).not.toContain('Bake the loaf');
  });

  // The header is computed from `name` and `message`, so an error whose `stack` does not start
  // with one cannot be split reliably. Frames are dropped rather than guessed at, because the
  // guess would be a guess about whether user content ends up in the log.
  it('drops the frames when the header cannot be located', () => {
    const err = new Error('Grandmas Secret Chili');
    err.stack = 'handcrafted preamble\nat somewhere (Grandmas Secret Chili)';
    const out = serializeError(err);

    expect(out.type).toBe('Error');
    expect(out.frames).toBeUndefined();
    expect(JSON.stringify(out)).not.toContain('Grandmas Secret Chili');
  });

  // The useful error is usually the one a TRPCError wrapped, so the chain is followed. It is
  // also bounded, because a cause chain is attacker-influencable in principle and unbounded
  // recursion into one would be a way to write an arbitrarily large log line.
  it('follows the cause chain to a bounded depth', () => {
    const deep = new Error('four', { cause: new Error('five') });
    const err = new Error('one', {
      cause: new Error('two', { cause: new Error('three', { cause: deep }) }),
    });
    const out = serializeError(err);

    expect(out.cause?.cause?.cause).toBeDefined();
    expect(out.cause?.cause?.cause?.cause).toBeUndefined();
  });

  // A ZodError is the worst case in the codebase: `received` and `message` quote what the
  // client submitted, and the enclosing TRPCError copies that string as its own message.
  it('reduces validation issues to the field and the kind of failure', () => {
    const zodish = Object.assign(new Error('unused'), {
      issues: [
        {
          code: 'invalid_enum_value',
          received: 'brunch',
          options: ['dinner'],
          path: ['mealTypes', 0],
          message: "Invalid enum value. Expected 'dinner', received 'brunch'",
        },
      ],
    });
    const out = serializeError(zodish);

    expect(out.issues).toEqual([{ path: 'mealTypes.0', code: 'invalid_enum_value' }]);
    expect(JSON.stringify(out)).not.toContain('brunch');
  });

  // `code` is emitted on the promise that it is an enum, so anything sentence-shaped is not
  // one. Postgres puts the offending value in `detail`/`message`, never in the SQLSTATE, but
  // a library that gets this wrong should not be able to launder content through the field.
  it('drops a code that is not enum-shaped', () => {
    const wrong = Object.assign(new Error('x'), {
      code: 'duplicate key (slug)=(grandmas-secret-chili) already exists',
    });

    expect(serializeError(wrong).code).toBeUndefined();
    expect(JSON.stringify(serializeError(wrong))).not.toContain('grandmas');
  });

  // The real boundary of SAFE_TOKEN, pinned. It bounds length and forbids whitespace; it cannot
  // tell a symbol from content, and a slug is exactly the shape that passes. Since a recipe slug
  // is slugify(title), a leaked one reconstructs the title. This is why a `z.record` schema,
  // whose keys are client-supplied and land in an issue path, is not safe here.
  it('admits a slug-shaped token, which is the limit of what the check can promise', () => {
    const withCode = Object.assign(new Error('x'), { code: 'grandmas-secret-chili' });
    expect(serializeError(withCode).code).toBe('grandmas-secret-chili');

    const withPath = Object.assign(new Error('x'), {
      issues: [{ code: 'custom', path: ['pantry', 'grandmas-secret-chili'] }],
    });
    expect(serializeError(withPath).issues).toEqual([
      { path: 'pantry.grandmas-secret-chili', code: 'custom' },
    ]);
  });

  it('reports only the kind of a thrown non-object', () => {
    expect(serializeError('grandmas-secret-chili')).toEqual({ type: 'string' });
    expect(serializeError(null)).toEqual({ type: 'object' });
  });

  // A throwing accessor on `stack`, `message` or `code` would otherwise propagate out of the
  // `log.error` call itself, turning a diagnosable 4xx into an unhandled throw and losing the
  // line that was being written to explain it.
  it('reports an unserializable error rather than throwing out of the log call', () => {
    const { sink, lines } = capture();
    const log = createLogger({ level: 'info', pretty: false, destination: sink });
    const bad = new Error('LEAKY');
    Object.defineProperty(bad, 'stack', {
      get() {
        throw new Error('boom');
      },
    });

    expect(serializeError(bad)).toEqual({ type: 'Unserializable' });
    expect(() => log.error({ err: bad }, 'trpc')).not.toThrow();
    expect(lines()[0]?.err).toEqual({ type: 'Unserializable' });
  });

  it('degrades only the level of the chain that cannot be read', () => {
    const badCause = new Error('inner');
    Object.defineProperty(badCause, 'stack', {
      get() {
        throw new Error('boom');
      },
    });
    const out = serializeError(new Error('outer', { cause: badCause }));

    expect(out.type).toBe('Error');
    expect(out.frames?.length).toBeGreaterThan(0);
    expect(out.cause).toEqual({ type: 'Unserializable' });
  });
});

/**
 * The mail module needs a logger that is never quieter than `warn`, because in console mode the
 * log IS how an invitation link is delivered. The obvious `child({}, { level: 'warn' })` also
 * makes it quieter than the operator asked for, which is what these cases pin: at `info` it
 * swallowed the one line confirming an SMTP relay had been configured.
 */
describe('noQuieterThan', () => {
  it.each([
    ['trace', 'trace'],
    ['debug', 'debug'],
    ['info', 'info'],
  ] as const)('keeps %j, which is more verbose than the floor', (level, expected) => {
    expect(noQuieterThan(level, 'warn')).toBe(expected);
  });

  it.each(['warn', 'error', 'fatal'] as const)('raises %j to the floor', (level) => {
    expect(noQuieterThan(level, 'warn')).toBe('warn');
  });

  // The deliberate gap: `silent` is the one unambiguous "emit nothing", and a floor that
  // overrode it would leave no way to say so.
  it('passes silent through rather than flooring it', () => {
    expect(noQuieterThan('silent', 'warn')).toBe('silent');
  });

  // pino types a logger's own `level` as a string, so an unrecognised one is reachable. The
  // floor is the safe answer: quieter than asked for, never quieter than the module needs.
  it('falls back to the floor for a level it does not recognise', () => {
    expect(noQuieterThan('verbose', 'warn')).toBe('warn');
  });

  it('honours a floor other than warn', () => {
    expect(noQuieterThan('error', 'debug')).toBe('debug');
    expect(noQuieterThan('trace', 'debug')).toBe('trace');
  });
});

/**
 * The behaviour the helper above exists for, exercised through a real pino child rather than
 * through the level string alone, because the bug was in what pino does with that string.
 */
describe('a child logger floored with noQuieterThan', () => {
  const childOf = (level: LevelWithSilent) => {
    const { sink, lines } = capture();
    const parent = createLogger({ level, pretty: false, destination: sink });
    return { child: parent.child({}, { level: noQuieterThan(parent.level, 'warn') }), lines };
  };

  it('emits an info line when the operator asked for info', () => {
    const { child, lines } = childOf('info');
    child.info('mail will be delivered over SMTP');
    expect(lines()).toHaveLength(1);
  });

  it('still emits a warn line when the operator asked for error', () => {
    const { child, lines } = childOf('error');
    child.warn('SMTP_HOST is unset');
    expect(lines()).toHaveLength(1);
  });

  it('emits nothing at all when the operator asked for silence', () => {
    const { child, lines } = childOf('silent');
    child.warn('SMTP_HOST is unset');
    expect(lines()).toHaveLength(0);
  });
});
