import { describe, expect, it } from 'vitest';
import { repairOcrAmounts } from './ocr-amounts';

/**
 * Every misreading here is a shape tesseract produced from photos of printed recipes (the same
 * faults are in `test/fixtures/ocr/`), with the amount the page actually prints.
 */
describe('fraction glyphs tesseract misreads, at the start of a line', () => {
  it.each([
    ['Y2 teaspoon kosher salt', '½ teaspoon kosher salt'],
    ['¥2 teaspoon kosher salt', '½ teaspoon kosher salt'],
    ['V2 cup grated parmesan cheese', '½ cup grated parmesan cheese'],
    ['%2 teaspoon ground cumin', '½ teaspoon ground cumin'],
    ['72 cup thinly sliced red onion', '½ cup thinly sliced red onion'],
    ['72 tsp dried oregano', '½ tsp dried oregano'],
    ['Ya teaspoon cayenne pepper', '¼ teaspoon cayenne pepper'],
    ['Va teaspoon freshly ground black pepper', '¼ teaspoon freshly ground black pepper'],
    ['7a cup chopped fresh basil', '¼ cup chopped fresh basil'],
    ['3%2 cups of water', '3½ cups of water'],
    ['2Y% cups (300g) unbleached all-', '2½ cups (300g) unbleached all-'],
    ['I cup Carmona Olives, pitied', '1 cup Carmona Olives, pitied'],
    ['I garlic clove, finely grated', '1 garlic clove, finely grated'],
  ])('reads %j as %j, with no guess', (input, expected) => {
    expect(repairOcrAmounts(input)).toEqual({ text: expected, guessed: false });
  });

  it('drops the stray mark OCR sets in front of an amount', () => {
    expect(repairOcrAmounts('= 1% pounds boneless,').text).toBe('1½ pounds boneless,');
  });
});

describe('a bare % or Y, which could be any fraction', () => {
  it('settles it from the grams a liquid is printed with', () => {
    expect(repairOcrAmounts('% cup (57g) water')).toEqual({
      text: '¼ cup (57g) water',
      guessed: false,
    });
    expect(repairOcrAmounts('"a cup (112g) water, warm')).toEqual({
      text: '½ cup (112g) water, warm',
      guessed: false,
    });
  });

  it('settles it from a weight in grams or a length in millimetres', () => {
    expect(repairOcrAmounts('Y pound (220 g) two-day-old Tuscan bread, sliced').text).toBe(
      '½ pound (220 g) two-day-old Tuscan bread, sliced',
    );
    expect(repairOcrAmounts('Yi inch (6 mm) thick').text).toBe('¼ inch (6 mm) thick');
    expect(repairOcrAmounts('Ys inch (1.5 cm) thick and toasted').text).toBe(
      '½ inch (1.5 cm) thick and toasted',
    );
  });

  it('does not let the grams of flour decide, since flour is not as heavy as water', () => {
    expect(repairOcrAmounts('% cup (30g) all-purpose flour')).toEqual({
      text: '½ cup (30g) all-purpose flour',
      guessed: true,
    });
  });

  it('guesses ½ when nothing on the line settles it, and says so', () => {
    expect(repairOcrAmounts('% finely diced yellow onion')).toEqual({
      text: '½ finely diced yellow onion',
      guessed: true,
    });
    expect(repairOcrAmounts('2% medium red onions, halved')).toEqual({
      text: '2½ medium red onions, halved',
      guessed: true,
    });
  });

  it('reads a fraction read as a full stop, "2. teaspoons", and flags it', () => {
    expect(repairOcrAmounts('2. teaspoons instant yeast')).toEqual({
      text: '2½ teaspoons instant yeast',
      guessed: true,
    });
    expect(repairOcrAmounts('2. Coat each slice').text).toBe('2. Coat each slice');
  });

  it('reads "1 2 tsp" as 1½ only when a unit follows, and flags it', () => {
    expect(repairOcrAmounts('1 2 tsp dijon mustard')).toEqual({
      text: '1½ tsp dijon mustard',
      guessed: true,
    });
    expect(repairOcrAmounts('1 2-pound chicken').text).toBe('1 2-pound chicken');
  });
});

