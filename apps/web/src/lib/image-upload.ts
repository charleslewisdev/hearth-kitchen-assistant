/**
 * Getting a photograph ready to be imported.
 *
 * Task J0 measured OCR on this hardware: a 12 megapixel phone photo costs 1.6 times what a 3.7
 * megapixel one costs and reads exactly the same text off it, because the page was already
 * legible at the smaller size. So the browser shrinks a photo before it goes anywhere, which
 * saves the upload as well as the recognition.
 *
 * Everything here degrades to "send the original file". A browser that cannot decode the image,
 * a canvas that will not give up a blob, an image that is already small: all of them fall
 * through to the bytes the cook chose, and the server decides what to do with them. Refusing a
 * photo because a convenience did not work would be the wrong trade.
 */

/**
 * The longest edge a photo is reduced to.
 *
 * 2200 keeps a letter-height page at about 260 pixels per inch, which is well above what
 * tesseract needs for 12pt body text, and lands a page at roughly 3.7 megapixels - the size
 * J0 measured as costing 1.6 times less than 12 megapixels for identical output.
 */
export const MAX_OCR_EDGE = 2200;

/** JPEG quality for the reduced copy. High enough that the letterforms keep their edges. */
export const JPEG_QUALITY = 0.82;

/** An image the browser has decoded, and whatever handle it decoded it into. */
export interface DecodedImage {
  width: number;
  height: number;
  source: unknown;
}

/**
 * The two browser capabilities this needs, as a seam.
 *
 * Injectable so the resize decision can be tested: jsdom implements neither `createImageBitmap`
 * nor a canvas that can encode a JPEG, so without this the only testable behaviour would be the
 * fallback, and the arithmetic that actually decides the output size would ship uncovered.
 */
export interface ImageResizer {
  decode(file: Blob): Promise<DecodedImage>;
  encode(
    image: DecodedImage,
    width: number,
    height: number,
    quality?: number,
  ): Promise<Blob | null>;
  release(image: DecodedImage): void;
}

/**
 * The size to reduce an image to, keeping its proportions.
 *
 * An image already inside the bound comes back unchanged, which is what tells the caller not to
 * re-encode it: a second JPEG pass over a small photo costs quality and buys nothing.
 */
export function fitWithin(
  width: number,
  height: number,
  maxEdge: number,
): { width: number; height: number } {
  const longest = Math.max(width, height);
  if (longest <= maxEdge) return { width, height };
  const scale = maxEdge / longest;
  // At least one pixel each way: a 4000x1 image would otherwise round to a height of zero, and
  // a canvas of height zero throws.
  return {
    width: Math.max(1, Math.round(width * scale)),
    height: Math.max(1, Math.round(height * scale)),
  };
}

export const browserResizer: ImageResizer = {
  async decode(file) {
    if (typeof createImageBitmap !== 'function') throw new Error('no image decoder here');
    const bitmap = await createImageBitmap(file);
    return { width: bitmap.width, height: bitmap.height, source: bitmap };
  },
  async encode(image, width, height, quality = JPEG_QUALITY) {
    const canvas = document.createElement('canvas');
    canvas.width = width;
    canvas.height = height;
    const context = canvas.getContext('2d');
    if (!context) return null;
    context.drawImage(image.source as CanvasImageSource, 0, 0, width, height);
    return new Promise((resolve) => canvas.toBlob(resolve, 'image/jpeg', quality));
  },
  release(image) {
    // Frees the decoded pixels now rather than when the collector gets round to it, which for a
    // 12 megapixel photo is about 48MB of them.
    (image.source as ImageBitmap | undefined)?.close?.();
  },
};

/** A photo reduced to something worth uploading, or the original when it cannot be. */
export async function downscaleForOcr(
  file: Blob,
  resizer: ImageResizer = browserResizer,
): Promise<Blob> {
  let image: DecodedImage;
  try {
    image = await resizer.decode(file);
  } catch {
    return file;
  }

  try {
    const target = fitWithin(image.width, image.height, MAX_OCR_EDGE);
    if (target.width === image.width && target.height === image.height) return file;
    return (await resizer.encode(image, target.width, target.height)) ?? file;
  } catch {
    return file;
  } finally {
    resizer.release(image);
  }
}

/**
 * A file as base64, for the JSON body a tRPC mutation travels in.
 *
 * `FileReader` rather than `blob.arrayBuffer()` and `btoa`, for two reasons. It hands back the
 * base64 already encoded, so a multi-megabyte photo never passes through
 * `String.fromCharCode(...bytes)` - which spreads every byte into an argument list and
 * overflows the call stack somewhere around a hundred thousand of them. And it is the older,
 * wider API: `Blob.prototype.arrayBuffer` is missing from Safari before 14, and from jsdom, so
 * the reader is also what makes this testable at all.
 *
 * The result is a data URL. Everything up to and including the comma is the media type and the
 * `;base64` marker, which the server has no use for: it decodes bytes, not a declared type.
 */
export function toBase64(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(reader.error ?? new Error('the file could not be read'));
    reader.onload = () => {
      const url = typeof reader.result === 'string' ? reader.result : '';
      const comma = url.indexOf(',');
      resolve(comma === -1 ? '' : url.slice(comma + 1));
    };
    reader.readAsDataURL(blob);
  });
}
