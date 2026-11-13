/**
 * Reading a recipe zip in the browser, one entry at a time (issue #37).
 *
 * The zip is a file the cook picked, and it may come from anyone, so it is never read whole:
 * on a phone a few hundred megabytes of photos would not fit, and a zip bomb (a small entry
 * that inflates to gigabytes) would take the tab down. Instead the file is read in slices and
 * fed to fflate's streaming `Unzip`. Only the entries asked for are decompressed, each is
 * counted while it decompresses, and one that crosses its cap is stopped there. Every other
 * entry is passed over without being inflated.
 *
 * Two passes use it: `readZipRecipes` reads the Markdown, and `readZipFiles` comes back for
 * the photos and scans of the recipes that were saved.
 *
 * Paths. An export puts everything under one folder (`hearth-recipes-<date>/`), and the paths
 * in its front matter are relative to that folder. The reader decides the top folder from the
 * first entry, so that one streaming pass is enough: when that entry's name has a `/` in it,
 * its first segment is taken as the top folder, and stripped from every name that starts with
 * it. An export writes the folder's own entry first, so this always finds it there. A zip whose
 * first entry is at the root has no top folder, and its names are used as they are. Because a
 * zip of loose files can begin with a recipe's folder (`pizza/photo-1.jpg`), `readZipFiles`
 * also matches a name as it is when the stripped name is not wanted.
 *
 * Folder entries (names ending in `/`) and macOS's `__MACOSX/` copies are ignored. Entry names
 * are only looked up, never used as paths to write.
 */
import {
  Inflate,
  Unzip,
  type UnzipDecoder,
  type UnzipDecoderConstructor,
  type UnzipFile,
} from 'fflate';
import { MAX_TEXT_LENGTH, readRecipeMarkdown, type MarkdownRecipe } from '@hearth/shared';

/** The most recipes one zip may hold, enough for any household. */
export const MAX_ZIP_RECIPES = 2000;

/**
 * How much of the file goes into the unzipper at a time. A DEFLATE stream inflates to at most
 * about 1032 times its size, so this bounds what one step can decompress past an entry's cap:
 * 8KB in, at most about 8MB out, before the count sees it and stops the entry.
 */
export const ZIP_INPUT_SLICE = 8 * 1024;

/** How much of the file is read from disk at a time, then fed in `ZIP_INPUT_SLICE` pieces. */
const READ_CHUNK = 1024 * 1024;

/**
 * A Markdown entry's cap in bytes. `MAX_TEXT_LENGTH` counts UTF-16 code units, and UTF-8 spends
 * at most three bytes on one, so no text within the cap is cut short by this. The decoded text
 * is checked against `MAX_TEXT_LENGTH` itself.
 */
const MARKDOWN_BYTE_CAP = 3 * MAX_TEXT_LENGTH;

const MACOS_JUNK = '__MACOSX/';

export class TooManyRecipesError extends Error {
  constructor() {
    super(`A zip can hold at most ${MAX_ZIP_RECIPES.toLocaleString('en-US')} recipes.`);
    this.name = 'TooManyRecipesError';
  }
}

export interface ZipRecipe {
  /** The Markdown entry's name, without the zip's top folder. */
  path: string;
  recipe: MarkdownRecipe;
}

export interface ZipRecipes {
  recipes: ZipRecipe[];
  /** Markdown entries without Hearth front matter, or that could not be decompressed. */
  notRecipes: string[];
  /** Markdown entries longer than `MAX_TEXT_LENGTH`, stopped at the cap. */
  tooLarge: string[];
}

export interface ZipFileHandlers {
  /** One wanted entry, whole. The reader waits for a returned promise before reading on. */
  onFile: (path: string, bytes: Uint8Array) => void | Promise<void>;
  /** A wanted entry larger than its cap; it was decompressed no further than the cap. */
  onTooLarge: (path: string) => void | Promise<void>;
  /** A wanted entry that could not be decompressed (damaged, or an unknown compression). */
  onUnreadable?: (path: string) => void | Promise<void>;
}

/**
 * Pass 1: every `.md` entry of the zip, read with `readRecipeMarkdown`. Other entries are not
 * decompressed. Throws `TooManyRecipesError` past `MAX_ZIP_RECIPES` recipes.
 */
