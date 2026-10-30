import { describe, it, expect } from 'vitest';
import { inflateSync } from 'node:zlib';
import { MAX_IMAGE_BYTES } from '@hearth/shared';
import {
  crc32,
  encodePng,
  grayscaleOf,
  imageClaims,
  MAX_SCAN_PIXELS,
  MAX_SCAN_SIDE,
  OCR_LONGEST_SIDE,
} from './scan-pages';

/** A PNG's chunks, in order, each with the CRC it carries. */
function chunksOf(png: Uint8Array) {
  const view = Buffer.from(png.buffer, png.byteOffset, png.byteLength);
  const chunks: { type: string; data: Buffer; crc: number; body: Buffer }[] = [];
  let at = 8;
  while (at < view.length) {
    const length = view.readUInt32BE(at);
    const type = view.toString('latin1', at + 4, at + 8);
    const data = view.subarray(at + 8, at + 8 + length);
    const body = view.subarray(at + 4, at + 8 + length);
    const crc = view.readUInt32BE(at + 8 + length);
    chunks.push({ type, data, crc, body });
    at += 12 + length;
  }
  return chunks;
}

describe('imageClaims', () => {
  const pdfText = (text: string) => new TextEncoder().encode(text);
  const image = (dict: string) =>
    `1 0 obj\n<< /Type /XObject /Subtype /Image ${dict} /Length 3 >>\nstream\nabc\nendstream\nendobj\n`;

  it('adds up what every image dictionary claims', () => {
    const bytes = pdfText(image('/Width 100 /Height 200') + image('/Height 10 /Width 30'));
    expect(imageClaims(bytes).pixels).toBe(100 * 200 + 30 * 10);
  });

  it('ignores streams that are not images', () => {
    const bytes = pdfText(
      '4 0 obj\n<< /Length 3 /Filter /FlateDecode >>\nstream\nabc\nendstream\n',
    );
    expect(imageClaims(bytes).pixels).toBe(0);
  });

  it('reads names spelled with # escapes', () => {
    expect(imageClaims(pdfText(image('/W#69dth 100 /H#65ight 200'))).pixels).toBe(20_000);
  });

  it('counts a size it cannot read as the most pdfjs would decode', () => {
    // An indirect width, or a comment between key and value: pdfjs resolves both.
    expect(imageClaims(pdfText(image('/Width 5 0 R /Height 200'))).pixels).toBe(MAX_SCAN_PIXELS);
    expect(imageClaims(pdfText(image('/Width %x\n100 /Height 200'))).pixels).toBe(MAX_SCAN_PIXELS);
  });

  it('counts nothing for an image pdfjs will drop for its size anyway, and says there was one', () => {
    const claims = imageClaims(pdfText(image('/Width 100000 /Height 100000')));
    expect(claims).toEqual({ pixels: 0, oversized: true });
    expect(imageClaims(pdfText(image('/Width 100 /Height 200'))).oversized).toBe(false);
  });

  it('stays linear on a file of nothing but stream keywords', () => {
    const hostile = pdfText('/Width 1 stream '.repeat(400_000));
    const started = Date.now();
    imageClaims(hostile);
    expect(Date.now() - started).toBeLessThan(1000);
  });
});

describe('crc32', () => {
  it('matches the standard check value', () => {
    // The CRC-32 of "123456789" is the check value every implementation publishes.
    expect(crc32(new TextEncoder().encode('123456789'))).toBe(0xcbf43926);
    expect(crc32(new TextEncoder().encode('IEND'))).toBe(0xae426082);
  });
});

