import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { strToU8, zipSync } from 'fflate';
import { MAX_DOCX_BYTES, MAX_TEXT_LENGTH } from '@hearth/shared';
import {
  draftFromDocx,
  MAX_DOCX_ENTRIES,
  MAX_DOCX_INFLATED_BYTES,
  textFromDocx,
} from './from-docx';

/*
  Every document here is invented, and all but one are built in the test: a `.docx` is a zip of
  XML, so a few lines of `fflate` make one with exactly the structure a test is about. The one
  committed fixture, `word-recipe.docx`, comes from python-docx and Word's default template
  (`test/make-word-fixture.py`), for the parts a hand-built zip would leave out.
*/

const W = 'http://schemas.openxmlformats.org/wordprocessingml/2006/main';
const R = 'http://schemas.openxmlformats.org/package/2006/relationships';
const OFFICE = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships';

function fixture(name: string): Uint8Array {
  return new Uint8Array(
    readFileSync(fileURLToPath(new URL(`../test/fixtures/${name}`, import.meta.url))),
  );
}

const rels = (main = 'word/document.xml') =>
  `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="${R}"><Relationship Id="rId1" Type="${OFFICE}/officeDocument" Target="${main}"/></Relationships>`;

const documentXml = (body: string) =>
  `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><w:document xmlns:w="${W}" xmlns:mc="http://schemas.openxmlformats.org/markup-compatibility/2006"><w:body>${body}<w:sectPr><w:pgSz w:w="12240"/></w:sectPr></w:body></w:document>`;

/** A paragraph of one run, with optional paragraph properties. */
const p = (text: string, pPr = '') =>
  `<w:p>${pPr ? `<w:pPr>${pPr}</w:pPr>` : ''}<w:r><w:rPr><w:b/></w:rPr><w:t xml:space="preserve">${text}</w:t></w:r></w:p>`;

const listItem = (text: string, numId: number, ilvl = 0) =>
  p(
    text,
    `<w:pStyle w:val="ListParagraph"/><w:numPr><w:ilvl w:val="${ilvl}"/><w:numId w:val="${numId}"/></w:numPr>`,
  );

/** numId 1 is a numbered list, 2 a bulleted one, 3 numbered from 5. */
const NUMBERING = `<?xml version="1.0" encoding="UTF-8"?><w:numbering xmlns:w="${W}">
<w:abstractNum w:abstractNumId="10"><w:lvl w:ilvl="0"><w:start w:val="1"/><w:numFmt w:val="decimal"/><w:lvlText w:val="%1."/></w:lvl><w:lvl w:ilvl="1"><w:start w:val="1"/><w:numFmt w:val="lowerLetter"/></w:lvl></w:abstractNum>
<w:abstractNum w:abstractNumId="20"><w:lvl w:ilvl="0"><w:numFmt w:val="bullet"/><w:lvlText w:val="&#61623;"/></w:lvl></w:abstractNum>
<w:num w:numId="1"><w:abstractNumId w:val="10"/></w:num>
<w:num w:numId="2"><w:abstractNumId w:val="20"/></w:num>
<w:num w:numId="3"><w:abstractNumId w:val="10"/><w:lvlOverride w:ilvl="0"><w:startOverride w:val="5"/></w:lvlOverride></w:num>
</w:numbering>`;

/** A `.docx` with `body` as its document, and any other parts given. */
function docx(body: string, parts: Record<string, string> = {}): Uint8Array {
  return zipSync({
    '[Content_Types].xml': strToU8('<Types/>'),
    '_rels/.rels': strToU8(rels()),
    'word/document.xml': strToU8(documentXml(body)),
    'word/numbering.xml': strToU8(NUMBERING),
    ...Object.fromEntries(Object.entries(parts).map(([name, xml]) => [name, strToU8(xml)])),
  });
}

function text(body: string, parts?: Record<string, string>): string {
  const read = textFromDocx(docx(body, parts));
  if (!('text' in read)) throw new Error(`expected text, got ${read.reason}`);
  return read.text;
}

