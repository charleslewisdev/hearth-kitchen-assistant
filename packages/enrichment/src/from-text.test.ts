import { describe, it, expect } from 'vitest';
import { MAX_TEXT_LENGTH, parseIngredientLine } from '@hearth/shared';
import { draftFromText } from './from-text';
import type { RecipeDraft } from './draft';

/**
 * The heuristics, exercised on the shapes a cook actually pastes.
 *
 * These are fixtures written as string literals rather than files, because the input IS text:
 * a checked-in `.txt` would add a hop without adding evidence. The two that came off a real
 * pipeline are marked - the OCR one is what tesseract returned for the photo fixture, and the
 * PDF one is what the extractor returned for the PDF fixture - so the shapes those tools
 * produce are pinned here even though the tools are not run.
 */

const PASTED = 'text' as const;

function at(text: string): RecipeDraft {
  const draft = draftFromText(text, { kind: PASTED });
  if (!draft) throw new Error('no recipe found in that text');
  return draft;
}

describe('a recipe with headings, as OCR returns it', () => {
  /**
   * VERBATIM tesseract output for `test/fixtures/cookbook-page.jpg`, captured 2026-09-10.
   *
   * The blank lines are tesseract's, and they are the reason blank lines cannot be the primary
   * signal for anything: it put one between every ingredient, one between steps 2 and 3, and
   * none between steps 1 and 2.
   */
  const text = `Skillet Cornbread
Serves 8 - Prep 10 minutes - Bake 25 minutes
INGREDIENTS

1 1/2 cups yellow cornmeal

1/2 cup all-purpose flour

2 tsp baking powder

1 tsp fine sea salt

1 1/4 cups buttermilk

2 large eggs

4 Tbsp unsalted butter, melted

2 Tbsp honey

Flaky salt, for serving

METHOD

1. Heat the oven to 425F and put a 10-inch cast iron
skillet on the middle rack while it comes up to heat.
2. Whisk the cornmeal, flour, baking powder and salt
together in a large bowl.

3. Beat the buttermilk and eggs in a second bowl, then
pour them into the dry ingredients with the melted
butter and the honey. Stir until it just comes together.
4. Take the hot skillet out, swirl in a little butter, and
pour in the batter. It should hiss.

5. Bake for 25 minutes, until the top is golden and a
skewer comes out clean. Serve it warm.
`;
  const draft = at(text);

  it('takes the first line as the title', () => {
    expect(draft.title.value).toBe('Skillet Cornbread');
  });

  it('reads every ingredient, including the one with no amount on it', () => {
    expect(draft.ingredientLines.value).toEqual([
      '1 1/2 cups yellow cornmeal',
      '1/2 cup all-purpose flour',
      '2 tsp baking powder',
      '1 tsp fine sea salt',
      '1 1/4 cups buttermilk',
      '2 large eggs',
      '4 Tbsp unsalted butter, melted',
      '2 Tbsp honey',
      'Flaky salt, for serving',
    ]);
  });

  it('keeps the headings out of the ingredients', () => {
    expect(draft.ingredientLines.value).not.toContain('INGREDIENTS');
    expect(draft.ingredientLines.value).not.toContain('METHOD');
  });

  it('rejoins each numbered step from the lines it was wrapped across', () => {
    expect(draft.steps.value).toHaveLength(5);
    expect(draft.steps.value[0]).toBe(
      'Heat the oven to 425F and put a 10-inch cast iron skillet on the middle rack while it comes up to heat.',
    );
    expect(draft.steps.value[2]).toContain('Stir until it just comes together.');
  });

  it('strips the step number, because the app numbers steps itself', () => {
    expect(draft.steps.value.every((step) => !/^\d/.test(step))).toBe(true);
  });

  it('reads the servings out of the line under the title', () => {
    expect(draft.servings.value).toBe(8);
    expect(draft.servings.raw).toBe('Serves 8 - Prep 10 minutes - Bake 25 minutes');
  });

  it('does not let a wrapped step line that starts with a number join the ingredients', () => {
    // "425F and put a 10-inch cast iron" leads with a number and would otherwise read as an
    // amount. Nothing from the method may end up in the ingredient list.
    expect(draft.ingredientLines.value.some((line) => line.includes('cast iron'))).toBe(false);
  });

  it('flags every field, because all of this is inference', () => {
    for (const field of [
      draft.title,
      draft.servings,
      draft.mealTypes,
      draft.tags,
      draft.ingredientLines,
      draft.steps,
    ]) {
      expect(field.confidence).toBe('low');
    }
  });

  it('remembers that it came from text rather than from a page', () => {
    expect(draft.source).toEqual({ kind: 'text' });
  });
});

