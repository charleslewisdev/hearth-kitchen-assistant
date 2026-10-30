import { describe, it, expect, beforeEach } from 'vitest';
import { and, eq, asc } from 'drizzle-orm';
import { departmentFor } from '@hearth/shared';
import { resetDb } from '../../test/db';
import { createHousehold, liftHouseholdCap } from '../../test/factories';
import { recipe, recipeIngredient, recipeStep, tag, recipeTags, food } from '../db/schema';
import { withHousehold } from './tenant';
import {
  createRecipe,
  getRecipe,
  updateRecipe,
  deleteRecipe,
  searchRecipes,
  listTagCounts,
  listSourceNames,
  TAG_CHIP_LIMIT,
  type SearchRecipesParams,
} from './recipes';

describe('recipe repository (structured create)', () => {
  beforeEach(async () => {
    await resetDb();
  });

  it('creates a recipe with ingredients (mapped to foods), ordered steps, and tags', async () => {
    const a = await createHousehold();

    const { id, slug } = await createRecipe(a, {
      title: 'Simple Tomato Pasta',
      servings: 4,
      mealTypes: ['dinner'],
      tags: ['Quick', 'Vegetarian'],
      ingredientLines: ['2 cups flour', '3 tomatoes, chopped', '1 tsp salt'],
      steps: ['Boil the pasta', 'Make the sauce', 'Combine and serve'],
    });

    expect(slug).toBe('simple-tomato-pasta');

    const [row] = await withHousehold(a, (tx) => tx.select().from(recipe).where(eq(recipe.id, id)));
    expect(row).toBeDefined();
    expect(row!.title).toBe('Simple Tomato Pasta');
    expect(row!.servings).toBe(4);
    expect(row!.mealTypes).toEqual(['dinner']);
    expect(row!.householdId).toBe(a);

    const ingredients = await withHousehold(a, (tx) =>
      tx
        .select()
        .from(recipeIngredient)
        .where(eq(recipeIngredient.recipeId, id))
        .orderBy(asc(recipeIngredient.position)),
    );
    expect(ingredients).toHaveLength(3);
    // positions are contiguous and in input order.
    expect(ingredients.map((i) => i.position)).toEqual([0, 1, 2]);
    // each ingredient mapped to a food.
    for (const ing of ingredients) {
      expect(ing.foodId).not.toBeNull();
      expect(ing.householdId).toBe(a);
    }

    const steps = await withHousehold(a, (tx) =>
      tx
        .select()
        .from(recipeStep)
        .where(eq(recipeStep.recipeId, id))
        .orderBy(asc(recipeStep.position)),
    );
    expect(steps).toHaveLength(3);
    expect(steps.map((s) => s.position)).toEqual([0, 1, 2]);
    expect(steps.map((s) => s.text)).toEqual([
      'Boil the pasta',
      'Make the sauce',
      'Combine and serve',
    ]);

    const links = await withHousehold(a, (tx) =>
      tx.select().from(recipeTags).where(eq(recipeTags.recipeId, id)),
    );
    expect(links).toHaveLength(2);
    const tagRows = await withHousehold(a, (tx) => tx.select().from(tag));
    expect(tagRows).toHaveLength(2);
  });

  it('preserves raw_text verbatim per ingredient', async () => {
    const a = await createHousehold();
    const lines = ['2 cups all-purpose flour', '3 tomatoes, chopped', 'Salt to taste'];

    const { id } = await createRecipe(a, {
      title: 'Raw Text Recipe',
      ingredientLines: lines,
    });

    const ingredients = await withHousehold(a, (tx) =>
      tx
        .select()
        .from(recipeIngredient)
        .where(eq(recipeIngredient.recipeId, id))
        .orderBy(asc(recipeIngredient.position)),
    );
    expect(ingredients.map((i) => i.rawText)).toEqual(lines);

    // parsing changed qty/unit but rawText is the untouched original line.
    const flour = ingredients[0]!;
    expect(flour.rawText).toBe('2 cups all-purpose flour');
    expect(flour.quantity).toBe('2');
    expect(flour.unit).toBe('cup');
  });

  it('reuses one food row when two ingredient lines name the same food', async () => {
    const a = await createHousehold();

    const { id } = await createRecipe(a, {
      title: 'Flour Twice',
      ingredientLines: ['2 cups flour', '1 cup flour'],
    });

    const foods = await withHousehold(a, (tx) =>
      tx.select().from(food).where(eq(food.normalizedName, 'flour')),
    );
    expect(foods).toHaveLength(1);

    const ingredients = await withHousehold(a, (tx) =>
      tx.select().from(recipeIngredient).where(eq(recipeIngredient.recipeId, id)),
    );
    expect(ingredients).toHaveLength(2);
    expect(ingredients[0]!.foodId).toBe(foods[0]!.id);
    expect(ingredients[1]!.foodId).toBe(foods[0]!.id);
  });

  it("isolates recipes per household (household B cannot read A's recipe)", async () => {
    // Two tenants, which the household cap forbids: isolation is the rule that must hold in
    // the world where that cap is lifted, so the test lifts it.
    await liftHouseholdCap();
    const a = await createHousehold();
    const b = await createHousehold();

    const { id } = await createRecipe(a, {
      title: 'Private Recipe',
      ingredientLines: ['1 cup sugar'],
      steps: ['Mix'],
    });

    // RLS: household B sees no rows for A's recipe, even with no app-layer filter.
    const rowsForB = await withHousehold(b, (tx) =>
      tx.select().from(recipe).where(eq(recipe.id, id)),
    );
    expect(rowsForB).toHaveLength(0);

    const allForB = await withHousehold(b, (tx) => tx.select().from(recipe));
    expect(allForB).toHaveLength(0);

    // A still sees it.
    const rowsForA = await withHousehold(a, (tx) =>
      tx
        .select()
        .from(recipe)
        .where(and(eq(recipe.id, id), eq(recipe.householdId, a))),
    );
    expect(rowsForA).toHaveLength(1);
  });
});

