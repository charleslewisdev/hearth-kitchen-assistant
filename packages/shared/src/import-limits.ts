/**
 * The caps both ends of an import have to agree on.
 *
 * Here rather than in `packages/enrichment` because the browser needs them too - it checks a
 * file before spending a minute uploading it, and tells the cook in its own words - and naming
 * `packages/enrichment` in a browser bundle fails the build: it reaches `node:dns`, `unpdf` and
 * `tesseract.js` through its imports.
 *
 * The browser's check is a courtesy. The server enforces these again, on the bytes it actually
 * received, because a browser is not a boundary.
 */

/**
 * The largest PDF worth reading.
 *
 * A printed one-page recipe is 35KB (`cookbook-page.pdf`), and a recipe PDF with photographs in
 * it runs to a few megabytes. The file is parsed in the server process, so the bound has to be
 * on the input rather than on the answer.
 */
export const MAX_PDF_BYTES = 6 * 1024 * 1024;

/**
 * The largest photograph worth reading.
 *
 * A 12 megapixel phone photo is 4 to 6MB as the camera writes it. The browser reduces one to
 * about half a megabyte before uploading (Task J0: 12MP costs 1.6 times a 3.7MP image for
 * identical text), so this is the room left for a browser that could not.
 */
export const MAX_IMAGE_BYTES = 6 * 1024 * 1024;

/**
 * How many photographs one recipe may span: a cookbook recipe that runs over a page turn, or
 * ingredients on one page and the method on the next. They are read in order and joined.
 */
export const MAX_IMAGES_PER_IMPORT = 4;

/**
 * The most all the photographs of one import may weigh together. Twice one photo's cap, since a
 * browser that reduced them sends about half a megabyte each; this bounds the request body.
 */
export const MAX_IMAGE_IMPORT_BYTES = 2 * MAX_IMAGE_BYTES;

/**
 * The longest text an import will read.
 *
 * The largest article text extracted from the saved page fixtures is 13KB, so this is about
 * eight times the longest real page. The point of it is refusing a pasted book, not tuning.
 */
export const MAX_TEXT_LENGTH = 100_000;

/**
 * How long `bytes` bytes are once base64 encoded.
 *
 * Uploads travel as base64 inside a JSON body, so the cap the input schema can enforce - before
 * anything is decoded - is on the encoded length. Four characters per three bytes, rounded up
 * to the padded block.
 */
export function base64Length(bytes: number): number {
  return Math.ceil(bytes / 3) * 4;
}

/**
 * The most procedure calls one tRPC request may batch together.
 *
 * Without a cap, one POST to `/trpc/import.fromUrl,import.fromUrl,...?batch=1` starts that many
 * outbound fetches for a single unit of the rate limiter. The server refuses a larger batch with
 * a 400, and the web client's batch link splits at the same number, so the app never meets it.
 */
export const MAX_TRPC_BATCH = 10;

/**
 * Recipe photos (the gallery and cook-log pictures). The browser shrinks a photo to
 * `PHOTO_EDGE` on its long side, and to `THUMB_EDGE` for the thumbnail, before it is sent, so
 * the byte caps below are generous ceilings for a JPEG of that size rather than targets.
 */
export const PHOTO_EDGE = 1600;
export const THUMB_EDGE = 480;
export const MAX_PHOTO_BYTES = 3 * 1024 * 1024;
export const MAX_THUMB_BYTES = 512 * 1024;
/** Photos and source pages together, per recipe. A gallery past this is a camera roll. */
export const MAX_FILES_PER_RECIPE = 40;
