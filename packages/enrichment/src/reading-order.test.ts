import { describe, it, expect } from 'vitest';
import { readingOrderText } from './reading-order';
import type { Box, OcrLine, OcrWord } from './reading-order';

/*
  Synthetic pages: every box here is made up, laid out the way tesseract reported the pilot
  photos (2026-09-23) - two-column cookbook pages, a skewed shot, a page photographed on its
  side. No image and no tesseract, so each case says exactly which geometry it is about.

  Type is 40 units tall; a character is 20 wide and a space between words 12.
*/
const SIZE = 40;
const CHAR = 20;
const SPACE = 12;

interface Place {
  /** Confidence for every word, or per word in order. */
  confidence?: number | number[];
  /** How much each word sits lower than the one before it: a skewed photo. */
  slope?: number;
  size?: number;
}

/** One printed line starting at (x, y), as tesseract's words. */
function words(text: string, x: number, y: number, place: Place = {}): OcrWord[] {
  const size = place.size ?? SIZE;
  const out: OcrWord[] = [];
  let left = x;
  text.split(' ').forEach((word, i) => {
    const top = y + i * (place.slope ?? 0);
    const width = word.length * CHAR * (size / SIZE);
    const confidence = Array.isArray(place.confidence)
      ? place.confidence[i]!
      : (place.confidence ?? 95);
    out.push({
      text: word,
      confidence,
      bbox: { x0: left, y0: top, x1: left + width, y1: top + size },
    });
    left += width + SPACE;
  });
  return out;
}

function line(text: string, x: number, y: number, place: Place = {}): OcrLine {
  return { words: words(text, x, y, place) };
}

/** The lines of the text, blank lines dropped: the order is what most cases are about. */
function order(lines: OcrLine[]): string[] {
  const text = readingOrderText(lines);
  if (text === null) throw new Error('expected text');
  return text.split('\n').filter((l) => l !== '');
}

/** A cookbook page: a title and an introduction across the top, then two columns. */
function cookbookPage(): OcrLine[] {
  return [
    line('Romesco Dip', 700, 100, { size: 100 }),
    line('This flavorful recipe is based on a traditional sauce from Spain.', 100, 300),
    line('With just a few whirls of the blender you have an appetizer.', 100, 360),
    // Ingredients on the left, the method on the right, their lines level with each other.
    line('1 jar roasted red peppers', 100, 500),
    line('1. In a blender, combine the peppers,', 1000, 500),
    line('1 can diced tomatoes', 100, 580),
    line('tomatoes, almonds and garlic.', 1000, 560),
    line('1/2 cup almonds', 100, 660),
    line('2. Pour in the oil with the blender', 1000, 640),
    line('2 garlic cloves', 100, 740),
    line('running until it is smooth.', 1000, 700),
    line('1/4 cup olive oil', 100, 820),
    line('3. Serve with raw vegetables.', 1000, 780),
  ];
}