describe('recipe repository (assembled get)', () => {
  beforeEach(async () => {
    await resetDb();
  });

  it('assembles the full recipe when fetched by slug', async () => {
    const a = await createHousehold();

    const { id, slug } = await createRecipe(a, {
      title: 'Simple Tomato Pasta',
      servings: 4,
      mealTypes: ['dinner'],
      tags: ['Quick', 'Vegetarian'],
      ingredientLines: ['2 cups flour', '3 tomatoes, chopped', '1 tsp salt'],
      steps: ['Boil the pasta', 'Make the sauce', 'Combine and serve'],
    });

    const got = await getRecipe(a, slug);
    expect(got).not.toBeNull();
    const r = got!;

    // scalars
    expect(r.id).toBe(id);
    expect(r.title).toBe('Simple Tomato Pasta');
    expect(r.slug).toBe('simple-tomato-pasta');
    expect(r.servings).toBe(4);
    expect(r.mealTypes).toEqual(['dinner']);
    expect(r.description).toBeNull();
    expect(r.prepMinutes).toBeNull();
    expect(r.cookMinutes).toBeNull();
    expect(r.sourceUrl).toBeNull();
    expect(r.sourceName).toBeNull();

    // ingredients (ordered), with foodName/department joined from `food`
    expect(r.ingredients).toHaveLength(3);
    expect(r.ingredients.map((i) => i.position)).toEqual([0, 1, 2]);

    const flour = r.ingredients[0]!;
    expect(flour.quantity).toBe(2); // coerced to number
    expect(flour.unit).toBe('cup');
    expect(flour.rawText).toBe('2 cups flour');
    expect(flour.scalingMode).toBe('linear');
    expect(flour.foodId).not.toBeNull();
    expect(flour.foodName).toBe('flour');
    expect(flour.department).toBe(departmentFor('flour'));

    const tomato = r.ingredients[1]!;
    expect(tomato.foodName).toBe('tomatoes');
    expect(tomato.department).toBe(departmentFor('tomatoes'));

    const salt = r.ingredients[2]!;
    expect(salt.foodName).toBe('salt');
    expect(salt.department).toBe(departmentFor('salt'));

    // steps (ordered)
    expect(r.steps).toHaveLength(3);
    expect(r.steps.map((s) => s.position)).toEqual([0, 1, 2]);
    expect(r.steps.map((s) => s.text)).toEqual([
      'Boil the pasta',
      'Make the sauce',
      'Combine and serve',
    ]);

    // tags (names)
    expect([...r.tags].sort()).toEqual(['Quick', 'Vegetarian']);
  });

  it('fetches the same recipe by id', async () => {
    const a = await createHousehold();
    const { id } = await createRecipe(a, {
      title: 'By Id Recipe',
      ingredientLines: ['1 cup sugar'],
      steps: ['Mix'],
    });

    const got = await getRecipe(a, id);
    expect(got).not.toBeNull();
    expect(got!.id).toBe(id);
    expect(got!.title).toBe('By Id Recipe');
    expect(got!.ingredients).toHaveLength(1);
    expect(got!.ingredients[0]!.foodName).toBe('sugar');
  });

  it('returns ingredients and steps in position order regardless of insert order', async () => {
    const a = await createHousehold();
    const { id, slug } = await createRecipe(a, { title: 'Ordering Recipe' });

    // Insert child rows out of natural (position) order to prove get sorts them.
    await withHousehold(a, async (tx) => {
      await tx.insert(recipeIngredient).values([
        { householdId: a, recipeId: id, position: 2, rawText: 'third', scalingModeValue: 'linear' },
        { householdId: a, recipeId: id, position: 0, rawText: 'first', scalingModeValue: 'linear' },
        {
          householdId: a,
          recipeId: id,
          position: 1,
          rawText: 'second',
          scalingModeValue: 'linear',
        },
      ]);
      await tx.insert(recipeStep).values([
        { householdId: a, recipeId: id, position: 2, text: 'step three' },
        { householdId: a, recipeId: id, position: 0, text: 'step one' },
        { householdId: a, recipeId: id, position: 1, text: 'step two' },
      ]);
    });

    const got = await getRecipe(a, slug);
    expect(got).not.toBeNull();
    expect(got!.ingredients.map((i) => i.position)).toEqual([0, 1, 2]);
    expect(got!.ingredients.map((i) => i.rawText)).toEqual(['first', 'second', 'third']);
    expect(got!.steps.map((s) => s.position)).toEqual([0, 1, 2]);
    expect(got!.steps.map((s) => s.text)).toEqual(['step one', 'step two', 'step three']);
  });

  it('returns null for a recipe owned by another household', async () => {
    // Two tenants, which the household cap forbids: isolation is the rule that must hold in
    // the world where that cap is lifted, so the test lifts it.
    await liftHouseholdCap();
    const a = await createHousehold();
    const b = await createHousehold();

    const { id, slug } = await createRecipe(a, {
      title: 'Private Recipe',
      ingredientLines: ['1 cup sugar'],
      steps: ['Mix'],
    });

    expect(await getRecipe(b, slug)).toBeNull();
    expect(await getRecipe(b, id)).toBeNull();

    // A can still read it.
    expect(await getRecipe(a, slug)).not.toBeNull();
  });
});

