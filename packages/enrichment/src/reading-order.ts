/**
 * Putting what OCR found on a page back into the order a cook reads it.
 *
 * tesseract's own text is in the order its layout analysis emitted blocks, and on a
 * photographed cookbook page that is not reading order. On the owner's pilot photos it emitted
 * most of an ingredient column before the title, and on another page it built "lines" that ran
 * straight across the gutter ("½ cup almonds 2. Begin puréeing the ingredients"), which put
 * the method inside the ingredient list.
 *
 * What this module gets instead is geometry: every line tesseract found, each word with a box.
 * From that it:
 *
 *  1. turns a page photographed sideways back upright, and levels a skewed one, in coordinates
 *     only (tesseract reads vertical and sloping lines on its own; only the order comes out
 *     wrong);
 *  2. cuts each line at any gap between words wider than type leaves inside a line, which
 *     un-joins a line tesseract ran across a gutter, and drops the pieces that are noise;
 *  3. orders the pieces by recursive XY-cut: a region with a clear vertical gutter is read a
 *     column at a time, one without is read in horizontal bands top to bottom. A title or an
 *     introduction set across two columns stops the gutter reaching the top of the region, so
 *     before giving up the cut looks for columns under or over whatever crosses the gutter
 *     (`framedColumns`);
 *  4. moves the largest confident type near the top to the front, because that is the title;
 *  5. writes one piece per line, with a blank line where the space above a line is wider than
 *     the page leaves inside a paragraph, which is what separates one ingredient from the next
 *     in a cookbook's narrow column.
 *
 * Pure, and tested on synthetic boxes (`reading-order.test.ts`): no image, no tesseract. The
 * PDF source solves the same problem another way (`from-pdf.ts`, one gutter per page from a
 * strip histogram) because a PDF's text layer is square to the page; a phone photo is skewed,
 * curved and noisy, so a gutter here is a gap between boxes rather than a straight strip.
 *
 * Every loop is bounded by the number of pieces, and that is capped (`MAX_PIECES`): a page with
 * more is handed back as null, and the caller uses tesseract's own text.
 */

export interface Box {
  x0: number;
  y0: number;
  x1: number;
  y1: number;
}

export interface OcrWord {
  text: string;
  /** 0-100, as tesseract reports it. */
  confidence: number;
  bbox: Box;
}

/** One line as tesseract found it: its words, in tesseract's order. */
export interface OcrLine {
  words: OcrWord[];
}

/** A piece of a line: its words up to a gap wider than `WORD_GAP_FACTOR` allows. */
interface Piece {
  text: string;
  box: Box;
  /** The type size: the median height of its words, which a skewed line's box overstates. */
  size: number;
  /** tesseract's confidence in its words, 0-100, weighted by their length. */
  confidence: number;
}

/**
 * More pieces than this and the page is left in tesseract's order.
 *
 * The pilot photos came to 32-99 pieces each, so this is several times the densest
 * real page. It bounds `framedColumns`, which scans a region once per candidate gutter.
 */
const MAX_PIECES = 600;

/** How deep the XY-cut may recurse before a region is read row by row. */
const MAX_DEPTH = 40;

/**
 * A gap between two words wider than this many type sizes cuts the line.
 *
 * Word spacing in print is about a third of the type size, and a loose justified line in a
 * narrow column stretches it; a gutter between columns is an em or more.
 */
const WORD_GAP_FACTOR = 1.2;

/** A gutter narrower than this many type sizes is not a gutter. */
const MIN_GUTTER_FACTOR = 0.5;

/**
 * Space above a line this many type sizes more than the page's usual leading
 * (`usualLeading`) starts a new paragraph in the text: a blank line. A cookbook's ingredient
 * column puts about this much more between one ingredient and the next than between the two
 * lines of one.
 */
const PARAGRAPH_GAP_FACTOR = 0.5;

/** Which quantile of a page's line gaps is its usual leading (`usualLeading`). */
const LEADING_QUANTILE = 0.25;

/** How many worded pieces each side of a clean gutter needs, across more than one row. */
const MIN_COLUMN_PIECES = 2;

