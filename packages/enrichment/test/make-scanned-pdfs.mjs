/*
 * Writes the image-only PDFs that `scan-pages.test.ts` and `from-pdf.test.ts` read.
 *
 *   node packages/enrichment/test/make-scanned-pdfs.mjs
 *
 * Every object and the xref table are written by hand, so each file is exactly what is described
 * here and nothing a PDF library decided to add. The output is deterministic: running this again
 * rewrites the same bytes.
 *
 *  - `scanned-cookbook.pdf` - what a phone scanner app or a flatbed hands over: one letter-size
 *    page whose only content is `cookbook-page.jpg` (1700x2200, grey) embedded as a DCTDecode
 *    image XObject and drawn across the whole page, plus a 64x32 "logo" in the corner, so a test
 *    that reads the recipe has also shown that the largest image on the page is the one read.
 *  - `scanned-tiny-image.pdf` - the logo and nothing else: an image-only PDF with no image big
 *    enough to be a scanned page.
 *  - `scanned-huge-claim.pdf` - HOSTILE. An image XObject that claims 100000x100000 grey pixels
 *    (ten gigabytes decoded) over a stream of a few bytes.
 *  - `scanned-dense-image.pdf` - HOSTILE. A white 9000x9000 grey image whose data is REALLY
 *    there: 81 million bytes that deflate to about 80KB. Every side is within bounds; only the
 *    pixel count is not.
 *  - `scanned-many-images.pdf` - HOSTILE. One page drawing eight different 5000x5000 grey
 *    images, each within every per-image bound, 200 million pixels between them in a 200KB file.
 *  - `scanned-five-pages.pdf` - five pages, each drawing the logo: longer than a scan Hearth
 *    will read.
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { deflateSync } from 'node:zlib';
import { fileURLToPath } from 'node:url';

const fixtures = (name) => fileURLToPath(new URL(`./fixtures/${name}`, import.meta.url));

/** A 64x32 grey gradient, Flate-compressed: small enough to be a logo, not a page. */
function logo() {
  const pixels = Buffer.alloc(64 * 32);
  for (let y = 0; y < 32; y++) for (let x = 0; x < 64; x++) pixels[y * 64 + x] = (x * 4) & 0xff;
  return {
    dict: '/Type /XObject /Subtype /Image /Width 64 /Height 32 /ColorSpace /DeviceGray /BitsPerComponent 8 /Filter /FlateDecode',
    data: deflateSync(pixels),
  };
}

/**
 * A PDF whose pages each draw the named images, as a Buffer.
 *
 * `pages` is a list of pages; each page is a list of [image, drawing operators] pairs.
 */
function pdf(pages) {
  const objects = [];
  const add = (body) => {
    objects.push(body);
    return objects.length;
  };
  const stream = (dict, data) =>
    Buffer.concat([
      Buffer.from(`<< ${dict} /Length ${data.length} >>\nstream\n`, 'latin1'),
      data,
      Buffer.from('\nendstream', 'latin1'),
    ]);

  const catalog = add(null);
  const pagesId = add(null);
  const kids = [];
  for (const page of pages) {
    const names = [];
    let content = '';
    page.forEach(([image, draw], index) => {
      const id = add(stream(image.dict, image.data));
      names.push(`/Im${index} ${id} 0 R`);
      content += `q ${draw} cm /Im${index} Do Q\n`;
    });
    const contents = add(stream('', Buffer.from(content, 'latin1')));
    kids.push(
      add(
        Buffer.from(
          `<< /Type /Page /Parent ${pagesId} 0 R /MediaBox [0 0 612 792] ` +
            `/Resources << /XObject << ${names.join(' ')} >> >> /Contents ${contents} 0 R >>`,
          'latin1',
        ),
      ),
    );
  }
  objects[catalog - 1] = Buffer.from(`<< /Type /Catalog /Pages ${pagesId} 0 R >>`, 'latin1');
  objects[pagesId - 1] = Buffer.from(
    `<< /Type /Pages /Kids [${kids.map((k) => `${k} 0 R`).join(' ')}] /Count ${kids.length} >>`,
    'latin1',
  );

  const parts = [Buffer.from('%PDF-1.4\n%\xe2\xe3\xcf\xd3\n', 'latin1')];
  let offset = parts[0].length;
  const offsets = [];
  objects.forEach((body, index) => {
    offsets.push(offset);
    const chunk = Buffer.concat([
      Buffer.from(`${index + 1} 0 obj\n`, 'latin1'),
      body,
      Buffer.from('\nendobj\n', 'latin1'),
    ]);
    parts.push(chunk);
    offset += chunk.length;
  });
  const xref =
    `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n` +
    offsets.map((o) => `${String(o).padStart(10, '0')} 00000 n \n`).join('') +
    `trailer\n<< /Size ${objects.length + 1} /Root ${catalog} 0 R >>\nstartxref\n${offset}\n%%EOF\n`;
  parts.push(Buffer.from(xref, 'latin1'));
  return Buffer.concat(parts);
}

const photo = {
  dict: '/Type /XObject /Subtype /Image /Width 1700 /Height 2200 /ColorSpace /DeviceGray /BitsPerComponent 8 /Filter /DCTDecode',
  data: readFileSync(fixtures('cookbook-page.jpg')),
};
const fullPage = '612 0 0 792 0 0';
const corner = '64 0 0 32 20 740';

writeFileSync(
  fixtures('scanned-cookbook.pdf'),
  pdf([
    [
      [photo, fullPage],
      [logo(), corner],
    ],
  ]),
);
writeFileSync(fixtures('scanned-tiny-image.pdf'), pdf([[[logo(), corner]]]));
writeFileSync(
  fixtures('scanned-huge-claim.pdf'),
  pdf([
    [
      [
        {
          dict: '/Type /XObject /Subtype /Image /Width 100000 /Height 100000 /ColorSpace /DeviceGray /BitsPerComponent 8 /Filter /FlateDecode',
          data: deflateSync(Buffer.alloc(1000)),
        },
        fullPage,
      ],
    ],
  ]),
);
writeFileSync(
  fixtures('scanned-dense-image.pdf'),
  pdf([
    [
      [
        {
          dict: '/Type /XObject /Subtype /Image /Width 9000 /Height 9000 /ColorSpace /DeviceGray /BitsPerComponent 8 /Filter /FlateDecode',
          data: deflateSync(Buffer.alloc(9000 * 9000, 255), { level: 9 }),
        },
        fullPage,
      ],
    ],
  ]),
);
writeFileSync(
  fixtures('scanned-many-images.pdf'),
  pdf([
    Array.from({ length: 8 }, (_, index) => [
      {
        // Distinct streams (each a different shade), so pdfjs cannot decode one and reuse it.
        dict: '/Type /XObject /Subtype /Image /Width 5000 /Height 5000 /ColorSpace /DeviceGray /BitsPerComponent 8 /Filter /FlateDecode',
        data: deflateSync(Buffer.alloc(5000 * 5000, 200 + index), { level: 9 }),
      },
      fullPage,
    ]),
  ]),
);
writeFileSync(
  fixtures('scanned-five-pages.pdf'),
  pdf(Array.from({ length: 5 }, () => [[logo(), corner]])),
);
