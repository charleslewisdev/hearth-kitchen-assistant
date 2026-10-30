import {
  levels as pinoLevels,
  pino,
  type DestinationStream,
  type Level,
  type LevelWithSilent,
  type LogFn,
  type Logger,
} from 'pino';
import { env } from './env';

/**
 * Keys that may carry a credential. Each one is redacted at both depths pino can reach
 * (see REDACT_PATHS), so adding a key here is enough. Hand-listing the two spellings is
 * how you get a key that is covered at one depth and silently leaks at the other.
 *
 * A key is listed under every spelling it actually OCCURS in, because pino matches paths
 * literally and case-sensitively - `secret` does not cover `BETTER_AUTH_SECRET`, and `pass`
 * does not cover `SMTP_PASS`. That is why the SCREAMING_SNAKE env names appear here beside
 * the ordinary ones: `pass` is how nodemailer's transport options spell the SMTP password,
 * and `SMTP_PASS` is how the env object does. A config object logged with only the first
 * listed would leak the password in full, which is not hypothetical - the mail layer is the
 * first thing in this codebase with a credential that arrives as configuration.
 *
 * This list is not a licence to log config objects. It is the backstop for the day someone
 * does.
 */
export const SECRET_KEYS = [
  'password',
  'token',
  'secret',
  'pass',
  'SMTP_PASS',
  'BETTER_AUTH_SECRET',
] as const;

/**
 * Anything that could carry a credential or a session. Pino only walks the paths it is
 * given, so the guarantee is the top level plus TWO levels down (`password`, `body.password`,
 * `body.user.password`). Nothing deeper is covered.
 *
 * Two rather than one because of the shape the mail layer produces: `smtpTransportOptions`
 * returns `{ host, port, secure, auth: { pass } }`, so logging it under any key at all - which
 * is the natural thing to do when a relay will not connect - puts the password at
 * `options.auth.pass`, a depth that one wildcard does not reach.
 *
 * The ids-only rule (D38) is a convention the call sites keep: log recipe ids, never recipe
 * content. Redaction is the backstop for secrets, not a substitute for that.
 *
 * `err` IS NOT COVERED BY REDACTION EITHER. No redact path reaches inside a message or a
 * stack, so errors are handled by replacing pino's serializer outright: see serializeError.
 */
export const REDACT_PATHS = [
  'req.headers.cookie',
  'req.headers.authorization',
  'res.headers["set-cookie"]',
  'headers.cookie',
  'headers.authorization',
  ...SECRET_KEYS.flatMap((key) => [key, `*.${key}`, `*.*.${key}`]),
];

/**
 * The ids-only rule (D38) enforced on the one object logged for every single request.
 *
 * Fastify's default `req` serializer emits `url` verbatim, query string included, and that is
 * not a neutral string here: httpBatchLink sends tRPC queries as GET with the procedure input
 * in `?input=`, and a recipe slug is slugify(title). Logging the raw url logs recipe titles at
 * info level on the hot path. So the url is cut at the `?`.
 *
 * `host` and `version` (from `accept-version`) are dropped as well: both are client-controlled
 * and neither tells you anything the route and the request id do not.
 *
 * Serializers run BEFORE redaction, so this is what actually keeps headers out of `req` - the
 * `req.headers.*` entries in REDACT_PATHS above cannot fire once this runs, and stay only as a
 * backstop should this serializer ever be removed. Fastify merges the instance's serializers
 * over its own defaults, which is what lets this one win.
 */
function serializeRequest(req: { method?: string; url?: string; ip?: string }): {
  method: string | undefined;
  url: string | undefined;
  remoteAddress: string | undefined;
} {
  const { url } = req;
  const queryAt = url === undefined ? -1 : url.indexOf('?');
  return {
    method: req.method,
    url: queryAt === -1 ? url : url?.slice(0, queryAt),
    remoteAddress: req.ip,
  };
}

/** What an error is allowed to become in a log line. Note the absence of `message`. */
export type LoggedError = {
  /** Constructor name (`TRPCError`, `ZodError`, `DatabaseError`), or `typeof` for a non-object. */
  type: string;
  /** A short enum-shaped code: a tRPC code, a pg SQLSTATE, a Node `ECONNREFUSED`. */
  code?: string;
  /** Schema validation failures, reduced to which field failed and how. */
  issues?: { path: string; code: string }[];
  /** `err.stack` with its message header removed, leaving only code locations. */
  frames?: string[];
  cause?: LoggedError;
};

/**
 * A bound on the shape of a field that is supposed to hold a symbol: at most 64 characters,
 * no whitespace, no quotes or brackets. That is all it promises, and the limit is worth being
 * precise about, because two comments below depend on it.
 *
 * It rejects prose, so a sentence that was handed to a field meant for an enum is dropped
 * rather than logged. It CANNOT distinguish a symbol from content, because a single token is
 * indistinguishable from a short value: `grandmas-secret-chili` passes. Recipe slugs are
 * slugify(title), so a leaked slug reconstructs the title. Anything routed through this check
 * must therefore be a field that only ever holds authored identifiers.
 */