export async function readZipRecipes(file: Blob): Promise<ZipRecipes> {
  const result: ZipRecipes = { recipes: [], notRecipes: [], tooLarge: [] };
  const decoder = new TextDecoder('utf-8');
  await walkZip(
    file,
    (name, relative) =>
      relative.toLowerCase().endsWith('.md') ? { path: relative, cap: MARKDOWN_BYTE_CAP } : null,
    (outcome) => {
      const { path } = outcome.wanted;
      if (outcome.kind === 'tooLarge') return void result.tooLarge.push(path);
      if (outcome.kind === 'unreadable') return void result.notRecipes.push(path);
      const text = decoder.decode(outcome.bytes);
      if (text.length > MAX_TEXT_LENGTH) return void result.tooLarge.push(path);
      const read = readRecipeMarkdown(text);
      if (read === null) return void result.notRecipes.push(path);
      if (result.recipes.length >= MAX_ZIP_RECIPES) throw new TooManyRecipesError();
      result.recipes.push({ path, recipe: read.recipe });
    },
  );
  return result;
}

/**
 * Pass 2: the entries named in `wanted` (path without the top folder, to its cap in bytes),
 * each handed to `onFile` whole. Everything else is passed over without being decompressed.
 *
 * While an `onFile` promise is pending (a photo being resized and uploaded), no more of the zip
 * is read, so memory holds the one entry being handled and not a queue of them.
 */
export async function readZipFiles(
  file: Blob,
  wanted: ReadonlyMap<string, number>,
  handlers: ZipFileHandlers,
): Promise<void> {
  await walkZip(
    file,
    (name, relative) => {
      const path = wanted.has(relative) ? relative : wanted.has(name) ? name : null;
      return path === null ? null : { path, cap: wanted.get(path)! };
    },
    async (outcome) => {
      const { path } = outcome.wanted;
      if (outcome.kind === 'file') await handlers.onFile(path, outcome.bytes);
      else if (outcome.kind === 'tooLarge') await handlers.onTooLarge(path);
      else await handlers.onUnreadable?.(path);
    },
  );
}

interface Wanted {
  path: string;
  cap: number;
}

type Outcome =
  | { kind: 'file'; wanted: Wanted; bytes: Uint8Array }
  | { kind: 'tooLarge'; wanted: Wanted }
  | { kind: 'unreadable'; wanted: Wanted };

/**
 * DEFLATE for `Unzip` that can be stopped. fflate's own `UnzipInflate` has no `terminate`, so
 * an entry stopped at its cap would go on inflating the rest of a bomb, only to be thrown away.
 */
class StoppableInflate implements UnzipDecoder {
  static compression = 8;
  ondata: UnzipDecoder['ondata'] = () => {};
  private stopped = false;
  private readonly inflate = new Inflate((data, final) => {
    if (!this.stopped) this.ondata(null, data, final);
  });

  push(chunk: Uint8Array, final: boolean): void {
    if (this.stopped) return;
    try {
      this.inflate.push(chunk, final);
    } catch (error) {
      this.stopped = true;
      this.ondata(error as Parameters<UnzipDecoder['ondata']>[0], new Uint8Array(0), final);
    }
  }

  terminate(): void {
    this.stopped = true;
  }
}

/** A stored (uncompressed) entry, likewise stoppable. */
class StoppablePassThrough implements UnzipDecoder {
  static compression = 0;
  ondata: UnzipDecoder['ondata'] = () => {};
  private stopped = false;

  push(chunk: Uint8Array, final: boolean): void {
    // The chunks are views of the `ArrayBuffer` `readBytes` returned, never a shared buffer.
    if (!this.stopped) this.ondata(null, chunk as Uint8Array<ArrayBuffer>, final);
  }

  terminate(): void {
    this.stopped = true;
  }
}

/**
 * A decoder that throws away whatever it is given, for an entry in a compression this reader
 * does not know. Without a decoder registered, `Unzip` would keep that entry's bytes in memory
 * in case it were started later.
 */
function discarding(compression: number): UnzipDecoderConstructor {
  return class implements UnzipDecoder {
    static compression = compression;
    ondata: UnzipDecoder['ondata'] = () => {};
    push(): void {}
    terminate(): void {}
  };
}