describe('a two-column cookbook page', () => {
  it('reads the title and introduction, then the whole ingredient column, then the method', () => {
    expect(order(cookbookPage())).toEqual([
      'Romesco Dip',
      'This flavorful recipe is based on a traditional sauce from Spain.',
      'With just a few whirls of the blender you have an appetizer.',
      '1 jar roasted red peppers',
      '1 can diced tomatoes',
      '1/2 cup almonds',
      '2 garlic cloves',
      '1/4 cup olive oil',
      '1. In a blender, combine the peppers,',
      'tomatoes, almonds and garlic.',
      '2. Pour in the oil with the blender',
      'running until it is smooth.',
      '3. Serve with raw vegetables.',
    ]);
  });

  it('cuts a line tesseract ran across the gutter back into its two columns', () => {
    // Measured: tesseract returned "½ cup almonds 2. Begin puréeing the ingredients" as ONE
    // line when the two sat level with each other.
    const lines = cookbookPage().filter(
      (l) => l.words[0]!.text !== '1/2' && l.words[0]!.text !== '2.',
    );
    lines.push({
      words: [
        ...words('1/2 cup almonds', 100, 660),
        ...words('2. Pour in the oil with the blender', 1000, 640),
      ],
    });
    const read = order(lines);
    expect(read.indexOf('1/2 cup almonds')).toBeLessThan(read.indexOf('1/4 cup olive oil'));
    expect(read.indexOf('2. Pour in the oil with the blender')).toBeGreaterThan(
      read.indexOf('1/4 cup olive oil'),
    );
  });

  it('still finds the columns on a skewed photo, where their lines overlap all the way down', () => {
    // Every line slopes down to the right, so each method line overlaps the ingredient lines
    // beside it and below it: there is no horizontal gap anywhere under the title.
    const lines = cookbookPage().map((l) => ({
      words: l.words.map((w) => ({
        ...w,
        bbox: { ...w.bbox, y0: w.bbox.y0 + w.bbox.x0 / 8, y1: w.bbox.y1 + w.bbox.x0 / 8 },
      })),
    }));
    const read = order(lines);
    expect(read.slice(3, 8)).toEqual([
      '1 jar roasted red peppers',
      '1 can diced tomatoes',
      '1/2 cup almonds',
      '2 garlic cloves',
      '1/4 cup olive oil',
    ]);
  });

  it('keeps a footer across both columns after them rather than between them', () => {
    const lines = [
      ...cookbookPage(),
      line('https://example.com/recipes/romesco-dip page 1', 100, 1000),
    ];
    expect(order(lines).at(-1)).toBe('https://example.com/recipes/romesco-dip page 1');
    expect(order(lines).at(-2)).toBe('3. Serve with raw vegetables.');
  });

  it('does not let a page number in the margin stop the page reading as columns', () => {
    const lines = [...cookbookPage(), line('112', 1900, 650)];
    const read = order(lines);
    expect(read.indexOf('1/4 cup olive oil')).toBeLessThan(
      read.indexOf('1. In a blender, combine the peppers,'),
    );
  });
});

describe('a page photographed on its side', () => {
  /** The cookbook page as a phone held sideways sees it: turned a quarter clockwise. */
  function sideways(lines: OcrLine[], turn: 'clockwise' | 'counter-clockwise'): OcrLine[] {
    const W = 2000;
    const H = 1200;
    const rotate = (b: Box): Box =>
      turn === 'clockwise'
        ? { x0: H - b.y1, y0: b.x0, x1: H - b.y0, y1: b.x1 }
        : { x0: b.y0, y0: W - b.x1, x1: b.y1, y1: W - b.x0 };
    return lines.map((l) => ({ words: l.words.map((w) => ({ ...w, bbox: rotate(w.bbox) })) }));
  }

  it('reads it upright, whichever way it was turned', () => {
    const upright = order(cookbookPage());
    expect(order(sideways(cookbookPage(), 'clockwise'))).toEqual(upright);
    expect(order(sideways(cookbookPage(), 'counter-clockwise'))).toEqual(upright);
  });
});

describe('a single column', () => {
  it('reads top to bottom, as tesseract did', () => {
    const lines = [
      line('Slow Cooker Carnitas', 100, 100, { size: 80 }),
      line('4 pounds pork butt', 100, 300),
      line('3 teaspoons salt', 100, 360),
      line('Rinse and pat dry the pork with a paper towel.', 100, 460),
      line('Cover and cook on low for 8 hours.', 100, 520),
    ];
    expect(order(lines)).toEqual([
      'Slow Cooker Carnitas',
      '4 pounds pork butt',
      '3 teaspoons salt',
      'Rinse and pat dry the pork with a paper towel.',
      'Cover and cook on low for 8 hours.',
    ]);
  });

  it('keeps a quantity set apart from its food by a wide space on the same line', () => {
    // A typed page sets "2" and "pkgs frozen peas" with a tab between them. Cut apart, the
    // quantities form a column of their own and are all read before any food.
    const lines = ['frozen peas', 'cups Arborio rice', 'small onion, chopped'].map((food, i) => ({
      words: [...words(String(i + 2), 100, 100 + i * 60), ...words(food, 300, 100 + i * 60)],
    }));
    expect(order(lines)).toEqual([
      '2 frozen peas',
      '3 cups Arborio rice',
      '4 small onion, chopped',
    ]);
  });

  it('reads the cells of one row left to right, even when the row is skewed', () => {
    const lines = [
      line('PREP 20 mins', 100, 120),
      line('BAKE 9 mins', 700, 100),
      line('YIELD 8', 1300, 80),
    ];
    expect(order(lines)).toEqual(['PREP 20 mins', 'BAKE 9 mins', 'YIELD 8']);
  });

  it('does not put a short line under a long skewed one ahead of it', () => {
    // The long line's box is two lines tall because it slopes; measured against that box, the
    // short line under it looked like the same row and, starting further left, came first.
    const lines = [
      line('In a pie pan, place the thin prosciutto slices along the bottom and', 120, 100, {
        slope: 6,
      }),
      line('sides. Set aside.', 100, 170),
    ];
    expect(order(lines)).toEqual([
      'In a pie pan, place the thin prosciutto slices along the bottom and',
      'sides. Set aside.',
    ]);
  });
});