describe('a recipe with no headings at all', () => {
  const draft = at(`Weeknight Lentil Soup

Serves 4

2 Tbsp olive oil
1 onion, diced
2 celery sticks, diced
1 cup brown lentils
4 cups vegetable stock
Salt and pepper

Soften the onion and celery in the oil over a low heat for ten minutes.

Add the lentils and the stock, bring it to a boil, then simmer for half an hour.

Season it well and serve.`);

  it('finds the ingredient block by its shape', () => {
    expect(draft.ingredientLines.value).toEqual([
      '2 Tbsp olive oil',
      '1 onion, diced',
      '2 celery sticks, diced',
      '1 cup brown lentils',
      '4 cups vegetable stock',
      'Salt and pepper',
    ]);
  });

  it('takes the prose after it as the steps, one per paragraph', () => {
    expect(draft.steps.value).toEqual([
      'Soften the onion and celery in the oil over a low heat for ten minutes.',
      'Add the lentils and the stock, bring it to a boil, then simmer for half an hour.',
      'Season it well and serve.',
    ]);
  });

  it('does not mistake the servings line for an ingredient', () => {
    expect(draft.servings.value).toBe(4);
    expect(draft.ingredientLines.value).not.toContain('Serves 4');
  });

  it('still finds the title above it all', () => {
    expect(draft.title.value).toBe('Weeknight Lentil Soup');
  });
});

describe('amounts written as words', () => {
  // The parser reads "a green bell pepper" as one of them, and prose starts the same way.
  const draft = at(`Stuffed Peppers

One year ago: Onion Soup and Potato Salad

2 Tbsp olive oil
1 onion, diced
a green bell pepper
1 cup rice
2 cups tomato sauce

Heat the oven. A hot oven matters here.`);

  it('finds the list by its figures and keeps the worded line inside it', () => {
    expect(draft.ingredientLines.value).toEqual([
      '2 Tbsp olive oil',
      '1 onion, diced',
      'a green bell pepper',
      '1 cup rice',
      '2 cups tomato sauce',
    ]);
  });
});

describe('a numbered method with no headings over it', () => {
  /**
   * The case that decides where the ingredient list STOPS when nothing names it.
   *
   * Both traps are here on purpose. `1. Heat the oven to` reads as an amount of 1 to
   * `parseIngredientLine`, exactly as `1 tsp salt` does, and `425F and put a 10-inch cast iron
   * skillet on the rack.` reads as an amount of 425 - so without the step-ordinal test and the
   * bare-number cap in `leadsWithAmount`, the method walks into the ingredient list. The
   * heading-led fixture above cannot show this: there, the headings say where the list ends and
   * the shape rules are never consulted.
   */
  const draft = at(`Skillet Cornbread

Serves 8

1 1/2 cups yellow cornmeal
1/2 cup all-purpose flour
2 tsp baking powder
1 1/4 cups buttermilk
2 large eggs

1. Heat the oven to
425F and put a 10-inch cast iron skillet on the rack.
2. Whisk the cornmeal, flour and baking powder together
in a large bowl.
3. Bake for 25 minutes, until a skewer comes out clean.`);

  it('keeps the method out of the ingredients', () => {
    expect(draft.ingredientLines.value).toEqual([
      '1 1/2 cups yellow cornmeal',
      '1/2 cup all-purpose flour',
      '2 tsp baking powder',
      '1 1/4 cups buttermilk',
      '2 large eggs',
    ]);
  });

  it('splits the method on its numbering and rejoins each wrapped step', () => {
    expect(draft.steps.value).toEqual([
      'Heat the oven to 425F and put a 10-inch cast iron skillet on the rack.',
      'Whisk the cornmeal, flour and baking powder together in a large bowl.',
      'Bake for 25 minutes, until a skewer comes out clean.',
    ]);
  });
});

