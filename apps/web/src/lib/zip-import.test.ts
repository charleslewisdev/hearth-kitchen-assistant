import { describe, expect, it, vi } from 'vitest';
import { strToU8, Zip, ZipDeflate, ZipPassThrough, zipSync } from 'fflate';
import { MAX_TEXT_LENGTH } from '@hearth/shared';
import {
  MAX_ZIP_RECIPES,
  readZipFiles,
  readZipRecipes,
  TooManyRecipesError,
  ZIP_INPUT_SLICE,
} from './zip-import';

// Every byte the reader's inflater hands out, so a test can see how much of an entry was
// decompressed, not only what the reader made of it.
const inflated = vi.hoisted(() => ({ bytes: 0 }));
vi.mock('fflate', async (importOriginal) => {
  const real = await importOriginal<typeof import('fflate')>();
  class CountingInflate extends real.Inflate {
    constructor(cb: (data: Uint8Array, final: boolean) => void) {
      super((data, final) => {
        inflated.bytes += data.length;
        cb(data, final);
      });
    }
  }
  return { ...real, Inflate: CountingInflate };
});

const recipeText = (title: string, extra = '') =>
  `---\nhearth_format: 1\ntitle: ${JSON.stringify(title)}\nservings: 2\n${extra}---\n\n## Ingredients\n\n- 1 egg\n`;

const asFile = (bytes: Uint8Array) => new File([bytes as Uint8Array<ArrayBuffer>], 'x.zip');

/**
 * A zip written the way a stream writes one: sizes in a data descriptor after each entry, so
 * the local header says nothing about how large the entry is and only decompressing tells.
 */
function streamedZip(entries: { name: string; data: Uint8Array; store?: boolean }[]): Uint8Array {
  const parts: Uint8Array[] = [];
  const zip = new Zip((err, chunk) => {
    if (err) throw err;
    parts.push(chunk);
  });
  for (const { name, data, store } of entries) {
    const entry = store ? new ZipPassThrough(name) : new ZipDeflate(name, { level: 9 });
    zip.add(entry);
    entry.push(data, true);
  }
  zip.end();
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let at = 0;
  for (const p of parts) {
    out.set(p, at);
    at += p.length;
  }
  return out;
}

describe('readZipRecipes', () => {
  it('lists each Markdown recipe with its path, and skips other entries without reading them', async () => {
    const zip = zipSync({
      'hearth-recipes-2026-11-13/': new Uint8Array(0),
      'hearth-recipes-2026-11-13/green-chile-stew.md': strToU8(
        recipeText('Green Chile Stew', "photos: ['green-chile-stew/photo-1.jpg']\n"),
      ),
      'hearth-recipes-2026-11-13/green-chile-stew/photo-1.jpg': new Uint8Array(50_000).fill(7),
      'hearth-recipes-2026-11-13/pizza-dough.md': strToU8(recipeText('Pizza Dough')),
      'hearth-recipes-2026-11-13/notes.md': strToU8('# Notes\n\nNot a recipe.\n'),
      '__MACOSX/hearth-recipes-2026-11-13/._pizza-dough.md': strToU8(recipeText('Junk')),
    });
    inflated.bytes = 0;
    const result = await readZipRecipes(asFile(zip));
    expect(result.recipes.map((r) => [r.path, r.recipe.title])).toEqual([
      ['green-chile-stew.md', 'Green Chile Stew'],
      ['pizza-dough.md', 'Pizza Dough'],
    ]);
    expect(result.recipes[0]!.recipe.files?.photos).toEqual(['green-chile-stew/photo-1.jpg']);
    expect(result.notRecipes).toEqual(['notes.md']);
    expect(result.tooLarge).toEqual([]);
    // The photo was never decompressed: only the three Markdown entries were.
    expect(inflated.bytes).toBeLessThan(2_000);
  });

  it('uses names as they are when the zip has no single top folder', async () => {
    const zip = zipSync({
      'pizza-dough.md': strToU8(recipeText('Pizza Dough')),
      'more/bread.md': strToU8(recipeText('Bread')),
    });
    const result = await readZipRecipes(asFile(zip));
    expect(result.recipes.map((r) => r.path)).toEqual(['pizza-dough.md', 'more/bread.md']);
  });

  it('stops reading an entry past its cap', async () => {
    const long = recipeText('Long') + 'a'.repeat(MAX_TEXT_LENGTH);
    const zip = zipSync({
      'top/long.md': strToU8(long),
      'top/short.md': strToU8(recipeText('Short')),
    });
    const result = await readZipRecipes(asFile(zip));
    expect(result.tooLarge).toEqual(['long.md']);
    expect(result.recipes.map((r) => r.path)).toEqual(['short.md']);
  });

  it('stops decompressing a zip bomb at the cap, whatever its header claims', async () => {
    const bomb = new Uint8Array(64 * 1024 * 1024);
    const zip = streamedZip([
      { name: 'top/', data: new Uint8Array(0), store: true },
      { name: 'top/bomb.md', data: bomb },
      { name: 'top/short.md', data: strToU8(recipeText('Short')) },
    ]);
    inflated.bytes = 0;
    const result = await readZipRecipes(asFile(zip));
    expect(result.tooLarge).toEqual(['bomb.md']);
    expect(result.recipes.map((r) => r.path)).toEqual(['short.md']);
    // The cap in bytes (three UTF-8 bytes per character at most), plus what one slice of input
    // can inflate to (DEFLATE's ratio tops out near 1032 to 1), plus the short recipe.
    expect(inflated.bytes).toBeLessThan(3 * MAX_TEXT_LENGTH + 1032 * ZIP_INPUT_SLICE + 1_000);
    expect(inflated.bytes).toBeLessThan(bomb.length / 4);
  });

  it('refuses more than 2,000 recipes', async () => {
    expect(MAX_ZIP_RECIPES).toBe(2000);
    const entries: Record<string, Uint8Array> = {};
    for (let i = 0; i <= MAX_ZIP_RECIPES; i++) entries[`r${i}.md`] = strToU8(recipeText(`R${i}`));
    await expect(readZipRecipes(asFile(zipSync(entries)))).rejects.toBeInstanceOf(
      TooManyRecipesError,
    );

    delete entries[`r${MAX_ZIP_RECIPES}.md`];
    const result = await readZipRecipes(asFile(zipSync(entries)));
    expect(result.recipes).toHaveLength(MAX_ZIP_RECIPES);
  });
});

