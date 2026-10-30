import { initTRPC, TRPCError } from '@trpc/server';
import { getHTTPStatusCodeFromError } from '@trpc/server/http';
import type { Context } from './context';

const t = initTRPC.context<Context>().create();

export const router = t.router;

/**
 * One line per call, on the request's own child logger, so it inherits the request id and the
 * tenancy ids from the context.
 *
 * The line is ids and shape only: never the input, which is where recipe titles, ingredient
 * text and account details live (D38). `err` is safe to pass raw because the logger's `err`
 * serializer strips it down to type, code, issue paths and stack frames; see log.ts for why
 * the message does not survive that.
 *
 * The level follows the HTTP status the client will see, rather than being `error` for every
 * rejection. An unauthenticated poll or a 404 is a normal event, and logging those at `error`
 * would bury the 500s that are not. `getHTTPStatusCodeFromError` is tRPC's own mapping, so a
 * code added upstream lands on the right side of the split without this needing to know it.
 */
const loggingMiddleware = t.middleware(async ({ ctx, path, type, next }) => {
  // Monotonic and sub-millisecond. `Date.now()` could go backwards across a clock adjustment
  // on a long-lived process, and its whole-millisecond floor erases the calls that never reach
  // Postgres: a rejected input is decided by Zod alone and lands well under 1ms, so it would
  // read `0` next to a slow query's `40` with nothing in between.
  //
  // This times the procedure, not the request: context creation runs before any middleware, so
  // the session lookup it does is not in here. Fastify's own `request completed` line carries
  // the whole-request `responseTime`, under the same request id.
  const started = performance.now();
  const result = await next();
  const durationMs = Math.round((performance.now() - started) * 100) / 100;
  const line = { path, type, durationMs, ok: result.ok };

  if (result.ok) ctx.log.info(line, 'trpc');
  else if (getHTTPStatusCodeFromError(result.error) >= 500)
    ctx.log.error({ ...line, err: result.error }, 'trpc');
  else ctx.log.warn({ ...line, err: result.error }, 'trpc');

  return result;
});

export const publicProcedure = t.procedure.use(loggingMiddleware);

/**
 * What a session with no household behind it is told.
 *
 * Named rather than left inline because migration 0006 turned it into the answer a REMOVED
 * member gets. A membership that ends clears the household off that person's sessions, so this
 * is the sentence their next request to any router meets, and the tests that prove the hole is
 * shut have to assert on it rather than on "rejected". It stays server-side: the client already
 * distinguishes the two FORBIDDEN cases by `NOT_A_MEMBER_MESSAGE` (messages.ts), and this one
 * is the state it renders `<Onboarding />` for.
 */
export const NO_ACTIVE_HOUSEHOLD_MESSAGE = 'No active household';

// Built on `publicProcedure`, not on `t.procedure`: otherwise a rejected protected call, which
// is every unauthenticated request the app receives, would log nothing at all.
export const protectedProcedure = publicProcedure.use(({ ctx, next }) => {
  if (!ctx.session) throw new TRPCError({ code: 'UNAUTHORIZED' });
  if (!ctx.householdId)
    throw new TRPCError({ code: 'FORBIDDEN', message: NO_ACTIVE_HOUSEHOLD_MESSAGE });
  return next({ ctx: { ...ctx, householdId: ctx.householdId, session: ctx.session } });
});
