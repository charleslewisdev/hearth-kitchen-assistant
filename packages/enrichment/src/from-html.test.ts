import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { parseIngredientLine } from '@hearth/shared';
import { draftFromHtml } from './from-html';

/**
 * Fixtures are checked-in HTML. All are hand-authored: invented recipes in the markup shapes real
 * sites emit, each named for the shape it holds, with a comment at the top of the file saying
 * so. The suite never touches the network, so it cannot go red because a site is down or
 * because somebody shipped a redesign this week.
 */
function fixture(name: string): string {
  return readFileSync(fileURLToPath(new URL(`../test/fixtures/${name}`, import.meta.url)), 'utf8');
}

const at = (name: string, url: string) => {
  const draft = draftFromHtml(fixture(name), url);
  if (!draft) throw new Error(`no recipe found in ${name}`);
  return draft;
};

describe('JSON-LD inside a @graph, among seven other node types', () => {
  const draft = at('ld-graph-sheet-pan-chicken.html', 'https://www.example.com/x/');

  it('finds the Recipe node and takes its name', () => {
    expect(draft.title.value).toBe('Sheet Pan Lemon Chicken');
    expect(draft.title.confidence).toBe('high');
  });

  it('reads a recipeYield given as an array of one string', () => {
    expect(draft.servings.value).toBe(5);
    expect(draft.servings.confidence).toBe('high');
    expect(draft.servings.raw).toBe('5');
  });

  it('takes recipeIngredient as written, with runs of whitespace collapsed', () => {
    expect(draft.ingredientLines.value).toHaveLength(8);
    expect(draft.ingredientLines.value[0]).toBe('4 Tbsp olive oil ($0.40)');
    expect(draft.ingredientLines.confidence).toBe('high');
  });

  it('unwraps HowToStep objects into their text', () => {
    expect(draft.steps.value).toHaveLength(5);
    expect(draft.steps.value[0]).toContain('Preheat the oven to 400');
    expect(draft.steps.confidence).toBe('high');
  });

  it('maps the site categories onto Hearth meal types, at low confidence', () => {
    expect(draft.mealTypes.value).toEqual(['dinner']);
    expect(draft.mealTypes.confidence).toBe('low');
    expect(draft.mealTypes.raw).toBe('Dinner, Main Course');
  });

  it('turns keywords and cuisine into tags, at low confidence', () => {
    expect(draft.tags.value).toContain('American');
    expect(draft.tags.value).toContain('Baked Chicken');
    expect(draft.tags.confidence).toBe('low');
  });

  it('remembers the URL it came from', () => {
    expect(draft.source).toEqual({ kind: 'url', url: 'https://www.example.com/x/' });
  });
});

describe('a recipeYield array whose entries disagree', () => {
  const draft = at('ld-yield-array-lentil-soup.html', 'https://www.example.com/x/');

  it('prefers the bare number over the prose one', () => {
    // The site emits ["4", "4 (Large bowls)"]. The first is unambiguous; the second is a note.
    expect(draft.servings.value).toBe(4);
    expect(draft.servings.confidence).toBe('high');
  });

  it('reads all seventeen ingredients', () => {
    expect(draft.ingredientLines.value).toHaveLength(17);
    // The site writes '1 Tbsp oil  ((or sub water))' with a double space. Collapsing runs of
    // whitespace is what `parseIngredientLine` does to the parts anyway, and it is what stops
    // the review screen showing gaps that look like a bug.
    expect(draft.ingredientLines.value[0]).toBe('1 Tbsp oil ((or sub water))');
  });

  it('folds an accented category onto the right meal type', () => {
    // "Entrée" -> entree -> dinner. A plain lowercase compare would miss it.
    expect(draft.mealTypes.value).toEqual(['dinner']);
  });
});