describe('recipe repository (update)', () => {
  beforeEach(async () => {
    await resetDb();
  });

  it('replaces title and re-parses ingredients, dropping the old ingredient rows', async () => {
    const a = await createHousehold();

    const { id, slug } = await createRecipe(a, {
      title: 'Old Title',
      servings: 2,
      ingredientLines: ['2 cups flour'],
      steps: ['Old step'],
    });

    const res = await updateRecipe(a, id, {
      title: 'New Title',
      servings: 6,
      mealTypes: ['breakfast'],
      ingredientLines: ['3 eggs'],
      steps: ['New step one', 'New step two'],
    });
    expect(res).not.toBeNull();
    // slug stays stable across an update.
    expect(res!.slug).toBe(slug);

    const got = await getRecipe(a, id);
    expect(got).not.toBeNull();
    const r = got!;
    expect(r.title).toBe('New Title');
    expect(r.slug).toBe(slug);
    expect(r.servings).toBe(6);
    expect(r.mealTypes).toEqual(['breakfast']);

    // exactly one ingredient now: eggs qty 3, and NO leftover flour row.
    expect(r.ingredients).toHaveLength(1);
    expect(r.ingredients[0]!.foodName).toBe('eggs');
    expect(r.ingredients[0]!.quantity).toBe(3);

    const ingRows = await withHousehold(a, (tx) =>
      tx.select().from(recipeIngredient).where(eq(recipeIngredient.recipeId, id)),
    );
    expect(ingRows).toHaveLength(1);
    expect(ingRows.some((i) => i.rawText === '2 cups flour')).toBe(false);

    // steps were replaced too.
    expect(r.steps.map((s) => s.text)).toEqual(['New step one', 'New step two']);
    expect(r.steps.map((s) => s.position)).toEqual([0, 1]);
  });

  it("is household-scoped: B cannot update A's recipe", async () => {
    // Two tenants, which the household cap forbids: isolation is the rule that must hold in
    // the world where that cap is lifted, so the test lifts it.
    await liftHouseholdCap();
    const a = await createHousehold();
    const b = await createHousehold();

    const { id } = await createRecipe(a, {
      title: 'A Recipe',
      ingredientLines: ['1 cup sugar'],
      steps: ['Mix'],
    });

    const res = await updateRecipe(b, id, {
      title: 'Hijacked',
      ingredientLines: ['9 cups poison'],
    });
    expect(res).toBeNull();

    // A's recipe is untouched.
    const got = await getRecipe(a, id);
    expect(got).not.toBeNull();
    expect(got!.title).toBe('A Recipe');
    expect(got!.ingredients).toHaveLength(1);
    expect(got!.ingredients[0]!.foodName).toBe('sugar');
  });
});

describe('recipe repository (delete)', () => {
  beforeEach(async () => {
    await resetDb();
  });

  it('removes the recipe and cascades its child rows', async () => {
    const a = await createHousehold();

    const { id } = await createRecipe(a, {
      title: 'Doomed Recipe',
      tags: ['Quick'],
      ingredientLines: ['2 cups flour', '3 eggs'],
      steps: ['Mix', 'Bake'],
    });

    const deleted = await deleteRecipe(a, id);
    expect(deleted).toBe(true);

    // recipe gone.
    expect(await getRecipe(a, id)).toBeNull();

    // child rows gone (queried directly).
    const ingRows = await withHousehold(a, (tx) =>
      tx.select().from(recipeIngredient).where(eq(recipeIngredient.recipeId, id)),
    );
    expect(ingRows).toHaveLength(0);

    const stepRows = await withHousehold(a, (tx) =>
      tx.select().from(recipeStep).where(eq(recipeStep.recipeId, id)),
    );
    expect(stepRows).toHaveLength(0);

    const tagLinks = await withHousehold(a, (tx) =>
      tx.select().from(recipeTags).where(eq(recipeTags.recipeId, id)),
    );
    expect(tagLinks).toHaveLength(0);
  });

  it("is household-scoped: B deleting A's recipe removes nothing", async () => {
    // Two tenants, which the household cap forbids: isolation is the rule that must hold in
    // the world where that cap is lifted, so the test lifts it.
    await liftHouseholdCap();
    const a = await createHousehold();
    const b = await createHousehold();

    const { id } = await createRecipe(a, {
      title: 'A Recipe',
      ingredientLines: ['1 cup sugar'],
      steps: ['Mix'],
    });

    const deleted = await deleteRecipe(b, id);
    expect(deleted).toBe(false);

    // A's recipe still retrievable.
    expect(await getRecipe(a, id)).not.toBeNull();
  });
});