describe('encodePng', () => {
  const width = 5;
  const height = 3;
  const pixels = Uint8Array.from({ length: width * height }, (_, i) => i * 17);
  const png = encodePng({ width, height, pixels });

  it('writes the signature and a greyscale header with the right size', () => {
    expect([...png.subarray(0, 8)]).toEqual([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
    const [header] = chunksOf(png);
    expect(header!.type).toBe('IHDR');
    expect(header!.data.readUInt32BE(0)).toBe(width);
    expect(header!.data.readUInt32BE(4)).toBe(height);
    // Bit depth 8, colour type 0 (greyscale), then compression, filter and interlace all 0.
    expect([...header!.data.subarray(8)]).toEqual([8, 0, 0, 0, 0]);
  });

  it('carries a correct CRC on every chunk and ends with IEND', () => {
    const chunks = chunksOf(png);
    expect(chunks.map((c) => c.type)).toEqual(['IHDR', 'IDAT', 'IEND']);
    for (const chunk of chunks) expect(chunk.crc).toBe(crc32(chunk.body));
  });

  it('round-trips the pixels through inflate', () => {
    const idat = chunksOf(png).find((c) => c.type === 'IDAT')!;
    const raw = inflateSync(idat.data);
    expect(raw.length).toBe(height * (width + 1));
    for (let y = 0; y < height; y++) {
      const row = raw.subarray(y * (width + 1), (y + 1) * (width + 1));
      expect(row[0]).toBe(0); // filter type None
      expect([...row.subarray(1)]).toEqual([...pixels.subarray(y * width, (y + 1) * width)]);
    }
  });

  it('stays under the photo cap at the largest size it is ever asked for, even on noise', () => {
    // Noise is the worst case for deflate. A square at the downscale bound is the most pixels
    // `grayscaleOf` ever hands over, so this is the largest PNG a scanned page can become.
    const side = OCR_LONGEST_SIDE;
    const noise = new Uint8Array(side * side);
    let seed = 1;
    for (let i = 0; i < noise.length; i++) {
      seed = (seed * 1103515245 + 12345) >>> 0;
      noise[i] = seed >>> 24;
    }
    const big = encodePng({ width: side, height: side, pixels: noise });
    expect(big.byteLength).toBeLessThan(MAX_IMAGE_BYTES);
  });
});

describe('grayscaleOf', () => {
  it('turns RGB into luma', () => {
    // Red, green, blue, white: the luma weights, and white stays white.
    const data = Uint8Array.from([255, 0, 0, 0, 255, 0, 0, 0, 255, 255, 255, 255]);
    const grey = grayscaleOf({ width: 4, height: 1, kind: 2, data })!;
    expect(grey.width).toBe(4);
    expect(grey.height).toBe(1);
    expect([...grey.pixels]).toEqual([76, 149, 28, 255]);
  });

  it('turns RGBA into luma and ignores alpha', () => {
    const data = Uint8Array.from([255, 255, 255, 0, 0, 0, 0, 255]);
    const grey = grayscaleOf({ width: 2, height: 1, kind: 3, data })!;
    expect([...grey.pixels]).toEqual([255, 0]);
  });

  it('reads one-bit pages, rows padded to a byte, with a set bit as white', () => {
    // 10 pixels wide is two bytes a row, the last six bits of each row padding.
    const data = Uint8Array.from([0b10100000, 0b01000000, 0b00000000, 0b11000000]);
    const grey = grayscaleOf({ width: 10, height: 2, kind: 1, data })!;
    expect([...grey.pixels]).toEqual([
      255, 0, 255, 0, 0, 0, 0, 0, 0, 255, 0, 0, 0, 0, 0, 0, 0, 0, 255, 255,
    ]);
  });

  it('reads an 8-bit grey image as it is', () => {
    const data = Uint8Array.from([0, 100, 200, 250]);
    const grey = grayscaleOf({ width: 2, height: 2, data })!;
    expect([...grey.pixels]).toEqual([0, 100, 200, 250]);
  });

  it('averages boxes when shrinking, and ends at or under the longest side', () => {
    // 4x2 to a longest side of 2: a factor of 2, so each output pixel is a 2x2 box.
    const data = Uint8Array.from([0, 100, 200, 200, 100, 200, 0, 0]);
    const grey = grayscaleOf({ width: 4, height: 2, data }, 2)!;
    expect(grey.width).toBe(2);
    expect(grey.height).toBe(1);
    expect([...grey.pixels]).toEqual([100, 100]);
  });

  it('averages the partial boxes at the right and bottom edges over what is there', () => {
    // 3x1 by a factor of 2: the last box holds one pixel, and must not be darkened by the
    // two that are not there.
    const data = Uint8Array.from([0, 200, 90]);
    const grey = grayscaleOf({ width: 3, height: 1, data }, 2)!;
    expect([...grey.pixels]).toEqual([100, 90]);
  });

  it('brings a large scan down to the OCR size', () => {
    const width = 5000;
    const height = 6500;
    const grey = grayscaleOf({ width, height, data: new Uint8Array(width * height) })!;
    expect(Math.max(grey.width, grey.height)).toBeLessThanOrEqual(OCR_LONGEST_SIDE);
    expect(grey.pixels.length).toBe(grey.width * grey.height);
    // Not shrunk further than it had to be.
    expect(Math.max(grey.width, grey.height)).toBeGreaterThan(OCR_LONGEST_SIDE / 2);
  });

  it('leaves a scan already under the OCR size alone', () => {
    const grey = grayscaleOf({ width: 1700, height: 2200, data: new Uint8Array(1700 * 2200) })!;
    expect([grey.width, grey.height]).toEqual([1700, 2200]);
  });

  it('refuses a side over the bound without touching the data', () => {
    // The data is far too short for what is claimed; the size is what is refused, first.
    const data = new Uint8Array(4);
    expect(grayscaleOf({ width: MAX_SCAN_SIDE + 1, height: 10, data })).toBeNull();
    expect(grayscaleOf({ width: 10, height: MAX_SCAN_SIDE + 1, data })).toBeNull();
  });

  it('refuses data whose length fits no pixel layout', () => {
    expect(grayscaleOf({ width: 3, height: 3, data: new Uint8Array(10) })).toBeNull();
    expect(grayscaleOf({ width: 0, height: 3, data: new Uint8Array(0) })).toBeNull();
  });
});