/**
 * And each side of a gutter found only under or over something set across it
 * (`framedColumns`), which is a search, and a search finds a "gutter" in a stack of short lines
 * more easily than a page has one.
 */
const MIN_FRAMED_COLUMN_PIECES = 3;

/**
 * A column's pieces start within this many type sizes of its usual left edge - allowing for
 * an indented wrap and for the drift of a skewed or curved page - and at least this share of
 * them do (`aligned`).
 */
const ALIGN_FACTOR = 2;
const ALIGNED_SHARE = 0.6;

/** Into how many stretches `framedColumns` cuts a region to look for its gutter. */
const GUTTER_WINDOWS = 6;

/** The most candidate gutters `framedColumns` tries in one region. */
const MAX_GUTTERS = 36;

/**
 * A piece needs one word tesseract is at least this sure of, and at least `MIN_PIECE_CONFIDENCE`
 * across all of them, or it is noise: a thumb, a shadow, the grain of a worktop, a script face
 * read as nonsense. Those are what bridge a gutter or take the title's place. A doubtful word
 * BESIDE sure ones stays: "2 limes," read at 30 is still the start of "2 limes, juiced".
 */
const MIN_WORD_CONFIDENCE = 40;
const MIN_PIECE_CONFIDENCE = 50;

/** Type this many times the page's median size or more is a candidate title. */
const TITLE_SIZE_FACTOR = 1.5;

/** The other lines of a title are within this share of its size, either way. */
const TITLE_LINE_LIKE = 0.7;

/** And no more than this many of its type sizes below or above the line next to them. */
const TITLE_LINE_GAP = 1;

/** A title is looked for in this top share of the page's text. */
const TITLE_REGION = 0.4;

/**
 * A title promoted on size alone has to be read well. A script face is set larger than
 * anything else on its page and tesseract makes nonsense of it ("What Sabsiceia e Word" for
 * "Pasta Salsiccia e Porri"); left where it is, the plain subtitle under it is taken instead.
 */
const MIN_TITLE_CONFIDENCE = 70;

/**
 * A title promoted on size has this many letters. A fragment cut off a letterhead ("net", the
 * end of an email address) can be set as large as the name and must not replace it.
 */
const MIN_TITLE_LETTERS = 5;

/** A word of three letters: what a title has, and what a column of quantities does not. */
const HAS_WORD = /\p{L}{3}/u;

/** The steepest skew levelled, about 11 degrees; past it the slope measured is not a skew. */
const MAX_SLOPE = 0.2;

/** How far apart, in type sizes, the middles of two pieces in one row may be. */
const ROW_TOLERANCE = 0.8;

/** A step number or a quantity on its own: "1.", "2", "1/4". Anchored and bounded: linear. */
const LIST_MARKER = /^[\d½¼¾⅓⅔⅛/.)]{1,6}$/u;

const LETTER = /\p{L}/u;

/** A word with a letter or a digit in it, which a bullet or a stray `|` has not. */
const HAS_ALNUM = /[\p{L}\p{N}]/u;

function median(values: number[]): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.floor(sorted.length / 2)]!;
}

/**
 * The lower of the two middles for an even count. A piece's type size, from its words: of two
 * words, tesseract sometimes boxes one far too tall ("for the" measured half as big again as
 * the line it sat in), and the upper middle of two is that one.
 */
function lowerMedian(values: number[]): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.floor((sorted.length - 1) / 2)]!;
}

/** How many letters a text has. A loop rather than a global regex, so it is plainly linear. */
function letters(text: string): number {
  let count = 0;
  for (const char of text) if (LETTER.test(char)) count += 1;
  return count;
}

function centre(piece: Piece): number {
  return (piece.box.y0 + piece.box.y1) / 2;
}

function union(boxes: Box[]): Box {
  let { x0, y0, x1, y1 } = boxes[0]!;
  for (const box of boxes) {
    x0 = Math.min(x0, box.x0);
    y0 = Math.min(y0, box.y0);
    x1 = Math.max(x1, box.x1);
    y1 = Math.max(y1, box.y1);
  }
  return { x0, y0, x1, y1 };
}

