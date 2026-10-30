import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { router, publicProcedure, protectedProcedure } from './trpc';
import { createLogger, type LoggedError } from '../log';
import { buildServer } from '../server';
import { capture } from '../../test/logs';
import { testContext } from '../../test/trpc';
import { signUpWithHousehold } from '../../test/session';
import { resetDb } from '../../test/db';

/**
 * A real pino over a sink, not a hand-rolled fake with `info`/`error` spies.
 *
 * A fake proves a method was called. It cannot prove the thing that actually matters here: that
 * the JSON a log processor receives is well formed, that the level is the one an alert would
 * fire on, and above all that the `err` serializer ran. The serializer is the entire privacy
 * guarantee of this feature, and it lives in the logger, so a test that swaps the logger out
 * tests everything except the part that can leak.
 */
function captureLogger() {
  const { sink, lines } = capture();
  return { log: createLogger({ level: 'info', pretty: false, destination: sink }), lines };
}

const trpcLines = (lines: () => Record<string, unknown>[]) =>
  lines().filter((l) => l.msg === 'trpc');

describe('tRPC logging middleware', () => {
  it('logs path, type, duration and ok=true for a successful call', async () => {
    const { log, lines } = captureLogger();
    const r = router({ ping: publicProcedure.query(() => 'pong') });
    await r.createCaller(testContext({ log })).ping();

    const line = trpcLines(lines)[0];
    expect(line).toMatchObject({ path: 'ping', type: 'query', ok: true, level: 30 });
    expect(typeof line?.durationMs).toBe('number');
  });

  // Deliberately `>= 0`, not `> 0`. A no-op procedure resolves in well under the 0.01ms the
  // value is rounded to, so it legitimately reports 0 about half the time; asserting `> 0`
  // here was a coin flip. What the field must never be is absent or negative, which is what
  // this pins. The clock choice itself is argued in trpc.ts and is not testable from here:
  // no assertion distinguishes the two clocks without a timing band that would flake worse
  // than the thing it protects. The 20ms case below is the real signal that the number moves.
  it('reports a duration for a procedure too fast to measure in whole milliseconds', async () => {
    const { log, lines } = captureLogger();
    const r = router({ instant: publicProcedure.query(() => 'x') });
    await r.createCaller(testContext({ log })).instant();

    const durationMs = trpcLines(lines)[0]?.durationMs as number;
    expect(typeof durationMs).toBe('number');
    expect(durationMs).toBeGreaterThanOrEqual(0);
  });

  it('reports the time a slow procedure actually took', async () => {
    const { log, lines } = captureLogger();
    const r = router({
      slow: publicProcedure.query(() => new Promise((resolve) => setTimeout(resolve, 20))),
    });
    await r.createCaller(testContext({ log })).slow();

    expect(trpcLines(lines)[0]?.durationMs as number).toBeGreaterThanOrEqual(15);
  });

  it('logs ok=false at error level when a procedure throws', async () => {
    const { log, lines } = captureLogger();
    const r = router({
      boom: publicProcedure.query(() => {
        throw new Error('nope');
      }),
    });
    await expect(r.createCaller(testContext({ log })).boom()).rejects.toThrow();

    const line = trpcLines(lines)[0];
    expect(line).toMatchObject({ path: 'boom', ok: false, level: 50 });
    expect(line?.err).toMatchObject({ type: 'TRPCError', code: 'INTERNAL_SERVER_ERROR' });
  });

  // An unauthenticated poll is a normal event, not an incident. Logging every 401 at `error`
  // buries the 500s that are, so the level follows the HTTP status the client will see.
  // This also proves `protectedProcedure` is built on `publicProcedure`: nothing else would
  // have logged a line for a call that never reached a resolver.
  it('logs a client error at warn so real failures stay findable', async () => {
    const { log, lines } = captureLogger();
    const r = router({ mine: protectedProcedure.query(() => 'x') });
    await expect(r.createCaller(testContext({ log })).mine()).rejects.toThrow();

    const line = trpcLines(lines)[0];
    expect(line).toMatchObject({ path: 'mine', ok: false, level: 40 });
    expect(line?.err).toMatchObject({ type: 'TRPCError', code: 'UNAUTHORIZED' });
  });

  // D38: the input is the payload of a recipe mutation. It never reaches a log line.
  it('never logs the procedure input', async () => {
    const { log, lines } = captureLogger();
    const r = router({
      create: publicProcedure.input(z.object({ title: z.string() })).mutation(() => null),
    });
    await r.createCaller(testContext({ log })).create({ title: 'Grandmas Secret Chili' });

    // The line has to exist first. "The input is absent" is trivially true of a log nobody
    // wrote, so without this the test would pass with the middleware deleted.
    expect(trpcLines(lines)[0]).toMatchObject({ path: 'create', ok: true });
    expect(JSON.stringify(lines())).not.toContain('Grandmas Secret Chili');
  });
});

