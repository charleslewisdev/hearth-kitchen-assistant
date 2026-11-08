/**
 * A small XML scanner for the parts of a Word document, and nothing more general than that.
 *
 * Hand-written rather than a parser from npm because what a `.docx` needs is so little - element
 * names, a few attributes, and the text inside `w:t` - and what an XML parser brings with it is
 * the risk: DTDs, entity declarations and external entities. This one has none of them. A
 * `<!DOCTYPE` or any other `<!` declaration is refused outright (Word never writes one), only the
 * five predefined entities and numeric character references are decoded, and anything else that
 * looks like an entity is left as the text it is. There is no way for a document to make this
 * read a file, fetch a URL or expand a billion laughs.
 *
 * Every step moves forward through the string with `indexOf` or a single loop, so the cost is
 * linear in the input whatever it holds. Nesting is capped, and mismatched tags are an error
 * rather than something to repair: the input is a part a word processor wrote, and one that is
 * not well formed is a damaged or a hostile file.
 */

/** Deeper than any Word document nests (a table in a table in a text box is about 30). */
export const MAX_XML_DEPTH = 256;

/** Thrown for input that is not well-formed XML of the kind a word processor writes. */
export class XmlError extends Error {
  constructor(what: string) {
    super(`malformed XML: ${what}`);
    this.name = 'XmlError';
  }
}

export interface XmlHandler {
  /**
   * An element opened. `name` is its local name, the prefix dropped (`w:p` is `p`), and `attrs`
   * is the raw text between the name and the `>`, for `parseAttributes` when it is wanted.
   */
  open(name: string, attrs: string, selfClosing: boolean): void;
  /** An element closed, including a self-closing one, straight after its `open`. */
  close(name: string): void;
  /** Character data, entities already decoded. */
  text(value: string): void;
}

/** `w:val` is `val`. Namespaces are not resolved: a Word part uses each local name once. */
function localName(qualified: string): string {
  return qualified.slice(qualified.indexOf(':') + 1);
}

const NAMED: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" };

/** The longest entity worth looking for: `&#x10FFFF;` is ten characters. */
const LONGEST_ENTITY = 10;

/** One character reference as text, or null when it is not one this scanner decodes. */
function entity(body: string): string | null {
  if (body in NAMED) return NAMED[body]!;
  if (body.charCodeAt(0) !== 35 /* # */) return null;
  const hex = body[1] === 'x' || body[1] === 'X';
  const digits = body.slice(hex ? 2 : 1);
  if (digits === '') return null;
  let code = 0;
  for (const c of digits) {
    const d = hex ? parseInt(c, 16) : c >= '0' && c <= '9' ? c.charCodeAt(0) - 48 : NaN;
    if (Number.isNaN(d)) return null;
    code = code * (hex ? 16 : 10) + d;
  }
  // A NUL, a lone surrogate or a code point past Unicode is no character at all.
  if (code === 0 || code > 0x10ffff || (code >= 0xd800 && code <= 0xdfff)) return '�';
  return String.fromCodePoint(code);
}

/** Text with its character references decoded. Unknown ones are kept as they were written. */
export function decodeEntities(raw: string): string {
  let at = raw.indexOf('&');
  if (at === -1) return raw;
  let out = '';
  let from = 0;
  while (at !== -1) {
    // Looked for only as far as the longest entity: an unbounded search from every `&` is
    // quadratic on a run of them (measured: 58s for 4MB of `&` with no `;`).
    let end = -1;
    for (let k = at + 1; k < raw.length && k <= at + LONGEST_ENTITY; k++) {
      if (raw[k] === ';') {
        end = k;
        break;
      }
    }
    const decoded = end !== -1 ? entity(raw.slice(at + 1, end)) : null;
    if (decoded !== null) {
      out += raw.slice(from, at) + decoded;
      from = end + 1;
      at = raw.indexOf('&', from);
    } else {
      at = raw.indexOf('&', at + 1);
    }
  }
  return out + raw.slice(from);
}

