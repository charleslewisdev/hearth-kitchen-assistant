import { describe, it, expect } from 'vitest';
import { parseIngredientLine } from './ingredient';

describe('parseIngredientLine', () => {
  it('parses qty + unit + food', () => {
    expect(parseIngredientLine('2 cups flour')).toEqual({ quantity: 2, unit: 'cup', foodName: 'flour', note: null });
  });
  it('parses mixed-fraction qty + unit + food', () => {
    expect(parseIngredientLine('1 1/2 tsp salt')).toEqual({ quantity: 1.5, unit: 'tsp', foodName: 'salt', note: null });
  });
  it('splits a trailing comma note', () => {
    expect(parseIngredientLine('3 cloves garlic, minced')).toEqual({ quantity: 3, unit: 'clove', foodName: 'garlic', note: 'minced' });
  });
  it('treats a parenthetical as the note and the trailing word as unit', () => {
    expect(parseIngredientLine('1 (14 oz) can diced tomatoes')).toEqual({ quantity: 1, unit: 'can', foodName: 'diced tomatoes', note: '14 oz' });
  });
  it('handles "to taste" (no qty, no unit)', () => {
    expect(parseIngredientLine('salt to taste')).toEqual({ quantity: null, unit: null, foodName: 'salt', note: 'to taste' });
  });
  it('handles a bare count with no unit', () => {
    expect(parseIngredientLine('2 eggs')).toEqual({ quantity: 2, unit: null, foodName: 'eggs', note: null });
  });

  // --- additional robustness cases ---

  it('parses a leading unicode fraction', () => {
    expect(parseIngredientLine('½ cup butter')).toEqual({ quantity: 0.5, unit: 'cup', foodName: 'butter', note: null });
  });
  it('parses a whole + unicode fraction', () => {
    expect(parseIngredientLine('1½ cups sugar')).toEqual({ quantity: 1.5, unit: 'cup', foodName: 'sugar', note: null });
  });
  it('trims surrounding whitespace', () => {
    expect(parseIngredientLine('  2 cups flour  ')).toEqual({ quantity: 2, unit: 'cup', foodName: 'flour', note: null });
  });
  it('parses a decimal quantity', () => {
    expect(parseIngredientLine('1.5 lb ground beef')).toEqual({ quantity: 1.5, unit: 'lb', foodName: 'ground beef', note: null });
  });
  it('collapses a range to its low end', () => {
    expect(parseIngredientLine('2-3 cloves garlic')).toEqual({ quantity: 2, unit: 'clove', foodName: 'garlic', note: null });
  });
  it('collapses a range written with a word to its low end, keeping the unit and the food', () => {
    expect(parseIngredientLine('4 to 5 tablespoons olive oil, plus more for drizzling')).toEqual({
      quantity: 4,
      unit: 'tbsp',
      foodName: 'olive oil',
      note: 'plus more for drizzling',
    });
    expect(parseIngredientLine('2 or 3 bay leaves')).toMatchObject({
      quantity: 2,
      foodName: 'bay leaves',
    });
    expect(parseIngredientLine('¾ to 1 cup onions')).toMatchObject({
      quantity: 0.75,
      unit: 'cup',
      foodName: 'onions',
    });
    expect(parseIngredientLine('1 1/2 to 2 cups stock')).toMatchObject({
      quantity: 1.5,
      unit: 'cup',
      foodName: 'stock',
    });
    expect(parseIngredientLine('1/4-1/2 tsp cayenne')).toMatchObject({
      quantity: 0.25,
      unit: 'tsp',
      foodName: 'cayenne',
    });
  });
  it('does not read a food that starts with "or" as a range', () => {
    expect(parseIngredientLine('2 oranges')).toMatchObject({ quantity: 2, foodName: 'oranges' });
    expect(parseIngredientLine('1 tomato')).toMatchObject({ quantity: 1, foodName: 'tomato' });
  });
  it('keeps adjectives listed with commas in the food, and still splits the note after it', () => {
    expect(parseIngredientLine('4 skinless, boneless chicken breasts, pounded thin')).toMatchObject(
      {
        foodName: 'skinless, boneless chicken breasts',
        note: 'pounded thin',
      },
    );
    expect(parseIngredientLine('2 lb boneless, skinless thighs')).toMatchObject({
      unit: 'lb',
      foodName: 'boneless, skinless thighs',
      note: null,
    });
    // A food of more than one word before the comma is the food; what follows is the note.
    expect(parseIngredientLine('1 red onion, large')).toMatchObject({
      foodName: 'red onion',
      note: 'large',
    });
  });
  it('handles a case-sensitive T abbreviation', () => {
    expect(parseIngredientLine('2 T olive oil')).toEqual({ quantity: 2, unit: 'tbsp', foodName: 'olive oil', note: null });
  });
  it('keeps food words raw (no normalization), but moves a size word to the note', () => {
    expect(parseIngredientLine('3 large Tomatoes')).toEqual({ quantity: 3, unit: null, foodName: 'Tomatoes', note: 'large' });
  });
  it('combines a parenthetical and a trailing comma note', () => {
    expect(parseIngredientLine('1 (15 oz) can black beans, drained')).toEqual({
      quantity: 1,
      unit: 'can',
      foodName: 'black beans',
      note: '15 oz; drained',
    });
  });
  it('handles no quantity and no note (bare food)', () => {
    expect(parseIngredientLine('olive oil')).toEqual({ quantity: null, unit: null, foodName: 'olive oil', note: null });
  });
  it('handles an empty line', () => {
    expect(parseIngredientLine('')).toEqual({ quantity: null, unit: null, foodName: '', note: null });
  });
});

