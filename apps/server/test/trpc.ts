import { createLogger } from '../src/log';
import type { Context } from '../src/trpc/context';

/**
 * A context for `router.createCaller`.
 *
 * `log` defaults to a silent logger so a test that is not about logging does not have to care,
 * and is overridden through `over` by the tests that read what the middleware wrote (build that
 * one over a sink from `test/logs.ts`). The spread comes last so an override actually wins.
 *
 * Typed as the real `Context`, deliberately. A cast would hide exactly the context-shape
 * breakage that adding a field to `createContext` is supposed to surface.
 */
export function testContext(over: Partial<Context> = {}): Context {
  return {
    session: null,
    householdId: null,
    log: createLogger({ level: 'silent', pretty: false }),
    // Empty by default, which says the same thing `session: null` does: this caller carries no
    // credential. A test whose procedure reaches Better Auth has to pass the real ones.
    headers: new Headers(),
    ...over,
  };
}
