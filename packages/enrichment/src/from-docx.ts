import { MAX_DOCX_BYTES, MAX_TEXT_LENGTH } from '@hearth/shared';
import { draftFromText } from './from-text';
import { parseAttributes, scanXml, XmlError } from './xml-scan';
import { ZipError, ZipReader } from './zip-read';
import type { RecipeDraft } from './draft';

/**
 * Reading a recipe out of a Word document (`.docx`).
 *
 * Like the PDF source, a decoder in front of `from-text.ts`: the document becomes lines and the
 * heuristics do the rest. The lines are what a cook would get by selecting the whole document
 * in Word and pasting it into the Text tile, which was the advice before this existed: one line
 * per paragraph, an empty paragraph as a blank line, a heading as its own line, a numbered list
 * item with its number in front ("3. Bake.") and a bulleted one with a bullet, which `from-text`
 * already reads as a list marker. A table gives one line per row, its cells joined by a space,
 * so a table of amounts and ingredients reads as ingredient lines; a row whose cells hold
 * several paragraphs each is a layout table, the recipe set out in columns, and is read a cell
 * at a time instead, the way a two-column PDF is read a column at a time.
 *
 * A `.docx` is a zip of XML parts. Only three are read: `word/document.xml` (or wherever the
 * package's relationships put the main part), `numbering.xml` for what kind of list each list
 * is, and `styles.xml` for the lists a paragraph style numbers (Word's "List Number"). See
 * `zip-read.ts` for the bounds on the zip and `xml-scan.ts` for the XML, which refuses DTDs and
 * resolves no entities. Everything here is synchronous, and bounded by the byte caps and by
 * `DOCX_TIME_LIMIT_MS` rather than by a queue: a queue orders work that waits, and none of this
 * ever waits, so two imports cannot overlap whatever is put in front of them.
 *
 * The old binary `.doc` is not read. It is a different format entirely (OLE2), and so is a
 * password-protected `.docx`; both are recognised by their first bytes so the cook can be told
 * what to do instead.
 *
 * D38: nothing here logs, and no thrown message carries the document's text.
 */

/** The most entries a document's zip may list: the fixture has 17, plus one per picture. */
export const MAX_DOCX_ENTRIES = 1000;

/**
 * The most the parts read may inflate to, together.
 *
 * `MAX_TEXT_LENGTH` is 100,000 characters. The python-docx fixture carries 8 bytes of markup per
 * character of text, and a file with a revision id and formatting on every short run can carry
 * ten times that, so 32MiB is room for the longest readable document while a bomb stops long before it
 * costs anything.
 */
export const MAX_DOCX_INFLATED_BYTES = 32 * 1024 * 1024;

/**
 * How long reading one document may take before it is given up.
 *
 * Measured: inflating and walking a 31.5MiB `document.xml` of formatted runs takes 200 to 270ms
 * on this machine, so the limit is a backstop for a much slower box, not an expected outcome.
 */
export const DOCX_TIME_LIMIT_MS = 3000;

/** Why a Word document did not become a draft. */
export type DocxFailureReason =
  | 'too-large'
  | 'old-format'
  | 'malformed'
  | 'too-much-content'
  | 'timed-out'
  | 'no-recipe';

export type DocxResult =
  | { ok: true; draft: RecipeDraft; text: string }
  /** `text` is what was read, set on `no-recipe`; it may be empty. */
  | { ok: false; reason: DocxFailureReason; text?: string };

export interface DocxOptions {
  /** Overrides `DOCX_TIME_LIMIT_MS`; a test sets it to 0 to see the limit work. */
  timeLimitMs?: number;
}

/** The first bytes of an OLE2 compound file: a Word 97-2003 `.doc`, or an encrypted `.docx`. */
const OLE2 = [0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1];

class TimedOut extends Error {
  constructor() {
    super('docx read timed out');
    this.name = 'TimedOut';
  }
}

class TooMuchContent extends Error {
  constructor() {
    super('docx text over the cap');
    this.name = 'TooMuchContent';
  }
}

const OFFICE_DOCUMENT = '/officeDocument';
const NUMBERING = '/numbering';
const STYLES = '/styles';