/** An element's attributes by local name, values decoded. */
export function parseAttributes(raw: string): Map<string, string> {
  const attrs = new Map<string, string>();
  let i = 0;
  while (i < raw.length) {
    const eq = raw.indexOf('=', i);
    if (eq === -1) break;
    const name = raw.slice(i, eq).trim();
    let q = eq + 1;
    while (
      q < raw.length &&
      (raw[q] === ' ' || raw[q] === '\t' || raw[q] === '\n' || raw[q] === '\r')
    )
      q++;
    const quote = raw[q];
    if (quote !== '"' && quote !== "'") break;
    const close = raw.indexOf(quote, q + 1);
    if (close === -1) break;
    if (name !== '') attrs.set(localName(name), decodeEntities(raw.slice(q + 1, close)));
    i = close + 1;
  }
  return attrs;
}

/** The index of the `>` that ends the tag starting at `from`, skipping any inside quotes. */
function tagEnd(xml: string, from: number): number {
  let quote = '';
  for (let i = from; i < xml.length; i++) {
    const c = xml[i];
    if (quote !== '') {
      if (c === quote) quote = '';
    } else if (c === '"' || c === "'") {
      quote = c;
    } else if (c === '>') {
      return i;
    }
  }
  return -1;
}

function isNameEnd(c: string | undefined): boolean {
  return (
    c === undefined || c === ' ' || c === '\t' || c === '\n' || c === '\r' || c === '/' || c === '>'
  );
}

/**
 * Walk `xml`, calling `handler` for each element and run of text, in document order.
 *
 * `check` is called every so often with no arguments, so a caller can stop a long walk by
 * throwing from it (`from-docx.ts` uses it for its time limit).
 */
export function scanXml(xml: string, handler: XmlHandler, check: () => void = () => {}): void {
  const stack: string[] = [];
  let i = 0;
  let steps = 0;
  while (i < xml.length) {
    if ((++steps & 0xfff) === 0) check();
    const lt = xml.indexOf('<', i);
    if (lt === -1) {
      if (stack.length > 0) handler.text(decodeEntities(xml.slice(i)));
      break;
    }
    if (lt > i && stack.length > 0) handler.text(decodeEntities(xml.slice(i, lt)));

    const next = xml[lt + 1];
    if (next === '?') {
      const end = xml.indexOf('?>', lt + 2);
      if (end === -1) throw new XmlError('unterminated processing instruction');
      i = end + 2;
    } else if (xml.startsWith('<!--', lt)) {
      const end = xml.indexOf('-->', lt + 4);
      if (end === -1) throw new XmlError('unterminated comment');
      i = end + 3;
    } else if (xml.startsWith('<![CDATA[', lt)) {
      const end = xml.indexOf(']]>', lt + 9);
      if (end === -1) throw new XmlError('unterminated CDATA');
      if (stack.length > 0) handler.text(xml.slice(lt + 9, end));
      i = end + 3;
    } else if (next === '!') {
      // A DOCTYPE, and with it every entity declaration. Never read, never expanded.
      throw new XmlError('declarations are not accepted');
    } else if (next === '/') {
      const end = xml.indexOf('>', lt + 2);
      if (end === -1) throw new XmlError('unterminated end tag');
      const name = localName(xml.slice(lt + 2, end).trim());
      if (stack.pop() !== name) throw new XmlError('mismatched end tag');
      handler.close(name);
      i = end + 1;
    } else {
      const end = tagEnd(xml, lt + 1);
      if (end === -1) throw new XmlError('unterminated start tag');
      let nameEnd = lt + 1;
      while (!isNameEnd(xml[nameEnd])) nameEnd++;
      if (nameEnd === lt + 1) throw new XmlError('element with no name');
      const name = localName(xml.slice(lt + 1, nameEnd));
      const selfClosing = xml[end - 1] === '/';
      const attrs = xml.slice(nameEnd, selfClosing ? end - 1 : end);
      handler.open(name, attrs, selfClosing);
      if (selfClosing) {
        handler.close(name);
      } else {
        if (stack.length >= MAX_XML_DEPTH) throw new XmlError('nested too deeply');
        stack.push(name);
      }
      i = end + 1;
    }
  }
  if (stack.length > 0) throw new XmlError('unclosed element');
}