describe('parseIngredientLine: descriptors move out of the food name', () => {
  // The lines behind the Food names piloting produced: garlic alone was seven Foods, so the
  // shopping list could not combine it. Each row is line -> quantity, unit, food, note.
  it.each([
    ['3 large cloves garlic', 3, 'clove', 'garlic', 'large'],
    ['4 garlic cloves', 4, 'clove', 'garlic', null],
    ['2 medium garlic cloves, minced', 2, 'clove', 'garlic', 'medium; minced'],
    ['2 pieces of garlic', 2, 'piece', 'garlic', null],
    ['5 oz baby spinach', 5, 'oz', 'spinach', 'baby'],
    ['2 cups fresh spinach', 2, 'cup', 'spinach', 'fresh'],
    ['1 medium-large leek', 1, null, 'leek', 'medium-large'],
    ['2 large onions', 2, null, 'onions', 'large'],
    ['1 small onion, diced', 1, null, 'onion', 'small; diced'],
    ['1 cup chopped onion', 1, 'cup', 'onion', 'chopped'],
    ['2 medium yellow onions', 2, null, 'yellow onions', 'medium'],
    ['2 large eggs', 2, null, 'eggs', 'large'],
    ['3 extra-large eggs', 3, null, 'eggs', 'extra-large'],
    ['3 extra large eggs', 3, null, 'eggs', 'extra large'],
    ['2 cups chopped parsnips', 2, 'cup', 'parsnips', 'chopped'],
    ['3 medium parsnips', 3, null, 'parsnips', 'medium'],
    ['1 tsp freshly ground black pepper', 1, 'tsp', 'black pepper', 'freshly ground'],
    ['2 tbsp fresh lime juice', 2, 'tbsp', 'lime juice', 'fresh'],
    ['1/2 cup fresh orange juice', 0.5, 'cup', 'orange juice', 'fresh'],
    ['2 tbsp finely chopped fresh parsley', 2, 'tbsp', 'parsley', 'finely chopped fresh'],
    ['1/4 cup chopped flat-leaf parsley', 0.25, 'cup', 'flat-leaf parsley', 'chopped'],
    [
      'A handful of chopped fresh flat-leaf parsley',
      1,
      'handful',
      'flat-leaf parsley',
      'chopped fresh',
    ],
    ['1 tbsp chopped fresh oregano', 1, 'tbsp', 'oregano', 'chopped fresh'],
    ['1/2 cup crumbled feta cheese', 0.5, 'cup', 'feta cheese', 'crumbled'],
    ['1/2 cup grated Parmesan cheese', 0.5, 'cup', 'Parmesan cheese', 'grated'],
    [
      '1 cup fresh grated Parmigiano Reggiano cheese',
      1,
      'cup',
      'Parmigiano Reggiano cheese',
      'fresh grated',
    ],
    ['2 cups boiling water', 2, 'cup', 'water', 'boiling'],
    ['1 cup warm water', 1, 'cup', 'water', 'warm'],
    ['1/2 cup ice cold water', 0.5, 'cup', 'water', 'ice cold'],
    ['1 1/4 cups warm tap water', 1.25, 'cup', 'water', 'warm tap'],
    ['1 cup hot water', 1, 'cup', 'water', 'hot'],
    ['4 thin slices prosciutto di Parma', 4, 'slice', 'prosciutto di Parma', 'thin'],
    ['6 slices prosciutto', 6, 'slice', 'prosciutto', null],
    ['1 bunch cilantro', 1, 'bunch', 'cilantro', null],
    ['1 sprig oregano', 1, 'sprig', 'oregano', null],
    ['2 sprigs fresh rosemary', 2, 'sprig', 'rosemary', 'fresh'],
    ['2 stalks celery', 2, 'stalk', 'celery', null],
    ['1 box Pillsbury Hot Roll Mix', 1, 'box', 'Pillsbury Hot Roll Mix', null],
    ['1 jar roasted red peppers', 1, 'jar', 'roasted red peppers', null],
    ['2 packages frozen peas', 2, 'package', 'frozen peas', null],
    ['2 tbl olive oil', 2, 'tbsp', 'olive oil', null],
    ['4 tbl unsalted butter, softened', 4, 'tbsp', 'unsalted butter', 'softened'],
    ['1 cup whole milk at room temperature', 1, 'cup', 'whole milk', 'at room temperature'],
    ['2 cups torn day-old bread or toast', 2, 'cup', 'bread or toast', 'torn day-old'],
    ['1 large can roma tomatoes', 1, 'can', 'roma tomatoes', 'large'],
    ['1 cup packed brown sugar', 1, 'cup', 'brown sugar', 'packed'],
    ['1 cup lightly packed brown sugar', 1, 'cup', 'brown sugar', 'lightly packed'],
    ['1/2 cup melted butter', 0.5, 'cup', 'butter', 'melted'],
    ['2 cups thinly sliced red onion', 2, 'cup', 'red onion', 'thinly sliced'],
    ['1 tbsp room temperature butter', 1, 'tbsp', 'butter', 'room temperature'],
    ['2 ripe bananas', 2, null, 'bananas', 'ripe'],
    ['1 heaping tbsp flour', 1, 'tbsp', 'flour', 'heaping'],
  ])('%s', (line, quantity, unit, foodName, note) => {
    expect(parseIngredientLine(line)).toEqual({ quantity, unit, foodName, note });
  });

  it.each([
    // Words that change what you buy stay in the food.
    ['1 tsp ground cumin', 'ground cumin'],
    ['1 tsp smoked paprika', 'smoked paprika'],
    ['1 tsp dried oregano', 'dried oregano'],
    ['1/2 tsp crushed red pepper flakes', 'crushed red pepper flakes'],
    ['1 cup frozen peas', 'frozen peas'],
    ['1 cup whole milk', 'whole milk'],
    ['1 cup heavy cream', 'heavy cream'],
    ['1 cup sour cream', 'sour cream'],
    ['2 tbsp extra-virgin olive oil', 'extra-virgin olive oil'],
    ['4 cups low-sodium chicken broth', 'low-sodium chicken broth'],
    ['2 tbsp lightly salted butter', 'lightly salted butter'],
    ['1 tsp hot sauce', 'hot sauce'],
    ['1 cup cold brew coffee', 'cold brew coffee'],
    ['1 block firm tofu', 'block firm tofu'],
    ['2 cups ice cubes', 'ice cubes'],
    ['1 cup half-and-half', 'half-and-half'],
  ])('keeps the buying word in %s', (line, foodName) => {
    expect(parseIngredientLine(line).foodName).toBe(foodName);
  });

  it('keeps what a container says about what is in it', () => {
    // "diced tomatoes" in a can is a different thing on the shelf from tomatoes.
    expect(parseIngredientLine('1 can diced tomatoes')).toMatchObject({
      unit: 'can',
      foodName: 'diced tomatoes',
    });
    expect(parseIngredientLine('1 bag shredded mozzarella')).toMatchObject({
      unit: 'bag',
      foodName: 'shredded mozzarella',
    });
  });

  it('never strips the food away entirely', () => {
    expect(parseIngredientLine('2 large')).toMatchObject({
      quantity: 2,
      foodName: 'large',
      note: null,
    });
    expect(parseIngredientLine('fresh')).toMatchObject({ foodName: 'fresh', note: null });
  });

  it('strips descriptors from a line with no amount', () => {
    expect(parseIngredientLine('Freshly ground black pepper, to taste')).toEqual({
      quantity: null,
      unit: null,
      foodName: 'black pepper',
      note: 'Freshly ground; to taste',
    });
    expect(parseIngredientLine('garlic cloves')).toEqual({
      quantity: null,
      unit: null,
      foodName: 'garlic',
      note: null,
    });
  });

  it('reads a trailing piece of a sized thing', () => {
    expect(parseIngredientLine('1 inch cinnamon piece')).toEqual({
      quantity: 1,
      unit: 'piece',
      foodName: 'cinnamon',
      note: '1 inch',
    });
    expect(parseIngredientLine('1-inch piece ginger')).toEqual({
      quantity: 1,
      unit: 'piece',
      foodName: 'ginger',
      note: '1-inch',
    });
    expect(parseIngredientLine('a 2-inch piece of fresh ginger')).toEqual({
      quantity: 1,
      unit: 'piece',
      foodName: 'ginger',
      note: '2-inch; fresh',
    });
  });
});