/** Bytes as text: UTF-8, or UTF-16 when a byte order mark says so (allowed, never seen). */
function decodePart(bytes: Uint8Array): string {
  if (bytes[0] === 0xff && bytes[1] === 0xfe) return new TextDecoder('utf-16le').decode(bytes);
  if (bytes[0] === 0xfe && bytes[1] === 0xff) return new TextDecoder('utf-16be').decode(bytes);
  return new TextDecoder('utf-8').decode(bytes);
}

/** A relationship target as a zip entry name, resolved against the part that names it. */
function resolveTarget(base: string, target: string): string {
  const parts = target.startsWith('/') ? [] : base.split('/').slice(0, -1);
  for (const segment of target.split('/')) {
    if (segment === '' || segment === '.') continue;
    if (segment === '..') parts.pop();
    else parts.push(segment);
  }
  return parts.join('/');
}

/** The relationships file for a part: `word/document.xml` has `word/_rels/document.xml.rels`. */
function relsFor(part: string): string {
  const slash = part.lastIndexOf('/');
  return `${part.slice(0, slash + 1)}_rels/${part.slice(slash + 1)}.rels`;
}

/** The targets of a relationships part by the type each ends with. */
function readRelationships(xml: string, base: string, check: () => void): Map<string, string> {
  const targets = new Map<string, string>();
  scanXml(
    xml,
    {
      open(name, raw) {
        if (name !== 'Relationship') return;
        const attrs = parseAttributes(raw);
        const type = attrs.get('Type') ?? '';
        const target = attrs.get('Target');
        if (target === undefined || attrs.get('TargetMode') === 'External') return;
        const kind = type.slice(type.lastIndexOf('/'));
        if (!targets.has(kind)) targets.set(kind, resolveTarget(base, target));
      },
      close() {},
      text() {},
    },
    check,
  );
  return targets;
}

/** One list level: how its items are marked and the number it starts at. */
interface Level {
  format: string;
  start: number;
}

/** Word's list levels are 0 to 8. */
const MAX_LIST_LEVEL = 8;

/**
 * A list level from an attribute, or null when it is not one Word could have written.
 *
 * Checked because it indexes the counters in `readBody`: a level of -5 or 4294967295 there threw
 * a RangeError, which escaped as a 500 rather than an answer.
 */
function listLevel(value: string | undefined): number | null {
  const n = Number(value ?? 0);
  return Number.isInteger(n) && n >= 0 && n <= MAX_LIST_LEVEL ? n : null;
}

/** A list's starting number from an attribute; 0 is a start Word allows. */
function startNumber(value: string | undefined): number | null {
  const n = Number(value);
  return Number.isSafeInteger(n) && n >= 0 ? n : null;
}

/** Looks up how a list numbers a level: `levelOf(numId, ilvl)`. */
type Lists = (numId: string, ilvl: number) => Level | undefined;

/**
 * The lists in `numbering.xml`, looked up rather than expanded.
 *
 * Each `w:num` points at an `w:abstractNum` and may override where a level starts. Expanding
 * every num into every level of its abstract up front is the product of the two: 5,000 of each,
 * a 25KB upload, blocked the server for 1.9s, and 10,000 ran it out of memory. So a level is
 * resolved only when a paragraph asks for it.
 */
