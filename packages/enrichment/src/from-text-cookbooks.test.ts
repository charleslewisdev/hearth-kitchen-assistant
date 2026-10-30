import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { draftFromText } from './from-text';
import type { RecipeDraft } from './draft';

/**
 * Invented recipe pages in the layouts printed cookbooks use, as tesseract reads such pages: what
 * `draftFromText` is actually handed. Every fault is a real one (split words, lost fractions,
 * columns read out of order, a footer run into the method), set in text written for these tests.
 *
 * The text is kept rather than photos, because the OCR is not what these test and a photo costs
 * seconds to read. `from-image.test.ts` covers the photo end.
 */
function page(name: string): RecipeDraft {
  const path = fileURLToPath(new URL(`../test/fixtures/ocr/${name}.txt`, import.meta.url));
  const draft = draftFromText(readFileSync(path, 'utf8'), { kind: 'image' });
  if (!draft) throw new Error(`no draft from ${name}`);
  return draft;
}

describe('Garlic Butter Knots: a page that used to find no recipe at all', () => {
  const draft = page('garlic-knots');
  const ingredients = draft.ingredientLines.value;

  it('reads both short lists, with their fractions put back', () => {
    expect(ingredients).toContain('2½ cups (300g) stone-ground all-purpose flour');
    expect(ingredients).toContain('1 teaspoon sugar');
    expect(ingredients).toContain('½ cup (112g) water, warm');
    expect(ingredients).toContain('3 tablespoons (42g) salted butter, melted');
    expect(ingredients).not.toContain('TOPPING');
  });

  it('keeps the yeast, whose ¼ OCR read as a full stop, and flags it for checking', () => {
    // The ⅞ on the line under it is past reading ('"to 1 cup'), so the two run together; the
    // flag is what sends the cook back to the page for both.
    expect(draft.amountsToCheck.some((line) => line.startsWith('2½ teaspoons instant yeast'))).toBe(
      true,
    );
  });

  it('splits the method by paragraph, and leaves the footer and nutrition out', () => {
    expect(draft.steps.value[0]).toMatch(/^Place the flour.*30 minutes\.$/);
    expect(draft.steps.value[1]).toMatch(/^Preheat the oven to 450°F/);
    const method = draft.steps.value.join(' ');
    expect(method).not.toContain('NEIGHBORHOOD BREAD BOX');
    expect(method).not.toMatch(/protein|sodium/);
  });
});

describe('Little Radish Sandwiches: a bold step number with no full stop', () => {
  const draft = page('radish-sandwiches');

  it('reads the title the page sets over two lines, in order', () => {
    expect(draft.title.value).toBe('Little Radish Sandwiches');
  });

  it('keeps the headnote under the title and the tip beside the list as notes', () => {
    expect(draft.details.description).toBe(
      'Peppery radish sandwiches are the first thing to vanish from any garden party ted.\n\nChoose the softest loaf you can find so the sandwiches stay tender and the radishes keep their crunch.',
    );
  });

  it('reads the steps as steps, not as ingredients with an amount of 1', () => {
    expect(draft.steps.value).toEqual([
      'Trim the radishes and shave them finely. Sprinkle with salt, leave in a sieve for 15 minutes, then blot dry.',
      'Butter every slice of bread right to the edges. Lay the radishes over six slices and season lightly. Close with the other slices. Press gently with your palm.',
      'Cut the sandwiches into quarters or small rectangles Pile onto a chilled plate.',
    ]);
  });

  it("takes a list of two amounts under the yield, and stops it before the cook's tip", () => {
    expect(draft.ingredientLines.value).toEqual([
      '1 bunch radishes',
      '12 slices brown bread, crusts removed',
      'butter, at room temperature, for spreading',
      'flaky salt, to taste',
    ]);
  });
});