/**
 * The library fixture the search tests share.
 *
 * Chosen so each filter has a discriminating answer: "soup" is in exactly one title, "quick" is
 * a tag on two recipes whose titles do NOT contain it (so a hit there can only have come from
 * the relational tag branch), and Roasted Chicken carries tomato on two separate ingredient
 * lines that fold to one `food` row - the arrangement a join duplicates and an EXISTS does not.
 */
async function seedLibrary(householdId: string) {
  const white = await createRecipe(householdId, {
    title: 'White Bean Soup',
    mealTypes: ['dinner'],
    tags: ['Quick'],
    ingredientLines: ['2 cups white beans', '1 onion, diced'],
    steps: ['Simmer'],
  });
  const oats = await createRecipe(householdId, {
    title: 'Morning Oats',
    mealTypes: ['breakfast'],
    tags: ['Vegetarian'],
    ingredientLines: ['1 cup oats', '1 banana'],
    steps: ['Stir'],
  });
  const chicken = await createRecipe(householdId, {
    title: 'Roasted Chicken',
    mealTypes: ['dinner'],
    tags: ['Sunday'],
    ingredientLines: ['1 chicken', '2 tomatoes', '3 tomatoes, halved'],
    steps: ['Roast'],
  });
  const cake = await createRecipe(householdId, {
    title: 'Chocolate Cake',
    mealTypes: ['dessert'],
    tags: ['Quick'],
    ingredientLines: ['200 g chocolate'],
    steps: ['Bake'],
  });
  return { white, oats, chicken, cake };
}

const titlesOf = (cards: { title: string }[]) => cards.map((c) => c.title);