function readNumbering(xml: string, check: () => void): Lists {
  const abstract = new Map<string, Map<number, Level>>();
  const nums = new Map<string, { abstractId: string; starts: Map<number, number> }>();

  let abstractId: string | null = null;
  let level: { ilvl: number; format: string; start: number } | null = null;
  let num: { id: string; abstractId: string; starts: Map<number, number> } | null = null;
  let overrideLevel: number | null = null;

  scanXml(
    xml,
    {
      open(name, raw) {
        if (name === 'abstractNum') {
          abstractId = parseAttributes(raw).get('abstractNumId') ?? null;
          if (abstractId !== null) abstract.set(abstractId, new Map());
        } else if (name === 'lvl' && abstractId !== null && num === null) {
          const ilvl = listLevel(parseAttributes(raw).get('ilvl'));
          level = ilvl === null ? null : { ilvl, format: 'decimal', start: 1 };
        } else if (name === 'numFmt' && level) {
          level.format = parseAttributes(raw).get('val') ?? 'decimal';
        } else if (name === 'start' && level) {
          level.start = startNumber(parseAttributes(raw).get('val')) ?? 1;
        } else if (name === 'num') {
          num = { id: parseAttributes(raw).get('numId') ?? '', abstractId: '', starts: new Map() };
        } else if (name === 'abstractNumId' && num) {
          num.abstractId = parseAttributes(raw).get('val') ?? '';
        } else if (name === 'lvlOverride' && num) {
          overrideLevel = listLevel(parseAttributes(raw).get('ilvl'));
        } else if (name === 'startOverride' && num && overrideLevel !== null) {
          const start = startNumber(parseAttributes(raw).get('val'));
          if (start !== null) num.starts.set(overrideLevel, start);
        }
      },
      close(name) {
        if (name === 'lvl' && level && abstractId !== null) {
          abstract.get(abstractId)!.set(level.ilvl, { format: level.format, start: level.start });
          level = null;
        } else if (name === 'abstractNum') {
          abstractId = null;
        } else if (name === 'lvlOverride') {
          overrideLevel = null;
        } else if (name === 'num' && num) {
          nums.set(num.id, { abstractId: num.abstractId, starts: num.starts });
          num = null;
        }
      },
      text() {},
    },
    check,
  );

  return (numId, ilvl) => {
    const found = nums.get(numId);
    const lvl = found && abstract.get(found.abstractId)?.get(ilvl);
    return lvl ? { format: lvl.format, start: found.starts.get(ilvl) ?? lvl.start } : undefined;
  };
}

/** A paragraph style's list, followed through `w:basedOn`. */
interface StyleList {
  numId: string | null;
  ilvl: number | null;
  basedOn: string | null;
}

/** How far `w:basedOn` is followed. Word's own chains are two or three long. */
const MAX_STYLE_CHAIN = 16;

/** The list each paragraph style numbers its paragraphs with, if any, by style id. */
function readStyleLists(
  xml: string,
  check: () => void,
): Map<string, { numId: string; ilvl: number }> {
  const styles = new Map<string, StyleList>();
  let current: StyleList | null = null;
  let id = '';
  let inParagraphProperties = false;
  /** Inside a tracked change's record of the old properties, which are not the style's now. */
  let inChange = 0;

  scanXml(
    xml,
    {
      open(name, raw) {
        if (name === 'style') {
          const attrs = parseAttributes(raw);
          id = attrs.get('styleId') ?? '';
          current =
            attrs.get('type') === 'paragraph' ? { numId: null, ilvl: null, basedOn: null } : null;
        } else if (!current) {
          return;
        } else if (name === 'pPrChange' || name === 'rPrChange' || inChange > 0) {
          inChange++;
        } else if (name === 'basedOn') {
          current.basedOn = parseAttributes(raw).get('val') ?? null;
        } else if (name === 'pPr') {
          inParagraphProperties = true;
        } else if (name === 'numId' && inParagraphProperties) {
          current.numId = parseAttributes(raw).get('val') ?? null;
        } else if (name === 'ilvl' && inParagraphProperties) {
          current.ilvl = listLevel(parseAttributes(raw).get('val'));
        }
      },
      close(name) {
        if (inChange > 0) {
          inChange--;
          return;
        }
        if (name === 'pPr') inParagraphProperties = false;
        if (name === 'style') {
          if (current) styles.set(id, current);
          current = null;
        }
      },
      text() {},
    },
    check,
  );

  const lists = new Map<string, { numId: string; ilvl: number }>();
  for (const styleId of styles.keys()) {
    let style = styles.get(styleId);
    let numId: string | null = null;
    let ilvl: number | null = null;
    for (let hops = 0; style && hops < MAX_STYLE_CHAIN; hops++) {
      numId ??= style.numId;
      ilvl ??= style.ilvl;
      style = style.basedOn === null ? undefined : styles.get(style.basedOn);
    }
    if (numId !== null && numId !== '0') lists.set(styleId, { numId, ilvl: ilvl ?? 0 });
  }
  return lists;
}

/** The marker a list item is written with: its number for a numbered list, else a bullet. */
const NUMBERED_FORMATS = new Set([
  'decimal',
  'decimalZero',
  'decimalEnclosedParen',
  'decimalEnclosedFullstop',
]);

/** A table cell being read: its lines, one per paragraph or nested row. */
type Cell = string[];