describe('a plain Recipe object, not wrapped in a @graph', () => {
  const draft = at('ld-plain-object-banana-loaf.html', 'https://www.example.com/recipe/x');

  it('finds it anyway', () => {
    expect(draft.title.value).toBe('Everyday Banana Loaf');
  });

  it('pulls the servings out of prose that leads with a different number', () => {
    // "1 loaf, 10 serving(s)": the first integer is the loaf, which is not the servings.
    expect(draft.servings.value).toBe(10);
    expect(draft.servings.confidence).toBe('high');
    expect(draft.servings.raw).toBe('1 loaf, 10 serving(s)');
  });

  it('reads ten steps', () => {
    expect(draft.steps.value).toHaveLength(10);
    expect(draft.steps.value[0]).toBe('Clear the oven and set a rack in the middle.');
  });

  it('splits a comma-separated keyword string into tags', () => {
    expect(draft.tags.value).toEqual(expect.arrayContaining(['Breads', 'Fruit', 'Oven']));
  });
});

describe('recipeInstructions as plain strings rather than HowToStep objects', () => {
  const draft = at('ld-string-steps-birthday-cake.html', 'https://www.example.com/x');

  it('takes them as they are', () => {
    expect(draft.steps.value).toHaveLength(17);
    expect(draft.steps.value[0]).toContain('To make the cake');
    expect(draft.steps.confidence).toBe('high');
  });

  it('reads servings out of "16 servings"', () => {
    expect(draft.servings.value).toBe(16);
    expect(draft.servings.confidence).toBe('high');
  });

  it('splits keywords on the double semicolon this site uses', () => {
    // "Layer cake;;Chocolate;;Vanilla;;Celebrations"
    expect(draft.tags.value).toEqual(
      expect.arrayContaining(['Layer cake', 'Chocolate', 'Vanilla', 'Celebrations']),
    );
    expect(draft.tags.value.some((t) => t.includes(';'))).toBe(false);
  });
});

describe('text that arrived HTML-encoded', () => {
  const draft = at('ld-encoded-pasta-with-peas.html', 'https://www.example.com/x/');

  it('decodes entities rather than storing them raw', () => {
    const joined = draft.steps.value.join('\n');
    expect(joined).not.toContain('&quot;');
    expect(joined).not.toContain('&amp;');
    expect(joined).toContain('1/5"');
  });

  it('still reads the ordinary fields', () => {
    expect(draft.title.value).toBe('Pasta with Peas (weeknight)');
    expect(draft.servings.value).toBe(4);
    expect(draft.ingredientLines.value).toHaveLength(11);
  });
});

describe('microdata, when there is no JSON-LD at all', () => {
  const draft = at('microdata-oat-cookies.html', 'https://example.com/oat-cookies');

  it('reads the recipe out of itemprop attributes', () => {
    expect(draft.title.value).toBe('Oat Cookies');
    expect(draft.ingredientLines.value).toHaveLength(8);
    expect(draft.ingredientLines.value[0]).toBe('1 cup rolled oats');
    expect(draft.steps.value).toHaveLength(5);
    expect(draft.steps.value[0]).toContain('Heat the oven to 350F');
  });

  it('flags a yield that is a count of cookies rather than of servings', () => {
    // "24 cookies" is a yield, not a serving count, and the review screen should say so.
    expect(draft.servings.value).toBe(24);
    expect(draft.servings.confidence).toBe('low');
    expect(draft.servings.raw).toBe('24 cookies');
  });

  it('maps its category and keywords too', () => {
    expect(draft.mealTypes.value).toEqual(['dessert']);
    expect(draft.tags.value).toEqual(expect.arrayContaining(['cookies', 'oats', 'baking']));
  });
});

describe('one parser, not two', () => {
  it('produces lines that parseIngredientLine turns into structure', () => {
    // The point of taking the site's line verbatim is that it meets the SAME parser a typed
    // line meets, inside `createRecipe`. Nothing in this package re-implements any of it; this
    // asserts the lines it hands over are the shape that parser expects.
    const draft = at('ld-plain-object-banana-loaf.html', 'https://www.example.com/recipe/x');
    const parsed = draft.ingredientLines.value.map((line) => parseIngredientLine(line));

    expect(parsed[0]).toEqual({
      quantity: 0.5,
      unit: 'cup',
      foodName: 'butter',
      note: 'softened',
    });
    // Every line yields a food name, which is what the shopping list is built out of.
    expect(parsed.every((p) => p.foodName !== '')).toBe(true);
  });

  it('leaves a quantity-less garnish alone rather than inventing one', () => {
    // Recipe sites list "Lime", "Avocado" and friends under an optional serving section.
    // A line with no amount is a real ingredient, and guessing "1" for it would be a lie.
    const draft = at('ld-yield-array-lentil-soup.html', 'https://www.example.com/x/');
    const lime = draft.ingredientLines.value.find((line) => line === 'Lime');
    expect(lime).toBeDefined();
    expect(parseIngredientLine(lime ?? '')).toEqual({
      quantity: null,
      unit: null,
      foodName: 'Lime',
      note: null,
    });
  });
});