describe('recipe repository (search)', () => {
  beforeEach(async () => {
    await resetDb();
  });

  it('returns every recipe newest-first when given no parameters', async () => {
    const a = await createHousehold();
    await seedLibrary(a);

    expect(titlesOf(await searchRecipes(a))).toEqual([
      'Chocolate Cake',
      'Roasted Chicken',
      'Morning Oats',
      'White Bean Soup',
    ]);
    // An explicitly empty object is the same request as no argument at all: the Library sends
    // one before the cook has typed anything.
    expect(titlesOf(await searchRecipes(a, {}))).toEqual(titlesOf(await searchRecipes(a)));
  });

  it('gives each card its tags in name order, and none as an empty list', async () => {
    const a = await createHousehold();
    await createRecipe(a, { title: 'Tagged', tags: ['Vegan', 'Italian'] });
    await createRecipe(a, { title: 'Plain' });
    const cards = await searchRecipes(a);
    expect(cards.find((c) => c.title === 'Tagged')!.tags).toEqual(['Italian', 'Vegan']);
    expect(cards.find((c) => c.title === 'Plain')!.tags).toEqual([]);
    expect(cards[0]!.updatedAt).toBeInstanceOf(Date);
  });

  it('matches free text against the title', async () => {
    const a = await createHousehold();
    await seedLibrary(a);

    expect(titlesOf(await searchRecipes(a, { text: 'soup' }))).toEqual(['White Bean Soup']);
  });

  it('matches the word still being typed as a prefix', async () => {
    const a = await createHousehold();
    await seedLibrary(a);

    // The Library searches on every keystroke. Whole-word matching emptied the grid at "chick"
    // and only found the recipe again at "chicken".
    expect(titlesOf(await searchRecipes(a, { text: 'chick' }))).toEqual(['Roasted Chicken']);
    expect(titlesOf(await searchRecipes(a, { text: 'white bean sou' }))).toEqual([
      'White Bean Soup',
    ]);
    // A hyphen inside a word is not an exclusion, so it still gets the prefix.
    expect(titlesOf(await searchRecipes(a, { text: 'roasted-chi' }))).toEqual(['Roasted Chicken']);
  });

  it('keeps websearch syntax exact, with no prefix widening', async () => {
    const a = await createHousehold();
    await seedLibrary(a);

    // An exclusion must stay an exclusion: widening "-chicken" to a prefix match on "chicken"
    // would bring back exactly what the cook asked to leave out.
    expect(titlesOf(await searchRecipes(a, { text: 'roasted -chicken' }))).toEqual([]);
    // Postgres also reads a `-` after a bracket as an exclusion.
    expect(titlesOf(await searchRecipes(a, { text: 'roasted(-chicken)' }))).toEqual([]);
  });

  it('matches a stop word as the start of a longer word', async () => {
    const a = await createHousehold();
    await createRecipe(a, { title: 'Onion Tart', steps: ['Bake'] });

    // The english config drops "on" as a stop word, which left nothing to match "onion" with.
    expect(titlesOf(await searchRecipes(a, { text: 'on' }))).toEqual(['Onion Tart']);
  });

  it('matches free text against the description', async () => {
    const a = await createHousehold();
    const { oats } = await seedLibrary(a);
    // `description` has no path through `createRecipe` yet, and the weight-B half of the
    // generated tsvector is only observable with one set.
    await withHousehold(a, (tx) =>
      tx
        .update(recipe)
        .set({ description: 'A slow-cooked porridge for cold mornings' })
        .where(eq(recipe.id, oats.id)),
    );

    expect(titlesOf(await searchRecipes(a, { text: 'porridge' }))).toEqual(['Morning Oats']);
  });

  it('matches free text against a tag name the tsvector does not contain', async () => {
    const a = await createHousehold();
    await seedLibrary(a);

    // Neither title contains "quick"; the only route to these two rows is the tag join.
    expect(titlesOf(await searchRecipes(a, { text: 'quick' })).sort()).toEqual([
      'Chocolate Cake',
      'White Bean Soup',
    ]);
  });

  it('ranks a title match above a description match', async () => {
    const a = await createHousehold();
    const inBody = await createRecipe(a, { title: 'Weeknight Bowl', steps: ['Assemble'] });
    await withHousehold(a, (tx) =>
      tx.update(recipe).set({ description: 'Built on lentils' }).where(eq(recipe.id, inBody.id)),
    );
    // Created LAST, so recency alone would put it second. Rank has to be what lifts it.
    await createRecipe(a, { title: 'Lentil Stew', steps: ['Simmer'] });

    expect(titlesOf(await searchRecipes(a, { text: 'lentils' }))).toEqual([
      'Lentil Stew',
      'Weeknight Bowl',
    ]);
  });

  it('filters by an ingredient through the canonical food name', async () => {
    const a = await createHousehold();
    await seedLibrary(a);

    // "tomatoes" normalizes to the food row "tomato", so the plural a cook types still lands.
    expect(titlesOf(await searchRecipes(a, { ingredient: 'tomatoes' }))).toEqual([
      'Roasted Chicken',
    ]);
    expect(titlesOf(await searchRecipes(a, { ingredient: 'oats' }))).toEqual(['Morning Oats']);
  });

  it('returns a recipe once when two of its ingredient lines match', async () => {
    const a = await createHousehold();
    const { chicken } = await seedLibrary(a);

    // Roasted Chicken carries tomato twice. A join would return it twice.
    const found = await searchRecipes(a, { ingredient: 'tomato' });
    expect(found.map((c) => c.id)).toEqual([chicken.id]);
  });

  it('filters by meal type', async () => {
    const a = await createHousehold();
    await seedLibrary(a);

    expect(titlesOf(await searchRecipes(a, { mealType: 'dinner' }))).toEqual([
      'Roasted Chicken',
      'White Bean Soup',
    ]);
    expect(titlesOf(await searchRecipes(a, { mealType: 'snack' }))).toEqual([]);
  });

  it('files and filters the recipe types that are not meals', async () => {
    const a = await createHousehold();
    await createRecipe(a, { title: 'Sofrito', mealTypes: ['sauce', 'base'] });
    await createRecipe(a, { title: 'Mashed Potatoes', mealTypes: ['dinner', 'side'] });

    expect(titlesOf(await searchRecipes(a, { mealType: 'sauce' }))).toEqual(['Sofrito']);
    expect(titlesOf(await searchRecipes(a, { mealType: 'side' }))).toEqual(['Mashed Potatoes']);
    expect((await getRecipe(a, 'sofrito'))!.mealTypes).toEqual(['sauce', 'base']);
  });

  it('filters by tag', async () => {
    const a = await createHousehold();
    await seedLibrary(a);

    expect(titlesOf(await searchRecipes(a, { tag: 'Quick' }))).toEqual([
      'Chocolate Cake',
      'White Bean Soup',
    ]);
  });

  it('combines all four filters with AND', async () => {
    const a = await createHousehold();
    await seedLibrary(a);

    expect(
      titlesOf(
        await searchRecipes(a, {
          text: 'chicken',
          ingredient: 'tomato',
          mealType: 'dinner',
          tag: 'Sunday',
        }),
      ),
    ).toEqual(['Roasted Chicken']);

    // One filter contradicting the rest empties the result rather than widening it.
    expect(
      await searchRecipes(a, {
        text: 'chicken',
        ingredient: 'tomato',
        mealType: 'breakfast',
        tag: 'Sunday',
      }),
    ).toEqual([]);
  });

  it('accepts an apostrophe, a quoted phrase and a bare hyphen without throwing', async () => {
    const a = await createHousehold();
    await seedLibrary(a);

    // `to_tsquery` raises a syntax error on every one of these. `websearch_to_tsquery` does not,
    // which is the whole reason it is the one this query uses.
    for (const text of ["grandma's", '"white bean"', '-', 'soup or -cake', 'a & | b ! ()']) {
      await expect(searchRecipes(a, { text })).resolves.toBeInstanceOf(Array);
    }

    // The quoted phrase is not merely tolerated, it searches.
    expect(titlesOf(await searchRecipes(a, { text: '"white bean"' }))).toEqual(['White Bean Soup']);
  });

  it('treats whitespace-only text as no text filter at all', async () => {
    const a = await createHousehold();
    await seedLibrary(a);

    expect(titlesOf(await searchRecipes(a, { text: '   ' }))).toEqual(
      titlesOf(await searchRecipes(a)),
    );
  });

  it("never returns another household's recipes, under any parameter combination", async () => {
    // Two tenants, which the household cap forbids: isolation is the rule that must hold in the
    // world where that cap is lifted, so the test lifts it.
    await liftHouseholdCap();
    const a = await createHousehold();
    const b = await createHousehold();

    // Identical libraries, so a leak shows up as a duplicate rather than as nothing at all.
    const aIds = new Set(Object.values(await seedLibrary(a)).map((r) => r.id));
    const bIds = new Set(Object.values(await seedLibrary(b)).map((r) => r.id));

    const paramSets: SearchRecipesParams[] = [
      {},
      { text: 'soup' },
      { text: 'quick' },
      { text: 'chicken' },
      { ingredient: 'tomato' },
      { mealType: 'dinner' },
      { tag: 'Quick' },
      { text: 'chicken', ingredient: 'tomato', mealType: 'dinner', tag: 'Sunday' },
    ];

    for (const params of paramSets) {
      const forA = await searchRecipes(a, params);
      const forB = await searchRecipes(b, params);

      // Each side sees only its own ids ...
      expect(forA.every((c) => aIds.has(c.id))).toBe(true);
      expect(forB.every((c) => bIds.has(c.id))).toBe(true);
      // ... and the same number of them, which is what makes "sees only its own" non-vacuous:
      // a search that returned nothing would satisfy the two assertions above.
      expect(forA.length).toBe(forB.length);
      expect(forA.length).toBeGreaterThan(0);
    }
  });
});