/** A table being read: the cells of the row in progress. */
interface Table {
  row: Cell[];
}

/** One paragraph being read. */
interface Paragraph {
  text: string;
  styleId: string | null;
  numId: string | null;
  ilvl: number | null;
}

/**
 * The document's text, as the lines described at the top of this file.
 *
 * A walk over `document.xml` with a stack of the tables it is inside, so a paragraph's line goes
 * to the innermost cell, and a finished row goes to the cell around it or to the document.
 */
function readBody(
  xml: string,
  levelOf: Lists,
  styleLists: Map<string, { numId: string; ilvl: number }>,
  check: () => void,
): string {
  const lines: string[] = [];
  let length = 0;
  const tables: Table[] = [];
  const paragraphs: Paragraph[] = [];
  /** Counters per list, per level. */
  const counters = new Map<string, number[]>();
  /** The open elements, as local names, for deciding what a `t` or a `tab` belongs to. */
  const open: string[] = [];
  /** How many open elements say to skip what is inside them. */
  let skipping = 0;

  /** Characters waiting in table cells for their row to end, counted against the cap too. */
  let held = 0;
  const emit = (line: string) => {
    const cell = tables.at(-1)?.row.at(-1);
    if (cell) {
      cell.push(line);
      held += line.length + 1;
    } else {
      lines.push(line);
      length += line.length + 1;
    }
    if (length + held > MAX_TEXT_LENGTH) throw new TooMuchContent();
  };

  const marker = (p: Paragraph): string => {
    const fromStyle = p.styleId === null ? undefined : styleLists.get(p.styleId);
    const numId = p.numId ?? fromStyle?.numId ?? null;
    if (numId === null || numId === '0') return '';
    const ilvl = p.ilvl ?? fromStyle?.ilvl ?? 0;
    const level = levelOf(numId, ilvl);
    if (level?.format === 'none') return '';
    if (!level || !NUMBERED_FORMATS.has(level.format)) return '• ';

    let counts = counters.get(numId);
    if (!counts) counters.set(numId, (counts = []));
    counts[ilvl] = counts[ilvl] === undefined ? level.start : counts[ilvl]! + 1;
    // A deeper level starts again under each new item above it.
    counts.length = ilvl + 1;
    return `${counts[ilvl]}. `;
  };

  /**
   * Elements whose content is not the document as it stands: deletions, field codes, the duplicate
   * fallback of a text box, and a tracked change's record of the old paragraph properties, whose
   * `numPr` and `pStyle` would otherwise overwrite the current ones.
   */
  const SKIPPED = new Set([
    'del',
    'moveFrom',
    'Fallback',
    'instrText',
    'delText',
    'rPr',
    'sectPr',
    'pPrChange',
  ]);

  scanXml(
    xml,
    {
      open(name, raw) {
        // `close` follows every `open`, a self-closing one's straight away, so both are pushed.
        const parent = open.at(-1);
        open.push(name);
        if (skipping > 0 || SKIPPED.has(name)) {
          skipping++;
          return;
        }
        const p = paragraphs.at(-1);
        if (name === 'p') {
          paragraphs.push({ text: '', styleId: null, numId: null, ilvl: null });
        } else if (name === 'tbl') {
          tables.push({ row: [] });
        } else if (name === 'tc') {
          tables.at(-1)?.row.push([]);
        } else if (!p) {
          return;
        } else if (name === 'pStyle' && parent === 'pPr') {
          p.styleId = parseAttributes(raw).get('val') ?? null;
        } else if (name === 'numId' && parent === 'numPr') {
          p.numId = parseAttributes(raw).get('val') ?? null;
        } else if (name === 'ilvl' && parent === 'numPr') {
          p.ilvl = listLevel(parseAttributes(raw).get('val')) ?? 0;
        } else if (parent === 'r') {
          if (name === 'tab') p.text += '\t';
          else if (name === 'br' || name === 'cr') p.text += '\n';
          else if (name === 'noBreakHyphen') p.text += '-';
        }
        if (p && p.text.length > MAX_TEXT_LENGTH) throw new TooMuchContent();
      },
      close(name) {
        open.pop();
        if (skipping > 0) {
          skipping--;
          return;
        }
        if (name === 'p') {
          const p = paragraphs.pop()!;
          const prefix = marker(p);
          const [first = '', ...rest] = p.text.split('\n');
          emit(prefix + first.trim());
          for (const line of rest) emit(line.trim());
        } else if (name === 'tr') {
          // Off the stack while its row is written, so the row goes to the cell around the table,
          // or to the document, rather than back into the row it came from.
          const table = tables.pop();
          if (!table) return;
          const row = table.row;
          table.row = [];
          for (const cell of row) for (const line of cell) held -= line.length + 1;
          const cells = row.map((cell) => cell.filter((line) => line !== ''));
          if (cells.every((cell) => cell.length <= 1)) {
            emit(cells.flat().join(' '));
          } else {
            for (const cell of cells) for (const line of cell) emit(line);
          }
          tables.push(table);
        } else if (name === 'tbl') {
          tables.pop();
        }
      },
      text(value) {
        if (skipping > 0 || open.at(-1) !== 't') return;
        const p = paragraphs.at(-1);
        if (!p) return;
        p.text += value;
        if (p.text.length > MAX_TEXT_LENGTH) throw new TooMuchContent();
      },
    },
    check,
  );

  // Blank lines kept singly, and none at the ends, as a paste of the same document would have.
  const tidy: string[] = [];
  for (const line of lines) {
    if (line === '' && (tidy.length === 0 || tidy.at(-1) === '')) continue;
    tidy.push(line);
  }
  while (tidy.at(-1) === '') tidy.pop();
  return tidy.join('\n');
}