describe('noise', () => {
  it('drops a piece tesseract was sure of none of, and keeps a doubtful word beside sure ones', () => {
    const lines = [
      line('Carnitas', 100, 100, { size: 80 }),
      line('4 pounds pork butt', 100, 300),
      line('ih Tn', 1400, 330, { confidence: 25 }),
      line('2 limes, juiced', 100, 360, { confidence: [30, 35, 95] }),
    ];
    expect(order(lines)).toEqual(['Carnitas', '4 pounds pork butt', '2 limes, juiced']);
  });

  it('keeps a bullet at the start of its line, where from-text looks for it', () => {
    const lines = [{ words: [...words('•', 100, 100), ...words('Rinse the pork.', 130, 100)] }];
    expect(order(lines)).toEqual(['• Rinse the pork.']);
  });
});

describe('the title', () => {
  it('puts the largest type near the top first, ahead of a letterhead', () => {
    const lines = [
      line('La Cucina Cooking School', 100, 50),
      line('Sformato di Riso', 400, 200, { size: 70 }),
      line('2 cups Arborio rice', 100, 400),
      line('1 small onion', 100, 460),
      line('Cook the rice.', 100, 560),
    ];
    expect(order(lines)[0]).toBe('Sformato di Riso');
  });

  it('leaves a large title it could not read where it was', () => {
    const lines = [
      line('Vata alsicoa e Forni', 400, 50, { size: 90, confidence: 60 }),
      line('Pasta with Leeks and Sausage', 400, 200),
      line('4 tablespoons olive oil', 100, 400),
      line('3 cups leeks', 100, 460),
    ];
    expect(order(lines).slice(0, 2)).toEqual([
      'Vata alsicoa e Forni',
      'Pasta with Leeks and Sausage',
    ]);
  });

  it('keeps a title set over several lines together, top line first', () => {
    // The Defined Dish sets "CURRIED / BEEF-STUFFED / ACORN SQUASH" down the page, and the
    // middle line is the widest and so the tallest box: promoting it alone read the title as
    // "BEEF-STUFFED" with the rest of it below.
    const lines = [
      line('CURRIED', 100, 100, { size: 100 }),
      line('BEEF-STUFFED', 100, 210, { size: 104 }),
      line('ACORN SQUASH', 100, 320, { size: 100 }),
      line('SERVES 4', 1200, 60),
      line('This recipe is one of my favorites, and that is saying a lot.', 100, 520),
      line('2 medium-size acorn squash', 1200, 520),
      line('1 tablespoon curry powder', 1200, 580),
    ];
    expect(order(lines)[0]).toBe('CURRIED BEEF-STUFFED ACORN SQUASH');
    expect(order(lines)).not.toContain('CURRIED');
  });

  it('does not pull a heading of the same size from across the page into the title', () => {
    const lines = [
      line('Pesto', 100, 100, { size: 100 }),
      line('Crostini', 1400, 400, { size: 100 }),
      line('1 cup basil leaves', 100, 700),
      line('2 cloves garlic', 100, 760),
    ];
    expect(order(lines)[0]).toBe('Pesto');
  });

  it('does not promote a large fragment too short to be a name', () => {
    const lines = [
      line('Sformato di Riso', 400, 200, { size: 70 }),
      line('La Cucina', 100, 60),
      line('net', 1400, 100, { size: 76 }),
      line('2 cups Arborio rice', 100, 400),
      line('1 small onion', 100, 460),
      line('Cook the rice.', 100, 560),
    ];
    expect(order(lines)[0]).toBe('Sformato di Riso');
  });
});