/** How a sideways page is turned back upright. */
type Turn = 'none' | 'clockwise' | 'counter-clockwise';

/**
 * Whether the page was photographed on its side, and which way.
 *
 * On a sideways page a line's words run down or up rather than across. tesseract gives them in
 * reading order, so when the last word of a line sits below its first, the text reads
 * downwards: a page turned a quarter clockwise.
 */
function pageTurn(lines: OcrLine[]): Turn {
  let across = 0;
  let down = 0;
  let up = 0;
  for (const line of lines) {
    if (line.words.length < 3) continue;
    const first = line.words[0]!.bbox;
    const last = line.words[line.words.length - 1]!.bbox;
    const dy = last.y0 - first.y0;
    if (Math.abs(last.x0 - first.x0) >= Math.abs(dy)) across += 1;
    else if (dy > 0) down += 1;
    else up += 1;
  }
  if (across >= down + up) return 'none';
  return down >= up ? 'clockwise' : 'counter-clockwise';
}

/** A box in the upright page's coordinates. */
function turned(box: Box, turn: Turn): Box {
  // Reading down a page turned clockwise, "across" is +y and "down the page" is -x.
  if (turn === 'clockwise') return { x0: box.y0, y0: -box.x1, x1: box.y1, y1: -box.x0 };
  if (turn === 'counter-clockwise') return { x0: -box.y1, y0: box.x0, x1: -box.y0, y1: box.x1 };
  return box;
}

/**
 * How far the page's lines drop for each unit across: the skew of the photo, as the median
 * over its lines of the slope from each line's first word to its last.
 *
 * A phone never holds a page square, and on the pilot photos lines dropped by up to about a
 * line's height across the page. Unlevelled, the end of one printed line sits at the height of
 * the start of the next, and a line cut in two by a wide space was read with its halves in
 * different rows.
 */
function pageSlope(lines: OcrLine[]): number {
  const slopes: number[] = [];
  for (const line of lines) {
    if (line.words.length < 3) continue;
    const first = line.words[0]!.bbox;
    const last = line.words[line.words.length - 1]!.bbox;
    const dx = (last.x0 + last.x1 - first.x0 - first.x1) / 2;
    if (dx <= 0) continue;
    slopes.push((last.y0 + last.y1 - first.y0 - first.y1) / 2 / dx);
  }
  return Math.max(-MAX_SLOPE, Math.min(MAX_SLOPE, median(slopes)));
}

/** A box with the page's skew taken out: each point raised by the drop at its x. */
function levelled(box: Box, slope: number): Box {
  const drop = (slope * (box.x0 + box.x1)) / 2;
  return { x0: box.x0, y0: box.y0 - drop, x1: box.x1, y1: box.y1 - drop };
}

interface Word {
  text: string;
  box: Box;
  confidence: number;
  /** Has a letter or digit. Punctuation alone - a bullet, a dash - is carried but not measured. */
  solid: boolean;
}

/** A group of words as a piece, or null when it is noise (`MIN_PIECE_CONFIDENCE`). */
function toPiece(group: Word[]): Piece | null {
  const solid = group.filter((word) => word.solid);
  const letters = solid.reduce((sum, word) => sum + word.text.length, 0);
  if (letters === 0) return null;
  const confidence =
    solid.reduce((sum, word) => sum + word.confidence * word.text.length, 0) / letters;
  if (confidence < MIN_PIECE_CONFIDENCE) return null;
  if (!solid.some((word) => word.confidence >= MIN_WORD_CONFIDENCE)) return null;
  return {
    text: group.map((word) => word.text).join(' '),
    box: union(solid.map((word) => word.box)),
    size: lowerMedian(solid.map((word) => word.box.y1 - word.box.y0)),
    confidence,
  };
}