describe('a narrative recipe, where the method leads with amounts too', () => {
  /**
   * The case the ingredient-line word cap is for.
   *
   * Two of these method sentences lead with an amount that `parseIngredientLine` reads happily
   * - "2 onions, halved, ..." and "3 hours later ..." - and both are inside the gap the run
   * tolerates. Length is the only thing that separates them from an ingredient line: they are
   * thirty and twenty-two words, against a median of five across the saved page fixtures.
   */
  const draft = at(`Braised Beans

500 g dried beans, soaked overnight
2 onions
1 head of garlic
Olive oil

Put the beans in a wide pot and cover them with cold water by two inches, then bring them slowly up to a simmer.

2 onions, halved, and the whole head of garlic go in at that point, along with a good glug of olive oil and a big pinch of salt.

3 hours later they should be creamy; top up with boiling water whenever they look dry, and never let them boil hard.`);

  it('keeps the sentences out of the ingredient list', () => {
    expect(draft.ingredientLines.value).toEqual([
      '500 g dried beans, soaked overnight',
      '2 onions',
      '1 head of garlic',
      'Olive oil',
    ]);
  });

  it('takes all three sentences as steps', () => {
    expect(draft.steps.value).toHaveLength(3);
    expect(draft.steps.value[1]).toContain('2 onions, halved');
  });
});

describe('headings, when shape alone would find nothing', () => {
  const draft = at(`Pancakes
Ingredients:
Flour
Milk
An egg
Butter for the pan
Method:
Whisk it all together and fry spoonfuls of it until bubbles show.`);

  it('takes what the headings bracket, even with no amount on any line', () => {
    expect(draft.ingredientLines.value).toEqual(['Flour', 'Milk', 'An egg', 'Butter for the pan']);
  });

  it('takes what follows the method heading as the steps', () => {
    expect(draft.steps.value).toEqual([
      'Whisk it all together and fry spoonfuls of it until bubbles show.',
    ]);
  });
});

describe('the punctuation a paste actually arrives with', () => {
  it('strips bullet markers before the amount', () => {
    const draft = at(`Bullet Salad
* 2 cups spinach
* 1 Tbsp olive oil
- 1 tsp mustard
• 1 clove garlic, crushed

Toss it all together.`);
    expect(draft.ingredientLines.value).toEqual([
      '2 cups spinach',
      '1 Tbsp olive oil',
      '1 tsp mustard',
      '1 clove garlic, crushed',
    ]);
  });

  it('drops a section label inside the ingredient block rather than buying it as a food', () => {
    // "For the topping:" would otherwise become an ingredient, and then a Food row, and then a
    // line on the shopping list.
    const draft = at(`Crumble
For the filling:
4 cups sliced apples
2 Tbsp sugar
1 tsp cinnamon
For the topping:
1 cup rolled oats
1/2 cup butter

Bake it for forty minutes.`);
    expect(draft.ingredientLines.value).toEqual([
      '4 cups sliced apples',
      '2 Tbsp sugar',
      '1 tsp cinnamon',
      '1 cup rolled oats',
      '1/2 cup butter',
    ]);
  });

  it('rejoins a word split across a line break by a hyphen', () => {
    // What a PDF's text layer does at the right margin, and what OCR copies from it.
    const draft = at(`Pie
1 cup flour
1 tsp salt
2 Tbsp butter

Roll the pastry out and line the tin, then chill it while the oven comes up to tem-
perature.`);
    expect(draft.steps.value[0]).toContain('comes up to temperature.');
  });

  it('reads a windows line ending the same as a unix one', () => {
    const draft = at('Soup\r\n2 cups stock\r\n1 tsp salt\r\n1 onion\r\n\r\nSimmer it.\r\n');
    expect(draft.ingredientLines.value).toHaveLength(3);
    expect(draft.steps.value).toEqual(['Simmer it.']);
  });
});

describe('how many it serves', () => {
  const withYield = (line: string) =>
    at(`Cookies\n${line}\n\n2 cups flour\n1 cup sugar\n2 eggs\n\nBake them.`);

  it.each([
    ['Serves 6', 6],
    ['serves 6', 6],
    ['6 servings', 6],
    ['Yield: 6 servings', 6],
    ['Makes 6', 6],
    ['Makes about 6 portions', 6],
  ])('reads %s', (line, expected) => {
    expect(withYield(line).servings.value).toBe(expected);
  });

  it('falls back to 1 when nothing says, and keeps raw empty rather than inventing a source', () => {
    const draft = at('Cookies\n\n2 cups flour\n1 cup sugar\n2 eggs\n\nBake them.');
    expect(draft.servings.value).toBe(1);
    expect(draft.servings.raw).toBe(null);
  });

  it('does not read a serving count out of a sentence that merely says "serves"', () => {
    // "Serves well with 4 slices" is what a loose gap between the verb and the number buys.
    const draft = at(
      'Bread\nServes well with 4 slices of good ham\n\n2 cups flour\n1 tsp salt\n1 packet yeast\n\nBake it.',
    );
    expect(draft.servings.value).toBe(1);
  });

  it('ignores a number that is not a serving count', () => {
    // "Bake 25 minutes" is not 25 servings, and neither is a temperature.
    const draft = at(
      'Cookies\nBake 25 minutes at 350F\n\n2 cups flour\n1 cup sugar\n2 eggs\n\nBake.',
    );
    expect(draft.servings.value).toBe(1);
  });
});

