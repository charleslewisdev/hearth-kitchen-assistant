/**
 * Reading a recipe zip in the browser, one entry at a time (issue #37).
 *
 * The zip is a file the cook picked, and it may come from anyone, so it is never read whole:
 * on a phone a few hundred megabytes of photos would not fit, and a zip bomb (a small entry
 * that inflates to gigabytes) would take the tab down. Instead the reader works from the zip's
 * central directory, the list of entries at its end, and reads the file by `Blob.slice`:
 *
 * 1. The tail of the file, for the end of central directory record (and the ZIP64 one, when the
 *    zip has it), which says where the directory is and how many entries it lists.
 * 2. The directory itself, capped in size and in entries: each entry's name, compression, sizes,
 *    CRC-32 and where its local header is.
 * 3. For each wanted entry, its local header (for the length of its name and extra field) and
 *    then exactly its compressed bytes, fed to the inflater in small pieces. The output is
 *    counted as it comes, and an entry that crosses its cap is stopped there. A whole entry is
 *    checked against the directory's size and CRC-32.
 *
 * Every other entry is never read at all. The directory, not the bytes between entries, says
 * where each entry starts and ends: a zip written as a stream (as Hearth's export, and macOS's
 * Archive Utility, write them) puts the sizes after the data, and a reader that scans the data
 * for the next signature cuts short any photo that happens to hold one.
 *
 * A file with no end of central directory record throws `NotAZipError`; one split across disks,
 * or whose directory is past the caps, throws `UnsupportedZipError`. ZIP64 is read, so a zip of
 * more than 4GB or 65,535 entries from another tool still works.
 *
 * Two passes use it: `readZipRecipes` reads the Markdown, and `readZipFiles` comes back for
 * the photos and scans of the recipes that were saved.
 *
 * Paths. An export puts everything under one folder (`hearth-recipes-<date>/`), and the paths
 * in its front matter are relative to that folder. The reader decides the top folder from the
 * directory's first entry: when that entry's name has a `/` in it, its first segment is taken as
 * the top folder, and stripped from every name that starts with it. An export writes the
 * folder's own entry first, so this always finds it there. A zip whose first entry is at the
 * root has no top folder, and its names are used as they are. Because a zip of loose files can
 * begin with a recipe's folder (`pizza/photo-1.jpg`), `readZipFiles` also matches a name as it
 * is when the stripped name is not wanted.
 *
 * Folder entries (names ending in `/`) and macOS's `__MACOSX/` copies are ignored. Entry names
 * are only looked up, never used as paths to write.
 */
import { Inflate, strFromU8 } from 'fflate';
import { MAX_TEXT_LENGTH, readRecipeMarkdown, type MarkdownRecipe } from '@hearth/shared';

/** The most recipes one zip may hold, enough for any household. */
export const MAX_ZIP_RECIPES = 2000;

/**
 * How much of an entry goes into the inflater at a time. A DEFLATE stream inflates to at most
 * about 1032 times its size, so this bounds what one step can decompress past an entry's cap:
 * 8KB in, at most about 8MB out, before the count sees it and stops the entry.
 */
export const ZIP_INPUT_SLICE = 8 * 1024;

/** How much of an entry is read from disk at a time, then fed in `ZIP_INPUT_SLICE` pieces. */
const READ_CHUNK = 1024 * 1024;

/** The largest central directory read, and the most entries it may list. */
const MAX_DIRECTORY_BYTES = 32 * 1024 * 1024;
const MAX_DIRECTORY_ENTRIES = 100_000;

/**
 * A Markdown entry's cap in bytes. `MAX_TEXT_LENGTH` counts UTF-16 code units, and UTF-8 spends
 * at most three bytes on one, so no text within the cap is cut short by this. The decoded text
 * is checked against `MAX_TEXT_LENGTH` itself.
 */
const MARKDOWN_BYTE_CAP = 3 * MAX_TEXT_LENGTH;

const MACOS_JUNK = '__MACOSX/';

// Record signatures and fixed sizes, from PKWARE's APPNOTE.
const EOCD_SIGNATURE = 0x06054b50;
const EOCD_SIZE = 22;
/** The end record, plus the longest comment it can carry. */
const EOCD_SEARCH = EOCD_SIZE + 0xffff;
const ZIP64_LOCATOR_SIGNATURE = 0x07064b50;
const ZIP64_LOCATOR_SIZE = 20;
const ZIP64_EOCD_SIGNATURE = 0x06064b50;
const ZIP64_EOCD_SIZE = 56;
const CENTRAL_SIGNATURE = 0x02014b50;
const CENTRAL_SIZE = 46;
const LOCAL_SIGNATURE = 0x04034b50;
const LOCAL_SIZE = 30;
const ZIP64_EXTRA = 0x0001;
const FLAG_ENCRYPTED = 0x0001;
const FLAG_UTF8 = 0x0800;

