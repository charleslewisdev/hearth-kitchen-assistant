import type { FastifyRequest } from 'fastify';
import { auth } from '../auth';

export async function createContext({ req }: { req: FastifyRequest }) {
  const headers = new Headers();
  for (const [k, v] of Object.entries(req.headers)) {
    if (typeof v === 'string') headers.set(k, v);
  }
  const session = await auth.api.getSession({ headers });
  const householdId = session?.session.activeOrganizationId ?? null;
  return { session, householdId };
}

export type Context = Awaited<ReturnType<typeof createContext>>;