describe('choosing WHICH recipe node, when a page offers more than one', () => {
  const wrap = (ld: string) =>
    `<html><head><script type="application/ld+json">${ld}</script></head><body></body></html>`;
  const stub = '{"@type":"Recipe","name":"Stub"}';

  it('falls through to microdata when the only JSON-LD Recipe is a stub', () => {
    // Before: `findRecipeNode() ?? recipeFromMicrodata()` only tried microdata when NO Recipe
    // node was found at all, so a stub node hid a perfectly good microdata recipe below it and
    // the cook was told the page had no recipe on it.
    const draft = draftFromHtml(
      `<html><head><script type="application/ld+json">${stub}</script></head><body>
        <div itemscope itemtype="http://schema.org/Recipe">
          <h1 itemprop="name">Real Cake</h1>
          <li itemprop="recipeIngredient">2 cups flour</li>
          <li itemprop="recipeInstructions">Bake it.</li>
        </div></body></html>`,
      'https://example.com/',
    );
    expect(draft?.title.value).toBe('Real Cake');
  });

  it('looks past a stub in one script block to a real recipe in the next', () => {
    const draft = draftFromHtml(
      `<html><head><script type="application/ld+json">${stub}</script>
       <script type="application/ld+json">{"@type":"Recipe","name":"Real","recipeIngredient":["2 cups flour"]}</script>
       </head></html>`,
      'https://example.com/',
    );
    expect(draft?.title.value).toBe('Real');
  });

  it('prefers the substantial recipe over a teaser earlier in the @graph', () => {
    // A sidebar "you might also like" card is a real Recipe node with one ingredient on it.
    // Taking the first one imported the teaser and left the actual recipe on the floor.
    const draft = draftFromHtml(
      wrap(
        `{"@graph":[
          {"@type":"Recipe","name":"Sidebar teaser","recipeIngredient":["see post"]},
          {"@type":"Recipe","name":"Real Recipe","recipeIngredient":["2 cups flour","1 tsp salt","3 eggs"],"recipeInstructions":["Mix.","Bake."]}]}`,
      ),
      'https://example.com/',
    );
    expect(draft?.title.value).toBe('Real Recipe');
    expect(draft?.ingredientLines.value).toHaveLength(3);
  });

  it('still finds the only recipe when a page has exactly one', () => {
    const draft = draftFromHtml(
      wrap('{"@type":"Recipe","name":"Only","recipeIngredient":["1 egg"]}'),
      'https://example.com/',
    );
    expect(draft?.title.value).toBe('Only');
  });

  it('recognises the schema.org URL spelling of @type', () => {
    // The form an older self-hosted blog emits, which is exactly what the microdata path is
    // here to serve, so refusing it defeated the point.
    for (const type of ['http://schema.org/Recipe', 'https://schema.org/Recipe']) {
      const draft = draftFromHtml(
        wrap(`{"@type":"${type}","name":"UrlTyped","recipeIngredient":["1 egg"]}`),
        'https://example.com/',
      );
      expect(draft?.title.value).toBe('UrlTyped');
    }
  });
});

