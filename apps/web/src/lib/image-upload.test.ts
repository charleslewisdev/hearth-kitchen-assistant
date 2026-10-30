import { describe, it, expect } from 'vitest';
import {
  downscaleForOcr,
  fitWithin,
  toBase64,
  type DecodedImage,
  type ImageResizer,
} from './image-upload';

/**
 * jsdom implements neither `createImageBitmap` nor a canvas that can encode a JPEG, so the
 * resizer is injected here. What that leaves untested is the eight lines of `browserResizer`
 * that call those two browser APIs; what it covers is every decision made around them, which is
 * where the arithmetic and the fallbacks live.
 */
function fakeResizer(over: Partial<ImageResizer> = {}): ImageResizer & { calls: number[][] } {
  const calls: number[][] = [];
  return {
    calls,
    decode: async () => ({ width: 3024, height: 4032, source: 'bitmap' }),
    encode: async (_image, width, height) => {
      calls.push([width, height]);
      return new Blob(['shrunk'], { type: 'image/jpeg' });
    },
    release: () => undefined,
    ...over,
  };
}

describe('fitWithin', () => {
  it('scales a portrait photo by its long edge', () => {
    // A 12 megapixel phone photo, which is what J0 measured as costing 1.6 times a 3.7MP one.
    expect(fitWithin(3024, 4032, 2200)).toEqual({ width: 1650, height: 2200 });
  });

  it('scales a landscape one by its long edge too', () => {
    expect(fitWithin(4032, 3024, 2200)).toEqual({ width: 2200, height: 1650 });
  });

  it('leaves an image already inside the bound exactly as it is', () => {
    // Identity is the signal to skip re-encoding: a second JPEG pass costs quality and saves
    // nothing.
    expect(fitWithin(1200, 1600, 2200)).toEqual({ width: 1200, height: 1600 });
    expect(fitWithin(2200, 900, 2200)).toEqual({ width: 2200, height: 900 });
  });

  it('never rounds a dimension down to zero', () => {
    // A canvas of height zero throws, and a panorama is the shape that gets there.
    expect(fitWithin(8000, 3, 2200)).toEqual({ width: 2200, height: 1 });
  });
});

describe('downscaleForOcr', () => {
  const photo = new Blob(['original'], { type: 'image/jpeg' });

  it('re-encodes a large photo at the fitted size', async () => {
    const resizer = fakeResizer();
    const out = await downscaleForOcr(photo, resizer);

    expect(resizer.calls).toEqual([[1650, 2200]]);
    expect(out).not.toBe(photo);
    expect(await toBase64(out)).toBe(btoa('shrunk'));
  });

  it('sends a small photo untouched, without a second JPEG pass', async () => {
    const resizer = fakeResizer({
      decode: async () => ({ width: 1200, height: 1600, source: 'bitmap' }),
    });
    const out = await downscaleForOcr(photo, resizer);

    expect(resizer.calls).toEqual([]);
    expect(out).toBe(photo);
  });

  it('sends the original when the browser cannot decode the image', async () => {
    // Which is what a browser with no `createImageBitmap` does, and what a HEIC does everywhere.
    // Refusing the photo over a failed convenience would be the wrong trade: the server reads
    // the bytes, or says it could not.
    const resizer = fakeResizer({
      decode: async () => {
        throw new Error('no decoder here');
      },
    });
    expect(await downscaleForOcr(photo, resizer)).toBe(photo);
  });

  it('sends the original when the canvas will not give up a blob', async () => {
    const resizer = fakeResizer({ encode: async () => null });
    expect(await downscaleForOcr(photo, resizer)).toBe(photo);
  });

  it('releases the decoded pixels either way', async () => {
    // 48MB of them, for a 12 megapixel photo.
    const released: DecodedImage[] = [];
    const resizer = fakeResizer({
      encode: async () => {
        throw new Error('canvas fell over');
      },
      release: (image) => released.push(image),
    });
    await downscaleForOcr(photo, resizer);
    expect(released).toHaveLength(1);
  });
});

describe('toBase64', () => {
  it('encodes the bytes of a blob', async () => {
    const blob = new Blob([new Uint8Array([104, 101, 97, 114, 116, 104])]);
    expect(await toBase64(blob)).toBe('aGVhcnRo');
  });

  it('encodes a blob far larger than one spread call could carry', async () => {
    // The size that rules out `btoa(String.fromCharCode(...bytes))`: spreading 300k bytes into
    // an argument list overflows the call stack, and a photo is an order of magnitude bigger
    // again. `FileReader` never builds that argument list.
    const big = new Uint8Array(300_000).fill(65);
    const encoded = await toBase64(new Blob([big]));
    expect(encoded).toHaveLength(400_000);
    expect(encoded.startsWith('QUFB')).toBe(true);
  });
});