const RECIPE_BODY = [
  p('Lemon Drizzle Squares', '<w:pStyle w:val="Heading1"/>'),
  p('Serves 12'),
  p(''),
  p('Ingredients', '<w:pStyle w:val="Heading2"/>'),
  listItem('1 cup butter, softened', 2),
  listItem('1 cup caster sugar', 2),
  listItem('2 cups self-raising flour', 2),
  listItem('4 eggs', 2),
  listItem('2 lemons, zested and juiced', 2),
  p('Method', '<w:pStyle w:val="Heading2"/>'),
  listItem('Heat the oven to 350F and line a square pan.', 1),
  listItem('Beat the butter and sugar, then the eggs, flour and zest.', 1),
  listItem('Bake for 30 minutes, then pour the lemon juice over while warm.', 1),
].join('');

describe('reading a Word document as lines', () => {
  it('gives a paragraph per line, a heading on its own, and lists with their markers', () => {
    expect(text(RECIPE_BODY)).toBe(
      [
        'Lemon Drizzle Squares',
        'Serves 12',
        '',
        'Ingredients',
        '• 1 cup butter, softened',
        '• 1 cup caster sugar',
        '• 2 cups self-raising flour',
        '• 4 eggs',
        '• 2 lemons, zested and juiced',
        'Method',
        '1. Heat the oven to 350F and line a square pan.',
        '2. Beat the butter and sugar, then the eggs, flour and zest.',
        '3. Bake for 30 minutes, then pour the lemon juice over while warm.',
      ].join('\n'),
    );
  });

  it('numbers from where a list says to start, and restarts a level under its parent', () => {
    expect(
      text(
        [
          listItem('Fifth', 3),
          listItem('Sixth', 3),
          listItem('One', 1),
          listItem('a sub-step', 1, 1),
          listItem('Two', 1),
        ].join(''),
      ),
    ).toBe('5. Fifth\n6. Sixth\n1. One\n• a sub-step\n2. Two');
  });

  it('numbers a paragraph whose style does the numbering, through basedOn', () => {
    const styles = `<w:styles xmlns:w="${W}">
      <w:style w:type="paragraph" w:styleId="ListNumber"><w:basedOn w:val="Normal"/><w:pPr><w:numPr><w:numId w:val="1"/></w:numPr></w:pPr></w:style>
      <w:style w:type="paragraph" w:styleId="StepStyle"><w:basedOn w:val="ListNumber"/></w:style>
      <w:style w:type="paragraph" w:styleId="Loop1"><w:basedOn w:val="Loop2"/></w:style>
      <w:style w:type="paragraph" w:styleId="Loop2"><w:basedOn w:val="Loop1"/></w:style>
    </w:styles>`;
    expect(
      text(
        [
          p('Mix.', '<w:pStyle w:val="ListNumber"/>'),
          p('Bake.', '<w:pStyle w:val="StepStyle"/>'),
          p('Plain.', '<w:pStyle w:val="Loop1"/>'),
        ].join(''),
        { 'word/styles.xml': styles },
      ),
    ).toBe('1. Mix.\n2. Bake.\nPlain.');
  });

  it('gives a table one line per row, and reads a layout table a cell at a time', () => {
    const cell = (...paragraphs: string[]) =>
      `<w:tc><w:tcPr/>${paragraphs.map((t) => p(t)).join('')}</w:tc>`;
    const row = (...cells: string[]) => `<w:tr>${cells.join('')}</w:tr>`;
    const amounts = `<w:tbl><w:tblPr/>${row(cell('1 cup'), cell('rolled oats'))}${row(cell('2 tbsp'), cell(''), cell('honey'))}</w:tbl>`;
    expect(text(amounts)).toBe('1 cup rolled oats\n2 tbsp honey');

    const layout = `<w:tbl>${row(cell('1 cup oats', '2 tbsp honey'), cell('Stir.', 'Bake.'))}</w:tbl>`;
    expect(text(layout)).toBe('1 cup oats\n2 tbsp honey\nStir.\nBake.');

    const nested = `<w:tbl>${row(`<w:tc>${p('Before')}<w:tbl>${row(cell('1 cup'), cell('oats'))}</w:tbl></w:tc>`)}</w:tbl>`;
    expect(text(nested)).toBe('Before\n1 cup oats');
  });

  it('turns breaks into lines and tabs into spaces, and decodes entities', () => {
    const body =
      '<w:p><w:r><w:t>Salt &amp; pepper</w:t><w:br/><w:t>1</w:t><w:tab/><w:t>cup &#x2014; &lt;sifted&gt; &unknown; &#0;</w:t></w:r></w:p>';
    expect(text(body)).toBe('Salt & pepper\n1\tcup — <sifted> &unknown; �');
  });

  it('leaves out deleted text, field codes and the fallback copy of a text box', () => {
    const body = [
      '<w:p><w:r><w:t>Kept</w:t></w:r><w:del><w:r><w:delText>gone</w:delText></w:r></w:del>',
      '<w:ins><w:r><w:t xml:space="preserve"> added</w:t></w:r></w:ins>',
      '<w:r><w:instrText>PAGE</w:instrText></w:r></w:p>',
      '<w:p><w:r><mc:AlternateContent><mc:Choice><w:txbxContent>',
      p('In the box'),
      '</w:txbxContent></mc:Choice><mc:Fallback><w:txbxContent>',
      p('In the box'),
      '</w:txbxContent></mc:Fallback></mc:AlternateContent></w:r></w:p>',
    ].join('');
    expect(text(body)).toBe('Kept added\nIn the box');
  });

  it('keeps one blank line for several, and none at either end', () => {
    expect(text([p(''), p('A'), p(''), p(''), p('B'), p('')].join(''))).toBe('A\n\nB');
  });

  it('finds the main part where the package relationships say it is', () => {
    const bytes = zipSync({
      '_rels/.rels': strToU8(rels('/word/document2.xml')),
      'word/document2.xml': strToU8(documentXml(p('Moved'))),
    });
    expect(textFromDocx(bytes)).toEqual({ text: 'Moved' });
  });
});