describe('microdata instructions get the same treatment as JSON-LD ones', () => {
  const blob = '1. Heat the oven. 2. Mix the batter. 3. Bake for 30 minutes.';
  const microdata = (instructions: string) =>
    `<html><body><div itemscope itemtype="http://schema.org/Recipe">
      <h1 itemprop="name">M</h1><li itemprop="recipeIngredient">1 egg</li>
      <div itemprop="recipeInstructions">${instructions}</div></div></body></html>`;

  it('splits one prose block, and flags it, exactly as the JSON-LD path does', () => {
    // Real microdata pages put the whole method in a single element. Coming back as one
    // unsplit paragraph marked `high` is precisely what the review screen exists to catch,
    // and it was invisible because the hand-authored fixture uses one <li> per step.
    const draft = draftFromHtml(microdata(blob), 'https://example.com/');
    expect(draft?.steps.value).toEqual([
      'Heat the oven.',
      'Mix the batter.',
      'Bake for 30 minutes.',
    ]);
    expect(draft?.steps.confidence).toBe('low');
  });

  it('leaves genuinely separate elements alone, at high confidence', () => {
    const draft = at('microdata-oat-cookies.html', 'https://example.com/oat-cookies');
    expect(draft.steps.value).toHaveLength(5);
    expect(draft.steps.confidence).toBe('high');
  });
});

describe('smaller things that would read as a bug', () => {
  const wrap = (ld: string) =>
    `<html><head><script type="application/ld+json">${ld}</script></head></html>`;

  it('uses a HowToStep name when its text is empty rather than dropping the step', () => {
    // `??` only falls back on null/undefined, so an empty `text` beat a perfectly good `name`.
    const draft = draftFromHtml(
      wrap(
        '{"@type":"Recipe","name":"S","recipeIngredient":["1 egg"],"recipeInstructions":[{"@type":"HowToStep","text":"","name":"Chop the onion."},{"@type":"HowToStep","text":"Fry it."}]}',
      ),
      'https://example.com/',
    );
    expect(draft?.steps.value).toEqual(['Chop the onion.', 'Fry it.']);
  });

  it('matches a meal type as a word, not as a substring', () => {
    // "Dinnerware" is not dinner. The rules below this one already used word boundaries; this
    // one did not, so it was the loosest match in the function.
    const draft = draftFromHtml(
      wrap(
        '{"@type":"Recipe","name":"S","recipeIngredient":["1 egg"],"recipeCategory":"Dinnerware"}',
      ),
      'https://example.com/',
    );
    expect(draft?.mealTypes.value).toEqual([]);
  });

  it('still matches an ordinary plural category', () => {
    const draft = draftFromHtml(
      wrap(
        '{"@type":"Recipe","name":"S","recipeIngredient":["1 egg"],"recipeCategory":"Desserts"}',
      ),
      'https://example.com/',
    );
    expect(draft?.mealTypes.value).toEqual(['dessert']);
  });

  it.each([
    ['Side Dish', ['side']],
    ['Sauces and Condiments', ['sauce']],
    ['Salad Dressing', ['sauce']],
    ['Drinks', ['drink']],
    ['Cocktail', ['drink']],
    ['Stocks, Main Course', ['dinner', 'base']],
  ])('files the category %s under the recipe types', (category, expected) => {
    const draft = draftFromHtml(
      wrap(
        `{"@type":"Recipe","name":"S","recipeIngredient":["1 egg"],"recipeCategory":"${category}"}`,
      ),
      'https://example.com/',
    );
    expect(draft?.mealTypes.value).toEqual(expected);
  });
});

describe('the third rung: a page with no structured data at all', () => {
  const draft = at('unstructured-recipe-post.html', 'https://nineacres.example/leek-soup');

  it('reads the ingredient list out of the article text', () => {
    expect(draft.ingredientLines.value).toEqual([
      '3 leeks, white and pale green parts only',
      '2 Tbsp butter',
      '500 g floury potatoes, peeled and cubed',
      '1 l chicken stock',
      '150 ml double cream',
      'Salt and plenty of black pepper',
    ]);
  });

  it('reads the numbered method, one step per list item', () => {
    expect(draft.steps.value).toHaveLength(4);
    expect(draft.steps.value[0]).toBe(
      'Split the leeks lengthways, wash the grit out of them properly, and slice them into half moons.',
    );
    expect(draft.steps.value[3]).toContain('Serve it hot in winter and cold in August.');
  });

  it('stops the method at the notes heading', () => {
    expect(draft.steps.value.join(' ')).not.toContain('It freezes without the cream');
  });

  it('leaves the sidebar amounts out, because the recipe is inside <article>', () => {
    const joined = draft.ingredientLines.value.join(' ');
    expect(joined).not.toContain('oats');
    expect(joined).not.toContain('harissa');
  });

  it('reads the title and the servings', () => {
    expect(draft.title.value).toBe('Leek and potato soup');
    expect(draft.servings.value).toBe(6);
  });

  it('flags everything, because none of it was stated by the page', () => {
    expect(draft.ingredientLines.confidence).toBe('low');
    expect(draft.steps.confidence).toBe('low');
    expect(draft.title.confidence).toBe('low');
  });

  it('still says the draft came from the URL it was fetched from', () => {
    expect(draft.source).toEqual({ kind: 'url', url: 'https://nineacres.example/leek-soup' });
  });
});

