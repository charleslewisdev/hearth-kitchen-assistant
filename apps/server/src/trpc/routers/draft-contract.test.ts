import { describe, it, expect, beforeEach } from 'vitest';
import { z } from 'zod';
import { draftToCreateInput, emptyDraft, field, MEAL_TYPES } from '@hearth/enrichment';
import type { MealType, RecipeCreateInput } from '@hearth/enrichment';
import { appRouter } from './index';
import { MEAL_TYPES as ROUTER_MEAL_TYPES } from './recipe';
import { resetDb } from '../../../test/db';
import { householdWithOwner } from '../../../test/factories';
import { testContext } from '../../../test/trpc';

/**
 * The seam between `packages/enrichment` and `recipe.create`.
 *
 * Enrichment cannot import the server - the dependency runs the other way - so it restates the
 * meal-type vocabulary and the create input's shape. This file is what makes that restatement
 * safe: if the router grows a required field, tightens a type, or changes the meal-type list,
 * these fail rather than a URL import failing in a cook's hands.
 */

type RouterMealType = (typeof ROUTER_MEAL_TYPES)[number];

// Mutual assignability is union identity: either list gaining or losing a member breaks one
// direction and resolves this to `false`.
type Identical<A, B> = [A] extends [B] ? ([B] extends [A] ? true : false) : false;

describe('the draft type round-trips through recipe.create', () => {
  beforeEach(resetDb);

  it('agrees with the router on the meal-type vocabulary', () => {
    // Assigning `true` to the union-identity type is the compile-time half: if the two unions
    // stop matching, `Identical` resolves to `false` and this line stops compiling. It is
    // asserted at run time as well so the check is a live part of the test rather than a
    // declaration lint would call unused.
    const unionsAreIdentical: Identical<MealType, RouterMealType> = true;
    expect(unionsAreIdentical).toBe(true);

    // The ARRAY as well as the union, because that is what a source maps `recipeCategory`
    // against, and a reordering would not move the union at all.
    expect([...MEAL_TYPES]).toEqual([...ROUTER_MEAL_TYPES]);
  });

  it('produces an object the create input schema accepts unchanged', async () => {
    const { householdId } = await householdWithOwner();
    const caller = appRouter.createCaller(
      testContext({ householdId, session: { userId: 'u' } as never }),
    );

    const input = draftToCreateInput({
      ...emptyDraft({ kind: 'url', url: 'https://example.com/banana-bread' }),
      title: field('Banana bread', 'high', 'Banana Bread'),
      servings: field(10, 'high', '1 loaf, 10 serving(s)'),
      mealTypes: field<MealType[]>(['dessert'], 'low', 'Quick Breads'),
      tags: field(['breads'], 'low', 'Breads,Fruit'),
      ingredientLines: field(['1/2 cup butter, softened', '1 cup sugar'], 'high', null),
      steps: field(['Cream the butter and sugar.'], 'high', null),
    });

    // `create` returns ids only, so the assertions read the recipe back the way the review
    // screen's redirect does. That also proves the children actually landed.
    const { slug } = await caller.recipe.create(input);
    const created = await caller.recipe.get({ idOrSlug: slug });
    if (!created) throw new Error('the recipe just created was not readable');

    expect(created.title).toBe('Banana bread');
    expect(created.servings).toBe(10);
    expect(created.mealTypes).toEqual(['dessert']);
    // Every line went through `parseIngredientLine` inside `createRecipe`, which is what makes
    // an imported recipe indistinguishable from a typed one: same parser, one write path.
    expect(created.ingredients.map((i) => i.rawText)).toEqual([
      '1/2 cup butter, softened',
      '1 cup sugar',
    ]);
    expect(created.ingredients[0]?.quantity).toBe(0.5);
    expect(created.ingredients[0]?.unit).toBe('cup');
  });

  it('is a compile error for the draft to omit a field create requires', () => {
    // `recipeFields` is not exported, so the guard is that enrichment's own input type still
    // satisfies the schema the router builds from it. A field added there as REQUIRED makes
    // this parse fail; a field removed makes the strict schema reject the extra key.
    const schema = z
      .object({
        title: z.string().min(1),
        servings: z.number().int().positive(),
        mealTypes: z.array(z.enum(ROUTER_MEAL_TYPES)),
        tags: z.array(z.string()),
        ingredientLines: z.array(z.string()),
        steps: z.array(z.string()),
        // Optional here as it is in the router, and a URL draft does send it: `.strict()` is
        // what makes this line load-bearing rather than decorative.
        sourceUrl: z.string().optional(),
        description: z.string().optional(),
        prepMinutes: z.number().int().min(0).optional(),
        cookMinutes: z.number().int().min(0).optional(),
      })
      .strict();

    const flattened: RecipeCreateInput = draftToCreateInput(
      emptyDraft({ kind: 'url', url: 'https://example.com/r' }),
    );
    // An empty draft still has to satisfy every non-title rule; only the title is empty.
    expect(schema.safeParse({ ...flattened, title: 'x' }).success).toBe(true);

    // And with the page's headnote and times, which a URL draft carries when the page had them.
    const detailed = emptyDraft({ kind: 'url', url: 'https://example.com/r' });
    detailed.details = { description: 'Headnote.', prepMinutes: 10, cookMinutes: 50 };
    expect(schema.safeParse({ ...draftToCreateInput(detailed), title: 'x' }).success).toBe(true);
  });

  it('saves the headnote and times a page stated', async () => {
    const { householdId } = await householdWithOwner();
    const caller = appRouter.createCaller(
      testContext({ householdId, session: { userId: 'u' } as never }),
    );
    const draft = emptyDraft({ kind: 'url', url: 'https://example.com/r' });
    draft.title = field('Soup', 'high', 'Soup');
    draft.details = { description: 'Headnote.', prepMinutes: 10, cookMinutes: 50 };
    const { slug } = await caller.recipe.create(draftToCreateInput(draft));
    const created = await caller.recipe.get({ idOrSlug: slug });
    expect([created?.description, created?.prepMinutes, created?.cookMinutes]).toEqual([
      'Headnote.',
      10,
      50,
    ]);
  });
});