const SAFE_TOKEN = /^[A-Za-z0-9_.:-]{1,64}$/;

/** Bounds, so one pathological error cannot write a megabyte into the log. */
const MAX_FRAMES = 20;
const MAX_ISSUES = 20;
const MAX_CAUSE_DEPTH = 3;

/**
 * A stack line as V8 writes it: `at fn (file:line:col)`, `at file:line:col`, `at fn (native)`.
 *
 * This is a second filter over text the header has already been removed from, NOT the thing
 * that finds the frames. It cannot be that: `at 350 degrees (Grandmas Secret Chili)` matches
 * this pattern and is a recipe, so a rule of the form "a frame-shaped line is a frame" admits
 * content whenever a message ends in one. stripHeader is what actually holds the line.
 */
const STACK_FRAME = /^at (?:\S.* \(.+\)|.+:\d+:\d+)$/;

/**
 * `err.stack` with its header removed, or null when the header cannot be located.
 *
 * V8 writes the stack as `${name}: ${message}` followed by the frames, so the header is not
 * something to be recognised: its length is computable from the error itself, and slicing
 * exactly that many characters leaves frames and nothing else, whatever the message contained.
 * That is the whole reason to do it by measurement. A message is often many lines (a ZodError's
 * is pretty-printed JSON), its last line sits directly against the real frames, and a line of
 * prose can be frame-shaped, so no amount of pattern-matching separates them reliably.
 *
 * Only two candidates, and deliberately not a bare `name`. A bare `name` would match precisely
 * when `${name}: ${message}` did not, which is the case where `message` was reassigned after
 * the stack was captured, and it would then strip `Error` and leave the stale message behind.
 * Failing to find a header is the safer outcome there.
 */
function stripHeader(stack: string, name: unknown, message: unknown): string | null {
  const msg = typeof message === 'string' ? message : '';
  const nm = typeof name === 'string' ? name : '';
  const candidates = [msg === '' ? nm : `${nm}: ${msg}`, msg].filter((c) => c !== '');
  for (const header of candidates) {
    if (stack.startsWith(header)) return stack.slice(header.length);
  }
  return null;
}

/**
 * The frames, with the message header removed by measurement.
 *
 * When the header cannot be located (a library that overwrote `stack`, a `message` reassigned
 * after capture) the frames are dropped rather than guessed at. `type`, `code` and `issues`
 * still identify the failure, and a guess here would be a guess about whether the log now
 * contains user content.
 */
function stackFrames(stack: string, name: unknown, message: unknown): string[] {
  const body = stripHeader(stack, name, message);
  if (body === null) return [];
  return body
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => STACK_FRAME.test(l))
    .slice(0, MAX_FRAMES);
}

/**
 * Zod issues reduced to `{ path, code }`. The rest of an issue is unsafe: `message` and
 * `received` quote what the client sent (`invalid_enum_value` renders as "received 'brunch'"),
 * which for a recipe mutation is the user's own content.
 *
 * A path segment is a schema field name, so it is authored rather than submitted. The exception
 * is a `z.record` key, which is client-supplied and lands in the path verbatim. SAFE_TOKEN does
 * NOT make that safe: a key is a single token, which is exactly what the check admits. No schema
 * here uses `z.record` today, so this is latent.
 *
 * DO NOT add a `z.record` (or any schema whose keys come from the request) without revisiting
 * this. Such a path would have to be reduced to its authored prefix, or dropped.
 */
function serializeIssues(issues: unknown[]): { path: string; code: string }[] {
  return issues.slice(0, MAX_ISSUES).map((raw) => {
    const issue = raw as { path?: unknown; code?: unknown };
    // `?` for a segment that cannot be represented, and for a path that is not one at all, so
    // there is a single sentinel to recognise rather than one per failure mode.
    const path = Array.isArray(issue.path)
      ? issue.path
          .map((seg: unknown) =>
            typeof seg === 'number' || (typeof seg === 'string' && SAFE_TOKEN.test(seg))
              ? String(seg)
              : '?',
          )
          .join('.')
      : '?';
    const code = typeof issue.code === 'string' && SAFE_TOKEN.test(issue.code) ? issue.code : '?';
    return { path, code };
  });
}