describe('the title of a page with no structured data', () => {
  it("takes the page's own title over the line that happens to sit above the list", () => {
    // Smitten Kitchen's older posts carry no structured data, and between the headline and the
    // ingredients they print links to the posts from a year and two years before. The line
    // above the list was taken as the title of a Greek salad.
    const draft = draftFromHtml(
      `<html><head><title>greek salad with lemon and oregano – smitten kitchen</title></head>
      <body><article>
      <p>Some words about salad.</p>
      <p>One year ago: Onion Soup and Potato Salad</p>
      <p>2 tomatoes<br>1 cucumber<br>4 ounces feta<br>2 tablespoons olive oil</p>
      <p>Chop it all and toss it together.</p>
      </article></body></html>`,
      'https://blog.example/greek-salad',
    );
    expect(draft?.title.value).toBe('greek salad with lemon and oregano');
    expect(draft?.ingredientLines.value).toHaveLength(4);
  });
});

describe('pages with no recipe on them', () => {
  it('returns null for an article that merely mentions cooking', () => {
    expect(draftFromHtml(fixture('no-recipe-blog-post.html'), 'https://example.com/pepper')).toBe(
      null,
    );
  });

  it('returns null for markup that is not a page', () => {
    expect(draftFromHtml('', 'https://example.com/')).toBe(null);
    expect(draftFromHtml('<html><body><p>hello</p></body></html>', 'https://example.com/')).toBe(
      null,
    );
  });

  it('survives JSON-LD that does not parse', () => {
    const html = `<html><head><script type="application/ld+json">{not json</script></head></html>`;
    expect(draftFromHtml(html, 'https://example.com/')).toBe(null);
  });

  it('does not mistake a Recipe-shaped node of the wrong type for a recipe', () => {
    const html = `<html><head><script type="application/ld+json">
      {"@type":"Product","name":"A pan","recipeIngredient":["1 pan"]}
    </script></head></html>`;
    expect(draftFromHtml(html, 'https://example.com/')).toBe(null);
  });
});