describe('Cumin Lamb-Stuffed Bell Peppers: the method to the left of the list', () => {
  const draft = page('stuffed-peppers');
  const ingredients = draft.ingredientLines.value;

  it('reads the title set over three lines in capitals, recased', () => {
    expect(draft.title.value).toBe('Cumin Lamb-Stuffed Bell Peppers');
  });

  it('reads every ingredient under both sub-lists', () => {
    expect(ingredients[0]).toBe('4 medium-size bell peppers');
    expect(ingredients).toContain('2 tablespoons extra virgin olive oil');
    expect(ingredients).toContain('½ teaspoon kosher salt');
    expect(ingredients).toContain('1 pound ground lamb (85 percent lean)');
    expect(ingredients).toContain('1 (½-inch) piece fresh ginger, finely grated');
    // The page lists the salt and pepper twice, once per sub-list; the importer merges them.
    expect(ingredients).toHaveLength(18);
  });

  it('finds the method above the list, without its run-in label', () => {
    expect(draft.steps.value[0]).toMatch(/^Preheat the oven to 400°F/);
    expect(draft.steps.value.join(' ')).toContain('Divide the meat mixture');
  });

  it('keeps the headnote as the description', () => {
    expect(draft.details.description).toMatch(/^I have made this on more weeknights/);
  });

  it('flags the one amount nothing on the page could settle', () => {
    expect(draft.amountsToCheck).toEqual(['½ finely diced red onion (1 cup)']);
  });
});

describe("Granny's Pecan Bars: a step read in among the ingredient columns", () => {
  const draft = page('pecan-bars');

  it('keeps the headnote, whose full stop OCR lost, and not the stray end of step 1', () => {
    expect(draft.details.description).toMatch(/^The contrast of toas ted oats.*lunchbox favorite$/);
  });

  it('recases a title in sentence case', () => {
    expect(draft.title.value).toBe("Granny's Pecan Bars");
  });

  it('does not take the step as an ingredient', () => {
    expect(draft.ingredientLines.value.some((line) => /Preheat/.test(line))).toBe(false);
  });

  it('splits the method on its bare numbers', () => {
    expect(draft.steps.value.some((step) => step.startsWith('To make the filling'))).toBe(true);
    expect(draft.steps.value.some((step) => step.startsWith('Add small spoonfuls'))).toBe(true);
  });
});

describe('Buttermilk Pancakes', () => {
  const draft = page('pancakes');

  it('drops the "Recipe" label from the title', () => {
    expect(draft.title.value).toBe('Buttermilk Pancakes');
  });

  it('reads all seven steps, and leaves the yield and footer off the last', () => {
    expect(draft.steps.value).toHaveLength(7);
    expect(draft.steps.value[6]).toBe(
      'Stack the pancakes on warm plates and serve straight away, with any of the toppings you like.',
    );
  });
});

describe('Ranch Beans', () => {
  const draft = page('ranch-beans');

  it('puts the fractions back', () => {
    expect(draft.ingredientLines.value).toContain('½ teaspoon smoked paprika powder');
    expect(draft.ingredientLines.value).toContain('½ teaspoon ground coriander');
  });

  it('reads the first ingredient, wrapped over five lines, as one', () => {
    expect(draft.ingredientLines.value[0]).toBe(
      '1 pound dried black peans, picked over and rinsed, or 2 15-ounce cans black beans, rinsed and drained',
    );
  });

  it('takes the story at the head of an unnumbered method as the headnote', () => {
    expect(draft.details.description).toMatch(/^The high plains past the county line/);
    expect(draft.steps.value).toHaveLength(3);
    expect(draft.steps.value[1]).toMatch(/^Heat the oil/);
  });

  it('keeps the tip out of the method and in the description', () => {
    expect(draft.steps.value.join(' ')).not.toMatch(/tip:/i);
    expect(draft.details.description).toContain('If using canned beans, simply add the bacon');
  });
});

