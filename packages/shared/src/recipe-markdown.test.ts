import { describe, it, expect } from 'vitest';
import {
  parseRecipeMarkdown,
  recipeMarkdownFileName,
  recipeToMarkdown,
  type MarkdownRecipe,
} from './recipe-markdown';

/** An invented recipe that uses every field the format carries. */
const rich: MarkdownRecipe = {
  title: 'Charred Fennel & "Smoky" Toast: Take 2',
  servings: 6,
  servingsHigh: 8,
  prepMinutes: 15,
  cookMinutes: 40,
  types: ['dinner', 'side'],
  tags: ['make ahead', 'weeknight'],
  rating: 4,
  sourceName: 'Aunt Wren’s card box, card 7',
  sourceUrl: 'https://example.com/recipes/fennel-toast?x=1&y=2',
  description:
    'Line one of the notes.\n\n## Not a heading of ours\n- not an ingredient\n1. not a step',
  ingredientLines: [
    '3 cups (360g) flour',
    '1 Pizza Dough [[Pizza Dough]]',
    '- a line that starts with a dash',
    '2 tbsp olive oil, plus more',
  ],
  steps: [
    'Heat the oven to 220°C.',
    'Toast the bread.\nThen rub it with garlic.\n  Indented on purpose.',
    '10. Starts with a number of its own.',
  ],
};

describe('recipeToMarkdown', () => {
  it('writes front matter, a title heading and the three sections in a fixed order', () => {
    const md = recipeToMarkdown(rich);
    expect(md).toBe(
      [
        '---',
        'hearth_format: 1',
        'title: "Charred Fennel & \\"Smoky\\" Toast: Take 2"',
        'servings: 6',
        'servings_high: 8',
        'prep_minutes: 15',
        'cook_minutes: 40',
        'types: ["dinner", "side"]',
        'tags: ["make ahead", "weeknight"]',
        'rating: 4',
        'source_name: "Aunt Wren’s card box, card 7"',
        'source_url: "https://example.com/recipes/fennel-toast?x=1&y=2"',
        '---',
        '',
        '# Charred Fennel & "Smoky" Toast: Take 2',
        '',
        '## Ingredients',
        '',
        '- 3 cups (360g) flour',
        '- 1 Pizza Dough [[Pizza Dough]]',
        '- - a line that starts with a dash',
        '- 2 tbsp olive oil, plus more',
        '',
        '## Method',
        '',
        '1. Heat the oven to 220°C.',
        '2. Toast the bread.',
        '   Then rub it with garlic.',
        '     Indented on purpose.',
        '3. 10. Starts with a number of its own.',
        '',
        '## Notes',
        '',
        'Line one of the notes.',
        '',
        '## Not a heading of ours',
        '- not an ingredient',
        '1. not a step',
        '',
      ].join('\n'),
    );
  });

  it('leaves out what a recipe does not have, but keeps both list sections', () => {
    const md = recipeToMarkdown({
      title: 'Toast',
      servings: 1,
      servingsHigh: null,
      prepMinutes: null,
      cookMinutes: null,
      types: [],
      tags: [],
      rating: null,
      sourceName: null,
      sourceUrl: null,
      description: null,
      ingredientLines: [],
      steps: [],
    });
    expect(md).toBe(
      '---\nhearth_format: 1\ntitle: "Toast"\nservings: 1\n---\n\n# Toast\n\n## Ingredients\n\n## Method\n',
    );
  });

  it('is the same text every time for the same recipe', () => {
    expect(recipeToMarkdown(rich)).toBe(recipeToMarkdown({ ...rich }));
  });
});