/** A line's words, cut at every gap too wide to be inside a line, noise dropped. */
function toPieces(line: OcrLine): Piece[] {
  const words: Word[] = line.words
    .map((word) => ({
      text: word.text.trim(),
      box: word.bbox,
      confidence: word.confidence,
      solid: HAS_ALNUM.test(word.text),
    }))
    .filter((word) => word.text !== '');
  const solid = words.filter((word) => word.solid);
  if (solid.length === 0) return [];
  const size = median(solid.map((word) => word.box.y1 - word.box.y0));

  const pieces: Piece[] = [];
  let group: Word[] = [];
  let punctuation: Word[] = [];
  // How much of the gap since the last solid word punctuation filled. A `),` between "(1" and
  // "plus" is type, not a gutter, and must not cut the line; a thin `|` in the middle of a
  // real gutter fills almost none of it.
  let filled = 0;
  let last: Word | undefined;
  const close = () => {
    const piece = toPiece(group);
    if (piece) pieces.push(piece);
    group = [];
  };
  for (const word of words) {
    if (!word.solid) {
      filled += Math.max(0, word.box.x1 - word.box.x0);
      punctuation.push(word);
      continue;
    }
    if (last !== undefined) {
      // In tesseract's order, not sorted by x: a "line" it built from two printed lines (an
      // ingredient and its indented wrap) goes backwards at the join, and sorting would
      // shuffle the two together word by word.
      const gap = word.box.x0 - last.box.x1;
      // A step number or a quantity set apart from its line ("1.   In a large stockpot",
      // "2  pkgs frozen peas") belongs to it.
      const marker = group.filter((w) => w.solid).length === 1 && LIST_MARKER.test(last.text);
      if ((!marker && gap - filled > WORD_GAP_FACTOR * size) || gap < -size) close();
    }
    // Punctuation between two solid words goes with the second: a bullet leads its line.
    group.push(...punctuation, word);
    punctuation = [];
    filled = 0;
    last = word;
  }
  group.push(...punctuation);
  close();
  return pieces;
}

/**
 * The region cut at every vertical gutter at least `minGap` wide, left to right, or one group
 * when there is none. A gutter is a gap in the x-projection of every piece in the region.
 */
function columns(pieces: Piece[], minGap: number): Piece[][] {
  const sorted = [...pieces].sort((a, b) => a.box.x0 - b.box.x0);
  const groups: Piece[][] = [[sorted[0]!]];
  let reach = sorted[0]!.box.x1;
  for (let i = 1; i < sorted.length; i++) {
    const piece = sorted[i]!;
    if (piece.box.x0 - reach >= minGap) groups.push([piece]);
    else groups[groups.length - 1]!.push(piece);
    reach = Math.max(reach, piece.box.x1);
  }
  return groups;
}

/** The region cut at every horizontal gap, top to bottom. Pieces that overlap stay together. */
function bands(pieces: Piece[]): Piece[][] {
  const sorted = [...pieces].sort((a, b) => a.box.y0 - b.box.y0);
  const groups: Piece[][] = [[sorted[0]!]];
  let reach = sorted[0]!.box.y1;
  for (let i = 1; i < sorted.length; i++) {
    const piece = sorted[i]!;
    if (piece.box.y0 > reach) groups.push([piece]);
    else groups[groups.length - 1]!.push(piece);
    reach = Math.max(reach, piece.box.y1);
  }
  return groups;
}

/**
 * Row by row, and left to right within a row: the order of last resort, for a region with no
 * gutter and no horizontal gap left to cut at. A piece joins a row when its middle is within
 * `ROW_TOLERANCE` type sizes of the one before it, so the cells of a skewed row stay in x
 * order although the right-hand one sits higher.
 *
 * Type size, not box height: a long line on a skewed page has a box two lines tall, and
 * measured against that, the short line under it ("sides. Set aside.") joined its row and,
 * starting further left, was read first.
 */
function byRows(pieces: Piece[]): Piece[] {
  return rowsOf(pieces).flatMap((row) => row.sort((a, b) => a.box.x0 - b.box.x0));
}

function rowsOf(pieces: Piece[]): Piece[][] {
  const sorted = [...pieces].sort((a, b) => centre(a) - centre(b));
  const rows: Piece[][] = [];
  let previous: Piece | null = null;
  for (const piece of sorted) {
    if (previous !== null && centre(piece) - centre(previous) <= ROW_TOLERANCE * previous.size) {
      rows[rows.length - 1]!.push(piece);
    } else {
      rows.push([piece]);
    }
    previous = piece;
  }
  return rows;
}