describe('recipe repository (tag counts)', () => {
  beforeEach(async () => {
    await resetDb();
  });

  it('counts the recipes behind each tag, most used first', async () => {
    const a = await createHousehold();
    await seedLibrary(a);
    await createRecipe(a, { title: 'Fast Eggs', tags: ['Quick'], steps: ['Fry'] });

    expect(await listTagCounts(a)).toEqual([
      { name: 'Quick', normalizedName: 'quick', count: 3 },
      { name: 'Sunday', normalizedName: 'sunday', count: 1 },
      { name: 'Vegetarian', normalizedName: 'vegetarian', count: 1 },
    ]);
  });

  it('omits a tag no recipe carries, which would only offer an empty grid', async () => {
    const a = await createHousehold();
    const cake = await createRecipe(a, { title: 'Cake', tags: ['Sweet'], steps: ['Bake'] });
    await updateRecipe(a, cake.id, { title: 'Cake', tags: [], steps: ['Bake'] });

    // The `tag` row survives the update (only the link is replaced), so a query over `tag`
    // alone would still offer it.
    const remaining = await withHousehold(a, (tx) => tx.select().from(tag));
    expect(remaining).toHaveLength(1);
    expect(await listTagCounts(a)).toEqual([]);
  });

  it('caps how many chips it offers', async () => {
    const a = await createHousehold();
    await createRecipe(a, {
      title: 'Everything',
      tags: Array.from({ length: TAG_CHIP_LIMIT + 3 }, (_, i) => `Tag ${i}`),
      steps: ['Serve'],
    });

    expect(await listTagCounts(a)).toHaveLength(TAG_CHIP_LIMIT);
  });

  it("never counts another household's recipes", async () => {
    await liftHouseholdCap();
    const a = await createHousehold();
    const b = await createHousehold();
    await createRecipe(a, { title: 'A dish', tags: ['Shared'], steps: ['Cook'] });
    await createRecipe(b, { title: 'B dish', tags: ['Shared'], steps: ['Cook'] });
    await createRecipe(b, { title: 'B other', tags: ['Shared'], steps: ['Cook'] });

    // Same tag name in both households, different row counts: a leak would read as 3.
    expect(await listTagCounts(a)).toEqual([
      { name: 'Shared', normalizedName: 'shared', count: 1 },
    ]);
    expect(await listTagCounts(b)).toEqual([
      { name: 'Shared', normalizedName: 'shared', count: 2 },
    ]);
  });
});