describe('what it leaves alone', () => {
  it.each([
    '2 cups flour',
    '12 slices white bread,',
    '72 g butter',
    '1 cup 2% milk',
    '2 % milk',
    'Yellow onion, diced',
    'I love this recipe',
    'Y tu mama',
    'Add the salt.',
    '½ cup sugar',
  ])('%j', (input) => {
    expect(repairOcrAmounts(input)).toEqual({ text: input, guessed: false });
  });
});

describe('inside a line', () => {
  it('repairs a certain token in front of a unit', () => {
    expect(repairOcrAmounts('overnight with another V2 teaspoon of baking soda').text).toBe(
      'overnight with another ½ teaspoon of baking soda',
    );
    expect(repairOcrAmounts('1 (Y2-inch) piece fresh ginger,').text).toBe(
      '1 (½-inch) piece fresh ginger,',
    );
    expect(repairOcrAmounts('warm them with 3%2 cups of water.').text).toBe(
      'warm them with 3½ cups of water.',
    );
  });

  it('repairs an ambiguous token inside a line when the metric after it settles it', () => {
    expect(repairOcrAmounts('lengthwise Yi inch (6 mm) thick').text).toBe(
      'lengthwise ¼ inch (6 mm) thick',
    );
  });

  it('never guesses inside a line, where the review screen cannot point at it', () => {
    expect(repairOcrAmounts('spread % cup of romesco dip').text).toBe(
      'spread % cup of romesco dip',
    );
  });
});

describe('a three-way measure: grams, ounces, cups', () => {
  it('reads the g and the oz tesseract made into digits, and the fraction after them', () => {
    expect(repairOcrAmounts("2509/902/2'% cups plain").text).toBe('250g/9oz/2½ cups plain');
    expect(repairOcrAmounts('909/302/7 tbsp unsalted').text).toBe('90g/3oz/7 tbsp unsalted');
    expect(repairOcrAmounts('90g/30z milk chocolate').text).toBe('90g/3oz milk chocolate');
    expect(repairOcrAmounts('2 x 400g/140z cans sweetened').text).toBe('2 x 400g/14oz cans sweetened');
  });

  it('leaves numbers that only look like it', () => {
    expect(repairOcrAmounts('Bake at 302 degrees').text).toBe('Bake at 302 degrees');
    expect(repairOcrAmounts('1/2 cup milk').text).toBe('1/2 cup milk');
  });

  it('reads Thsp as Tbsp', () => {
    expect(repairOcrAmounts('6 Thsp extra-virgin olive oil').text).toBe('6 Tbsp extra-virgin olive oil');
  });
});

describe('step numbers OCR bent', () => {
  it('reads "I." as 1. and separates "4.Ina" from its first word', () => {
    expect(repairOcrAmounts('I. Cook pasta until al dente').text).toBe(
      '1. Cook pasta until al dente',
    );
    expect(repairOcrAmounts('4.Ina large bowl combine the').text).toBe(
      '4. Ina large bowl combine the',
    );
    expect(repairOcrAmounts('2.5 cups stock').text).toBe('2.5 cups stock');
  });
});

describe('hostile input', () => {
  it('stays linear on long runs of the characters it looks for', () => {
    const inputs = [
      'Y2'.repeat(50_000),
      '%'.repeat(100_000),
      `${'1'.repeat(100_000)}%`,
      ` ${'V2 '.repeat(30_000)}`,
      `(${'9'.repeat(50_000)} g`,
      'I '.repeat(50_000),
      `${'9'.repeat(50_000)}/1`,
      `${'10'.repeat(50_000)}z`,
      `1${'02'.repeat(50_000)}/`,
    ];
    for (const input of inputs) {
      const started = performance.now();
      repairOcrAmounts(input);
      expect(performance.now() - started).toBeLessThan(200);
    }
  });
});