describe('what comes after the method', () => {
  const draft = at(`Bread
2 cups flour
1 tsp salt
1 packet yeast

Mix, knead, prove and bake.

Notes
Keeps two days wrapped on the counter.
Nutrition
Calories 210 per slice`);

  it('stops the steps at a notes heading', () => {
    expect(draft.steps.value).toEqual(['Mix, knead, prove and bake.']);
  });
});

describe('text with no recipe in it', () => {
  it('returns null for an article that merely mentions cooking', () => {
    expect(
      draftFromText(
        `Why I stopped buying pre-ground pepper

It goes stale. That is the whole post. A peppercorn keeps its oils until it is cracked,
and the tin on the shelf cracked them a year before it reached you.`,
        { kind: PASTED },
      ),
    ).toBe(null);
  });

  it('returns null for empty and for whitespace', () => {
    expect(draftFromText('', { kind: PASTED })).toBe(null);
    expect(draftFromText('   \n\n \t \n', { kind: PASTED })).toBe(null);
  });

  it('returns null for two stray measurements in a piece of prose', () => {
    // Both of these lines DO lead with an amount, and are the reason the minimum is three
    // rather than one: a post that lists what is on somebody's counter is not a recipe. Set
    // MIN_INGREDIENT_LINES to 2 and this returns a draft.
    expect(
      draftFromText(
        `What lives on my counter

2 tsp flaky salt in a little dish

1 bottle of olive oil, never refrigerated

and nothing else, because everything else has a cupboard.`,
        { kind: PASTED },
      ),
    ).toBe(null);
  });

  it('returns a draft for an ingredient list with no method, which is a real thing to paste', () => {
    const draft = at('Spice rub\n2 Tbsp paprika\n1 Tbsp cumin\n1 tsp cayenne');
    expect(draft.ingredientLines.value).toHaveLength(3);
    expect(draft.steps.value).toEqual([]);
  });
});

describe('one parser, not two', () => {
  it('hands over lines the shared parser turns into structure', () => {
    const draft = at(`Skillet Cornbread
INGREDIENTS
1 1/2 cups yellow cornmeal
2 tsp baking powder
4 Tbsp unsalted butter, melted
Flaky salt, for serving
METHOD
1. Bake it.`);
    const parsed = draft.ingredientLines.value.map((line) => parseIngredientLine(line));

    expect(parsed[0]).toEqual({
      quantity: 1.5,
      unit: 'cup',
      foodName: 'yellow cornmeal',
      note: null,
    });
    expect(parsed[2]).toEqual({
      quantity: 4,
      unit: 'tbsp',
      foodName: 'unsalted butter',
      note: 'melted',
    });
    // The quantity-less one survives with no amount invented for it.
    expect(parsed[3]).toEqual({
      quantity: null,
      unit: null,
      foodName: 'Flaky salt',
      note: 'for serving',
    });
    expect(parsed.every((p) => p.foodName !== '')).toBe(true);
  });
});