/**
 * D38 applied to errors: the message is dropped, everything else that identifies the failure
 * is kept. This replaces pino's default `err` serializer, so it governs the `err` FIELD of
 * every line in the app, not just the tRPC middleware that logs the most of them.
 *
 * It does NOT govern `msg`, and that distinction is the whole of D38's last hole. pino copies
 * `err.message` into `msg` whenever a call site passes no message string of its own, before any
 * serializer runs and where no serializer could reach. A message string is therefore mandatory
 * at every `err` call site - and mandatory is enforced by requireMessage() below rather than
 * asked for here, because this comment previously claimed a guarantee it did not have.
 *
 * Why the message goes. It is the one field on an error that routinely quotes its input, and
 * nothing at runtime distinguishes an author-written literal from one that interpolated user
 * content. Three cases already exist or are one milestone away: a ZodError's message is its
 * stringified issue list, which for an enum quotes the submitted value; a TRPCError copies that
 * message verbatim when it wraps one; and C1/C2's import parsers are precisely the code that
 * throws `failed to parse ingredient "${line}"`. Redaction cannot help, because a message is
 * one opaque string. So there is no version of "keep the message" that is also ids-only.
 *
 * Why that is still debuggable on a headless box, which is the other half of the tradeoff:
 *
 *   - `frames` is the stack, minus exactly its header. A stack's frames are file, function and
 *     line numbers, which are code, not content. This is the part that tells you where a 500
 *     came from, and it is kept in full. See stripHeader for why "exactly" is load-bearing.
 *   - `code` carries the discriminator that free text usually only restates: `BAD_REQUEST`,
 *     pg's `23505` (unique violation), Node's `ECONNREFUSED` on a failed startup.
 *   - `issues` names the field a validation failure rejected.
 *   - `cause` is followed, because the interesting error is usually the one a TRPCError wrapped.
 *
 * What is genuinely lost is a driver's free-text detail, e.g. which constraint `23505` hit. The
 * mitigation is that the request id on the same line ties it to the response the caller saw,
 * and tRPC does return the message to that caller. So the detail is recoverable by asking,
 * which is a fair price for it not being written into a file that outlives the request.
 */
export function serializeError(err: unknown, depth = 0): LoggedError {
  try {
    return describeError(err, depth);
  } catch {
    // `stack`, `message` and `code` are all readable as accessors, and an accessor can throw.
    // Uncaught, that propagates out of the `log.error` call itself, which inside the tRPC
    // middleware turns a diagnosable 4xx into an unhandled throw and loses the very line that
    // was being written to explain it. Caught per level, so one bad link in a cause chain
    // costs only its own entry.
    return { type: 'Unserializable' };
  }
}

function describeError(err: unknown, depth: number): LoggedError {
  // A thrown non-object (a string, most often) has nowhere safe to put its value, so only its
  // kind is reported.
  if (typeof err !== 'object' || err === null) return { type: typeof err };

  const e = err as {
    constructor?: { name?: string };
    name?: unknown;
    message?: unknown;
    code?: unknown;
    stack?: unknown;
    issues?: unknown;
    cause?: unknown;
  };
  const out: LoggedError = { type: e.constructor?.name ?? 'Object' };

  if (typeof e.code === 'string' && SAFE_TOKEN.test(e.code)) out.code = e.code;
  if (Array.isArray(e.issues)) out.issues = serializeIssues(e.issues);
  if (typeof e.stack === 'string') {
    // `name` and `message` are read to measure the header, never to emit it.
    const frames = stackFrames(e.stack, e.name, e.message);
    if (frames.length > 0) out.frames = frames;
  }
  if (e.cause != null && depth < MAX_CAUSE_DEPTH) out.cause = serializeError(e.cause, depth + 1);

  return out;
}

/**
 * What `msg` says when a call site logged an error and gave no message of its own.
 *
 * Deliberately about the call site rather than about the error: the line it appears on has a
 * fully serialized `err`, so what is missing is the human label, and this is what to grep for
 * to find the call that needs one.
 */
export const MISSING_MESSAGE = 'error logged without a message';

/**
 * The message pino would put in `msg` by reaching into the error, or undefined when it would
 * not reach for one at all.
 *
 * A transcription of `pino/lib/proto.js` `write()`, which has exactly two such branches: a bare
 * Error becomes `{ err }` and lends its message unconditionally, while a merging object lends
 * `err.message` only when the object carries no `msg` of its own. Anything else - a null `err`,
 * an `err` that is a string, an object with a `msg` already - is a line pino labels correctly
 * and this must not interfere with.
 */
function borrowedErrorMessage(first: unknown): string | undefined {
  const err: unknown = first instanceof Error ? first : readErrForMessage(first);
  if (typeof err !== 'object' || err === null) return undefined;
  const message = (err as { message?: unknown }).message;
  return typeof message === 'string' && message !== '' ? message : undefined;
}

function readErrForMessage(first: unknown): unknown {
  if (typeof first !== 'object' || first === null) return undefined;
  const obj = first as Record<string, unknown>;
  // pino's default `messageKey`. A `msg` on the merging object is the call site's own label,
  // and pino keeps it, so borrowing from the error would be pino's behaviour AND this hook's
  // only in the case where the call site gave nothing.
  return obj.msg === undefined ? obj.err : undefined;
}