describe('parseIngredientLine: amounts written as words', () => {
  it.each([
    ['a green bell pepper', 1, null, 'green bell pepper', null],
    ['an onion, chopped', 1, null, 'onion', 'chopped'],
    ['One onion', 1, null, 'onion', null],
    ['two cups flour', 2, 'cup', 'flour', null],
    ['twelve eggs', 12, null, 'eggs', null],
    ['half a lemon', 0.5, null, 'lemon', null],
    ['half an onion', 0.5, null, 'onion', null],
    ['a half cup milk', 0.5, 'cup', 'milk', null],
    ['one and a half cups rice', 1.5, 'cup', 'rice', null],
    ['one-and-a-half cups rice', 1.5, 'cup', 'rice', null],
    ['two and a half cups stock', 2.5, 'cup', 'stock', null],
    ['A pinch of salt', 1, 'pinch', 'salt', null],
    ['Pinch crushed red pepper flakes', 1, 'pinch', 'crushed red pepper flakes', null],
    ['Dash of hot sauce', 1, 'dash', 'hot sauce', null],
  ])('%s', (line, quantity, unit, foodName, note) => {
    expect(parseIngredientLine(line)).toEqual({ quantity, unit, foodName, note });
  });

  it('reads number words only at the start of the line', () => {
    expect(parseIngredientLine('salt, a pinch')).toMatchObject({
      quantity: null,
      foodName: 'salt',
      note: 'a pinch',
    });
    expect(parseIngredientLine('2 cups one-minute oats')).toMatchObject({
      quantity: 2,
      foodName: 'one-minute oats',
    });
  });

  it('does not read a food as an amount', () => {
    expect(parseIngredientLine('half-and-half')).toMatchObject({
      quantity: null,
      foodName: 'half-and-half',
    });
    expect(parseIngredientLine('half and half')).toMatchObject({
      quantity: null,
      foodName: 'half and half',
    });
    expect(parseIngredientLine('a few sprigs thyme')).toMatchObject({ quantity: null });
    expect(parseIngredientLine('a')).toMatchObject({ quantity: null, foodName: 'a' });
    expect(parseIngredientLine('One')).toMatchObject({ quantity: null, foodName: 'One' });
    expect(parseIngredientLine('Anise seed')).toMatchObject({
      quantity: null,
      foodName: 'Anise seed',
    });
  });
});