/**
 * The unit tests above hand the middleware a context they built. These prove the wiring that
 * only exists in a real request: that `createContext` derives its child from `req.log` (so the
 * request id survives) and binds the real tenancy ids, and that a rejected recipe mutation logs
 * nothing the user typed.
 */
describe('tRPC logging over a real request', () => {
  let server: FastifyInstance;
  let lines: () => Record<string, unknown>[];
  let cookie: string;
  let userId: string;
  let householdId: string;

  beforeAll(async () => {
    await resetDb();
    const captured = capture();
    lines = captured.lines;
    server = await buildServer({
      logger: createLogger({ level: 'info', pretty: false, destination: captured.sink }),
    });
    ({ cookie, userId, householdId } = await signUpWithHousehold(server, 'log@test.dev'));
  });

  afterAll(async () => {
    await server.close();
  });

  // Every line this request wrote, found the way an operator finds them: by the id echoed on
  // the response. That the tRPC line is in here at all is the proof that the child logger came
  // from `req.log` rather than the module-level singleton, which carries no request id.
  const linesFor = (res: { headers: Record<string, unknown> }) =>
    lines().filter((l) => l.reqId === res.headers['x-request-id']);

  const createRecipe = (payload: unknown) =>
    server.inject({
      method: 'POST',
      url: '/trpc/recipe.create',
      payload: payload as object,
      headers: { 'content-type': 'application/json', cookie },
    });

  it('binds the request id and the tenancy ids onto every tRPC line', async () => {
    const res = await createRecipe({ title: 'White Bean Soup', servings: 4 });
    expect(res.statusCode).toBe(200);

    const mine = linesFor(res);
    expect(mine.find((l) => l.msg === 'incoming request')).toBeDefined();
    const line = mine.find((l) => l.msg === 'trpc');
    expect(line).toMatchObject({
      path: 'recipe.create',
      type: 'mutation',
      ok: true,
      level: 30,
      userId,
      householdId,
    });
    // The title is a recipe's single most identifying piece of content (D38).
    expect(JSON.stringify(mine)).not.toContain('White Bean Soup');
  });

  // The concrete leak this feature had to close. A ZodError's `message` is its stringified
  // issue list, and for an enum that list quotes what the client sent; the TRPCError wrapping
  // it copies that whole string as its own message. Pino's default `err` serializer would emit
  // both verbatim. C1/C2's import parsers make this worse, not better.
  it('logs a rejected recipe input without the values the user submitted', async () => {
    const res = await createRecipe({ title: 'Grandmas Secret Chili', mealTypes: ['brunch'] });
    expect(res.statusCode).toBe(400);

    const mine = linesFor(res);
    const line = mine.find((l) => l.msg === 'trpc');
    expect(line).toMatchObject({
      path: 'recipe.create',
      ok: false,
      level: 40,
      userId,
      householdId,
    });

    // What survives is enough to debug it: the code, the failing field, and the frames.
    const err = line?.err as LoggedError;
    expect(err.type).toBe('TRPCError');
    expect(err.code).toBe('BAD_REQUEST');
    expect(err.cause?.type).toBe('ZodError');
    expect(err.cause?.issues).toContainEqual({ path: 'mealTypes.0', code: 'invalid_enum_value' });
    expect(err.frames?.length).toBeGreaterThan(0);

    // What does not survive is anything the user typed, at any depth of the cause chain.
    const serialized = JSON.stringify(mine);
    expect(serialized).not.toContain('Grandmas Secret Chili');
    expect(serialized).not.toContain('brunch');
    expect(Object.keys(err)).not.toContain('message');
    expect(Object.keys(err.cause ?? {})).not.toContain('message');
  });
});
