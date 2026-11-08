import { Inflate } from 'fflate';

/**
 * Reading named entries out of a zip, with a budget, for `from-docx.ts`.
 *
 * A `.docx` is a zip, and a zip from a stranger is the classic decompression bomb: a few
 * megabytes that inflate to gigabytes. fflate's one-shot `unzipSync` allocates each entry at the
 * size its header claims and inflates it in one call, so neither a lying header nor a huge
 * honest one can be stopped part way. This reads the central directory itself and inflates only
 * the entries asked for, through fflate's streaming `Inflate`, a small slice of input at a time,
 * counting what comes out against one budget for the whole file. The moment the budget is spent
 * it stops, having produced at most one slice's worth past it.
 *
 * Deliberately narrow: no ZIP64 (a recipe document is nowhere near 4GB or 65,535 entries, so a
 * file that needs it is not one), no encryption, and only the two compression methods Word and
 * every other writer of these files use, stored and deflate.
 */

/** Why a zip could not be read. `too-large` is a budget spent; the rest are a broken file. */
export type ZipFailure = 'not-a-zip' | 'too-many-entries' | 'too-large' | 'unsupported';

export class ZipError extends Error {
  constructor(readonly reason: ZipFailure) {
    super(`zip refused: ${reason}`);
    this.name = 'ZipError';
  }
}

/** Where one entry's data is, from its central directory record. */
interface Entry {
  method: number;
  flags: number;
  compressedSize: number;
  localHeader: number;
}

export interface ZipLimits {
  /** The most entries the central directory may list. */
  maxEntries: number;
  /** The most bytes all the entries read may inflate to, together. */
  maxInflatedBytes: number;
}

const EOCD = 0x06054b50;
const CENTRAL = 0x02014b50;
const LOCAL = 0x04034b50;
const EOCD_SIZE = 22;
const MAX_COMMENT = 0xffff;

/**
 * How much compressed input goes to the inflater at a time. DEFLATE expands at most about
 * 1,032 to 1, so one slice can never produce more than about 4MB before the budget is checked.
 */
const SLICE = 4096;

/** A zip's entries by name, read lazily against one shared budget. */
export class ZipReader {
  private readonly entries = new Map<string, Entry>();
  private readonly view: DataView;
  private spent = 0;

  constructor(
    private readonly bytes: Uint8Array,
    private readonly limits: ZipLimits,
  ) {
    this.view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    this.readDirectory();
  }

  private u16(at: number): number {
    return this.view.getUint16(at, true);
  }

  private u32(at: number): number {
    return this.view.getUint32(at, true);
  }

  /** The end-of-central-directory record, searched for backwards past any comment. */
  private findEnd(): number {
    const last = this.bytes.length - EOCD_SIZE;
    const first = Math.max(0, last - MAX_COMMENT);
    for (let at = last; at >= first; at--) {
      if (this.u32(at) === EOCD) return at;
    }
    throw new ZipError('not-a-zip');
  }

  private readDirectory(): void {
    if (this.bytes.length < EOCD_SIZE) throw new ZipError('not-a-zip');
    const end = this.findEnd();
    const count = this.u16(end + 10);
    const size = this.u32(end + 12);
    const offset = this.u32(end + 16);
    // 0xFFFF and 0xFFFFFFFF are ZIP64's markers that the real numbers are elsewhere.
    if (count === 0xffff || offset === 0xffffffff || size === 0xffffffff) {
      throw new ZipError('unsupported');
    }
    if (count > this.limits.maxEntries) throw new ZipError('too-many-entries');
    if (offset + size > end) throw new ZipError('not-a-zip');

    const decoder = new TextDecoder('utf-8');
    let at = offset;
    for (let n = 0; n < count; n++) {
      if (at + 46 > end || this.u32(at) !== CENTRAL) throw new ZipError('not-a-zip');
      const nameLength = this.u16(at + 28);
      const extraLength = this.u16(at + 30);
      const commentLength = this.u16(at + 32);
      const nameEnd = at + 46 + nameLength;
      if (nameEnd > end) throw new ZipError('not-a-zip');
      const name = decoder.decode(this.bytes.subarray(at + 46, nameEnd));
      // The first of two entries with one name wins, as it would in most readers.
      if (!this.entries.has(name)) {
        this.entries.set(name, {
          flags: this.u16(at + 8),
          method: this.u16(at + 10),
          compressedSize: this.u32(at + 20),
          localHeader: this.u32(at + 42),
        });
      }
      at = nameEnd + extraLength + commentLength;
    }
  }

  has(name: string): boolean {
    return this.entries.has(name);
  }

  /** One entry's bytes, or null when there is no such entry. Throws `ZipError` past the budget. */
  read(name: string, check: () => void = () => {}): Uint8Array | null {
    const entry = this.entries.get(name);
    if (!entry) return null;
    // Bit 0 is encryption. A password-protected Word document is not a zip at all, so this is
    // a hand-made file, but it is still not one to read.
    if ((entry.flags & 1) !== 0) throw new ZipError('unsupported');

    const local = entry.localHeader;
    if (local + 30 > this.bytes.length || this.u32(local) !== LOCAL) {
      throw new ZipError('not-a-zip');
    }
    const start = local + 30 + this.u16(local + 26) + this.u16(local + 28);
    const stop = start + entry.compressedSize;
    if (stop > this.bytes.length) throw new ZipError('not-a-zip');
    const data = this.bytes.subarray(start, stop);

    if (entry.method === 0) {
      this.spend(data.length);
      return data;
    }
    if (entry.method !== 8) throw new ZipError('unsupported');

    const chunks: Uint8Array[] = [];
    let total = 0;
    let finished = false;
    const inflater = new Inflate((chunk, final) => {
      this.spend(chunk.length);
      chunks.push(chunk);
      total += chunk.length;
      if (final) finished = true;
    });
    try {
      for (let from = 0; from < data.length; from += SLICE) {
        check();
        inflater.push(data.subarray(from, from + SLICE), from + SLICE >= data.length);
      }
      if (data.length === 0) inflater.push(new Uint8Array(0), true);
    } catch (error) {
      if (error instanceof ZipError) throw error;
      // fflate's own errors: an invalid block, a truncated stream. Its message is about the
      // stream, never about what it holds, but it is not passed on either way.
      if (!(error instanceof Error) || !('code' in error)) throw error;
      throw new ZipError('not-a-zip');
    }
    if (!finished) throw new ZipError('not-a-zip');

    const out = new Uint8Array(total);
    let offset = 0;
    for (const chunk of chunks) {
      out.set(chunk, offset);
      offset += chunk.length;
    }
    return out;
  }

  private spend(bytes: number): void {
    this.spent += bytes;
    if (this.spent > this.limits.maxInflatedBytes) throw new ZipError('too-large');
  }
}