describe('text built to be expensive rather than to be a recipe', () => {
  /*
    The word cap counts space-separated tokens, so a line with no spaces in it is ONE word
    however long it is - and that is exactly what a PDF's text layer produces when its items
    share a baseline. Together with the unanchored parenthetical rule in `parseIngredientLine`,
    that made a 100,000-character line quadratic: 3,127ms of blocked event loop, measured
    through `draftFromText` with an HTTP server answering /health in the same process. It is
    now 2ms.
  */
  it('does not treat a line of a hundred thousand characters as an ingredient', () => {
    const started = Date.now();
    const draft = draftFromText(
      `Pastry\n2 cups flour\n1 tsp salt\n2 Tbsp butter\n${'('.repeat(50_000)}`,
      { kind: PASTED },
    );
    expect(Date.now() - started).toBeLessThan(1000);
    expect(draft?.ingredientLines.value).toEqual(['2 cups flour', '1 tsp salt', '2 Tbsp butter']);
  });

  it('refuses text longer than the cap the shared constant claims', () => {
    // `MAX_TEXT_LENGTH` is enforced HERE rather than at each caller, because a PDF's text layer
    // and a photo's OCR output both arrive through this function and neither passes through a
    // zod schema on the way. Only `import.fromText` has an input schema to check it in.
    const long = `Soup\n2 cups stock\n1 tsp salt\n1 onion\n${'a '.repeat(MAX_TEXT_LENGTH)}`;
    expect(long.length).toBeGreaterThan(MAX_TEXT_LENGTH);
    expect(draftFromText(long, { kind: PASTED })).toBe(null);
  });

  it('still reads a recipe that is merely long', () => {
    const padding = 'Serve it with bread and a green salad. '.repeat(200);
    const draft = draftFromText(
      `Soup\n2 cups stock\n1 tsp salt\n1 onion\n\nSimmer it. ${padding}`,
      { kind: PASTED },
    );
    expect(draft?.ingredientLines.value).toHaveLength(3);
  });
});