describe('where a recipe came from', () => {
  beforeEach(resetDb);

  it('stores the source URL an import supplied, and reads it back', async () => {
    const a = await createHousehold();
    const { slug } = await createRecipe(a, {
      title: 'Imported Soup',
      sourceUrl: 'https://www.budgetbytes.com/garlic-butter-baked-chicken-thighs/',
    });
    const got = await getRecipe(a, slug);
    expect(got!.sourceUrl).toBe('https://www.budgetbytes.com/garlic-butter-baked-chicken-thighs/');
  });

  it('leaves it null for a recipe typed by hand', async () => {
    const a = await createHousehold();
    const { slug } = await createRecipe(a, { title: 'Typed Soup' });
    expect((await getRecipe(a, slug))!.sourceUrl).toBeNull();
  });

  it('keeps it through an edit that does not carry the field', async () => {
    // A caller that does not know the field (an older client, a script) must not clear it.
    const a = await createHousehold();
    const { id, slug } = await createRecipe(a, {
      title: 'Imported Soup',
      sourceUrl: 'https://example.com/soup',
    });
    await updateRecipe(a, id, { title: 'Imported Soup, my way', servings: 6 });
    expect((await getRecipe(a, slug))!.sourceUrl).toBe('https://example.com/soup');
  });

  it('lets an edit attach a link to a pasted recipe, and clear it again', async () => {
    const a = await createHousehold();
    const { id, slug } = await createRecipe(a, { title: 'Pasted Osso Buco' });
    await updateRecipe(a, id, { title: 'Pasted Osso Buco', sourceUrl: 'https://example.com/ob' });
    expect((await getRecipe(a, slug))!.sourceUrl).toBe('https://example.com/ob');

    await updateRecipe(a, id, { title: 'Pasted Osso Buco', sourceUrl: null });
    expect((await getRecipe(a, slug))!.sourceUrl).toBeNull();
  });
});

describe('the optional details a cook types in', () => {
  beforeEach(resetDb);

  it('stores notes, a book source and times on create', async () => {
    const a = await createHousehold();
    const { slug } = await createRecipe(a, {
      title: "Mimma's Rolls",
      description: '  Double it for Easter.  ',
      sourceName: 'Joy of Cooking, p. 212',
      prepMinutes: 20,
      cookMinutes: 18,
    });
    const got = (await getRecipe(a, slug))!;
    expect(got.description).toBe('Double it for Easter.');
    expect(got.sourceName).toBe('Joy of Cooking, p. 212');
    expect(got.prepMinutes).toBe(20);
    expect(got.cookMinutes).toBe(18);
  });

  it('keeps them through an update that leaves them out, and clears them on null or blank', async () => {
    const a = await createHousehold();
    const { id, slug } = await createRecipe(a, {
      title: 'Rolls',
      description: 'Notes',
      sourceName: 'Book',
      prepMinutes: 5,
    });
    await updateRecipe(a, id, { title: 'Rolls' });
    let got = (await getRecipe(a, slug))!;
    expect([got.description, got.sourceName, got.prepMinutes]).toEqual(['Notes', 'Book', 5]);

    await updateRecipe(a, id, {
      title: 'Rolls',
      description: '   ',
      sourceName: null,
      prepMinutes: null,
    });
    got = (await getRecipe(a, slug))!;
    expect([got.description, got.sourceName, got.prepMinutes]).toEqual([null, null, null]);
  });
});

