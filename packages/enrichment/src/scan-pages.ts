import { deflateSync } from 'node:zlib';
import { getResolvedPDFJS } from 'unpdf';
import type { getDocumentProxy } from 'unpdf';

/**
 * The pages of a scanned PDF, as greyscale PNGs that OCR can read.
 *
 * A scan - Google Drive, Adobe Scan or iOS Notes on a phone, or a flatbed - is one image per page
 * and nothing else. Rendering the page would need a canvas implementation, which is a native
 * dependency this image (node:20-slim) does not carry and J0 deliberately excluded. Rendering is
 * also unnecessary: the page IS the image, so the image pdfjs already decodes for each page is
 * taken as it is, turned grey, shrunk if it is large, and written as a PNG by the small encoder
 * below. Those PNGs then go to `draftFromImages` like photographs.
 *
 * D38: nothing here logs. A page image is a recipe.
 */

/** A decoded PDF image as pdfjs hands it over: `kind` is pdfjs's `ImageKind`. */
export interface PdfImage {
  width: number;
  height: number;
  kind?: number;
  data: Uint8Array | Uint8ClampedArray;
}

/** One byte per pixel, row by row, top to bottom. */
export interface GrayImage {
  width: number;
  height: number;
  pixels: Uint8Array;
}

/**
 * The most pixels pdfjs may decode for any one image, handed to it as `maxImageSize`.
 *
 * pdfjs checks the width and height an image CLAIMS against this before it allocates anything
 * (and drops the image, it does not throw), so a 700-byte file claiming 100000x100000 costs
 * nothing. 25 million is 5000x5000: a letter page at 450dpi, where phone scanner apps and a
 * flatbed at its usual 300dpi (2550x3300) are well under it. pdfjs decodes to RGB, so one image
 * at the bound is 75MB for as long as it is held.
 */
export const MAX_SCAN_PIXELS = 25_000_000;

/**
 * The most pixels all the images in one scanned PDF may claim between them.
 *
 * A per-image bound is not enough on its own. pdfjs decodes every image on a page at once, as
 * the page's operator list is built, and none of it can be stopped once started: measured, a
 * 200KB page of eight different 5000x5000 images held 650MB of RSS. So the whole file's claim is
 * added up from its bytes (see `imageClaims`) and refused past this before pdfjs is asked
 * for any page's images. 64 million is four pages of a 300dpi letter scan with room over, and
 * about 190MB of RGB at worst.
 */
export const MAX_SCAN_PIXELS_PER_PDF = 64_000_000;

/** The longest side a page image may have. Past this it is not a scanned page. */
export const MAX_SCAN_SIDE = 10_000;

/**
 * The shortest side an image needs to be a scanned page rather than a logo.
 *
 * A recipe card scanned at 100dpi is 400 pixels on its short side; a publisher's logo or a QR
 * code on a printed page is well under this.
 */
export const MIN_SCAN_SIDE = 300;

/**
 * The longest side a page is shrunk to before OCR.
 *
 * A letter page at 200dpi is 1700x2200, and both scanned fixtures and the real scan this was
 * built against (2040x2048) are at or under this, so none of them is shrunk. What it stops is a
 * 600dpi scan costing several times the recognition time of a 200dpi one for body text that was
 * already legible, and it is also what keeps every PNG under `MAX_IMAGE_BYTES`: a 2400x2400
 * page of pure noise, the worst case for deflate, stays under it (tested).
 */
export const OCR_LONGEST_SIDE = 2400;

/** pdfjs's `ImageKind.GRAYSCALE_1BPP`: one bit a pixel, rows padded to a byte, set is white. */
const GRAYSCALE_1BPP = 1;

/**
 * The image as grey pixels no longer than `longestSide` on either side, or null when it is not
 * something to read: a side over `MAX_SCAN_SIDE`, or data whose length fits no pixel layout.
 *
 * Shrinking is box averaging by a whole factor, the smallest one that brings the longest side
 * within bounds. Coarse, and enough: OCR needs the strokes, not the antialiasing, and a whole
 * factor needs no filter and no floating point per pixel.
 */