/**
 * A cut as real columns, or null when it is not one: at least two of its groups need `least`
 * pieces with a word in them. The words are what stop a run of quantities set apart from their
 * foods by a wide space ("2" ... "pkgs frozen peas") from being read as a column of its own.
 *
 * A thin group beside real ones - a page number in the margin, a circled step number sitting
 * in the gutter - goes with its nearer neighbour rather than spoiling the cut.
 */
/**
 * Whether most of a column's pieces start at the same place, as a column of type does. What
 * this refuses is a "column" of the words a justified paragraph left after its widest spaces:
 * a line of it cut at "Then    refrigerate" leaves "refrigerate" out on its own, and a few of
 * those stacked down a page have a gap to their left like a gutter, but they start wherever
 * the spacing put them.
 */
function aligned(column: Piece[]): boolean {
  const start = median(column.map((piece) => piece.box.x0));
  const size = median(column.map((piece) => piece.size));
  const near = column.filter((piece) => Math.abs(piece.box.x0 - start) <= ALIGN_FACTOR * size);
  return near.length >= ALIGNED_SHARE * column.length;
}

function realColumns(split: Piece[][], least: number): Piece[][] | null {
  const real = split.map((column) => {
    const worded = column.filter((piece) => HAS_WORD.test(piece.text));
    return worded.length >= least && aligned(worded);
  });
  if (real.filter(Boolean).length < 2) return null;
  const left = (column: Piece[]) => Math.min(...column.map((piece) => piece.box.x0));
  const right = (column: Piece[]) => Math.max(...column.map((piece) => piece.box.x1));

  const merged: Piece[][] = [];
  let pending: Piece[] = [];
  for (let i = 0; i < split.length; i++) {
    const column = split[i]!;
    if (real[i]) {
      merged.push([...pending, ...column]);
      pending = [];
      continue;
    }
    const before = merged[merged.length - 1];
    const next = split.find((_, j) => j > i && real[j]);
    const gapBefore = before ? left(column) - right(before) : Infinity;
    const gapAfter = next ? left(next) - right(column) : Infinity;
    if (before && gapBefore <= gapAfter) before.push(...column);
    else pending.push(...column);
  }
  if (pending.length > 0) merged[merged.length - 1]!.push(...pending);
  return merged;
}

interface Framed {
  top: Piece[];
  middle: Piece[];
  bottom: Piece[];
}

/**
 * Columns with something set across the top or bottom of them: a title and an introduction
 * above two columns, a footer or a URL below them. Those are what stop a gutter being a clean
 * gap through the whole region.
 *
 * Candidate gutters come from the gaps in short runs of the region's pieces, taken in order of
 * their middles: somewhere down the page there is a stretch of the two columns alone, and its
 * gap is the gutter. For each candidate, the pieces that cross it split the region into runs
 * that do not, and the longest run that cuts into real columns is the columns; what is above
 * it is read first, and what is below it after.
 *
 * In order of middles rather than by horizontal bands, because on a skewed or curved page the
 * lines of two columns overlap in y all the way down: there is no horizontal gap between a
 * heading and the columns under it. And by runs rather than by peeling a counted number of
 * pieces off the top, because at the size the browser uploads, an introduction in italic came
 * apart into more pieces than any fixed count allowed for.
 */