describe('paragraphs', () => {
  it('puts a blank line between ingredients set apart by extra space, and none inside one', () => {
    // A narrow ingredient column wraps an ingredient onto a second line and leaves more space
    // above the next ingredient than between the two: that space is the only thing that says
    // "red peppers, drained" is not an ingredient of its own.
    const text = readingOrderText([
      line('1 jar roasted', 100, 100),
      line('red peppers, drained', 100, 150),
      line('1 can diced', 100, 230),
      line('tomatoes, undrained', 100, 280),
    ]);
    expect(text).toBe('1 jar roasted\nred peppers, drained\n\n1 can diced\ntomatoes, undrained');
  });

  it('measures a break against the page, so a roomy printout is not broken after every line', () => {
    // Over half a type size between the lines of one step - more than a tight cookbook leaves
    // between two ingredients - and two type sizes between steps.
    const text = readingOrderText([
      line('Rinse the pork and pat it dry', 100, 100),
      line('with a paper towel.', 100, 164),
      line('Cover and cook on low', 100, 284),
      line('for eight hours.', 100, 348),
      line('Shred it with two forks.', 100, 468),
    ]);
    expect(text).toBe(
      'Rinse the pork and pat it dry\nwith a paper towel.\n\nCover and cook on low\nfor eight hours.\n\nShred it with two forks.',
    );
  });
});

describe('a justified paragraph', () => {
  it('keeps a word left out on its own by a wide space in its line, not in a column of its own', () => {
    // "Then    refrigerate": justified type in a photo, cut at the wide space. Stacked down the
    // page those stragglers have clear space to their left, like a column, but they start
    // wherever the spacing put them.
    const straggling = (left: string, right: string, x: number, y: number): OcrLine => ({
      words: [...words(left, 100, y), ...words(right, x, y)],
    });
    const lines = [
      line('Then cut the butter into small pieces and add it to the flour and cut', 100, 100),
      straggling('texture of soft dry polenta. Stir in', 'refrigerate', 1100, 150),
      straggling('the spinach well to remove all', 'from the heat', 1500, 200),
      straggling('then place it in a large pot', 'chopped', 1250, 250),
      straggling('cover it and cook it until', 'barely', 1650, 300),
      straggling('squeeze out all the water', 'drained', 1350, 350),
      straggling('put the spinach in a bowl', 'Meanwhile', 1800, 400),
      line('and cook it until it is barely tender, about four minutes, then drain', 100, 450),
    ];
    expect(order(lines)).toEqual([
      'Then cut the butter into small pieces and add it to the flour and cut',
      'texture of soft dry polenta. Stir in',
      'refrigerate',
      'the spinach well to remove all',
      'from the heat',
      'then place it in a large pot',
      'chopped',
      'cover it and cook it until',
      'barely',
      'squeeze out all the water',
      'drained',
      'put the spinach in a bowl',
      'Meanwhile',
      'and cook it until it is barely tender, about four minutes, then drain',
    ]);
  });
});

describe('what it will not order', () => {
  it("returns null for a page with no words on it, so tesseract's text is used", () => {
    expect(readingOrderText([])).toBeNull();
    expect(readingOrderText([line('| ~ |', 100, 100)])).toBeNull();
  });

  it('returns null for more pieces than any recipe page has, rather than searching them', () => {
    const lines = Array.from({ length: 700 }, (_, i) => line(`word${i}`, (i % 7) * 400, i * 10));
    expect(readingOrderText(lines)).toBeNull();
  });

  it('stays fast on the most pieces it will take, laid out to make the search work hardest', () => {
    // Short pieces scattered so no gutter survives and every region falls through to the
    // peel search: the worst case for `framedColumns`.
    let seed = 7;
    const random = () => {
      seed = (seed * 48271) % 2147483647;
      return seed / 2147483647;
    };
    const lines = Array.from({ length: 590 }, () =>
      line('ab cd', Math.floor(random() * 3000), Math.floor(random() * 4000)),
    );
    const started = Date.now();
    readingOrderText(lines);
    expect(Date.now() - started).toBeLessThan(2000);
  });

  it('keeps its patterns linear on a hostile word', () => {
    const started = Date.now();
    readingOrderText([
      {
        words: [
          { text: '1'.repeat(200_000), confidence: 95, bbox: { x0: 0, y0: 0, x1: 10, y1: 40 } },
        ],
      },
      {
        words: [
          {
            text: '½/'.repeat(100_000) + 'x',
            confidence: 95,
            bbox: { x0: 0, y0: 50, x1: 10, y1: 90 },
          },
        ],
      },
      line(`${'a'.repeat(100_000)} b`, 0, 100, { size: 200 }),
    ]);
    expect(Date.now() - started).toBeLessThan(500);
  });
});
