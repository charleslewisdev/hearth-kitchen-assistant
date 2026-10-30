import { PHOTO_EDGE, THUMB_EDGE } from '@hearth/shared';
import { browserResizer, fitWithin, MAX_OCR_EDGE, type ImageResizer } from './image-upload';

/** A photo made ready to keep: a display copy, a thumbnail, and the display copy's size. */
export interface PreparedImage {
  full: Blob;
  thumb: Blob;
  width: number;
  height: number;
}

/** Thrown when this browser cannot open the file as an image at all. */
export class UnreadableImageError extends Error {
  constructor() {
    super('This browser could not open that photo.');
  }
}

/**
 * Shrink a photo to what a recipe keeps, in the browser, before anything is sent.
 *
 * Always re-encoded, even when it is already small: the JPEG that comes out of the canvas has
 * no EXIF, so a phone photo's GPS position and camera details never leave the device. Unlike
 * the OCR path, a photo the browser cannot decode (HEIC on a desktop browser) is refused rather
 * than sent as it is, because the server keeps only JPEG and a thumbnail has to be made here.
 */
export async function prepareImage(
  file: Blob,
  maxEdge: number = PHOTO_EDGE,
  resizer: ImageResizer = browserResizer,
): Promise<PreparedImage> {
  let image;
  try {
    image = await resizer.decode(file);
  } catch {
    throw new UnreadableImageError();
  }
  try {
    const size = fitWithin(image.width, image.height, maxEdge);
    const small = fitWithin(image.width, image.height, THUMB_EDGE);
    const full = await resizer.encode(image, size.width, size.height, 0.85);
    const thumb = await resizer.encode(image, small.width, small.height, 0.8);
    if (!full || !thumb) throw new UnreadableImageError();
    return { full, thumb, ...size };
  } finally {
    resizer.release(image);
  }
}

/** A page an import was read from, kept at the size OCR used so it stays legible. */
export function prepareSourcePage(file: Blob, resizer?: ImageResizer): Promise<PreparedImage> {
  return prepareImage(file, MAX_OCR_EDGE, resizer);
}

/** Where the server hands a kept file back. */
export function fileUrl(id: string, variant: 'full' | 'thumb'): string {
  return `/api/files/${id}/${variant}`;
}
