import { describe, it, expect, vi } from 'vitest';
import { prepareImage, UnreadableImageError } from './photo-upload';
import type { ImageResizer } from './image-upload';

function resizer(
  width: number,
  height: number,
): ImageResizer & { encode: ReturnType<typeof vi.fn> } {
  return {
    decode: vi.fn(async () => ({ width, height, source: null })),
    encode: vi.fn(async (_image, w: number, h: number) => new Blob([`${w}x${h}`])),
    release: vi.fn(),
  };
}

describe('prepareImage', () => {
  it('makes a 1600px copy and a 480px thumbnail of a big photo', async () => {
    const r = resizer(4032, 3024);
    const prepared = await prepareImage(new Blob(['x']), undefined, r);
    expect([prepared.width, prepared.height]).toEqual([1600, 1200]);
    expect(r.encode).toHaveBeenLastCalledWith(expect.anything(), 480, 360, 0.8);
  });

  it('re-encodes a small photo too, which is what strips its EXIF', async () => {
    const r = resizer(800, 600);
    await prepareImage(new Blob(['x']), undefined, r);
    expect(r.encode).toHaveBeenCalledWith(expect.anything(), 800, 600, 0.85);
  });

  it('refuses a file this browser cannot open, rather than sending it as it is', async () => {
    const r = resizer(1, 1);
    r.decode = vi.fn(async () => {
      throw new Error('HEIC');
    });
    await expect(prepareImage(new Blob(['x']), undefined, r)).rejects.toBeInstanceOf(
      UnreadableImageError,
    );
  });
});