describe('readZipFiles', () => {
  it('yields only the wanted entries, each capped', async () => {
    const photo = new Uint8Array(1000).fill(1);
    const zip = zipSync(
      {
        'hearth-recipes-2026-11-13/': new Uint8Array(0),
        'hearth-recipes-2026-11-13/a.md': strToU8(recipeText('A')),
        'hearth-recipes-2026-11-13/a/photo-1.jpg': photo,
        'hearth-recipes-2026-11-13/a/photo-2.jpg': new Uint8Array(2000).fill(2),
        'hearth-recipes-2026-11-13/a/page-1.jpg': new Uint8Array(5000).fill(3),
      },
      { level: 0 },
    );
    const got: [string, number[]][] = [];
    const onTooLarge = vi.fn();
    await readZipFiles(
      asFile(zip),
      new Map([
        ['a/photo-1.jpg', 3 * 1024 * 1024],
        ['a/page-1.jpg', 4000],
      ]),
      {
        onFile: (path, bytes) => {
          got.push([path, [...new Set(bytes)]]);
        },
        onTooLarge,
      },
    );
    expect(got).toEqual([['a/photo-1.jpg', [1]]]);
    expect(onTooLarge).toHaveBeenCalledOnce();
    expect(onTooLarge).toHaveBeenCalledWith('a/page-1.jpg');
  });

  it('stops decompressing an entry at its cap', async () => {
    const zip = streamedZip([
      { name: 'top/a/source.pdf', data: new Uint8Array(64 * 1024 * 1024) },
      { name: 'top/a/photo-1.jpg', data: new Uint8Array(10).fill(9) },
    ]);
    inflated.bytes = 0;
    const onFile = vi.fn();
    const onTooLarge = vi.fn();
    await readZipFiles(
      asFile(zip),
      new Map([
        ['a/source.pdf', 1024 * 1024],
        ['a/photo-1.jpg', 100],
      ]),
      { onFile, onTooLarge },
    );
    expect(onTooLarge).toHaveBeenCalledOnce();
    expect(onTooLarge).toHaveBeenCalledWith('a/source.pdf');
    expect(onFile).toHaveBeenCalledOnce();
    expect(onFile).toHaveBeenCalledWith('a/photo-1.jpg', expect.any(Uint8Array));
    expect(inflated.bytes).toBeLessThan(1024 * 1024 + 1032 * ZIP_INPUT_SLICE + 100);
  });

  it('awaits each file before reading further, so one entry is held at a time', async () => {
    const zip = zipSync(
      {
        'top/a/photo-1.jpg': new Uint8Array(10).fill(1),
        'top/a/photo-2.jpg': new Uint8Array(10).fill(2),
      },
      { level: 0 },
    );
    const events: string[] = [];
    await readZipFiles(
      asFile(zip),
      new Map([
        ['a/photo-1.jpg', 100],
        ['a/photo-2.jpg', 100],
      ]),
      {
        onFile: async (path) => {
          events.push(`start ${path}`);
          await new Promise((resolve) => setTimeout(resolve, 5));
          events.push(`end ${path}`);
        },
        onTooLarge: () => {},
      },
    );
    expect(events).toEqual([
      'start a/photo-1.jpg',
      'end a/photo-1.jpg',
      'start a/photo-2.jpg',
      'end a/photo-2.jpg',
    ]);
  });

  it('matches names as they are when the first folder is not a top folder', async () => {
    const zip = zipSync({
      'a/photo-1.jpg': new Uint8Array(10).fill(1),
      'a.md': strToU8(recipeText('A')),
    });
    const onFile = vi.fn();
    await readZipFiles(asFile(zip), new Map([['a/photo-1.jpg', 100]]), {
      onFile,
      onTooLarge: () => {},
    });
    expect(onFile).toHaveBeenCalledOnce();
    expect(onFile).toHaveBeenCalledWith('a/photo-1.jpg', expect.any(Uint8Array));
  });
});