describe('parseIngredientLine: a size in front of the unit', () => {
  it.each([
    ['one 14-ounce can chickpeas', 1, 'can', 'chickpeas', '14-ounce'],
    ['one 14-ounce can full fat coconut milk', 1, 'can', 'full fat coconut milk', '14-ounce'],
    ['One-and-a-half 28-ounce cans chopped tomatoes', 1.5, 'can', 'chopped tomatoes', '28-ounce'],
    ['1 1-pound package dried fusilli', 1, 'package', 'dried fusilli', '1-pound'],
    ['1-pound package dried fusilli', 1, 'package', 'dried fusilli', '1-pound'],
    ['2 6-inch flour tortillas', 2, null, 'flour tortillas', '6-inch'],
    ['1 8-oz package cream cheese, softened', 1, 'package', 'cream cheese', '8-oz; softened'],
    ['2 15.5-ounce cans black beans', 2, 'can', 'black beans', '15.5-ounce'],
  ])('%s', (line, quantity, unit, foodName, note) => {
    expect(parseIngredientLine(line)).toEqual({ quantity, unit, foodName, note });
  });

  it('leaves a hyphenated word that is not a size alone', () => {
    expect(parseIngredientLine('2 7-up cans')).toMatchObject({
      quantity: 2,
      foodName: '7-up cans',
      note: null,
    });
  });
});

