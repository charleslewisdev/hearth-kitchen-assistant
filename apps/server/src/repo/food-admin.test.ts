import { describe, it, expect, beforeEach } from 'vitest';
import { resetDb } from '../../test/db';
import { createHousehold, liftHouseholdCap } from '../../test/factories';
import { createRecipe, getRecipe } from './recipes';
import { addManualItem, getActiveList, addRecipeToList } from './shopping';
import {
  deleteAllUnusedFoods,
  deleteUnusedFood,
  listFoods,
  mergeFoods,
  renameFood,
  setFoodDepartment,
} from './foods';

async function foodNamed(householdId: string, name: string) {
  const foods = await listFoods(householdId);
  const found = foods.find((f) => f.name === name);
  if (!found) throw new Error(`no food called ${name}: ${foods.map((f) => f.name).join(', ')}`);
  return found;
}

describe('the Foods screen: listing', () => {
  beforeEach(resetDb);

  it('lists foods by name with how many recipe lines use each', async () => {
    const a = await createHousehold();
    await createRecipe(a, { title: 'One', ingredientLines: ['2 cups rice', '1 onion'] });
    await createRecipe(a, { title: 'Two', ingredientLines: ['1 cup rice'] });
    const foods = await listFoods(a);
    expect(foods.map((f) => [f.name, f.uses])).toEqual([
      ['onion', 1],
      ['rice', 2],
    ]);
  });
});

describe('the Foods screen: renaming and departments', () => {
  beforeEach(resetDb);

  it('renames a food, and every recipe shows the new name', async () => {
    const a = await createHousehold();
    const { slug } = await createRecipe(a, { title: 'Soup', ingredientLines: ['3 scallions'] });
    const scallion = await foodNamed(a, 'scallions');
    await renameFood(a, scallion.id, 'green onions');
    const recipe = await getRecipe(a, slug);
    expect(recipe?.ingredients[0]?.foodName).toBe('green onions');
    expect((await foodNamed(a, 'green onions')).normalizedName).toBe('green onion');
  });

  it('refuses a name another food already has, as a CONFLICT', async () => {
    const a = await createHousehold();
    await createRecipe(a, { title: 'Soup', ingredientLines: ['3 scallions', '1 green onion'] });
    const scallion = await foodNamed(a, 'scallions');
    await expect(renameFood(a, scallion.id, 'Green Onions')).rejects.toMatchObject({
      code: 'CONFLICT',
    });
  });

  it('sets a department, and moves unchecked list items for that food with it', async () => {
    const a = await createHousehold();
    const { id } = await createRecipe(a, { title: 'Tea', ingredientLines: ['2 bags rooibos'] });
    await addRecipeToList(a, id, 1);
    const rooibos = await foodNamed(a, 'rooibos');
    expect(rooibos.department).toBeNull();
    await setFoodDepartment(a, rooibos.id, 'Beverages');
    expect((await foodNamed(a, 'rooibos')).department).toBe('Beverages');
    const { items } = await getActiveList(a);
    expect(items.find((i) => i.foodId === rooibos.id)?.department).toBe('Beverages');
  });
});

describe('the Foods screen: merging and deleting', () => {
  beforeEach(resetDb);

  it('merges one food into another: recipes and list items move, the first is gone', async () => {
    const a = await createHousehold();
    const { slug, id } = await createRecipe(a, {
      title: 'Soup',
      ingredientLines: ['3 scallions', '2 green onions'],
    });
    await addRecipeToList(a, id, 1);
    const scallion = await foodNamed(a, 'scallions');
    const green = await foodNamed(a, 'green onions');

    await mergeFoods(a, scallion.id, green.id);

    const foods = await listFoods(a);
    expect(foods.map((f) => f.name)).toEqual(['green onions']);
    expect(foods[0]?.uses).toBe(2);
    const recipe = await getRecipe(a, slug);
    expect(recipe?.ingredients.map((i) => i.foodName)).toEqual(['green onions', 'green onions']);
    const { items } = await getActiveList(a);
    expect(items.every((i) => i.foodId === green.id)).toBe(true);
  });

  it('refuses to merge a food into itself', async () => {
    const a = await createHousehold();
    await createRecipe(a, { title: 'Soup', ingredientLines: ['1 onion'] });
    const onion = await foodNamed(a, 'onion');
    await expect(mergeFoods(a, onion.id, onion.id)).rejects.toMatchObject({ code: 'BAD_REQUEST' });
  });

  it('deletes a food nothing uses, and refuses one that is used', async () => {
    const a = await createHousehold();
    await createRecipe(a, { title: 'Soup', ingredientLines: ['1 onion'] });
    await addManualItem(a, 'paper towels');
    const onion = await foodNamed(a, 'onion');
    await expect(deleteUnusedFood(a, onion.id)).rejects.toMatchObject({ code: 'CONFLICT' });

    const towels = await foodNamed(a, 'paper towels');
    expect(await deleteUnusedFood(a, towels.id)).toBe(true);
    expect((await listFoods(a)).map((f) => f.name)).toEqual(['onion']);
    // The list item keeps its name; only the link to the food is gone.
    expect((await getActiveList(a)).items[0]?.name).toBe('paper towels');
  });

  it("cannot touch another household's foods", async () => {
    await liftHouseholdCap();
    const a = await createHousehold();
    const b = await createHousehold();
    await createRecipe(b, { title: 'Theirs', ingredientLines: ['1 onion'] });
    const theirs = await foodNamed(b, 'onion');
    await createRecipe(a, { title: 'Mine', ingredientLines: ['1 leek'] });
    const mine = await foodNamed(a, 'leek');
    await expect(renameFood(a, theirs.id, 'x')).rejects.toMatchObject({ code: 'NOT_FOUND' });
    await expect(mergeFoods(a, theirs.id, mine.id)).rejects.toMatchObject({ code: 'NOT_FOUND' });
    await expect(deleteUnusedFood(a, theirs.id)).rejects.toMatchObject({ code: 'NOT_FOUND' });
    expect((await listFoods(a)).map((f) => f.name)).toEqual(['leek']);
  });
});

describe('the Foods screen: clearing out unused foods', () => {
  beforeEach(resetDb);

  it('deletes every food no recipe uses, and only those', async () => {
    const a = await createHousehold();
    await createRecipe(a, { title: 'Soup', ingredientLines: ['1 onion'] });
    await addManualItem(a, 'paper towels');
    await addManualItem(a, 'foil');
    expect(await deleteAllUnusedFoods(a)).toBe(2);
    expect((await listFoods(a)).map((f) => f.name)).toEqual(['onion']);
    expect(await deleteAllUnusedFoods(a)).toBe(0);
  });
});