/**
 * The enforcement half of D40.
 *
 * pino copies `err.message` into `msg` whenever a call site gives no message of its own, which
 * is how `log.error(err)` and `log.error({ err })` both put a raw message into `msg` while the
 * `err` beside it is correctly reduced. The line then LOOKS redacted and is not, which is worse
 * than an obvious leak. Fastify's own error handler did exactly this, in the one route where
 * email addresses live.
 *
 * So the message is supplied here when the call site did not: the leak becomes impossible
 * rather than forbidden. A lint rule or a wrapper would each cover only the call sites written
 * to expect them, and this bug was already documented-but-not-enforced once.
 *
 * Blank counts as missing on the CALL SITE's side, as it does for configuration (see env.ts):
 * `log.error({ err }, '')` does not leak, but it does throw away a label this can supply. The
 * promise is therefore precise: a message pino would have borrowed from an error never reaches
 * `msg`, and the line that would have carried it is labelled instead. A line pino already
 * labels correctly - including an error with an empty message, which lends nothing - is left
 * exactly as pino wrote it.
 */
function requireMessage(args: Parameters<LogFn>): Parameters<LogFn> {
  const [first, message] = args as [unknown, unknown];
  const given = typeof message === 'string' ? message.trim() !== '' : message !== undefined;
  if (given || borrowedErrorMessage(first) === undefined) return args;
  return [first, MISSING_MESSAGE] as unknown as Parameters<LogFn>;
}

/**
 * Three output branches, in precedence order:
 *   1. `destination` wins whenever it is set, including over `pretty` - tests pass a sink here.
 *   2. `pretty` uses the pino-pretty transport, for local development.
 *   3. otherwise, newline-delimited JSON on stdout, which is what a deployed box gets.
 */
export function createLogger(opts: {
  level: LevelWithSilent;
  pretty: boolean;
  destination?: DestinationStream;
}): Logger {
  const base = {
    level: opts.level,
    redact: { paths: REDACT_PATHS, censor: '[Redacted]' },
    // Keyed, and the key matters: pino runs a serializer only on a top-level property of that
    // exact name. `log.error({ error: e })` or `{ cause: e }` bypasses this and emits `{}`,
    // because an Error's own properties are non-enumerable. That fails safe but silently, so
    // an error goes under `err` or it does not go in the log at all.
    serializers: { req: serializeRequest, err: serializeError },
    // Inherited by child loggers, which is what makes it hold for Fastify's per-request logger
    // and for the tRPC middleware's, not just for direct calls on this one.
    hooks: {
      logMethod(this: Logger, args: Parameters<LogFn>, method: LogFn): void {
        method.apply(this, requireMessage(args));
      },
    },
  };
  if (opts.destination) return pino(base, opts.destination);
  if (opts.pretty) {
    return pino({
      ...base,
      transport: { target: 'pino-pretty', options: { colorize: true, translateTime: 'HH:MM:ss' } },
    });
  }
  return pino(base);
}

/**
 * The level a child logger needs so that it is never QUIETER than `floor`, and never quieter
 * than the operator asked for either.
 *
 * The naive spelling is `child({}, { level: 'warn' })`, and it is wrong in one direction that
 * is easy to miss: a pino child's level replaces its parent's rather than bounding it, so that
 * child is silent at `info` too. Measured against a real container: with `LOG_LEVEL=info` and
 * SMTP configured, the mail module's one `info` line - the only confirmation an operator gets
 * that their relay settings were read - was never emitted.
 *
 * `silent` passes through, because it is the one unambiguous "emit nothing" and a floor that
 * overrode it would make the level meaningless. An unrecognised level yields the floor: this
 * takes `string` because pino types a logger's own `level` that way, and the alternative to a
 * guess is a throw at import time on a logger that is otherwise working.
 */
export function noQuieterThan(level: string, floor: Level): LevelWithSilent {
  if (level === 'silent') return 'silent';
  const values = pinoLevels.values;
  const chosen = values[level];
  // Lower number, more verbose: trace is 10 and fatal is 60.
  return chosen !== undefined && chosen <= values[floor]! ? (level as Level) : floor;
}

/**
 * Silent under test so the suite stays quiet at the source. Doing this by level rather than by
 * Fastify's `disableRequestLogging` also covers the lines Fastify does not gate: the default
 * error handler's, and the per-call tRPC lines Task 3 adds. A test that wants to read log
 * output builds its own logger over a sink and injects it, rather than reaching for this one.
 */
export const logger = createLogger({
  level: env.NODE_ENV === 'test' ? 'silent' : env.LOG_LEVEL,
  pretty: env.NODE_ENV === 'development',
});
