import type { FastifyRequest } from 'fastify';
import { auth, authHeaders } from '../auth';

export async function createContext({ req }: { req: FastifyRequest }) {
  // The same headers the `/api/auth/*` route hands over, client IP included. `getSession` does
  // not consult it today, but building these two sets differently is how one of them ends up
  // trusting a header the client wrote.
  //
  // Carried on the context, not just used here, because the household router acts on Better
  // Auth's own tables through `auth.api.*`, and those endpoints authenticate from headers:
  // there is no way to hand one a session object. Built once and passed on, so the call the
  // router makes is authenticated by exactly the request that reached this server - a second
  // set assembled downstream is how the two drift.
  //
  // IT IS A CREDENTIAL TO FORWARD, AND NOTHING ELSE. No procedure may read a header off it and
  // decide anything: `session` and `householdId` below are what this app authorizes against,
  // and they are derived here, once, from a signature Better Auth checked. A header is whatever
  // the client wrote. That distinction is also what made a forged context fail - hand a
  // procedure one household's id and another's session and the Better Auth call re-derives
  // membership from these headers and refuses - and it holds only while nothing trusts the raw
  // values. It is not logged either: `REDACT_PATHS` covers `headers.cookie` at the top level of
  // a log line, not `ctx.headers.cookie`, so a logged context survives redaction today only
  // because `Headers` has no enumerable own properties. Do not log the context.
  const headers = authHeaders(req);
  const session = await auth.api.getSession({ headers });
  const householdId = session?.session.activeOrganizationId ?? null;

  // Child logger so tenancy rides on every line the request produces (D38), and derived from
  // `req.log` rather than the module-level `logger` because that is the one that carries the
  // request id. A child of the singleton would log the same fields with nothing to correlate
  // them to the access log line, which is most of the point of having a request id at all.
  const log = req.log.child({ userId: session?.user.id ?? null, householdId });

  return { session, householdId, log, headers };
}

export type Context = Awaited<ReturnType<typeof createContext>>;