/**
 * Pass an entry over. It is started into a stopped decoder rather than left alone, because an
 * entry never started has its compressed bytes kept by `Unzip` until the end of the zip.
 */
function skip(entry: UnzipFile): void {
  entry.ondata = () => {};
  entry.start();
  entry.terminate();
}

/**
 * The streaming loop both passes share. `pick` names the entries to read and their caps; `done`
 * gets each one, in zip order, and the loop waits for it before feeding more of the file.
 */
async function walkZip(
  file: Blob,
  pick: (name: string, relative: string) => Wanted | null,
  done: (outcome: Outcome) => void | Promise<void>,
): Promise<void> {
  const unzip = new Unzip();
  unzip.register(StoppableInflate);
  unzip.register(StoppablePassThrough);
  const known = new Set([StoppableInflate.compression, StoppablePassThrough.compression]);
  // Entries finished during one `push`. A slice can end several small entries at once.
  const ready: Outcome[] = [];
  // Undecided until the first entry; then the top folder with its `/`, or '' for none.
  let top: string | null = null;

  unzip.onfile = (entry) => {
    const name = entry.name;
    if (!known.has(entry.compression)) {
      unzip.register(discarding(entry.compression));
      known.add(entry.compression);
    }
    if (name.startsWith(MACOS_JUNK)) return skip(entry);
    if (top === null) {
      const slash = name.indexOf('/');
      top = slash > 0 ? name.slice(0, slash + 1) : '';
    }
    if (name.endsWith('/')) return skip(entry);
    const relative = top !== '' && name.startsWith(top) ? name.slice(top.length) : name;
    const wanted = pick(name, relative);
    if (wanted === null) return skip(entry);
    if (entry.compression !== 0 && entry.compression !== 8) {
      ready.push({ kind: 'unreadable', wanted });
      return skip(entry);
    }
    // The header's size is the writer's claim, so it can only turn an entry away early. A zip
    // written as a stream states no size here at all; the count below is what holds.
    if (entry.originalSize !== undefined && entry.originalSize > wanted.cap) {
      ready.push({ kind: 'tooLarge', wanted });
      return skip(entry);
    }

    let parts: Uint8Array[] = [];
    let size = 0;
    let finished = false;
    entry.ondata = (error, data, final) => {
      if (finished) return;
      if (error) {
        finished = true;
        parts = [];
        entry.terminate();
        ready.push({ kind: 'unreadable', wanted });
        return;
      }
      size += data.length;
      if (size > wanted.cap) {
        finished = true;
        parts = [];
        entry.terminate();
        ready.push({ kind: 'tooLarge', wanted });
        return;
      }
      parts.push(data);
      if (final) {
        finished = true;
        ready.push({ kind: 'file', wanted, bytes: join(parts, size) });
        parts = [];
      }
    };
    entry.start();
  };

  const drain = async () => {
    while (ready.length > 0) await done(ready.shift()!);
  };

  for (let offset = 0; offset < file.size; offset += READ_CHUNK) {
    const chunk = await readBytes(file.slice(offset, offset + READ_CHUNK));
    for (let at = 0; at < chunk.length; at += ZIP_INPUT_SLICE) {
      unzip.push(chunk.subarray(at, at + ZIP_INPUT_SLICE), false);
      await drain();
    }
  }
  unzip.push(new Uint8Array(0), true);
  await drain();
}

function join(parts: Uint8Array[], size: number): Uint8Array {
  if (parts.length === 1) return parts[0]!;
  const out = new Uint8Array(size);
  let at = 0;
  for (const part of parts) {
    out.set(part, at);
    at += part.length;
  }
  return out;
}

/**
 * A slice of the file as bytes. `FileReader` rather than `Blob.arrayBuffer()` or `stream()`, as
 * `toBase64` in `image-upload.ts` does: it is the older, wider API (Safari before 14 lacks
 * both), and jsdom has neither, so it is also what makes this testable.
 */
function readBytes(blob: Blob): Promise<Uint8Array> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(reader.error ?? new Error('the file could not be read'));
    reader.onload = () =>
      resolve(
        reader.result instanceof ArrayBuffer ? new Uint8Array(reader.result) : new Uint8Array(0),
      );
    reader.readAsArrayBuffer(blob);
  });
}
