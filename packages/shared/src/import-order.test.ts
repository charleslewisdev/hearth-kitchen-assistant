import { describe, expect, it } from 'vitest';
import { planImport, unlinkRecipeLine } from './import-order';
import { recipeTitleKey } from './recipe-link';

interface Item {
  title: string;
  lines: string[];
}

const read = (item: Item) => ({ title: item.title, ingredientLines: item.lines });
const plan = (items: Item[], library: string[] = []) =>
  planImport(items, read, new Set(library.map(recipeTitleKey)));
const titles = (p: ReturnType<typeof plan>) => p.create.map((c) => c.item.title);

describe('planImport', () => {
  it('skips titles already in the library and repeats inside the zip', () => {
    const p = plan(
      [
        { title: 'Pizza Dough', lines: [] },
        { title: 'Stew', lines: [] },
        { title: 'stew', lines: [] },
      ],
      ['Pizza Dough'],
    );
    expect(p.skipped).toEqual(['Pizza Dough', 'stew']);
    expect(titles(p)).toEqual(['Stew']);
  });

  it('creates linked recipes first', () => {
    const p = plan([
      { title: 'Pizza', lines: ['1 [[Pizza Dough]]', '200 g mozzarella'] },
      { title: 'Pizza Dough', lines: ['500 g flour'] },
    ]);
    expect(titles(p)).toEqual(['Pizza Dough', 'Pizza']);
    expect(p.create[1]?.ingredientLines).toEqual(['1 [[Pizza Dough]]', '200 g mozzarella']);
    expect(p.unlinked).toEqual([]);
  });

  it('keeps input order among independent recipes', () => {
    const p = plan([
      { title: 'C', lines: [] },
      { title: 'A', lines: [] },
      { title: 'B', lines: [] },
    ]);
    expect(titles(p)).toEqual(['C', 'A', 'B']);
  });

  it('keeps a link to a library recipe', () => {
    const p = plan([{ title: 'Pizza', lines: ['1 [[pizza dough]]'] }], ['Pizza Dough']);
    expect(p.create[0]?.ingredientLines).toEqual(['1 [[pizza dough]]']);
    expect(p.unlinked).toEqual([]);
  });

  it('unlinks a title found nowhere', () => {
    const p = plan([{ title: 'Haunted', lines: ['1 [[Ghost]]', '2 eggs'] }]);
    expect(p.create[0]?.ingredientLines).toEqual(['1 Ghost', '2 eggs']);
    expect(p.unlinked).toEqual(['Haunted']);
  });

  it('unlinks a line that is only a link to its bare title', () => {
    const p = plan([{ title: 'Haunted', lines: ['[[Ghost]]'] }]);
    expect(p.create[0]?.ingredientLines).toEqual(['Ghost']);
  });

  it('breaks a cycle', () => {
    const p = plan([
      { title: 'A', lines: ['1 [[B]]'] },
      { title: 'B', lines: ['1 [[A]]'] },
    ]);
    expect(titles(p)).toEqual(['B', 'A']);
    expect(p.create[0]?.ingredientLines).toEqual(['1 A']);
    expect(p.create[1]?.ingredientLines).toEqual(['1 [[B]]']);
    expect(p.unlinked).toEqual(['B']);
  });

  it('unlinks a recipe that links itself', () => {
    const p = plan([{ title: 'A', lines: ['1 [[A]]'] }]);
    expect(p.create[0]?.ingredientLines).toEqual(['1 A']);
    expect(p.unlinked).toEqual(['A']);
  });

  it('a link to a skipped duplicate is kept', () => {
    const p = plan(
      [
        { title: 'Pizza Dough', lines: [] },
        { title: 'Pizza', lines: ['1 [[Pizza Dough]]'] },
      ],
      ['Pizza Dough'],
    );
    expect(p.skipped).toEqual(['Pizza Dough']);
    expect(titles(p)).toEqual(['Pizza']);
    expect(p.create[0]?.ingredientLines).toEqual(['1 [[Pizza Dough]]']);
    expect(p.unlinked).toEqual([]);
  });

  it('orders a long chain without overflowing the stack', () => {
    const n = 5000;
    const items = Array.from({ length: n }, (_, i) => ({
      title: `R${i}`,
      lines: i + 1 < n ? [`1 [[R${i + 1}]]`] : [],
    }));
    const p = plan(items);
    expect(p.create).toHaveLength(n);
    expect(p.create[0]?.item.title).toBe(`R${n - 1}`);
    expect(p.create[n - 1]?.item.title).toBe('R0');
  });
});

describe('unlinkRecipeLine', () => {
  it('writes the link back as the linked title in plain words', () => {
    expect(unlinkRecipeLine('1 [[Pizza Dough]]')).toBe('1 Pizza Dough');
    expect(unlinkRecipeLine('[[Pizza Dough]]')).toBe('Pizza Dough');
  });

  it('leaves a line without a link as it is', () => {
    expect(unlinkRecipeLine('200 g mozzarella')).toBe('200 g mozzarella');
  });
});