describe('shapes real sites emit that the fixtures do not cover', () => {
  const wrap = (ld: string) =>
    `<html><head><script type="application/ld+json">${ld}</script></head><body></body></html>`;

  it('finds a Recipe in a top-level JSON-LD array', () => {
    const draft = draftFromHtml(
      wrap(
        '[{"@type":"WebSite","name":"s"},{"@type":"Recipe","name":"Soup","recipeIngredient":["1 onion"]}]',
      ),
      'https://example.com/',
    );
    expect(draft?.title.value).toBe('Soup');
  });

  it('finds a Recipe whose @type is an array of types', () => {
    const draft = draftFromHtml(
      wrap('{"@type":["Recipe","NewsArticle"],"name":"Stew","recipeIngredient":["1 onion"]}'),
      'https://example.com/',
    );
    expect(draft?.title.value).toBe('Stew');
  });

  it('accepts recipeIngredient given as a single string rather than an array', () => {
    const draft = draftFromHtml(
      wrap('{"@type":"Recipe","name":"S","recipeIngredient":"1 onion"}'),
      'https://example.com/',
    );
    expect(draft?.ingredientLines.value).toEqual(['1 onion']);
  });

  it('flattens HowToSection into the steps it contains', () => {
    const draft = draftFromHtml(
      wrap(`{"@type":"Recipe","name":"S","recipeInstructions":[
        {"@type":"HowToSection","name":"Sauce","itemListElement":[
          {"@type":"HowToStep","text":"Chop the onion."},
          {"@type":"HowToStep","text":"Fry it."}]},
        {"@type":"HowToSection","name":"Pasta","itemListElement":[
          {"@type":"HowToStep","text":"Boil the water."}]}]}`),
      'https://example.com/',
    );
    expect(draft?.steps.value).toEqual(['Chop the onion.', 'Fry it.', 'Boil the water.']);
  });

  it('splits a single instruction blob, and says it had to', () => {
    const draft = draftFromHtml(
      wrap(
        '{"@type":"Recipe","name":"S","recipeInstructions":"Chop the onion.\\nFry it gently.\\nAdd stock."}',
      ),
      'https://example.com/',
    );
    expect(draft?.steps.value).toEqual(['Chop the onion.', 'Fry it gently.', 'Add stock.']);
    // Derived rather than given, so the cook is asked to look at it.
    expect(draft?.steps.confidence).toBe('low');
  });

  it('splits a numbered blob that arrived on one line', () => {
    const draft = draftFromHtml(
      wrap('{"@type":"Recipe","name":"S","recipeInstructions":"1. Chop it. 2. Fry it. 3. Eat."}'),
      'https://example.com/',
    );
    expect(draft?.steps.value).toEqual(['Chop it.', 'Fry it.', 'Eat.']);
    expect(draft?.steps.confidence).toBe('low');
  });

  it('strips markup out of an instruction that arrived as HTML', () => {
    const draft = draftFromHtml(
      wrap('{"@type":"Recipe","name":"S","recipeInstructions":["<p>Chop the <b>onion</b>.</p>"]}'),
      'https://example.com/',
    );
    expect(draft?.steps.value).toEqual(['Chop the onion.']);
  });

  it('drops blank ingredient entries rather than saving empty lines', () => {
    const draft = draftFromHtml(
      wrap('{"@type":"Recipe","name":"S","recipeIngredient":["1 onion","","   ","2 parsnips"]}'),
      'https://example.com/',
    );
    expect(draft?.ingredientLines.value).toEqual(['1 onion', '2 parsnips']);
  });

  it('falls back to the page title when the Recipe node has no name', () => {
    const html = `<html><head><title>Granny's Stew | A blog</title>
      <script type="application/ld+json">{"@type":"Recipe","recipeIngredient":["1 onion"]}</script>
      </head></html>`;
    const draft = draftFromHtml(html, 'https://example.com/');
    expect(draft?.title.value).toBe("Granny's Stew");
    expect(draft?.title.confidence).toBe('low');
  });

  it('leaves servings at 1 and flagged when the page says nothing about yield', () => {
    const draft = draftFromHtml(
      wrap('{"@type":"Recipe","name":"S","recipeIngredient":["1 onion"]}'),
      'https://example.com/',
    );
    expect(draft?.servings.value).toBe(1);
    expect(draft?.servings.confidence).toBe('low');
    expect(draft?.servings.raw).toBe(null);
  });

  it('takes recipeYield given as a bare number', () => {
    const draft = draftFromHtml(
      wrap('{"@type":"Recipe","name":"S","recipeYield":6,"recipeIngredient":["1 onion"]}'),
      'https://example.com/',
    );
    expect(draft?.servings.value).toBe(6);
    expect(draft?.servings.confidence).toBe('high');
  });

  it('refuses a servings count that is not a sane number of servings', () => {
    const draft = draftFromHtml(
      wrap('{"@type":"Recipe","name":"S","recipeYield":"10000","recipeIngredient":["1 onion"]}'),
      'https://example.com/',
    );
    expect(draft?.servings.value).toBe(1);
    expect(draft?.servings.confidence).toBe('low');
  });

  it('needs more than a name to call something a recipe', () => {
    // A Recipe node with neither ingredients nor steps is a stub, and importing it would give
    // the cook an empty draft with a title on it.
    expect(draftFromHtml(wrap('{"@type":"Recipe","name":"S"}'), 'https://example.com/')).toBe(null);
  });
});