describe('a recipe from a Word document', () => {
  it('becomes a draft through the text heuristics', () => {
    const result = draftFromDocx(docx(RECIPE_BODY));
    if (!result.ok) throw new Error(result.reason);
    expect(result.draft.source).toEqual({ kind: 'docx' });
    expect(result.draft.title.value).toBe('Lemon Drizzle Squares');
    expect(result.draft.servings.value).toBe(12);
    expect(result.draft.ingredientLines.value).toEqual([
      '1 cup butter, softened',
      '1 cup caster sugar',
      '2 cups self-raising flour',
      '4 eggs',
      '2 lemons, zested and juiced',
    ]);
    expect(result.draft.steps.value).toHaveLength(3);
  });

  it('reads a document saved from Word’s own template', () => {
    const result = draftFromDocx(fixture('word-recipe.docx'));
    if (!result.ok) throw new Error(result.reason);
    expect(result.text).toContain('1. Heat the oven to 350F');
    expect(result.text).toContain('1/2 cup chocolate chips');
    expect(result.draft.title.value).toBe('Brown Butter Oat Bars');
    expect(result.draft.steps.value).toHaveLength(4);
    expect(result.draft.steps.value[3]).toMatch(/^Scatter the topping over/);
    // The table of amounts, and the bulleted list after it, are one ingredient list.
    expect(result.draft.ingredientLines.value).toEqual([
      '1 cup unsalted butter',
      '2 cups rolled oats',
      '1 1/2 cups all-purpose flour',
      '3/4 cup packed brown sugar',
      '1 tsp baking soda',
      '1/2 tsp fine salt',
      '2 tsp vanilla extract',
      '1/2 cup chocolate chips',
      '1/4 cup chopped pecans',
    ]);
  });

  it('says there is no recipe, with what it read, when there is none', () => {
    expect(draftFromDocx(docx(p('Minutes of the allotment meeting.')))).toEqual({
      ok: false,
      reason: 'no-recipe',
      text: 'Minutes of the allotment meeting.',
    });
  });
});

