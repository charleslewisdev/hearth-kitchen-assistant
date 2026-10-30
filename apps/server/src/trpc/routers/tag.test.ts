import { describe, it, expect, beforeEach } from 'vitest';
import { appRouter } from './index';
import { createRecipe } from '../../repo/recipes';
import { resetDb } from '../../../test/db';
import { householdWithOwner } from '../../../test/factories';
import { testContext } from '../../../test/trpc';
import { TAG_NAME_TAKEN_MESSAGE } from '../../messages';

async function codeAndMessage(call: Promise<unknown>) {
  try {
    await call;
    return null;
  } catch (err) {
    const e = err as { code?: string; message?: string };
    return { code: e.code, message: e.message };
  }
}

describe('tag router: the Tags screen', () => {
  beforeEach(resetDb);

  it('lists, refuses a clashing rename in words, colours, merges and clears unused tags', async () => {
    const { householdId } = await householdWithOwner();
    const caller = appRouter.createCaller(
      testContext({ householdId, session: { userId: 'u' } as never }),
    );
    await createRecipe(householdId, { title: 'Saag', tags: ['Indian', 'palak chicken'] });
    const [indian, palak] = await caller.tag.all();
    expect([indian?.name, palak?.name]).toEqual(['Indian', 'palak chicken']);

    expect(await codeAndMessage(caller.tag.rename({ id: palak!.id, name: 'indian' }))).toEqual({
      code: 'CONFLICT',
      message: TAG_NAME_TAKEN_MESSAGE,
    });
    await caller.tag.setColor({ id: indian!.id, color: 'amber' });
    await caller.tag.merge({ fromId: palak!.id, intoId: indian!.id });
    expect(await caller.tag.all()).toEqual([
      expect.objectContaining({ name: 'Indian', color: 'amber', uses: 1 }),
    ]);
    expect(await caller.tag.removeUnused()).toBe(0);
  });

  it('refuses a colour that is not in the palette', async () => {
    const { householdId } = await householdWithOwner();
    const caller = appRouter.createCaller(
      testContext({ householdId, session: { userId: 'u' } as never }),
    );
    await createRecipe(householdId, { title: 'Soup', tags: ['Vegan'] });
    const [vegan] = await caller.tag.all();
    expect(
      (await codeAndMessage(caller.tag.setColor({ id: vegan!.id, color: 'chartreuse' as never })))
        ?.code,
    ).toBe('BAD_REQUEST');
  });
});