/** The document's text, or the reason it has none. Throws only on a bug. */
export function textFromDocx(
  bytes: Uint8Array,
  options: DocxOptions = {},
): { text: string } | { reason: Exclude<DocxFailureReason, 'no-recipe'> } {
  if (bytes.byteLength > MAX_DOCX_BYTES) return { reason: 'too-large' };
  if (OLE2.every((b, i) => bytes[i] === b)) return { reason: 'old-format' };

  const deadline = Date.now() + (options.timeLimitMs ?? DOCX_TIME_LIMIT_MS);
  const check = () => {
    if (Date.now() >= deadline) throw new TimedOut();
  };

  try {
    check();
    const zip = new ZipReader(bytes, {
      maxEntries: MAX_DOCX_ENTRIES,
      maxInflatedBytes: MAX_DOCX_INFLATED_BYTES,
    });
    const readPart = (name: string): string | null => {
      const part = zip.read(name, check);
      return part === null ? null : decodePart(part);
    };

    const packageRels = readPart('_rels/.rels');
    const main =
      (packageRels === null
        ? undefined
        : readRelationships(packageRels, '', check).get(OFFICE_DOCUMENT)) ?? 'word/document.xml';
    const document = readPart(main);
    if (document === null) return { reason: 'malformed' };

    const documentRels = readPart(relsFor(main));
    const related =
      documentRels === null
        ? new Map<string, string>()
        : readRelationships(documentRels, main, check);
    const numberingXml = readPart(related.get(NUMBERING) ?? resolveTarget(main, 'numbering.xml'));
    const stylesXml = readPart(related.get(STYLES) ?? resolveTarget(main, 'styles.xml'));

    const levelOf: Lists =
      numberingXml === null ? () => undefined : readNumbering(numberingXml, check);
    const styleLists = stylesXml === null ? new Map() : readStyleLists(stylesXml, check);
    return { text: readBody(document, levelOf, styleLists, check) };
  } catch (error) {
    if (error instanceof TimedOut) return { reason: 'timed-out' };
    if (error instanceof TooMuchContent) return { reason: 'too-much-content' };
    if (error instanceof ZipError) {
      return {
        reason:
          error.reason === 'too-large' || error.reason === 'too-many-entries'
            ? 'too-large'
            : 'malformed',
      };
    }
    if (error instanceof XmlError) return { reason: 'malformed' };
    throw error;
  }
}

/** A draft from a Word document, or the reason there is not one. */
export function draftFromDocx(bytes: Uint8Array, options: DocxOptions = {}): DocxResult {
  const read = textFromDocx(bytes, options);
  if ('reason' in read) return { ok: false, reason: read.reason };
  const draft = draftFromText(read.text, { kind: 'docx' });
  return draft
    ? { ok: true, draft, text: read.text }
    : { ok: false, reason: 'no-recipe', text: read.text };
}