describe('files that are not a Word document Hearth can read', () => {
  it('names an old .doc, or a password-protected .docx, by its first bytes', () => {
    const ole = new Uint8Array(4096);
    ole.set([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1]);
    expect(draftFromDocx(ole)).toEqual({ ok: false, reason: 'old-format' });
  });

  it.each([
    ['not a zip', strToU8('Lemon Drizzle Squares, 1 cup butter')],
    ['an empty file', new Uint8Array(0)],
    ['a zip with no document in it', zipSync({ 'notes.txt': strToU8('hello') })],
    [
      'a document that is not XML',
      zipSync({ 'word/document.xml': strToU8('<w:document><w:body>') }),
    ],
    ['a truncated zip', docx(RECIPE_BODY).subarray(0, 200)],
  ])('calls %s malformed', (_, bytes) => {
    expect(draftFromDocx(bytes)).toEqual({ ok: false, reason: 'malformed' });
  });

  it('refuses a DTD, so no entity is ever declared, let alone resolved', () => {
    const xxe = `<?xml version="1.0"?><!DOCTYPE d [<!ENTITY x SYSTEM "file:///etc/passwd">]><w:document xmlns:w="${W}"><w:body>${p('&x;')}</w:body></w:document>`;
    const bytes = zipSync({ 'word/document.xml': strToU8(xxe) });
    expect(draftFromDocx(bytes)).toEqual({ ok: false, reason: 'malformed' });

    const laughs = `<!DOCTYPE d [<!ENTITY a "aaaaaaaaaa"><!ENTITY b "&a;&a;&a;&a;&a;&a;&a;&a;">]>`;
    const bomb = zipSync({ 'word/document.xml': strToU8(laughs + documentXml(p('&b;'))) });
    expect(draftFromDocx(bomb)).toEqual({ ok: false, reason: 'malformed' });
  });

  it('refuses a file over the upload cap without opening it', () => {
    expect(draftFromDocx(new Uint8Array(MAX_DOCX_BYTES + 1))).toEqual({
      ok: false,
      reason: 'too-large',
    });
  });

  it('stops a zip bomb early, in time and memory', () => {
    // 64MiB of one character compresses to about 64KiB, twice what the reader will inflate.
    const huge = new Uint8Array(2 * MAX_DOCX_INFLATED_BYTES).fill(0x20);
    const bytes = zipSync({ 'word/document.xml': huge }, { level: 9 });
    expect(bytes.byteLength).toBeLessThan(MAX_DOCX_BYTES);
    const started = performance.now();
    expect(draftFromDocx(bytes)).toEqual({ ok: false, reason: 'too-large' });
    // Generous for a busy machine: inflating all 64MiB and then refusing it would still pass a
    // time check, which is why the half-budget test below is the one that pins the early stop.
    expect(performance.now() - started).toBeLessThan(5000);
  });

  it('stops inflating at the budget rather than after the entry', () => {
    // Exactly the budget, then one byte more, in the one entry: the first is read, the second is
    // refused, so the count is taken as the bytes come out and not from the header's claim.
    const at = (n: number) =>
      zipSync({ 'word/document.xml': strToU8(documentXml(p('x')).padEnd(n, ' ')) }, { level: 9 });
    expect(textFromDocx(at(MAX_DOCX_INFLATED_BYTES))).toEqual({ text: 'x' });
    expect(textFromDocx(at(MAX_DOCX_INFLATED_BYTES + 1))).toEqual({ reason: 'too-large' });
  });

  it('counts the budget across parts, so many small bombs are one big one', () => {
    const third = new Uint8Array(Math.ceil(MAX_DOCX_INFLATED_BYTES / 3) + 1).fill(0x20);
    const bytes = zipSync(
      {
        '_rels/.rels': third,
        'word/document.xml': strToU8(documentXml(p('x'))),
        'word/_rels/document.xml.rels': third,
        'word/numbering.xml': third,
      },
      { level: 9 },
    );
    expect(draftFromDocx(bytes)).toEqual({ ok: false, reason: 'too-large' });
  });

  it('refuses a zip listing more entries than a document has', () => {
    const files: Record<string, Uint8Array> = { 'word/document.xml': strToU8(documentXml(p('x'))) };
    for (let i = 0; i < MAX_DOCX_ENTRIES; i++) files[`word/media/${i}.png`] = new Uint8Array(0);
    expect(draftFromDocx(zipSync(files, { level: 0 }))).toEqual({ ok: false, reason: 'too-large' });
  });

  it('refuses more text than an import reads, before reading all of it', () => {
    const paragraph = p('1 cup oats '.repeat(1000));
    const body = paragraph.repeat(Math.ceil(MAX_TEXT_LENGTH / 11_000) + 1);
    expect(draftFromDocx(docx(body))).toEqual({ ok: false, reason: 'too-much-content' });
    const row = `<w:tr><w:tc>${paragraph}</w:tc><w:tc>${paragraph}</w:tc></w:tr>`;
    const table = `<w:tbl>${row.repeat(Math.ceil(MAX_TEXT_LENGTH / 22_000) + 1)}</w:tbl>`;
    expect(draftFromDocx(docx(table))).toEqual({ ok: false, reason: 'too-much-content' });
  });

  it('gives up when its time is spent', () => {
    expect(draftFromDocx(docx(RECIPE_BODY), { timeLimitMs: 0 })).toEqual({
      ok: false,
      reason: 'timed-out',
    });
  });

  /** A zip with one entry whose central directory record is edited by `edit`. */
  function editedZip(edit: (view: DataView, central: number) => void): Uint8Array {
    const bytes = zipSync({ 'word/document.xml': strToU8(documentXml(p('x'))) });
    const view = new DataView(bytes.buffer);
    const end = bytes.length - 22;
    edit(view, view.getUint32(end + 16, true));
    return bytes;
  }

  it.each([
    ['encrypted', (v: DataView, c: number) => v.setUint16(c + 8, 1, true)],
    ['compressed some other way', (v: DataView, c: number) => v.setUint16(c + 10, 12, true)],
    ['pointing past the end', (v: DataView, c: number) => v.setUint32(c + 20, 0x7fffffff, true)],
  ])('calls an entry that is %s malformed', (_, edit) => {
    expect(draftFromDocx(editedZip(edit))).toEqual({ ok: false, reason: 'malformed' });
  });
});