export class TooManyRecipesError extends Error {
  constructor() {
    super(`A zip can hold at most ${MAX_ZIP_RECIPES.toLocaleString('en-US')} recipes.`);
    this.name = 'TooManyRecipesError';
  }
}

/** The file has no zip directory at its end: not a zip, or one cut short. */
export class NotAZipError extends Error {
  constructor() {
    super('This file is not a zip, or it is damaged.');
    this.name = 'NotAZipError';
  }
}

/** A zip this reader will not read: split across disks, or with an oversized directory. */
export class UnsupportedZipError extends Error {
  constructor(reason: string) {
    super(`This zip cannot be read: ${reason}.`);
    this.name = 'UnsupportedZipError';
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
  /** A wanted entry that could not be read (damaged, encrypted, or an unknown compression). */
  onUnreadable?: (path: string) => void | Promise<void>;
}

/**
 * Pass 1: every `.md` entry of the zip, in directory order, read with `readRecipeMarkdown`.
 * Other entries are not read. Throws `NotAZipError` or `UnsupportedZipError` for a file it
 * cannot list, and `TooManyRecipesError` past `MAX_ZIP_RECIPES` recipes.
 */
export async function readZipRecipes(file: Blob): Promise<ZipRecipes> {
  const result: ZipRecipes = { recipes: [], notRecipes: [], tooLarge: [] };
  const decoder = new TextDecoder('utf-8');
  for (const { entry, relative } of named(await readDirectory(file))) {
    if (!relative.toLowerCase().endsWith('.md')) continue;
    const path = relative;
    const outcome = await readEntry(file, entry, MARKDOWN_BYTE_CAP);
    if (outcome.kind === 'tooLarge') result.tooLarge.push(path);
    else if (outcome.kind === 'unreadable') result.notRecipes.push(path);
    else {
      const text = decoder.decode(outcome.bytes);
      if (text.length > MAX_TEXT_LENGTH) {
        result.tooLarge.push(path);
        continue;
      }
      const read = readRecipeMarkdown(text);
      if (read === null) {
        result.notRecipes.push(path);
        continue;
      }
      if (result.recipes.length >= MAX_ZIP_RECIPES) throw new TooManyRecipesError();
      result.recipes.push({ path, recipe: read.recipe });
    }
  }
  return result;
}

/**
 * Pass 2: the entries named in `wanted` (path without the top folder, to its cap in bytes),
 * each handed to `onFile` whole, in the order of `wanted`. A path the zip holds twice is
 * delivered once, from its first entry; a path it does not hold gets no call at all. Everything
 * else is never read.
 *
 * While an `onFile` promise is pending (a photo being resized and uploaded), no more of the zip
 * is read, so memory holds the one entry being handled and not a queue of them.
 */
export async function readZipFiles(
  file: Blob,
  wanted: ReadonlyMap<string, number>,
  handlers: ZipFileHandlers,
): Promise<void> {
  const byRelative = new Map<string, Entry>();
  const byName = new Map<string, Entry>();
  for (const { entry, relative } of named(await readDirectory(file))) {
    if (wanted.has(relative) && !byRelative.has(relative)) byRelative.set(relative, entry);
    if (wanted.has(entry.name) && !byName.has(entry.name)) byName.set(entry.name, entry);
  }
  for (const [path, cap] of wanted) {
    const entry = byRelative.get(path) ?? byName.get(path);
    if (entry === undefined) continue;
    const outcome = await readEntry(file, entry, cap);
    if (outcome.kind === 'file') await handlers.onFile(path, outcome.bytes);
    else if (outcome.kind === 'tooLarge') await handlers.onTooLarge(path);
    else await handlers.onUnreadable?.(path);
  }
}

/** One entry as the central directory lists it. Sizes and offsets are in bytes. */
interface Entry {
  name: string;
  flags: number;
  method: number;
  crc: number;
  compressedSize: number;
  size: number;
  localOffset: number;
}

type Outcome = { kind: 'file'; bytes: Uint8Array } | { kind: 'tooLarge' } | { kind: 'unreadable' };

/**
 * The directory's entries with their names relative to the top folder, in directory order,
 * leaving out folders and `__MACOSX/`.
 */
function* named(entries: Entry[]): Generator<{ entry: Entry; relative: string }> {
  // Undecided until the first entry; then the top folder with its `/`, or '' for none.
  let top: string | null = null;
  for (const entry of entries) {
    const name = entry.name;
    if (name.startsWith(MACOS_JUNK)) continue;
    if (top === null) {
      const slash = name.indexOf('/');
      top = slash > 0 ? name.slice(0, slash + 1) : '';
    }
    if (name.endsWith('/')) continue;
    yield { entry, relative: top !== '' && name.startsWith(top) ? name.slice(top.length) : name };
  }
}

/** Little-endian readers over a slice of the file. */
const u16 = (b: Uint8Array, at: number) => b[at]! | (b[at + 1]! << 8);
const u32 = (b: Uint8Array, at: number) => (u16(b, at) | (u16(b, at + 2) << 16)) >>> 0;
/** A 64-bit field, or NaN past what a double holds exactly (no real file is that large). */
const u64 = (b: Uint8Array, at: number) => {
  const high = u32(b, at + 4);
  return high >= 2 ** 21 ? NaN : high * 2 ** 32 + u32(b, at);
};

/** The central directory, read by way of the end record at the file's tail. */
async function readDirectory(file: Blob): Promise<Entry[]> {
  const tailStart = Math.max(0, file.size - EOCD_SEARCH);
  const tail = await readBytes(file.slice(tailStart));
  // The record ends the file, so its comment length must account for every byte after it.
  let end = -1;
  for (let at = tail.length - EOCD_SIZE; at >= 0; at--) {
    if (u32(tail, at) === EOCD_SIGNATURE && u16(tail, at + 20) === tail.length - at - EOCD_SIZE) {
      end = at;
      break;
    }
  }
  if (end < 0) throw new NotAZipError();

  let disk = u16(tail, end + 4);
  let directoryDisk = u16(tail, end + 6);
  let diskCount = u16(tail, end + 8);
  let count = u16(tail, end + 10);
  let directorySize = u32(tail, end + 12);
  let directoryOffset = u32(tail, end + 16);
  // Where the directory must end: the ZIP64 records, when there are any, or the end record.
  let directoryLimit = tailStart + end;

  const zip64 =
    disk === 0xffff ||
    directoryDisk === 0xffff ||
    diskCount === 0xffff ||
    count === 0xffff ||
    directorySize === 0xffffffff ||
    directoryOffset === 0xffffffff;
  if (zip64) {
    const locator = end - ZIP64_LOCATOR_SIZE;
    if (locator < 0 || u32(tail, locator) !== ZIP64_LOCATOR_SIGNATURE) throw new NotAZipError();
    const recordOffset = u64(tail, locator + 8);
    if (!(recordOffset + ZIP64_EOCD_SIZE <= tailStart + locator)) throw new NotAZipError();
    const record = await readBytes(file.slice(recordOffset, recordOffset + ZIP64_EOCD_SIZE));
    if (record.length < ZIP64_EOCD_SIZE || u32(record, 0) !== ZIP64_EOCD_SIGNATURE) {
      throw new NotAZipError();
    }
    disk = u32(record, 16);
    directoryDisk = u32(record, 20);
    diskCount = u64(record, 24);
    count = u64(record, 32);
    directorySize = u64(record, 40);
    directoryOffset = u64(record, 48);
    directoryLimit = recordOffset;
  }

  if (disk !== 0 || directoryDisk !== 0 || diskCount !== count) {
    throw new UnsupportedZipError('it is split across several files');
  }
  if (!(directoryOffset + directorySize <= directoryLimit)) throw new NotAZipError();
  if (count > MAX_DIRECTORY_ENTRIES) {
    throw new UnsupportedZipError(
      `it lists more than ${MAX_DIRECTORY_ENTRIES.toLocaleString('en-US')} files`,
    );
  }
  if (directorySize > MAX_DIRECTORY_BYTES) {
    throw new UnsupportedZipError('its list of files is too long');
  }

  const directory = await readBytes(file.slice(directoryOffset, directoryOffset + directorySize));
  const entries: Entry[] = [];
  let at = 0;
  for (let i = 0; i < count; i++) {
    if (at + CENTRAL_SIZE > directory.length || u32(directory, at) !== CENTRAL_SIGNATURE) {
      throw new NotAZipError();
    }
    const flags = u16(directory, at + 8);
    const nameLength = u16(directory, at + 28);
    const extraLength = u16(directory, at + 30);
    const commentLength = u16(directory, at + 32);
    const nameStart = at + CENTRAL_SIZE;
    const extraStart = nameStart + nameLength;
    const next = extraStart + extraLength + commentLength;
    if (next > directory.length) throw new NotAZipError();

    const entry: Entry = {
      name: decodeName(directory.subarray(nameStart, extraStart), flags),
      flags,
      method: u16(directory, at + 10),
      crc: u32(directory, at + 16),
      compressedSize: u32(directory, at + 20),
      size: u32(directory, at + 24),
      localOffset: u32(directory, at + 42),
    };
    readZip64Extra(directory.subarray(extraStart, extraStart + extraLength), entry);
    entries.push(entry);
    at = next;
  }
  return entries;
}

/**
 * The ZIP64 extra field holds, in this order, each of the uncompressed size, compressed size
 * and local header offset whose 32-bit field is 0xFFFFFFFF.
 */
function readZip64Extra(extra: Uint8Array, entry: Entry): void {
  for (let at = 0; at + 4 <= extra.length; ) {
    const id = u16(extra, at);
    const length = u16(extra, at + 2);
    const body = at + 4;
    if (id === ZIP64_EXTRA) {
      let field = body;
      const take = () => {
        const value =
          field + 8 <= body + length && field + 8 <= extra.length ? u64(extra, field) : NaN;
        field += 8;
        return value;
      };
      if (entry.size === 0xffffffff) entry.size = take();
      if (entry.compressedSize === 0xffffffff) entry.compressedSize = take();
      if (entry.localOffset === 0xffffffff) entry.localOffset = take();
      return;
    }
    at = body + length;
  }
}

/**
 * An entry name. With the UTF-8 flag it is UTF-8; without it the standard says CP437, but macOS
 * and most tools since write UTF-8 there anyway, so UTF-8 is tried first and Latin-1 (which
 * agrees with CP437 on ASCII) taken when that fails.
 */
function decodeName(bytes: Uint8Array, flags: number): string {
  if (flags & FLAG_UTF8) return new TextDecoder('utf-8').decode(bytes);
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch {
    return strFromU8(bytes, true);
  }
}

/**
 * One entry, read and decompressed no further than `cap` bytes of output (nor past the size
 * the directory gives it), then checked against the directory's size and CRC-32.
 */
async function readEntry(file: Blob, entry: Entry, cap: number): Promise<Outcome> {
  if (entry.flags & FLAG_ENCRYPTED) return { kind: 'unreadable' };
  if (entry.method !== 0 && entry.method !== 8) return { kind: 'unreadable' };
  if (!Number.isFinite(entry.size) || !Number.isFinite(entry.compressedSize)) {
    return { kind: 'unreadable' };
  }
  // The directory's size is the writer's claim, so it can only turn an entry away early; the
  // count below is what holds.
  if (entry.size > cap) return { kind: 'tooLarge' };

  const header = await readBytes(file.slice(entry.localOffset, entry.localOffset + LOCAL_SIZE));
  if (header.length < LOCAL_SIZE || u32(header, 0) !== LOCAL_SIGNATURE) {
    return { kind: 'unreadable' };
  }
  const start = entry.localOffset + LOCAL_SIZE + u16(header, 26) + u16(header, 28);
  const end = start + entry.compressedSize;
  if (!(end <= file.size)) return { kind: 'unreadable' };

  let parts: Uint8Array[] = [];
  let size = 0;
  let stop: 'tooLarge' | 'unreadable' | null = null;
  const take = (data: Uint8Array) => {
    if (stop !== null) return;
    size += data.length;
    if (size > cap) stop = 'tooLarge';
    else if (size > entry.size) stop = 'unreadable';
    if (stop !== null) parts = [];
    else parts.push(data);
  };
  const inflate = entry.method === 8 ? new Inflate((data) => take(data)) : null;

  if (start === end && inflate) {
    try {
      inflate.push(new Uint8Array(0), true);
    } catch {
      return { kind: 'unreadable' };
    }
  }
  for (let offset = start; offset < end && stop === null; offset += READ_CHUNK) {
    const chunkEnd = Math.min(end, offset + READ_CHUNK);
    const chunk = await readBytes(file.slice(offset, chunkEnd));
    if (chunk.length !== chunkEnd - offset) return { kind: 'unreadable' };
    if (!inflate) {
      take(chunk);
      continue;
    }
    for (let at = 0; at < chunk.length && stop === null; at += ZIP_INPUT_SLICE) {
      const piece = chunk.subarray(at, at + ZIP_INPUT_SLICE);
      try {
        inflate.push(piece, offset + at + piece.length === end);
      } catch {
        return { kind: 'unreadable' };
      }
    }
  }
  if (stop !== null) return { kind: stop };
  if (size !== entry.size) return { kind: 'unreadable' };
  const bytes = join(parts, size);
  if (crc32(bytes) !== entry.crc) return { kind: 'unreadable' };
  return { kind: 'file', bytes };
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

let crcTable: Int32Array | null = null;

/** CRC-32 as zip uses it. fflate computes one internally but does not export it. */
function crc32(bytes: Uint8Array): number {
  if (crcTable === null) {
    crcTable = new Int32Array(256);
    for (let i = 0; i < 256; i++) {
      let c = i;
      for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      crcTable[i] = c;
    }
  }
  let c = -1;
  for (let i = 0; i < bytes.length; i++) c = crcTable[(c ^ bytes[i]!) & 255]! ^ (c >>> 8);
  return ~c >>> 0;
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
