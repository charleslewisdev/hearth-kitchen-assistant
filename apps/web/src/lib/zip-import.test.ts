import { afterEach, describe, expect, it, vi } from 'vitest';
import { strToU8, Zip, ZipDeflate, ZipPassThrough, zipSync } from 'fflate';
import { MAX_TEXT_LENGTH } from '@hearth/shared';
import {
  MAX_ZIP_RECIPES,
  NotAZipError,
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

afterEach(() => {
  vi.restoreAllMocks();
});

const recipeText = (title: string, extra = '') =>
  `---\nhearth_format: 1\ntitle: ${JSON.stringify(title)}\nservings: 2\n${extra}---\n\n## Ingredients\n\n- 1 egg\n`;

const asFile = (bytes: Uint8Array) => new File([bytes as Uint8Array<ArrayBuffer>], 'x.zip');

/**
 * A zip written the way a stream writes one, as the server's export does: sizes in a data
 * descriptor after each entry, so the local header says nothing about how large the entry is.
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

const u16 = (bytes: Uint8Array, at: number) => bytes[at]! | (bytes[at + 1]! << 8);
const u32 = (bytes: Uint8Array, at: number) => (u16(bytes, at) | (u16(bytes, at + 2) << 16)) >>> 0;
const put32 = (bytes: Uint8Array, at: number, value: number) => {
  for (let i = 0; i < 4; i++) bytes[at + i] = (value >>> (8 * i)) & 255;
};

/** Where an entry's central directory record, local header and data are, to damage a test zip. */
function locate(zip: Uint8Array, name: string) {
  const eocd = zip.length - 22;
  expect(u32(zip, eocd)).toBe(0x06054b50);
  let at = u32(zip, eocd + 16);
  const wanted = strToU8(name);
  for (let i = 0; i < u16(zip, eocd + 10); i++) {
    const nameLength = u16(zip, at + 28);
    const here = zip.subarray(at + 46, at + 46 + nameLength);
    if (here.length === wanted.length && here.every((b, j) => b === wanted[j])) {
      const local = u32(zip, at + 42);
      const data = local + 30 + u16(zip, local + 26) + u16(zip, local + 28);
      return { central: at, local, data, compressedSize: u32(zip, at + 20) };
    }
    at += 46 + nameLength + u16(zip, at + 30) + u16(zip, at + 32);
  }
  throw new Error(`no entry ${name}`);
}

/** Make the central directory claim `size` as an entry's uncompressed size. */
function claimSize(zip: Uint8Array, name: string, size: number): void {
  put32(zip, locate(zip, name).central + 24, size);
}

/**
 * The same zip written as ZIP64: every size and offset in the central directory moved into a
 * ZIP64 extra field, and the end record pointing at a ZIP64 end record, as a tool does for a
 * zip past 4GB or 65,535 entries.
 */
function toZip64(zip: Uint8Array): Uint8Array {
  const eocd = zip.length - 22;
  const count = u16(zip, eocd + 10);
  const directoryOffset = u32(zip, eocd + 16);
  const out: number[] = [...zip.subarray(0, directoryOffset)];
  const push16 = (v: number) => out.push(v & 255, (v >>> 8) & 255);
  const push32 = (v: number) => {
    push16(v & 0xffff);
    push16(v >>> 16);
  };
  const push64 = (v: number) => {
    push32(v);
    push32(0);
  };
  let at = directoryOffset;
  for (let i = 0; i < count; i++) {
    const nameLength = u16(zip, at + 28);
    const extraLength = u16(zip, at + 30);
    const commentLength = u16(zip, at + 32);
    const record = [...zip.subarray(at, at + 46)];
    const sizes = [u32(zip, at + 24), u32(zip, at + 20), u32(zip, at + 42)];
    for (const field of [20, 24, 42]) record.splice(field, 4, 0xff, 0xff, 0xff, 0xff);
    record[30] = (extraLength + 28) & 255;
    record[31] = (extraLength + 28) >>> 8;
    out.push(...record, ...zip.subarray(at + 46, at + 46 + nameLength + extraLength));
    push16(0x0001);
    push16(24);
    for (const value of sizes) push64(value);
    out.push(
      ...zip.subarray(
        at + 46 + nameLength + extraLength,
        at + 46 + nameLength + extraLength + commentLength,
      ),
    );
    at += 46 + nameLength + extraLength + commentLength;
  }
  const directorySize = out.length - directoryOffset;
  const record64 = out.length;
  push32(0x06064b50);
  push64(44);
  push16(45);
  push16(45);
  push32(0);
  push32(0);
  push64(count);
  push64(count);
  push64(directorySize);
  push64(directoryOffset);
  push32(0x07064b50);
  push32(0);
  push64(record64);
  push32(1);
  push32(0x06054b50);
  push16(0);
  push16(0);
  push16(0xffff);
  push16(0xffff);
  push32(0xffffffff);
  push32(0xffffffff);
  push16(0);
  return new Uint8Array(out);
}

/** Counts every byte the reader reads from the file. */
function countReads(): { bytes: number } {
  const counter = { bytes: 0 };
  const original = FileReader.prototype.readAsArrayBuffer;
  vi.spyOn(FileReader.prototype, 'readAsArrayBuffer').mockImplementation(function (
    this: FileReader,
    blob: Blob,
  ) {
    counter.bytes += blob.size;
    original.call(this, blob);
  });
  return counter;
}

/** A photo-like run of bytes with `marker` in its middle. */
function photoWith(marker: number[]): Uint8Array {
  const bytes = new Uint8Array(4000);
  for (let i = 0; i < bytes.length; i++) bytes[i] = (i * 37 + 11) & 255;
  bytes.set(marker, 2000);
  return bytes;
}

const SIGNATURES: [string, number[]][] = [
  ['a data descriptor', [0x50, 0x4b, 0x07, 0x08]],
  ['a central directory record', [0x50, 0x4b, 0x01, 0x02]],
  ['a local file header', [0x50, 0x4b, 0x03, 0x04]],
];

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

  it('never reads the bytes of an entry it does not want', async () => {
    const photo = photoWith([]);
    const big = new Uint8Array(2 * 1024 * 1024);
    for (let i = 0; i < big.length; i += photo.length)
      big.set(photo.subarray(0, big.length - i), i);
    const zip = streamedZip([
      { name: 'top/', data: new Uint8Array(0), store: true },
      { name: 'top/a.md', data: strToU8(recipeText('A')) },
      { name: 'top/a/photo-1.jpg', data: big, store: true },
    ]);
    const reads = countReads();
    const result = await readZipRecipes(asFile(zip));
    expect(result.recipes.map((r) => r.path)).toEqual(['a.md']);
    expect(reads.bytes).toBeLessThan(100_000);
  });

  it.each(SIGNATURES)(
    'reads past a stored photo that holds the bytes of %s',
    async (_label, marker) => {
      const photo = photoWith(marker);
      const zip = streamedZip([
        { name: 'hearth-recipes-2026-11-13/', data: new Uint8Array(0), store: true },
        { name: 'hearth-recipes-2026-11-13/a.md', data: strToU8(recipeText('A')) },
        { name: 'hearth-recipes-2026-11-13/a/photo-1.jpg', data: photo, store: true },
        { name: 'hearth-recipes-2026-11-13/b.md', data: strToU8(recipeText('B')) },
      ]);
      const result = await readZipRecipes(asFile(zip));
      expect(result.recipes.map((r) => r.path)).toEqual(['a.md', 'b.md']);
      expect(result.notRecipes).toEqual([]);

      const got: [string, Uint8Array][] = [];
      await readZipFiles(asFile(zip), new Map([['a/photo-1.jpg', 1024 * 1024]]), {
        onFile: (path, bytes) => void got.push([path, bytes]),
        onTooLarge: () => {},
      });
      expect(got).toHaveLength(1);
      expect(got[0]![0]).toBe('a/photo-1.jpg');
      expect(Array.from(got[0]![1])).toEqual(Array.from(photo));
    },
  );

  it('reads a deflated entry written as a stream', async () => {
    const zip = streamedZip([
      { name: 'top/', data: new Uint8Array(0), store: true },
      {
        name: 'top/stew.md',
        data: strToU8(recipeText('Stew', 'yield: ' + 'x'.repeat(5000) + '\n')),
      },
    ]);
    const result = await readZipRecipes(asFile(zip));
    expect(result.recipes.map((r) => [r.path, r.recipe.title])).toEqual([['stew.md', 'Stew']]);
  });

  it('reads a ZIP64 zip', async () => {
    const photo = photoWith([0x50, 0x4b, 0x03, 0x04]);
    const zip = toZip64(
      streamedZip([
        { name: 'top/', data: new Uint8Array(0), store: true },
        { name: 'top/a.md', data: strToU8(recipeText('A')) },
        { name: 'top/a/photo-1.jpg', data: photo, store: true },
        { name: 'top/b.md', data: strToU8(recipeText('B')) },
      ]),
    );
    const result = await readZipRecipes(asFile(zip));
    expect(result.recipes.map((r) => r.path)).toEqual(['a.md', 'b.md']);
    const onFile = vi.fn();
    await readZipFiles(asFile(zip), new Map([['a/photo-1.jpg', 10_000]]), {
      onFile,
      onTooLarge: () => {},
    });
    expect(onFile).toHaveBeenCalledWith('a/photo-1.jpg', photo);
  });

  it('throws NotAZipError for a file that is not a zip', async () => {
    const text = new File(['just some text, nothing like a zip\n'.repeat(50)], 'notes.zip');
    await expect(readZipRecipes(text)).rejects.toBeInstanceOf(NotAZipError);
    await expect(readZipRecipes(new File([], 'empty.zip'))).rejects.toBeInstanceOf(NotAZipError);
    await expect(
      readZipFiles(text, new Map([['a.jpg', 100]]), { onFile: () => {}, onTooLarge: () => {} }),
    ).rejects.toBeInstanceOf(NotAZipError);
  });

  it('lists damaged and unknown entries as not recipes, and reads on', async () => {
    const zip = zipSync({
      'top/damaged.md': strToU8(recipeText('Damaged')),
      'top/wrong-crc.md': strToU8(recipeText('Wrong CRC')),
      'top/unknown.md': strToU8(recipeText('Unknown')),
      'top/good.md': strToU8(recipeText('Good')),
    });
    const damaged = locate(zip, 'top/damaged.md');
    // Block type 3 is reserved, so the deflate stream is invalid from its first byte.
    zip.fill(0xff, damaged.data, damaged.data + damaged.compressedSize);
    const wrongCrc = locate(zip, 'top/wrong-crc.md');
    put32(zip, wrongCrc.central + 16, u32(zip, wrongCrc.central + 16) ^ 1);
    const unknown = locate(zip, 'top/unknown.md');
    zip[unknown.central + 10] = 12;
    zip[unknown.local + 8] = 12;

    const result = await readZipRecipes(asFile(zip));
    expect(result.recipes.map((r) => r.path)).toEqual(['good.md']);
    expect(result.notRecipes).toEqual(['damaged.md', 'wrong-crc.md', 'unknown.md']);
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

  it('turns a zip bomb away by its stated size without decompressing it', async () => {
    const zip = streamedZip([
      { name: 'top/', data: new Uint8Array(0), store: true },
      { name: 'top/bomb.md', data: new Uint8Array(64 * 1024 * 1024) },
      { name: 'top/short.md', data: strToU8(recipeText('Short')) },
    ]);
    inflated.bytes = 0;
    const result = await readZipRecipes(asFile(zip));
    expect(result.tooLarge).toEqual(['bomb.md']);
    expect(result.recipes.map((r) => r.path)).toEqual(['short.md']);
    expect(inflated.bytes).toBeLessThan(1_000);
  });

  it('stops decompressing a zip bomb at the cap when the zip understates its size', async () => {
    const bomb = new Uint8Array(64 * 1024 * 1024);
    const zip = streamedZip([
      { name: 'top/', data: new Uint8Array(0), store: true },
      { name: 'top/bomb.md', data: bomb },
      { name: 'top/short.md', data: strToU8(recipeText('Short')) },
    ]);
    claimSize(zip, 'top/bomb.md', 3 * MAX_TEXT_LENGTH);
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

  it('stops decompressing an entry at its cap when the zip understates its size', async () => {
    const zip = streamedZip([
      { name: 'top/a/source.pdf', data: new Uint8Array(64 * 1024 * 1024) },
      { name: 'top/a/photo-1.jpg', data: new Uint8Array(10).fill(9) },
    ]);
    claimSize(zip, 'top/a/source.pdf', 1024 * 1024);
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

  it('reports damaged, mislabelled and unknown entries as unreadable', async () => {
    const zip = zipSync({
      'top/a/damaged.jpg': new Uint8Array(3000).fill(4),
      'top/a/wrong-crc.jpg': new Uint8Array(3000).fill(5),
      'top/a/unknown.jpg': new Uint8Array(3000).fill(6),
      'top/a/good.jpg': new Uint8Array(3000).fill(7),
    });
    const damaged = locate(zip, 'top/a/damaged.jpg');
    zip.fill(0xff, damaged.data, damaged.data + damaged.compressedSize);
    const wrongCrc = locate(zip, 'top/a/wrong-crc.jpg');
    put32(zip, wrongCrc.central + 16, u32(zip, wrongCrc.central + 16) ^ 1);
    const unknown = locate(zip, 'top/a/unknown.jpg');
    zip[unknown.central + 10] = 12;
    zip[unknown.local + 8] = 12;

    const onFile = vi.fn();
    const onUnreadable = vi.fn();
    const paths = ['a/damaged.jpg', 'a/wrong-crc.jpg', 'a/unknown.jpg', 'a/good.jpg'];
    await readZipFiles(asFile(zip), new Map(paths.map((p) => [p, 10_000])), {
      onFile,
      onTooLarge: () => {},
      onUnreadable,
    });
    expect(onUnreadable.mock.calls).toEqual([
      ['a/damaged.jpg'],
      ['a/wrong-crc.jpg'],
      ['a/unknown.jpg'],
    ]);
    expect(onFile).toHaveBeenCalledOnce();
    expect(onFile).toHaveBeenCalledWith('a/good.jpg', expect.any(Uint8Array));
  });

  it('visits the wanted entries in the order of the map, each once', async () => {
    const zip = streamedZip([
      { name: 'top/a/photo-1.jpg', data: new Uint8Array(10).fill(1), store: true },
      { name: 'top/a/photo-2.jpg', data: new Uint8Array(10).fill(2), store: true },
      { name: 'top/a/photo-3.jpg', data: new Uint8Array(10).fill(3), store: true },
      { name: 'top/a/photo-2.jpg', data: new Uint8Array(10).fill(9), store: true },
    ]);
    const got: [string, number][] = [];
    await readZipFiles(
      asFile(zip),
      new Map([
        ['a/photo-3.jpg', 100],
        ['a/photo-1.jpg', 100],
        ['a/photo-2.jpg', 100],
      ]),
      { onFile: (path, bytes) => void got.push([path, bytes[0]!]), onTooLarge: () => {} },
    );
    expect(got).toEqual([
      ['a/photo-3.jpg', 3],
      ['a/photo-1.jpg', 1],
      ['a/photo-2.jpg', 2],
    ]);
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