function framedColumns(pieces: Piece[], minGap: number): Framed | null {
  const sorted = [...pieces].sort((a, b) => centre(a) - centre(b));
  const n = sorted.length;
  const window = Math.max(2 * MIN_FRAMED_COLUMN_PIECES, Math.ceil(n / GUTTER_WINDOWS));

  // Each gap seen in a stretch gives three x positions to try: its two edges and its middle. A
  // stretch sees only some of each column, so its gap can be wider than the page's gutter, and
  // the gutter is somewhere inside it; which of the three lies in it is for the cut to find.
  const gutters = new Set<number>();
  for (let start = 0; start + window <= n && gutters.size < MAX_GUTTERS; start += window) {
    const groups = columns(sorted.slice(start, start + window), minGap);
    let reach = -Infinity;
    for (let i = 0; i < groups.length; i++) {
      const group = groups[i]!;
      if (i > 0) {
        const to = Math.min(...group.map((p) => p.box.x0));
        gutters
          .add(reach + minGap / 2)
          .add((reach + to) / 2)
          .add(to - minGap / 2);
      }
      reach = Math.max(reach, ...group.map((p) => p.box.x1));
    }
  }

  let best: Framed | null = null;
  for (const gutter of [...gutters].slice(0, MAX_GUTTERS)) {
    const crosses = (piece: Piece) => piece.box.x0 < gutter && piece.box.x1 > gutter;
    let from = 0;
    for (let i = 0; i <= n; i++) {
      if (i < n && !crosses(sorted[i]!)) continue;
      const length = i - from;
      if (length < n && length > (best?.middle.length ?? 2 * MIN_FRAMED_COLUMN_PIECES - 1)) {
        const middle = sorted.slice(from, i);
        if (realColumns(columns(middle, minGap), MIN_FRAMED_COLUMN_PIECES)) {
          best = { top: sorted.slice(0, from), middle, bottom: sorted.slice(i) };
        }
      }
      from = i + 1;
    }
  }
  return best;
}

function order(pieces: Piece[], minGap: number, depth: number): Piece[] {
  if (pieces.length <= 1 || depth >= MAX_DEPTH) return byRows(pieces);

  // One row's cells are read left to right however few there are. Across several rows, a
  // "column" of one piece is a line cut short by a stray mark, and reading it after everything
  // to its left would tear that line out of its place.
  const oneRow = rowsOf(pieces).length === 1;
  const split = columns(pieces, minGap);
  const cut = split.length < 2 ? null : oneRow ? split : realColumns(split, MIN_COLUMN_PIECES);
  if (cut) return cut.flatMap((column) => order(column, minGap, depth + 1));
  if (oneRow) return byRows(pieces);

  // Tried even when no horizontal gap cuts the region: on a skewed photo the lines of two
  // columns overlap in y all the way down, and the whole page is one band.
  const framed = framedColumns(pieces, minGap);
  if (framed) {
    return [
      ...order(framed.top, minGap, depth + 1),
      ...order(framed.middle, minGap, depth + 1),
      ...order(framed.bottom, minGap, depth + 1),
    ];
  }
  const rows = bands(pieces);
  if (rows.length === 1) return byRows(pieces);
  return rows.flatMap((band) => order(band, minGap, depth + 1));
}

/**
 * The largest confident type near the top of the page, moved to the front: the recipe's name.
 *
 * `from-text.ts` takes the first line above the ingredients that reads as a phrase, and on a
 * cookbook page that is often not the name: a sidebar ("SERVES"), a letterhead ("La Cucina")
 * or a category line comes first in reading order. The name is set larger than everything
 * else, and this is the only place that knows sizes.
 */