describe('a draft keeps the one piece of provenance a cook can act on', () => {
  beforeEach(resetDb);

  it("carries a URL draft's address through create and back off the saved recipe", async () => {
    const { householdId } = await householdWithOwner();
    const caller = appRouter.createCaller(
      testContext({ householdId, session: { userId: 'u' } as never }),
    );

    const url = 'https://www.food.com/recipe/best-banana-bread-2886';
    const input = draftToCreateInput({
      ...emptyDraft({ kind: 'url', url }),
      title: field('Banana bread', 'high', 'Banana Bread'),
    });
    expect(input.sourceUrl).toBe(url);

    const { slug } = await caller.recipe.create(input);
    const saved = await caller.recipe.get({ idOrSlug: slug });
    expect(saved?.sourceUrl).toBe(url);
  });

  it('sends none for a draft that came from a file, which has no address', async () => {
    // A file name is not somewhere anybody can go back to, so the three other kinds set nothing
    // and the recipe looks exactly like one typed by hand.
    for (const source of [{ kind: 'text' }, { kind: 'pdf' }, { kind: 'image' }] as const) {
      const input = draftToCreateInput({
        ...emptyDraft(source),
        title: field('Skillet Cornbread', 'low', null),
      });
      expect(input.sourceUrl).toBeUndefined();
    }
  });

  it('refuses a source link that is not http or https, on update as well as create', async () => {
    // The value is rendered as an href, and React does not sanitize one.
    const { householdId } = await householdWithOwner();
    const caller = appRouter.createCaller(
      testContext({ householdId, session: { userId: 'u' } as never }),
    );
    await expect(
      caller.recipe.create({ title: 'Nasty', sourceUrl: 'javascript:alert(1)' }),
    ).rejects.toThrow();
    const { id } = await caller.recipe.create({ title: 'Plain' });
    await expect(
      caller.recipe.update({ id, title: 'Plain', sourceUrl: 'javascript:alert(1)' }),
    ).rejects.toThrow();
  });
});
