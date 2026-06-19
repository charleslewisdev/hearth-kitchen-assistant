import { initTRPC, TRPCError } from '@trpc/server';
import type { Context } from './context';

const t = initTRPC.context<Context>().create();

export const router = t.router;
export const publicProcedure = t.procedure;

export const protectedProcedure = t.procedure.use(({ ctx, next }) => {
  if (!ctx.session) throw new TRPCError({ code: 'UNAUTHORIZED' });
  if (!ctx.householdId) throw new TRPCError({ code: 'FORBIDDEN', message: 'No active household' });
  return next({ ctx: { ...ctx, householdId: ctx.householdId, session: ctx.session } });
});