function titleFirst(ordered: Piece[], size: number): Piece[] {
  let top = Infinity;
  let bottom = -Infinity;
  for (const piece of ordered) {
    top = Math.min(top, piece.box.y0);
    bottom = Math.max(bottom, piece.box.y1);
  }
  const reach = top + TITLE_REGION * (bottom - top);
  let best = -1;
  for (let i = 0; i < ordered.length; i++) {
    const piece = ordered[i]!;
    if (piece.box.y0 > reach || piece.size < TITLE_SIZE_FACTOR * size) continue;
    if (piece.confidence < MIN_TITLE_CONFIDENCE || letters(piece.text) < MIN_TITLE_LETTERS)
      continue;
    if (best === -1 || piece.size > ordered[best]!.size) best = i;
  }
  if (best === -1) return ordered;

  // A long name is set over two or three lines ("Classic cucumber" / "sandwiches"), and the
  // largest of them is not the first. Every line of it comes along, top to bottom, as one line:
  // type of about the same size, read well, each under or over the last with no more than a
  // line's space between.
  const title = ordered[best]!;
  const chain = [title];
  const alike = ordered.filter(
    (piece) =>
      piece !== title &&
      piece.size >= TITLE_LINE_LIKE * title.size &&
      piece.size <= title.size / TITLE_LINE_LIKE &&
      piece.confidence >= MIN_TITLE_CONFIDENCE &&
      HAS_WORD.test(piece.text),
  );
  for (let grew = true; grew; ) {
    grew = false;
    for (const piece of alike) {
      if (chain.includes(piece)) continue;
      const near = chain.some(
        (link) =>
          piece.box.y0 - link.box.y1 <= TITLE_LINE_GAP * title.size &&
          link.box.y0 - piece.box.y1 <= TITLE_LINE_GAP * title.size &&
          piece.box.x0 < link.box.x1 &&
          link.box.x0 < piece.box.x1,
      );
      if (near) {
        chain.push(piece);
        grew = true;
      }
    }
  }
  if (chain.length === 1) {
    if (best === 0) return ordered;
    return [title, ...ordered.filter((_, i) => i !== best)];
  }
  chain.sort((a, b) => a.box.y0 - b.box.y0);
  const joined: Piece = {
    text: chain.map((piece) => piece.text).join(' '),
    box: union(chain.map((piece) => piece.box)),
    size: title.size,
    confidence: title.confidence,
  };
  return [joined, ...ordered.filter((piece) => !chain.includes(piece))];
}

/**
 * The page's text in reading order, one piece per line, with a blank line above a piece that
 * starts a new paragraph or a new column. Null when there is nothing to order or too much to
 * order safely, so the caller can use tesseract's own text.
 */
export function readingOrderText(lines: OcrLine[]): string | null {
  const turn = pageTurn(lines);
  const upright = lines.map((line) => ({
    words: line.words.map((word) => ({ ...word, bbox: turned(word.bbox, turn) })),
  }));
  const slope = pageSlope(upright);
  const pieces = upright
    .map((line) => ({
      words: line.words.map((word) => ({ ...word, bbox: levelled(word.bbox, slope) })),
    }))
    .flatMap(toPieces);
  if (pieces.length === 0 || pieces.length > MAX_PIECES) return null;

  const size = median(pieces.map((piece) => piece.size));
  const ordered = titleFirst(order(pieces, MIN_GUTTER_FACTOR * size, 0), size);
  const leading = usualLeading(ordered);

  let text = ordered[0]!.text;
  for (let i = 1; i < ordered.length; i++) {
    const previous = ordered[i - 1]!;
    const piece = ordered[i]!;
    const gap = piece.box.y0 - previous.box.y1;
    const paragraph =
      gap > leading + PARAGRAPH_GAP_FACTOR * Math.max(previous.size, piece.size) ||
      // Back up the page: the top of the next column.
      centre(piece) < previous.box.y0;
    text += `${paragraph ? '\n\n' : '\n'}${piece.text}`;
  }
  return text;
}

/**
 * The space a page leaves between the lines of one paragraph: the lower quartile of the gaps
 * between each piece and the one read after it, where that one is directly under it.
 *
 * A quartile rather than a fixed share of the type size, because pages differ by more than the
 * signal: a roomy printout left gaps inside a paragraph half a type size tall, which a fixed
 * threshold read as a break after every line, while a tight cookbook column left less than
 * that between one ingredient and the next. The lower quartile rather than the median, because
 * in a column of two-line ingredients half the gaps ARE the breaks.
 */
function usualLeading(ordered: Piece[]): number {
  const gaps: number[] = [];
  for (let i = 1; i < ordered.length; i++) {
    const previous = ordered[i - 1]!;
    const piece = ordered[i]!;
    if (centre(piece) > previous.box.y1 && piece.box.x0 < previous.box.x1) {
      gaps.push(piece.box.y0 - previous.box.y1);
    }
  }
  gaps.sort((a, b) => a - b);
  return gaps[Math.floor(LEADING_QUANTILE * (gaps.length - 1))] ?? 0;
}
