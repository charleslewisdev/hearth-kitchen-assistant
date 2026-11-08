import { describe, it, expect, beforeEach } from 'vitest';
import { appRouter } from './index';
import { auth } from '../../auth';
import { resetDb } from '../../../test/db';
import { ownerWithHousehold } from '../../../test/session';
import { testContext } from '../../../test/trpc';

async function callerFor(headers: Headers) {
  const session = await auth.api.getSession({ headers });
  if (session === null) throw new Error('the fixture produced no session');
  return appRouter.createCaller(
    testContext({ session, householdId: session.session.activeOrganizationId ?? null, headers }),
  );
}

async function errorOf(call: Promise<unknown>): Promise<{ code: string; message: string } | null> {
  try {
    await call;
    return null;
  } catch (err) {
    const e = err as { code?: string; message?: string };
    return { code: e.code ?? 'UNKNOWN', message: e.message ?? '' };
  }
}

describe('shoppingList.setAmount', () => {
  let headers: Headers;

  beforeEach(async () => {
    await resetDb();
    ({ headers } = await ownerWithHousehold());
  });

  it('reads the typed amount with the ingredient parser', async () => {
    const caller = await callerFor(headers);
    const eggs = await caller.shoppingList.addItem({ text: '6 eggs' });

    const updated = await caller.shoppingList.setAmount({
      itemId: eggs.id,
      text: '1 1/2 dozen',
      seen: { quantity: 6, unit: null },
    });

    expect(updated).toMatchObject({ id: eggs.id, quantity: 1.5, unit: 'dozen' });
  });

  it('clears the amount for an empty box', async () => {
    const caller = await callerFor(headers);
    const eggs = await caller.shoppingList.addItem({ text: '6 eggs' });

    const updated = await caller.shoppingList.setAmount({
      itemId: eggs.id,
      text: '  ',
      seen: { quantity: 6, unit: null },
    });

    expect(updated).toMatchObject({ quantity: null, unit: null });
  });

  it('refuses text that is not an amount, without echoing it', async () => {
    const caller = await callerFor(headers);
    const eggs = await caller.shoppingList.addItem({ text: '6 eggs' });

    const err = await errorOf(
      caller.shoppingList.setAmount({
        itemId: eggs.id,
        text: '2 cups secretword',
        seen: { quantity: 6, unit: null },
      }),
    );

    expect(err?.code).toBe('BAD_REQUEST');
    expect(err?.message).not.toContain('secretword');
    const { items } = await caller.shoppingList.get();
    expect(items[0]).toMatchObject({ quantity: 6, unit: null });
  });

  it('refuses an over-long amount before parsing it', async () => {
    const caller = await callerFor(headers);
    const eggs = await caller.shoppingList.addItem({ text: '6 eggs' });

    const err = await errorOf(
      caller.shoppingList.setAmount({
        itemId: eggs.id,
        text: '1'.repeat(10_000),
        seen: { quantity: 6, unit: null },
      }),
    );

    expect(err?.code).toBe('BAD_REQUEST');
  });

  it('answers CONFLICT when the amount changed on another phone', async () => {
    const caller = await callerFor(headers);
    const eggs = await caller.shoppingList.addItem({ text: '6 eggs' });

    const err = await errorOf(
      caller.shoppingList.setAmount({
        itemId: eggs.id,
        text: '12',
        seen: { quantity: 4, unit: null },
      }),
    );

    expect(err?.code).toBe('CONFLICT');
  });
});