describe('parseRecipeMarkdown', () => {
  it('reads back exactly what recipeToMarkdown wrote', () => {
    expect(parseRecipeMarkdown(recipeToMarkdown(rich))).toEqual(rich);
  });

  it('round-trips a recipe with nothing optional in it', () => {
    const bare: MarkdownRecipe = {
      title: 'Toast',
      servings: 1,
      servingsHigh: null,
      prepMinutes: null,
      cookMinutes: null,
      types: [],
      tags: [],
      rating: null,
      sourceName: null,
      sourceUrl: null,
      description: null,
      ingredientLines: [],
      steps: [],
    };
    expect(parseRecipeMarkdown(recipeToMarkdown(bare))).toEqual(bare);
  });

  it('round-trips the text a line-by-line format finds hardest', () => {
    const awkward: MarkdownRecipe = {
      ...rich,
      title: 'Back\\slash, “curly” and émigré: a \t tab',
      sourceName: 'Line one\nline two',
      tags: ['a, with a comma', '#hash', '"quoted"'],
      ingredientLines: ['## not a heading', '1. not a step', '[[Linked]] only'],
      steps: [
        'Mix.\n\nThen rest, after a blank line.',
        '- starts like a bullet',
        '## starts like a heading',
        'Ends on a list:\n- one\n- two',
        'Two blank lines\n\n\nin a row.',
      ],
      description: '---\nNotes that open with a rule.\n## Ingredients\n- not one',
    };
    expect(parseRecipeMarkdown(recipeToMarkdown(awkward))).toEqual(awkward);
  });

  it('keeps a blank line inside a step after an editor strips trailing spaces', () => {
    const recipe = { ...rich, steps: ['Mix.\n\nThen rest.', 'Bake.'] };
    const saved = recipeToMarkdown(recipe).replace(/ +\n/g, '\n');
    expect(parseRecipeMarkdown(saved)?.steps).toEqual(['Mix.\n\nThen rest.', 'Bake.']);
  });

  it('round-trips more than nine steps, whose markers grow a digit', () => {
    const many = { ...rich, steps: Array.from({ length: 12 }, (_, i) => `Step ${i}\nmore ${i}`) };
    expect(parseRecipeMarkdown(recipeToMarkdown(many))?.steps).toEqual(many.steps);
  });

  it('is null for text without front matter, so the text heuristics take it', () => {
    expect(parseRecipeMarkdown('# Toast\n\n## Ingredients\n- 1 slice bread\n')).toBeNull();
    expect(parseRecipeMarkdown('---\nnot closed\n')).toBeNull();
    expect(parseRecipeMarkdown('Toast\n---\ntitle: x\n---\n')).toBeNull();
  });

  it('is null for a paste that opens with a horizontal rule rather than front matter', () => {
    expect(
      parseRecipeMarkdown("---\nGrandma's Soup\n2 cups stock\n---\n1. Simmer it.\n"),
    ).toBeNull();
  });

  it('survives Windows line ends and a byte-order mark', () => {
    const md = '﻿' + recipeToMarkdown(rich).replace(/\n/g, '\r\n');
    expect(parseRecipeMarkdown(md)).toEqual(rich);
  });

  it('reads front matter a person wrote by hand in ordinary YAML', () => {
    const md = [
      '---',
      'title: Weeknight Beans',
      "source_name: 'Grandpa''s notebook'",
      'servings: 3',
      'types: [dinner, Lunch, pudding]',
      'tags:',
      '  - quick',
      '- "one pot"',
      '# a comment',
      'unknown_key: ignored',
      '---',
      '## Ingredients',
      '* 1 can beans',
      '',
      'a line with no marker',
      '## Steps',
      '1) Warm the beans.',
      '- Season them.',
      '## Notes',
      'Good with rice.',
    ].join('\n');
    expect(parseRecipeMarkdown(md)).toEqual({
      title: 'Weeknight Beans',
      servings: 3,
      servingsHigh: null,
      prepMinutes: null,
      cookMinutes: null,
      types: ['dinner', 'lunch'],
      tags: ['quick', 'one pot'],
      rating: null,
      sourceName: "Grandpa's notebook",
      sourceUrl: null,
      description: 'Good with rice.',
      ingredientLines: ['1 can beans', 'a line with no marker'],
      steps: ['Warm the beans.', 'Season them.'],
    });
  });

  it('takes the title from the first heading when the front matter has none', () => {
    const md = '---\nservings: 2\n---\n# Pan Sauce\n## Ingredients\n- 1 shallot\n';
    expect(parseRecipeMarkdown(md)?.title).toBe('Pan Sauce');
  });

  it('drops values Hearth would refuse rather than guessing at them', () => {
    const md = [
      '---',
      'title: "Toast"',
      'servings: 0',
      'prep_minutes: -5',
      'cook_minutes: 99999',
      'rating: 9',
      'source_url: "javascript:alert(1)"',
      'types: "dinner"',
      '---',
    ].join('\n');
    expect(parseRecipeMarkdown(md)).toMatchObject({
      servings: 1,
      servingsHigh: null,
      prepMinutes: null,
      cookMinutes: null,
      rating: null,
      sourceUrl: null,
      types: [],
    });
  });

  it('reads a hand-written range of servings, quoted or bare', () => {
    expect(parseRecipeMarkdown('---\nservings: 4\nservings_high: 6\n---\n')?.servingsHigh).toBe(6);
    expect(parseRecipeMarkdown("---\nservings: '4'\nservings_high: '6'\n---\n")).toMatchObject({
      servings: 4,
      servingsHigh: 6,
    });
    // A file with only the key is still a recipe's front matter.
    expect(parseRecipeMarkdown('---\nservings_high: 6\n---\n')).not.toBeNull();
  });

  it('drops a servings range the API would refuse or not store', () => {
    const high = (front: string) => parseRecipeMarkdown(`---\n${front}\n---\n`)?.servingsHigh;
    // Not above the servings: "4 to 4" is just 4, and a range never runs downward.
    expect(high('servings: 4\nservings_high: 4')).toBeNull();
    expect(high('servings: 4\nservings_high: 3')).toBeNull();
    // Over the cap `recipe.create` puts on it, and anything not a whole number.
    expect(high('servings: 4\nservings_high: 10000')).toBe(10_000);
    expect(high('servings: 4\nservings_high: 10001')).toBeNull();
    expect(high('servings: 4\nservings_high: 5.5')).toBeNull();
    expect(high('servings: 4\nservings_high: six')).toBeNull();
    expect(high('servings: 4\nservings_high: [6]')).toBeNull();
    // No low end stated (or one that was dropped): no range, rather than one from the fallback 1.
    expect(high('servings_high: 6')).toBeNull();
    expect(high('servings: 0\nservings_high: 6')).toBeNull();
    // A count past the cap can have no high end under it.
    expect(high('servings: 20000\nservings_high: 30000')).toBeNull();
  });

  it('stays linear on hostile input, each shape on its own clock', () => {
    const closedTags = `---\ntags: [${'"a",'.repeat(12_000)}"a"]\n---\n`;
    const runs: [string, string][] = [
      ['unclosed front matter', '---\n' + 'a'.repeat(200_000)],
      ['a run of quotes as a value', '---\ntitle: ' + '"'.repeat(49_000) + '\n---\n'],
      ['a closed flow list at the cap', closedTags],
      ['bare flow list items', `---\ntags: [${'a,'.repeat(24_000)}a]\n---\n`],
      ['a long block list', '---\ntags:\n' + '  - x\n'.repeat(8_000) + '---\n'],
      ['front matter just over the cap', '---\ntitle: x\n' + 'a'.repeat(50_000) + '\n---\n'],
      [
        'a run of digits as a range',
        '---\nservings: 4\nservings_high: ' + '9'.repeat(49_000) + '\n---\n',
      ],
      ['a run of colons', '---\n' + ':'.repeat(49_000) + '\ntitle: x\n---\n'],
      ['digits before a marker', '---\ntitle: x\n---\n## Method\n' + '1'.repeat(100_000) + '. x\n'],
      ['spaces before a step', '---\ntitle: x\n---\n## Method\n' + ' '.repeat(100_000) + 'x\n'],
      ['many steps', '---\ntitle: x\n---\n## Method\n' + '1. x\n   y\n\n'.repeat(10_000)],
      [
        'many blank lines in a step',
        '---\ntitle: x\n---\n## Method\n1. x\n' + '\n'.repeat(100_000) + '   y\n',
      ],
      ['a run of hashes', '---\ntitle: x\n---\n' + '#'.repeat(100_000) + '\n'],
      [
        'a run of list markers',
        '---\ntitle: x\n---\n## Ingredients\n' + '- '.repeat(50_000) + '\n',
      ],
      ['a run of headings', '---\ntitle: x\n---\n' + '## x\n'.repeat(20_000)],
      ['a run of newlines', '---\ntitle: x\n---\n' + '\n'.repeat(100_000)],
    ];
    for (const [name, run] of runs) {
      const started = Date.now();
      parseRecipeMarkdown(run);
      expect([name, Date.now() - started < 200]).toEqual([name, true]);
    }
    // The writer too: notes and steps are the household's own text, and have no small cap.
    const started = Date.now();
    recipeToMarkdown({
      ...rich,
      description: 'x' + '\n'.repeat(100_000) + 'y',
      steps: ['a' + '\n'.repeat(100_000)],
    });
    expect(Date.now() - started).toBeLessThan(200);
  });
});

describe('recipeMarkdownFileName', () => {
  it('names a file after the recipe, and never twice in one export', () => {
    const used = new Set<string>();
    expect(recipeMarkdownFileName('Lemon Rice', used)).toBe('lemon-rice.md');
    expect(recipeMarkdownFileName('Lemon rice!', used)).toBe('lemon-rice-2.md');
    expect(recipeMarkdownFileName('Lemon Rice', used)).toBe('lemon-rice-3.md');
    expect(recipeMarkdownFileName('Сырники', used)).toBe('recipe.md');
    expect(recipeMarkdownFileName('', used)).toBe('recipe-2.md');
  });

  it('keeps a long title to a name every file system takes', () => {
    expect(recipeMarkdownFileName('x'.repeat(500), new Set()).length).toBeLessThanOrEqual(83);
  });
});