describe('the zip around the document', () => {
  const PLAIN = documentXml(p('Plain'));

  it('reads an entry that was stored rather than compressed', () => {
    const bytes = zipSync({ 'word/document.xml': strToU8(PLAIN) }, { level: 0 });
    expect(textFromDocx(bytes)).toEqual({ text: 'Plain' });
  });

  it('finds the directory past a comment at the end of the zip', () => {
    const bytes = zipSync({ 'word/document.xml': strToU8(PLAIN) });
    const comment = strToU8('saved by a test');
    const withComment = new Uint8Array(bytes.length + comment.length);
    withComment.set(bytes);
    withComment.set(comment, bytes.length);
    new DataView(withComment.buffer).setUint16(bytes.length - 2, comment.length, true);
    expect(textFromDocx(withComment)).toEqual({ text: 'Plain' });
  });

  it('reads the first of two entries with one name', () => {
    const bytes = zipSync({
      'word/document.xml': strToU8(PLAIN),
      'word/documenX.xml': strToU8(documentXml(p('Smuggled'))),
    });
    // Rename the second entry to the first's name, in its local and central headers both.
    const from = strToU8('word/documenX.xml');
    for (let i = 0; i + from.length <= bytes.length; i++) {
      if (from.every((b, k) => bytes[i + k] === b)) bytes[i + 16] = 0x74; // 'X' -> 't'
    }
    expect(textFromDocx(bytes)).toEqual({ text: 'Plain' });
  });

  it.each([
    ['entry count', 10, 0xffff, 2],
    ['directory size', 12, 0xffffffff, 4],
    ['directory offset', 16, 0xffffffff, 4],
  ])('refuses a ZIP64 marker in the %s', (_, field, marker, width) => {
    const bytes = zipSync({ 'word/document.xml': strToU8(PLAIN) });
    const view = new DataView(bytes.buffer);
    const end = bytes.length - 22;
    if (width === 2) view.setUint16(end + field, marker, true);
    else view.setUint32(end + field, marker, true);
    expect(textFromDocx(bytes)).toEqual({ reason: 'malformed' });
  });
});