describe('ingredient lines that link another recipe', () => {
  beforeEach(async () => {
    await resetDb();
  });

  it('stores the link by id and the line without its token', async () => {
    const a = await createHousehold();
    const dough = await createRecipe(a, { title: 'Neapolitan Pizza Dough', servings: 4 });
    await createRecipe(a, {
      title: 'Binulati',
      ingredientLines: ['1 pizza dough [[neapolitan  pizza dough]]', '200 g mozzarella'],
    });

    const binulati = await getRecipe(a, 'binulati');
    const [doughLine, cheese] = binulati!.ingredients;
    expect(doughLine!.rawText).toBe('1 pizza dough');
    expect(doughLine!.foodName).toBe('pizza dough');
    expect(doughLine!.linkedRecipe).toEqual({
      id: dough.id,
      slug: 'neapolitan-pizza-dough',
      title: 'Neapolitan Pizza Dough',
    });
    expect(cheese!.linkedRecipe).toBeNull();
  });

  it('keeps the link when the linked recipe is renamed, and lists where it is used', async () => {
    const a = await createHousehold();
    const dough = await createRecipe(a, { title: 'Pizza Dough' });
    await createRecipe(a, { title: 'Binulati', ingredientLines: ['1 dough [[Pizza Dough]]'] });
    await createRecipe(a, {
      title: 'Calzone',
      ingredientLines: ['2 dough [[Pizza Dough]]', '1 dough [[Pizza Dough]]'],
    });
    await updateRecipe(a, dough.id, { title: 'Cold-Ferment Dough' });

    const binulati = await getRecipe(a, 'binulati');
    expect(binulati!.ingredients[0]!.linkedRecipe!.title).toBe('Cold-Ferment Dough');

    const renamed = await getRecipe(a, dough.id);
    expect(renamed!.usedIn.map((r) => r.title)).toEqual(['Binulati', 'Calzone']);
  });

  it('leaves the line as plain text when the linked recipe is deleted', async () => {
    const a = await createHousehold();
    const dough = await createRecipe(a, { title: 'Pizza Dough' });
    await createRecipe(a, {
      title: 'Binulati',
      ingredientLines: ['1 pizza dough [[Pizza Dough]]'],
    });
    await deleteRecipe(a, dough.id);

    const [line] = (await getRecipe(a, 'binulati'))!.ingredients;
    expect(line!.linkedRecipe).toBeNull();
    expect(line!.rawText).toBe('1 pizza dough');
  });

  it('refuses a title no recipe has, or two recipes share, and saves nothing', async () => {
    const a = await createHousehold();
    await expect(
      createRecipe(a, { title: 'Binulati', ingredientLines: ['1 dough [[Nope]]'] }),
    ).rejects.toThrow('Ingredient 1 links to a recipe that is not in your library.');

    await createRecipe(a, { title: 'Dough' });
    await createRecipe(a, { title: 'dough' });
    await expect(
      createRecipe(a, { title: 'Binulati', ingredientLines: ['salt', '1 dough [[Dough]]'] }),
    ).rejects.toThrow('Ingredient 2 links to a title two recipes share.');

    expect(await searchRecipes(a, { text: 'Binulati' })).toEqual([]);
  });

  it('refuses a link to itself or one that closes a cycle', async () => {
    const a = await createHousehold();
    const dough = await createRecipe(a, { title: 'Dough' });
    const pizza = await createRecipe(a, { title: 'Pizza', ingredientLines: ['1 dough [[Dough]]'] });
    await createRecipe(a, { title: 'Party', ingredientLines: ['2 pizza [[Pizza]]'] });

    await expect(
      updateRecipe(a, dough.id, { title: 'Dough', ingredientLines: ['1 dough [[Dough]]'] }),
    ).rejects.toThrow('links this recipe to itself');
    await expect(
      updateRecipe(a, dough.id, { title: 'Dough', ingredientLines: ['1 party [[Party]]'] }),
    ).rejects.toThrow('links to a recipe that already uses this one');

    // The refused update rolled back whole: the pizza still links the dough.
    expect((await getRecipe(a, pizza.id))!.ingredients[0]!.linkedRecipe!.id).toBe(dough.id);
  });

  it("never resolves a title to another household's recipe", async () => {
    await liftHouseholdCap();
    const a = await createHousehold();
    const b = await createHousehold();
    await createRecipe(b, { title: 'Secret Dough' });

    await expect(
      createRecipe(a, { title: 'Pizza', ingredientLines: ['1 dough [[Secret Dough]]'] }),
    ).rejects.toThrow('not in your library');
  });
});

describe('ingredient links sent by id', () => {
  beforeEach(async () => {
    await resetDb();
  });

  it('links the sent id even when two recipes share the title', async () => {
    const a = await createHousehold();
    await createRecipe(a, { title: 'Pizza Dough' });
    const second = await createRecipe(a, { title: 'Pizza Dough' });
    const { id } = await createRecipe(a, {
      title: 'Binulati',
      ingredientLines: ['1 dough [[Pizza Dough]]'],
      ingredientLinks: [second.id],
    });
    expect((await getRecipe(a, id))!.ingredients[0]!.linkedRecipe!.id).toBe(second.id);
  });

  it("refuses a sent id that is not one of the household's recipes", async () => {
    await liftHouseholdCap();
    const a = await createHousehold();
    const b = await createHousehold();
    await createRecipe(a, { title: 'Pizza Dough' });
    const theirs = await createRecipe(b, { title: 'Pizza Dough' });
    await expect(
      createRecipe(a, {
        title: 'Binulati',
        ingredientLines: ['1 dough [[Pizza Dough]]'],
        ingredientLinks: [theirs.id],
      }),
    ).rejects.toThrow('not in your library');
  });

  it('keeps the title as the food on a line that is only an amount and a link', async () => {
    const a = await createHousehold();
    const dough = await createRecipe(a, { title: 'Pizza Dough' });
    const { id } = await createRecipe(a, {
      title: 'Pizza',
      ingredientLines: ['1 [[Pizza Dough]]'],
    });
    await deleteRecipe(a, dough.id);

    const [line] = (await getRecipe(a, id))!.ingredients;
    expect(line!.rawText).toBe('1 Pizza Dough');
    expect(line!.foodName).toBe('Pizza Dough');
  });
});

describe('the sources a household has typed', () => {
  beforeEach(resetDb);

  it('lists each source once with its count, most used first, and never another household’s', async () => {
    await liftHouseholdCap();
    const a = await createHousehold();
    const b = await createHousehold();
    await createRecipe(a, { title: 'One', sourceName: 'The Newlywed Cookbook' });
    await createRecipe(a, { title: 'Two', sourceName: 'The Newlywed Cookbook' });
    await createRecipe(a, { title: 'Three', sourceName: 'King Arthur' });
    await createRecipe(a, { title: 'Four' });
    await createRecipe(b, { title: 'Theirs', sourceName: 'Secret Book' });
    expect(await listSourceNames(a)).toEqual([
      { name: 'The Newlywed Cookbook', count: 2 },
      { name: 'King Arthur', count: 1 },
    ]);
  });
});