describe('parseIngredientLine: a line that is trying to be expensive', () => {
  /**
   * The parenthetical rule is the only unanchored pattern in this parser, and before it was
   * bounded it was quadratic: on a run of `(` with no `)`, the engine tried `\(` at every
   * position and backtracked the whole rest of the line at each one.
   *
   * That reached the server through recipe import - a PDF's text layer is user content and a
   * 7KB one blocked the process for 3.4 seconds - but it is reachable from the recipe form too,
   * where the only bound is how much a person will paste into a textarea.
   *
   * The timing bound is deliberately loose. Before the fix this line took about 3 seconds; it
   * now takes single-digit milliseconds, so a 1-second budget separates the two without being
   * sensitive to what else the machine is doing.
   */
  it('parses a long run of open parentheses in linear time', () => {
    const hostile = '('.repeat(100_000);
    const started = Date.now();
    const parsed = parseIngredientLine(hostile);
    expect(Date.now() - started).toBeLessThan(1000);
    // No closing bracket, so there is no aside to find and the whole line is the food name.
    expect(parsed.note).toBeNull();
    expect(parsed.foodName).toHaveLength(100_000);
  });

  it('reads nested brackets in linear time', () => {
    const lines = [
      '(('.repeat(50_000),
      `(${'a('.repeat(50_000)}`,
      `((${'a'.repeat(100_000)}`,
      `(${'(a)'.repeat(30_000)}`,
    ];
    const started = Date.now();
    for (const line of lines) parseIngredientLine(line);
    expect(Date.now() - started).toBeLessThan(1000);
  });

  it('reads a leading range in linear time however the line is padded', () => {
    const lines = [
      `1${' '.repeat(100_000)}x`,
      `1 1/2${' '.repeat(100_000)}-x`,
      `1${'1'.repeat(100_000)}`,
      `1 to${' '.repeat(100_000)}`,
      `${'1 '.repeat(50_000)}`,
    ];
    const started = Date.now();
    for (const line of lines) parseIngredientLine(line);
    expect(Date.now() - started).toBeLessThan(1000);
  });

  it('reads trailing phrases, sizes, number words and descriptors in linear time', () => {
    // One for each of the patterns and word loops the descriptor rules added: the trailing
    // "to taste" / "at room temperature" pattern after a long run of whitespace, the size in
    // front of a unit as one enormous word, number words, and a line made of descriptors.
    const lines = [
      `salt${' '.repeat(100_000)}to`,
      `salt${' \t'.repeat(50_000)}at room`,
      `milk${' '.repeat(100_000)}at${' '.repeat(100_000)}room temperature x`,
      `1 ${'1'.repeat(100_000)}-ounce can`,
      `1 1-${'o'.repeat(100_000)} can`,
      `1-${'1'.repeat(100_000)}`,
      'large '.repeat(50_000),
      `2 ${'finely '.repeat(50_000)}x`,
      `2 ${'hot '.repeat(50_000)}water`,
      `2 cups ${'warm '.repeat(50_000)}water`,
      'one and a half '.repeat(20_000),
      `${'one-and-a-half-'.repeat(20_000)} cups`,
      'a '.repeat(50_000),
      `1 inch ${'piece '.repeat(50_000)}`,
      `${'garlic cloves '.repeat(30_000)}`,
    ];
    const started = Date.now();
    for (const line of lines) parseIngredientLine(line);
    expect(Date.now() - started).toBeLessThan(1000);
  });

  it('still reads the asides real ingredient lines carry', () => {
    expect(parseIngredientLine('1 (14 oz) can diced tomatoes').note).toBe('14 oz');
    // Doubled, from the Minimalist Baker fixture: WP Recipe Maker wraps notes twice. The food
    // must not keep the second closing bracket - it made Foods called "garlic )" and "mirin )".
    expect(parseIngredientLine('1 Tbsp oil ((or sub water))')).toMatchObject({
      foodName: 'oil',
      note: 'or sub water',
    });
    expect(parseIngredientLine('2 cloves garlic ((minced))')).toMatchObject({
      foodName: 'garlic',
      note: 'minced',
    });
    // Two asides on one line, neither left in the food: the weight is the second measure
    // (`measure-system.ts`) and the other is the note.
    expect(parseIngredientLine('1 cup (125g) all-purpose flour (spooned & leveled)')).toMatchObject(
      {
        unit: 'cup',
        foodName: 'all-purpose flour',
        note: 'spooned & leveled',
        altQuantity: 125,
        altUnit: 'g',
      },
    );
    // Doubled AND nested: nothing of it is left in the food.
    expect(
      parseIngredientLine('2 skin-on salmon fillets ((3/4 lb, 340 g; 3/4 inch (2 cm) thick))')
        .foodName,
    ).toBe('skin-on salmon fillets');
    // An aside with an aside inside it comes out whole.
    expect(parseIngredientLine('2 salmon fillets (3/4 lb; 3/4 inch (2 cm) thick)')).toMatchObject({
      foodName: 'salmon fillets',
      note: '3/4 lb; 3/4 inch (2 cm) thick',
    });
  });
});