describe('lists that are not what Word writes', () => {
  /** numbering.xml with one decimal level at `ilvl`, as list 1. */
  const numbering = (ilvl: string, start = '1') =>
    `<w:numbering xmlns:w="${W}"><w:abstractNum w:abstractNumId="0"><w:lvl w:ilvl="${ilvl}"><w:start w:val="${start}"/><w:numFmt w:val="decimal"/></w:lvl></w:abstractNum><w:num w:numId="1"><w:abstractNumId w:val="0"/></w:num></w:numbering>`;
  const item = (ilvl: string) =>
    p('Stir', `<w:numPr><w:ilvl w:val="${ilvl}"/><w:numId w:val="1"/></w:numPr>`);

  it.each(['-5', '4294967295', '1.5', 'x'])(
    'reads a list level of %s as no level at all',
    (ilvl) => {
      expect(text(item(ilvl), { 'word/numbering.xml': numbering(ilvl) })).toBe('• Stir');
    },
  );

  it('numbers from 0 when a list says to', () => {
    expect(text(item('0'), { 'word/numbering.xml': numbering('0', '0') })).toBe('0. Stir');
  });

  it('resolves only the levels paragraphs use, so thousands of lists cost nothing', () => {
    // 8,000 levels in one abstract list and 8,000 lists over it. Expanded up front, 5,000 of each
    // (a 25KB upload) blocked the server for 1.9s and 10,000 ran it out of memory.
    const n = 8000;
    let xml = `<w:numbering xmlns:w="${W}"><w:abstractNum w:abstractNumId="0">`;
    for (let i = 0; i < n; i++) xml += `<w:lvl w:ilvl="${i}"><w:numFmt w:val="decimal"/></w:lvl>`;
    xml += '</w:abstractNum>';
    for (let i = 0; i < n; i++) xml += `<w:num w:numId="${i}"><w:abstractNumId w:val="0"/></w:num>`;
    xml += '</w:numbering>';
    const started = performance.now();
    expect(text(item('0'), { 'word/numbering.xml': xml })).toBe('1. Stir');
    expect(performance.now() - started).toBeLessThan(2000);
  });

  it('reads a tracked change to a paragraph as the paragraph is now, not as it was', () => {
    const wasNumbered = p(
      'Plain line',
      '<w:pPrChange w:id="1" w:author="A"><w:pPr><w:numPr><w:ilvl w:val="0"/><w:numId w:val="1"/></w:numPr></w:pPr></w:pPrChange>',
    );
    const nowNumbered = p(
      'Step one',
      '<w:numPr><w:ilvl w:val="0"/><w:numId w:val="1"/></w:numPr><w:pPrChange w:id="2" w:author="A"><w:pPr><w:pStyle w:val="Normal"/><w:numPr><w:numId w:val="0"/></w:numPr></w:pPr></w:pPrChange>',
    );
    expect(text(wasNumbered + nowNumbered)).toBe('Plain line\n1. Step one');

    const styles = `<w:styles xmlns:w="${W}"><w:style w:type="paragraph" w:styleId="Was"><w:pPr><w:pPrChange w:id="3"><w:pPr><w:numPr><w:numId w:val="1"/></w:numPr></w:pPr></w:pPrChange></w:pPr></w:style></w:styles>`;
    expect(text(p('Styled', '<w:pStyle w:val="Was"/>'), { 'word/styles.xml': styles })).toBe(
      'Styled',
    );
  });

  it('leaves an entity name that only an object prototype knows as it was written', () => {
    expect(text(p('a &toString; b &__proto__; c'))).toBe('a &toString; b &__proto__; c');
  });
});

describe('hostile documents finish in linear time', () => {
  /** A document part of `xml`, as raw as it comes, and how long reading it took. */
  function timed(xml: string) {
    const bytes = zipSync({ 'word/document.xml': strToU8(xml) }, { level: 1 });
    const started = performance.now();
    const result = draftFromDocx(bytes);
    return { result, ms: performance.now() - started };
  }

  const HUGE = 4_000_000;

  it.each([
    ['unclosed tags', '<'.repeat(HUGE), 'malformed'],
    ['an open quote in a tag', `<w:document a="${'x'.repeat(HUGE)}`, 'malformed'],
    [
      'ampersands with no semicolon',
      `<w:document><w:body><w:p><w:r><w:t>${'&'.repeat(HUGE)}</w:t></w:r></w:p></w:body></w:document>`,
      'too-much-content',
    ],
    [
      'ampersands far from a semicolon',
      `<w:document><w:body><w:p><w:r><w:t>${'&#1'.repeat(HUGE / 3)};</w:t></w:r></w:p></w:body></w:document>`,
      'too-much-content',
    ],
    // Closed again, so only the depth cap can refuse it.
    ['nesting past the depth cap', '<a>'.repeat(HUGE / 7) + '</a>'.repeat(HUGE / 7), 'malformed'],
    ['a long run of equals signs in a tag', `<w:document ${'='.repeat(HUGE)}>`, 'malformed'],
    ['many empty paragraphs', documentXml('<w:p/>'.repeat(HUGE / 6)), 'too-much-content'],
    [
      'a run of tabs',
      documentXml(`<w:p><w:r>${'<w:tab/>'.repeat(HUGE / 8)}</w:r></w:p>`),
      'too-much-content',
    ],
  ])('%s', (_, xml, reason) => {
    const { result, ms } = timed(xml);
    expect(result).toMatchObject({ ok: false, reason });
    // Generous for a busy machine; the quadratic entity search this caught took 58 seconds.
    expect(ms).toBeLessThan(5000);
  });
});