/**
 * A hostile page must cost linear time. An unanchored pattern over a long run of digits or
 * spaces is quadratic, and the page cap is 4MB, so a 1MB run once blocked the event loop for
 * minutes. The budgets are generous so a slow CI box cannot flake them; quadratic behaviour
 * misses them by two orders of magnitude.
 */
describe('hostile pages finish in linear time', () => {
  const RUN = 200_000;
  const recipePage = (recipe: object, title = 'x') =>
    `<html><head><title>${title}</title><script type="application/ld+json">${JSON.stringify(recipe)}</script></head><body></body></html>`;
  const timed = (html: string) => {
    const started = performance.now();
    const draft = draftFromHtml(html, 'https://example.com/r');
    return { draft, ms: performance.now() - started };
  };

  it('a recipeYield made of one long run of digits', () => {
    const { ms } = timed(
      recipePage({
        '@type': 'Recipe',
        name: 'r',
        recipeIngredient: ['x'],
        recipeYield: '1'.repeat(RUN),
      }),
    );
    expect(ms).toBeLessThan(500);
  });

  it('a <title> made of one long run of whitespace', () => {
    const { ms } = timed(
      recipePage({ '@type': 'Recipe', recipeIngredient: ['x'] }, `a${' '.repeat(RUN)}b`),
    );
    expect(ms).toBeLessThan(500);
  });

  it('JSON-LD nested far deeper than any real page answers "no recipe", not a crash', () => {
    const deep = '['.repeat(RUN) + ']'.repeat(RUN);
    const html = `<html><head><script type="application/ld+json">${deep}</script></head><body></body></html>`;
    expect(() => draftFromHtml(html, 'https://example.com/r')).not.toThrow();
  });
});

const URL_STUB = 'https://example.com/recipe';

describe('the headnote and times a page states', () => {
  it('reads prep and cook time and the description from JSON-LD', () => {
    const draft = draftFromHtml(fixture('ld-yield-array-lentil-soup.html'), URL_STUB);
    expect(draft?.details.prepMinutes).toBe(5);
    expect(draft?.details.cookMinutes).toBe(25);
    expect(draft?.details.description).toMatch(/^A speedy pot of spiced red lentil soup/);
  });

  it('works cook time out from total minus prep when no cook time is stated', () => {
    const html = `<script type="application/ld+json">${JSON.stringify({
      '@type': 'Recipe',
      name: 'Soup',
      recipeIngredient: ['1 cup broth'],
      recipeInstructions: 'Heat it.',
      prepTime: 'PT10M',
      totalTime: 'PT1H',
    })}</script>`;
    expect(draftFromHtml(html, URL_STUB)?.details).toEqual({
      description: null,
      prepMinutes: 10,
      cookMinutes: 50,
    });
  });

  it('says nothing about either time from a total alone', () => {
    const draft = draftFromHtml(fixture('microdata-oat-cookies.html'), URL_STUB);
    expect(draft?.details.prepMinutes).toBeNull();
    expect(draft?.details.cookMinutes).toBeNull();
  });

  it('decodes markup in a description and caps its length', () => {
    const html = `<script type="application/ld+json">${JSON.stringify({
      '@type': 'Recipe',
      name: 'Soup',
      recipeIngredient: ['1 cup broth'],
      recipeInstructions: 'Heat it.',
      description: `<p>Mom&#39;s soup</p>${'x'.repeat(10_000)}`,
    })}</script>`;
    const description = draftFromHtml(html, URL_STUB)?.details.description ?? '';
    expect(description.startsWith("Mom's soup")).toBe(true);
    expect(description.length).toBe(5000);
  });

  it('keeps only the headnote for a paste-style page with no structured data', () => {
    // The paragraph between the title and the list is read by shape (`from-text.ts`); the times
    // are only ever taken from structured data.
    const draft = draftFromHtml(fixture('unstructured-recipe-post.html'), URL_STUB);
    expect(draft?.details).toEqual({
      description:
        'The soup I make when there is nothing in the house, which is to say the soup I make most weeks. It wants more pepper than you think.',
      prepMinutes: null,
      cookMinutes: null,
    });
  });
});