export function grayscaleOf(image: PdfImage, longestSide = OCR_LONGEST_SIDE): GrayImage | null {
  const { width, height, data } = image;
  if (!Number.isInteger(width) || !Number.isInteger(height)) return null;
  if (width < 1 || height < 1 || width > MAX_SCAN_SIDE || height > MAX_SCAN_SIDE) return null;

  const pixelCount = width * height;
  const rowBytes = Math.ceil(width / 8);
  const oneBit = data.length === rowBytes * height;
  const channels = data.length / pixelCount;

  let lumaAt: (x: number, y: number) => number;
  if (oneBit && (image.kind === GRAYSCALE_1BPP || ![1, 3, 4].includes(channels))) {
    lumaAt = (x, y) => ((data[y * rowBytes + (x >> 3)]! >> (7 - (x & 7))) & 1 ? 255 : 0);
  } else if (channels === 1) {
    lumaAt = (x, y) => data[y * width + x]!;
  } else if (channels === 3 || channels === 4) {
    // Rec. 601 weights in eighths of 256, so white stays 255 and no pixel needs a float.
    lumaAt = (x, y) => {
      const at = (y * width + x) * channels;
      return (data[at]! * 77 + data[at + 1]! * 150 + data[at + 2]! * 29) >> 8;
    };
  } else {
    return null;
  }

  const factor = Math.max(1, Math.ceil(Math.max(width, height) / longestSide));
  const outWidth = Math.ceil(width / factor);
  const outHeight = Math.ceil(height / factor);
  const pixels = new Uint8Array(outWidth * outHeight);
  const sums = new Uint32Array(outWidth);
  const counts = new Uint32Array(outWidth);

  for (let outY = 0; outY < outHeight; outY++) {
    sums.fill(0);
    counts.fill(0);
    const lastY = Math.min(height, (outY + 1) * factor);
    for (let y = outY * factor; y < lastY; y++) {
      for (let x = 0; x < width; x++) {
        const box = Math.floor(x / factor);
        sums[box]! += lumaAt(x, y);
        counts[box]! += 1;
      }
    }
    for (let box = 0; box < outWidth; box++) {
      pixels[outY * outWidth + box] = Math.floor((sums[box]! + (counts[box]! >> 1)) / counts[box]!);
    }
  }
  return { width: outWidth, height: outHeight, pixels };
}

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  return table;
})();

/** CRC-32 as PNG uses it (ISO 3309, the same one as zip and gzip). */
export function crc32(bytes: Uint8Array): number {
  let c = 0xffffffff;
  for (let i = 0; i < bytes.length; i++) c = CRC_TABLE[(c ^ bytes[i]!) & 0xff]! ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type: string, data: Uint8Array): Buffer {
  const out = Buffer.alloc(12 + data.length);
  out.writeUInt32BE(data.length, 0);
  out.write(type, 4, 'latin1');
  out.set(data, 8);
  out.writeUInt32BE(crc32(out.subarray(4, 8 + data.length)), 8 + data.length);
  return out;
}

/**
 * An 8-bit greyscale PNG of the image: signature, IHDR, one IDAT, IEND.
 *
 * Every row uses filter None. Up or Paeth would compress a scan somewhat better, but the size
 * that matters is bounded already (see `OCR_LONGEST_SIDE`) and the PNG never leaves the process.
 */
export function encodePng(image: GrayImage): Uint8Array {
  const { width, height, pixels } = image;
  const raw = Buffer.alloc(height * (width + 1));
  for (let y = 0; y < height; y++) {
    raw[y * (width + 1)] = 0;
    raw.set(pixels.subarray(y * width, (y + 1) * width), y * (width + 1) + 1);
  }
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0);
  header.writeUInt32BE(height, 4);
  header[8] = 8; // bit depth
  header[9] = 0; // colour type: greyscale
  return new Uint8Array(
    Buffer.concat([
      Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
      chunk('IHDR', header),
      chunk('IDAT', deflateSync(raw)),
      chunk('IEND', new Uint8Array(0)),
    ]),
  );
}

/** How far back from a `stream` keyword its dictionary is looked for. */
const STREAM_DICT_WINDOW = 4096;

/** A name's `#xx` escapes, spelled out: `/W#69dth` is `/Width` to pdfjs. */
function unescapeNames(text: string): string {
  return text.replace(/#([0-9A-Fa-f]{2})/g, (_, hex: string) =>
    String.fromCharCode(parseInt(hex, 16)),
  );
}

/** A direct whole number after `/key`, or null when the value is indirect, odd or absent. */
function directSize(dict: string, key: 'Width' | 'Height'): number | null {
  const match = new RegExp(
    `/${key}(?![A-Za-z])\\s{0,20}(\\d{1,9})(\\s{1,20}\\d{1,9}\\s{1,20}R)?`,
  ).exec(dict);
  if (!match || match[2] !== undefined) return null;
  const next = dict.charAt(match.index + match[0].length);
  // `5000.5` or a comment: something pdfjs reads and this does not, so not a direct size.
  return /[\d.%]/.test(next) ? null : Number(match[1]);
}

/** What the images in a PDF claim, read from its bytes before pdfjs parses it. */
export interface ImageClaims {
  /** The pixels pdfjs would decode, at most, for all of them together. */
  pixels: number;
  /** Whether any claims more than `MAX_SCAN_PIXELS`, so that pdfjs will drop it. */
  oversized: boolean;
}

/**
 * The pixels every image in the file claims, added up from its bytes before pdfjs parses it.
 *
 * Image XObjects are streams, and a stream can never be inside an object stream, so every
 * image's dictionary is in the file as plain text in front of its `stream` keyword. What cannot
 * be read here counts as the worst pdfjs would decode (`MAX_SCAN_PIXELS`): an indirect or
 * decimal size, or a comment in the way. An image claiming more than that counts nothing,
 * because pdfjs drops it unread. A dictionary with a /Width or /Height counts as an image
 * whatever its /Subtype says, because an SMask needs no /Subtype and a /Subtype can be indirect.
 *
 * NOT covered: an inline image (`BI ... ID ... EI`) inside a compressed content stream, which
 * cannot be seen without inflating every content stream. pdfjs's per-image bound still applies
 * to each.
 *
 * Linear: each window runs from the previous `stream` keyword to this one, so no byte is looked
 * at twice, and each is capped at `STREAM_DICT_WINDOW`.
 */