describe('what printed pages and their photographs add around a recipe', () => {
  /*
    The shapes below come from the first import test on real files (2026-09-22): web recipes
    printed to PDF, photographs of those printouts, and a cookbook page. The recipes here are
    written for this repo; only the shape of what the tools did to them is copied.
  */

  it('strips the bullet glyphs tesseract reads a printed bullet as', () => {
    const draft = at(`Citrus Pork
Ingredients
e 3 pounds pork shoulder
« 2 teaspoons salt
|e 1 tablespoon cumin
+ 2 oranges, juiced
Instructions
e Season the pork all over.
« Roast it low until it falls apart.`);
    expect(draft.ingredientLines.value).toEqual([
      '3 pounds pork shoulder',
      '2 teaspoons salt',
      '1 tablespoon cumin',
      '2 oranges, juiced',
    ]);
    // And a misread bullet still starts a step, as a printed one does: the carnitas printout
    // from the pilot has an evenly spaced bulleted method, and without this its wrapped lines
    // came apart at every blank line OCR guessed at.
    expect(draft.steps.value).toEqual([
      'Season the pork all over.',
      'Roast it low until it falls apart.',
    ]);
  });

  it('keeps a short label ending in a colon out of the bullet above it', () => {
    const draft = at(`Carnitas
Ingredients
• 3 pounds pork shoulder
• 2 teaspoons salt
• 2 oranges, juiced
Instructions
e Shred the pork
with two forks.
TO CRISP IN THE OVEN:
e Broil it for 5 minutes.`);
    expect(draft.steps.value).toEqual([
      'Shred the pork with two forks.',
      'TO CRISP IN THE OVEN:',
      'Broil it for 5 minutes.',
    ]);
  });

  it('leaves a lone "e" alone when a lower-case word follows, because that is Italian', () => {
    const draft = at(`Sugo
2 cups passata
1 tsp salt
3 leaves basil
Method
Scaldare l'olio
e poi aggiungere il sugo.`);
    expect(draft.steps.value[0]).toBe("Scaldare l'olio e poi aggiungere il sugo.");
  });

  it('drops the header and footer a browser prints on every page', () => {
    const draft = at(`Lemon Chicken | Some Food Site 6/24/18, 10*10 AM
Serves 4
2 pounds chicken thighs
2 lemons, juiced
1 tsp salt
https://www.example.com/recipes/lemon-chicken Page 1 of 2

Roast the chicken with the lemon.
https://www.example.com/recipes/lemon-chicken 4/1/25, 1:20 AM Page 2 of 2`);
    expect(draft.title.value).toBe('Lemon Chicken');
    expect(draft.ingredientLines.value).toEqual([
      '2 pounds chicken thighs',
      '2 lemons, juiced',
      '1 tsp salt',
    ]);
    expect(draft.steps.value).toEqual(['Roast the chicken with the lemon.']);
  });

  it('does not take a breadcrumb or a line of OCR noise for the title', () => {
    const draft = at(`Recipes > Weeknight Dinners
BE TT Ga
Braised Leeks
3 leeks, halved
1 cup stock
2 Tbsp butter

Braise until soft.`);
    expect(draft.title.value).toBe('Braised Leeks');
  });

  it('splits a method numbered "Step 1", "Step 2", with the number on its own line or not', () => {
    const draft = at(`Saltimbocca
4 chicken cutlets
8 sage leaves
2 Tbsp butter
Directions
Step 1
Pound the chicken thin.
Step 2 Lay the sage on it
and fry it in the butter.
Step 3: Serve it hot.`);
    expect(draft.steps.value).toEqual([
      'Pound the chicken thin.',
      'Lay the sage on it and fry it in the butter.',
      'Serve it hot.',
    ]);
  });

  it('rejoins an ingredient a narrow column wrapped onto a second line', () => {
    const draft = at(`Green Eggs
1 pound spinach
1½ teaspoons Aleppo pepper or 1
teaspoon paprika plus a pinch of
cayenne
2 cloves garlic (thinly
sliced)
1 teaspoon harissa, plus more to taste
(brands vary in heat)
½ cup peas
salt
6 eggs

Cook the greens, then the eggs.`);
    expect(draft.ingredientLines.value).toEqual([
      '1 pound spinach',
      '1½ teaspoons Aleppo pepper or 1 teaspoon paprika plus a pinch of cayenne',
      '2 cloves garlic (thinly sliced)',
      '1 teaspoon harissa, plus more to taste (brands vary in heat)',
      '½ cup peas',
      'salt',
      '6 eggs',
    ]);
  });

  it('drops a section label that has no colon after it', () => {
    const draft = at(`Spinach Chicken
Ingredients
To Marinate
1 pound chicken
1 tablespoon lemon juice
To make the paste
8 ounces spinach
2 green chilies
Other Ingredients
2 tablespoons oil
For serving, lemon wedges`);
    expect(draft.ingredientLines.value).toEqual([
      '1 pound chicken',
      '1 tablespoon lemon juice',
      '8 ounces spinach',
      '2 green chilies',
      '2 tablespoons oil',
      'For serving, lemon wedges',
    ]);
  });

  it('stops the ingredient list at a "My Private Notes" box', () => {
    const draft = at(`Shakshuka
4 eggs
1 can tomatoes
1 tsp cumin
My Private Notes`);
    expect(draft.ingredientLines.value).toEqual(['4 eggs', '1 can tomatoes', '1 tsp cumin']);
  });

  it('reads a select-all paste of a recipe page, with its buttons and photo credits', () => {
    // The shape of Allrecipes copied from the browser: the facts grid puts the label and the
    // number on separate lines, the scale buttons sit above the list, and a photo credit sits
    // under every step.
    const draft = at(`White Bean Skillet
Prep Time:
10 mins
Servings:
4
Ingredients
1/2X
1X
2X

Original recipe (1X) yields 4 servings

1 tablespoon olive oil

2 cloves garlic, minced

2 cans white beans, drained

Directions

Warm the oil and cook the garlic.

Studio Photo Credit

Add the beans and heat through.

Studio Photo Credit

Nutrition Facts (per serving)
604
Calories`);
    expect(draft.ingredientLines.value).toEqual([
      '1 tablespoon olive oil',
      '2 cloves garlic, minced',
      '2 cans white beans, drained',
    ]);
    expect(draft.steps.value).toEqual([
      'Warm the oil and cook the garlic.',
      'Add the beans and heat through.',
    ]);
    expect(draft.servings.value).toBe(4);
  });

  it('keeps a step that happens to repeat when it is a sentence', () => {
    const draft = at(`Twice Stirred
1 cup rice
2 cups water
1 tsp salt

Stir.

Wait five minutes, covered, off the heat entirely.

Stir.`);
    expect(draft.steps.value).toEqual([
      'Stir.',
      'Wait five minutes, covered, off the heat entirely.',
      'Stir.',
    ]);
  });

  it('splits a bulleted method into one step per bullet', () => {
    // A PDF has no blank lines, so the bullets are all there is.
    const draft = at(`Green Eggs
1 pound spinach
6 eggs
1 tsp salt
DIRECTIONS
● Wilt the spinach with the salt,
using your hands.
● Make six wells and crack
an egg into each.`);
    expect(draft.steps.value).toEqual([
      'Wilt the spinach with the salt, using your hands.',
      'Make six wells and crack an egg into each.',
    ]);
  });

  it('keeps every new pattern linear on hostile lines', () => {
    const hostile = [
      `${'Step '.repeat(20_000)}1`,
      `${'1/1/11, 1:11 am '.repeat(5_000)}x`,
      `${'page 1 of '.repeat(10_000)}x`,
      `https://${'a'.repeat(60_000)}`,
      `For the ${'a'.repeat(60_000)}`,
      `${'e '.repeat(30_000)}A`,
      `x ${'('.repeat(40_000)}`,
      `x${' and'.repeat(20_000)}`,
      `Notes (${'('.repeat(60_000)}`,
      `Servings:\n${'9'.repeat(60_000)}`,
      `per serving${' '.repeat(60_000)}x`,
      `Nutrition${' info'.repeat(20_000)}`,
      `ingredient tips${'s'.repeat(60_000)}:`,
      `${'¢ '.repeat(30_000)}A`,
      `${'\n'.repeat(2)}2 cups${' x'.repeat(30_000)}`,
    ];
    for (const line of hostile) {
      const started = Date.now();
      draftFromText(`Soup\n2 cups stock\n1 tsp salt\n${line}\n${line}`, { kind: PASTED });
      expect(Date.now() - started).toBeLessThan(500);
    }
  });
});