describe('dozen', () => {
  it('reads "2 dozen eggs" as two dozen of eggs', () => {
    expect(parseIngredientLine('2 dozen eggs')).toMatchObject({
      quantity: 2,
      unit: 'dozen',
      foodName: 'eggs',
    });
  });
});

describe('pints, quarts, gallons and fluid ounces', () => {
  it.each([
    ['1 pint cherry tomatoes', 1, 'pint', 'cherry tomatoes'],
    ['2 pints heavy cream', 2, 'pint', 'heavy cream'],
    ['1 pt strawberries', 1, 'pint', 'strawberries'],
    ['1 quart chicken stock', 1, 'quart', 'chicken stock'],
    ['2 qt water', 2, 'quart', 'water'],
    ['1 gallon milk', 1, 'gallon', 'milk'],
    ['1/2 gal apple cider', 0.5, 'gallon', 'apple cider'],
    ['8 fl oz coconut milk', 8, 'fl oz', 'coconut milk'],
    ['8 fl. oz. coconut milk', 8, 'fl oz', 'coconut milk'],
    ['12 fluid ounces beer', 12, 'fl oz', 'beer'],
  ])('reads %j', (line, quantity, unit, foodName) => {
    expect(parseIngredientLine(line)).toMatchObject({ quantity, unit, foodName });
  });

  it('leaves "fl" alone when no ounce follows it', () => {
    expect(parseIngredientLine('2 fl bananas').unit).toBeNull();
  });
});