describe('Honey Oat Sandwich Bread', () => {
  const draft = page('oat-bread');

  it('settles a bare % from the grams of water printed beside it', () => {
    expect(draft.ingredientLines.value).toContain('¼ cup (57g) water');
  });

  it('leaves the nutrition line and the running footer out of the method', () => {
    const method = draft.steps.value.join(' ');
    expect(method).not.toContain('EVERYDAY LOAVES');
    expect(method).not.toContain('149');
    expect(method).not.toMatch(/protein/);
  });

  it('recases a title set in capitals', () => {
    expect(draft.title.value).toBe('Honey Oat Sandwich Sread');
  });
});

describe('Fusilli Picnic Salad', () => {
  const draft = page('fusilli-salad');

  it('reads fractions tesseract made into digits and capital I', () => {
    expect(draft.ingredientLines.value).toContain('½ cup thinly sliced red onion');
    expect(draft.ingredientLines.value).toContain('¼ cup chopped fresh dill');
    expect(draft.ingredientLines.value).toContain('1 cup Kalamata Olives, pitied and halved*');
  });

  it('reads the prep time the page states', () => {
    expect(draft.details.prepMinutes).toBe(20);
  });

  it('splits the method on "I." as well as "1."', () => {
    expect(draft.steps.value).toHaveLength(7);
    expect(draft.steps.value[0]).toBe('Boil the fusilli in salted water until just tender.');
  });
});

describe('Chimichurri Poached Chicken', () => {
  const draft = page('chimichurri-chicken');

  it('reads the first and last amounts', () => {
    expect(draft.ingredientLines.value[0]).toBe(
      '1½ pounds boneless, skinless chicken breasts, cut into 6 pieces',
    );
    expect(draft.ingredientLines.value).toContain('¼ teaspoon freshly ground black pepper');
  });

  it('keeps the headnote without the mark OCR made of its ornament, and the tip', () => {
    expect(draft.details.description).toMatch(/^We keep a jar of Chimichurri/);
    expect(draft.details.description).toContain('Tip: Poaching chicken breasts');
  });

  it('reads three steps', () => {
    expect(draft.steps.value).toHaveLength(3);
  });
});

describe('White Bean Soup with Sage', () => {
  const draft = page('bean-soup');

  it('flags the onions, whose ½ was only a guess', () => {
    expect(draft.ingredientLines.value).toContain(
      '2½ medium red onions, halved, then sliced lengthwise ¼ inch (6 mm) thick',
    );
    expect(draft.amountsToCheck).toContain(
      '2½ medium red onions, halved, then sliced lengthwise ¼ inch (6 mm) thick',
    );
  });

  it('leaves the photo caption off the last step', () => {
    expect(draft.steps.value.at(-1)).toMatch(/serve at once,?$/);
  });
});

describe('the cookbook patterns, on text built to be expensive', () => {
  it('stays linear on long runs of what each new pattern looks for', () => {
    // Each under the 100,000-character cap `draftFromText` enforces, so every pattern runs.
    const runs = [
      `1 ${'Peel '.repeat(18_000)}`,
      'CAPITALS '.repeat(10_000),
      '1g fat | '.repeat(10_000),
      `Prep time: ${'1'.repeat(90_000)}`,
      `${'tip'.repeat(30_000)}:`,
      `@ ${'@ '.repeat(40_000)}Word`,
      `${'MAKE '.repeat(18_000)}Preheat the oven.`,
      `${'9'.repeat(90_000)} g fat`,
      `${'Y2'.repeat(40_000)} cup`,
      `${'I '.repeat(40_000)}cup`,
      `2${'%'.repeat(90_000)}`,
    ];
    for (const run of runs) {
      const text = `Title\n\n${run}\n\n2 cups flour\n1 cup sugar\n3 eggs\n\nMix it.`;
      expect(text.length).toBeLessThan(100_000);
      const started = performance.now();
      const draft = draftFromText(text, { kind: 'image' });
      expect(performance.now() - started).toBeLessThan(500);
      expect(draft).not.toBeNull();
    }
  });
});