export function imageClaims(bytes: Uint8Array): ImageClaims {
  const text = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength).toString('latin1');
  let pixels = 0;
  let oversized = false;
  let previous = 0;
  for (let at = text.indexOf('stream'); at !== -1; at = text.indexOf('stream', at + 6)) {
    const windowStart = Math.max(previous, at - STREAM_DICT_WINDOW);
    previous = at + 6;
    if (text.startsWith('end', at - 3)) continue;

    let dict = text.slice(windowStart, at);
    const objectStart = dict.lastIndexOf('obj');
    if (objectStart !== -1) dict = dict.slice(objectStart);
    dict = unescapeNames(dict);
    if (!/\/(Width|Height)(?![A-Za-z])/.test(dict)) continue;

    const width = directSize(dict, 'Width');
    const height = directSize(dict, 'Height');
    if (width === null || height === null) {
      pixels += MAX_SCAN_PIXELS;
    } else if (width * height <= MAX_SCAN_PIXELS) {
      pixels += width * height;
    } else {
      oversized = true;
    }
  }
  return { pixels, oversized };
}

type PdfDocument = Awaited<ReturnType<typeof getDocumentProxy>>;

/**
 * How long to wait for an image pdfjs is still decoding.
 *
 * A large image arrives AFTER `getOperatorList` has returned (measured: a 9000x9000 one 450ms
 * later), so each is awaited rather than looked up. pdfjs resolves an image it failed to decode
 * as null, so this is a backstop against a promise that never settles, not a normal outcome.
 */
const IMAGE_WAIT_MS = 30_000;

/** The decoded image behind `id`, once pdfjs has it, or null if it never arrives. */
function imageOf(
  store: { get(id: string, callback: (data: unknown) => void): unknown },
  id: string,
) {
  return new Promise<unknown>((resolve) => {
    const timer = setTimeout(() => resolve(null), IMAGE_WAIT_MS);
    timer.unref();
    store.get(id, (data) => {
      clearTimeout(timer);
      resolve(data);
    });
  });
}

/** Whether an image is the size of a scanned page. */
function isPageSized(image: { width: number; height: number }): boolean {
  return (
    Math.min(image.width, image.height) >= MIN_SCAN_SIDE &&
    Math.max(image.width, image.height) <= MAX_SCAN_SIDE
  );
}

function looksDecoded(value: unknown): value is PdfImage {
  if (typeof value !== 'object' || value === null) return false;
  const image = value as Partial<PdfImage>;
  return (
    typeof image.width === 'number' &&
    typeof image.height === 'number' &&
    (image.data instanceof Uint8Array || image.data instanceof Uint8ClampedArray)
  );
}

/**
 * Each page's largest page-sized image as a PNG, in page order. Pages without one are skipped:
 * a blank back of a sheet, or a page drawn only in vectors.
 *
 * The document must have been opened with `maxImageSize: MAX_SCAN_PIXELS`, which bounds each
 * image `getOperatorList` decodes, and the caller must have checked `imageClaims` against
 * `MAX_SCAN_PIXELS_PER_PDF`, which bounds them all together, and bounded the page count.
 *
 * Only `paintImageXObject` and `paintInlineImageXObject` are read. An image mask (a one-bit
 * stencil painted in the fill colour) is not: pdfjs hands those over in a different shape, and
 * the one real scan measured here (one JPEG a page) is not drawn that way.
 */
export async function readScannedPages(doc: PdfDocument): Promise<Uint8Array[]> {
  const { OPS } = await getResolvedPDFJS();
  const pngs: Uint8Array[] = [];

  for (let number = 1; number <= doc.numPages; number++) {
    const page = await doc.getPage(number);
    try {
      const operators = await page.getOperatorList();
      let largest: PdfImage | null = null;
      for (let i = 0; i < operators.fnArray.length; i++) {
        const op = operators.fnArray[i];
        const args = operators.argsArray[i] as unknown[] | undefined;
        let image: unknown = null;
        if (op === OPS.paintImageXObject && typeof args?.[0] === 'string') {
          const id = args[0];
          // Images used on several pages are shared, and live in the document's common store.
          const store = id.startsWith('g_') ? page.commonObjs : page.objs;
          image = await imageOf(store, id);
        } else if (op === OPS.paintInlineImageXObject) {
          image = args?.[0];
        }
        if (!looksDecoded(image) || !isPageSized(image)) continue;
        if (!largest || image.width * image.height > largest.width * largest.height) {
          largest = image;
        }
      }
      const grey = largest && grayscaleOf(largest);
      if (grey) pngs.push(encodePng(grey));
    } finally {
      // The decoded images are held by the page until it is told otherwise, and a page image
      // is tens of megabytes.
      page.cleanup();
    }
  }
  return pngs;
}
