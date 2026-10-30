import { describe, it, expect, beforeEach } from 'vitest';
import { appRouter } from './index';
import { createRecipe } from '../../repo/recipes';
import { resetDb } from '../../../test/db';
import { householdWithOwner } from '../../../test/factories';
import { testContext } from '../../../test/trpc';
import { FOOD_NAME_TAKEN_MESSAGE } from '../../messages';

async function codeAndMessage(call: Promise<unknown>) {
  try {
    await call;
    return null;
  } catch (err) {
    const e = err as { code?: string; message?: string };
    return { code: e.code, message: e.message };
  }
}

describe('food router: the Foods screen', () => {
  beforeEach(resetDb);

  it('lists, renames with a clash refused in words, files and merges', async () => {
    const { householdId } = await householdWithOwner();
    const caller = appRouter.createCaller(
      testContext({ householdId, session: { userId: 'u' } as never }),
    );
    await createRecipe(householdId, { title: 'Soup', ingredientLines: ['3 scallions', '1 leek'] });
    const [leek, scallion] = await caller.food.all();
    expect([leek?.name, scallion?.name]).toEqual(['leek', 'scallions']);

    expect(await codeAndMessage(caller.food.rename({ id: scallion!.id, name: 'Leeks' }))).toEqual({
      code: 'CONFLICT',
      message: FOOD_NAME_TAKEN_MESSAGE,
    });
    await caller.food.setDepartment({ id: leek!.id, department: 'Produce' });
    await caller.food.merge({ fromId: scallion!.id, intoId: leek!.id });
    expect(await caller.food.all()).toEqual([
      expect.objectContaining({ name: 'leek', department: 'Produce', uses: 2 }),
    ]);
  });

  it('refuses a department that is not one of the eight', async () => {
    const { householdId } = await householdWithOwner();
    const caller = appRouter.createCaller(
      testContext({ householdId, session: { userId: 'u' } as never }),
    );
    await createRecipe(householdId, { title: 'Soup', ingredientLines: ['1 leek'] });
    const [leek] = await caller.food.all();
    expect(
      (await codeAndMessage(caller.food.setDepartment({ id: leek!.id, department: 'Garden' })))
        ?.code,
    ).toBe('BAD_REQUEST');
  });
});