describe('a two-column cookbook page, read a column at a time', () => {
  /*
    The shape `reading-order.ts` hands over for a photographed cookbook page: the ingredient
    column whole, with a blank line above each ingredient and none inside a wrapped one, then
    the nutrition line under that column, then the method column beside it, then a tip. The
    recipe is written for this repo; the shape is the pilot photos' (2026-09-23).
  */
  const text = `Roasted Pepper Dip

1 (12-ounce) jar roasted
red peppers, drained

1 (14.5-ounce) can diced
tomatoes, undrained

1/2 cup almonds

2 teaspoons red
wine vinegar

1 teaspoon smoked
paprika or 1/2 teaspoon
cayenne pepper

Sliced raw vegetables,
for serving

Per Serving Calories: 107; Total
Fat: 9g; Protein: 2g

1. In a blender, combine the peppers,
tomatoes, almonds and vinegar.
2. Blend until smooth.
3. Serve with the vegetables.

Ingredient tip: Look for fire-roasted
tomatoes to add more flavor.`;
  const draft = at(text);

  it('joins each ingredient a narrow column wrapped, by the space left between ingredients', () => {
    expect(draft.ingredientLines.value).toEqual([
      '1 (12-ounce) jar roasted red peppers, drained',
      '1 (14.5-ounce) can diced tomatoes, undrained',
      '1/2 cup almonds',
      '2 teaspoons red wine vinegar',
      '1 teaspoon smoked paprika or 1/2 teaspoon cayenne pepper',
      'Sliced raw vegetables, for serving',
    ]);
  });

  it('finds the method after the nutrition line under the ingredient column, and ends it at the tip', () => {
    expect(draft.steps.value).toEqual([
      'In a blender, combine the peppers, tomatoes, almonds and vinegar.',
      'Blend until smooth.',
      'Serve with the vegetables.',
    ]);
  });

  it('leaves a paste with no blank lines in its list to the ordinary wrap rule', () => {
    // No blank lines, so nothing says "red peppers, drained" is a wrap and not a food.
    const pasted = at('Dip\n1 jar roasted\nred peppers, drained\n1 can tomatoes\n1 cup almonds');
    expect(pasted.ingredientLines.value).toHaveLength(4);
  });

  it('reads the main recipe, not the sub-recipe under it that is one line longer', () => {
    const page = at(`Rice Mold
2 cups rice
1 onion, chopped
3 tbl butter
4 cups broth
1 Recipe Meat Sauce

1. Cook the rice in the broth.
2. Fill the mold.

Meat Sauce
1 tbl olive oil
1 small onion
1 lb ground beef
2 cloves garlic
1 can tomatoes
1/4 cup red wine

1. Brown the beef and simmer it all.`);
    expect(page.ingredientLines.value[0]).toBe('2 cups rice');
    expect(page.steps.value[0]).toBe('Cook the rice in the broth.');
  });

  it('reads a cent sign as a misread bullet too', () => {
    const page = at(`Pork
2 pounds pork
1 tsp salt
1 tsp cumin
Instructions
e Roast the pork.
¢ Pour 1 ladle of the liquid over it.`);
    expect(page.steps.value).toEqual(['Roast the pork.', 'Pour 1 ladle of the liquid over it.']);
  });
});
