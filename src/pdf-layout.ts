/**
 * Glyph runs at coordinates -> lines, columns and paragraphs.
 *
 * Everything in this file is inference. A PDF records where ink goes, not what
 * the text means: there are no paragraphs, no reading order, no columns and no
 * tables in the file, only positioned runs. So each rule here is conservative,
 * and each one states what it would rather get wrong.
 */

import { sanitizeText } from './utils/text.js';

export interface TextItem {
  str: string;
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface Line {
  /** Baseline, in PDF user space, where larger is further up the page. */
  y: number;
  left: number;
  right: number;
  text: string;
}

/** A baseline may wobble by this share of the glyph height and stay one line. */
const BASELINE_TOLERANCE = 0.5;
/** A vertical gap this much larger than the usual line spacing is a paragraph. */
const PARAGRAPH_GAP = 1.5;
/** Runs closer than this fraction of a character are the same word. */
const TIGHT_RUN = 0.3;
/** Narrower than this, a vertical band is word spacing rather than a gutter. */
const MIN_GUTTER = 18;
/** A gutter has to be clear on this share of the page's lines. */
const CLEAR_SHARE = 0.8;
/** …and has to have this many whole lines on each side of it. */
const MIN_COLUMN_LINES = 3;

function median(values: number[]): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.floor(sorted.length / 2)] as number;
}

/** Width of one character, for turning a horizontal offset into a column. */
function characterWidth(items: TextItem[]): number {
  const widths = items
    .filter((it) => it.width > 0 && it.str.length > 0)
    .map((it) => it.width / it.str.length);
  return median(widths) || 1;
}

/**
 * Lay one line's items out on a character grid.
 *
 * Positions become columns rather than single spaces, so a table's alignment
 * and a code block's indentation both survive. Where the alignment is not
 * meaningful the runs of spaces cost nothing: `collapseSpaces` removes them
 * during cleaning, and only content that is fenced keeps them.
 */
function layOut(items: TextItem[], origin: number, charWidth: number): string {
  let out = '';
  let previousRight: number | undefined;

  for (const item of items) {
    const column = Math.max(0, Math.round((item.x - origin) / charWidth));
    if (column > out.length || out.length === 0) out = out.padEnd(column, ' ');
    // Two runs closer than a fraction of a character are one word that the
    // engine split on a kerning or font change: `Style` arrives as `St` and
    // `yle`, and a space between them invents a word break.
    else if (previousRight !== undefined && item.x - previousRight > charWidth * TIGHT_RUN) out += ' ';

    out += item.str;
    previousRight = item.x + item.width;
  }
  return out.replace(/\s+$/, '');
}

interface Metrics {
  origin: number;
  charWidth: number;
  tolerance: number;
}

function metricsOf(items: TextItem[]): Metrics {
  return {
    origin: Math.min(...items.map((it) => it.x)),
    charWidth: characterWidth(items),
    tolerance: (median(items.map((it) => it.height).filter((h) => h > 0)) || 1) * BASELINE_TOLERANCE,
  };
}

/**
 * Whitespace-only runs are dropped rather than kept: PDF generators emit them
 * as positioning filler, and one that spans a page's gutter would hide the
 * gutter from column detection. The gaps come back from the coordinates.
 */
function realItems(items: TextItem[]): TextItem[] {
  return items
    .map((it) => ({ ...it, str: sanitizeText(it.str) }))
    .filter((it) => it.str.trim() !== '');
}

/** Items sharing a baseline, each row ordered left to right, page top first. */
function toRows(items: TextItem[], tolerance: number): TextItem[][] {
  const rows: TextItem[][] = [];
  for (const item of [...items].sort((a, b) => b.y - a.y || a.x - b.x)) {
    const current = rows[rows.length - 1];
    const baseline = current?.[0]?.y;
    if (current && baseline !== undefined && Math.abs(baseline - item.y) <= tolerance) current.push(item);
    else rows.push([item]);
  }
  // Grouping walked the page by baseline, so a row that swept up a subscript or
  // a superscript holds it after every full-height run. Ordering each row by
  // position is what puts `θ` and its `0` back together.
  return rows.map((row) => row.sort((a, b) => a.x - b.x));
}

function toLine(row: TextItem[], metrics: Metrics): Line {
  return {
    y: row[0]?.y ?? 0,
    left: Math.min(...row.map((it) => it.x)),
    right: Math.max(...row.map((it) => it.x + it.width)),
    text: layOut(row, metrics.origin, metrics.charWidth),
  };
}

/** Lines in page order, with no column reconstruction. */
export function toLines(items: TextItem[]): Line[] {
  const real = realItems(items);
  if (real.length === 0) return [];

  const metrics = metricsOf(real);
  return toRows(real, metrics.tolerance).map((row) => toLine(row, metrics));
}

// --------------------------------------------------------------------------
// columns
// --------------------------------------------------------------------------

interface Gutter {
  start: number;
  end: number;
}

/**
 * The vertical band that separates two columns, if the page has one.
 *
 * Detection runs on items rather than on lines, because side-by-side columns
 * usually share their baselines: on the fixture's two-column spread every body
 * line holds one run from each column, so a line-level view sees no gap at all.
 *
 * The decisive guard is that there must be *exactly one* candidate band. A
 * table produces one clear band per column boundary, and reading a five-column
 * table as two columns of prose would be far worse than leaving a two-column
 * page interleaved — so anything with more than one band is not a column
 * layout, and is left alone.
 */
function findGutter(rows: TextItem[][]): Gutter | undefined {
  if (rows.length < MIN_COLUMN_LINES) return undefined;

  const items = rows.flat();
  const edges = [...new Set(items.flatMap((it) => [it.x, it.x + it.width]))].sort((a, b) => a - b);
  const allowed = Math.floor(rows.length * (1 - CLEAR_SHARE));
  const bands: Gutter[] = [];

  for (let i = 0; i < edges.length - 1; i++) {
    const band = { start: edges[i] as number, end: edges[i + 1] as number };
    if (band.end - band.start < MIN_GUTTER) continue;
    if (rows.filter((row) => crosses(row, band)).length > allowed) continue;
    if (rows.filter((row) => row.some((it) => it.x + it.width <= band.start)).length < MIN_COLUMN_LINES) continue;
    if (rows.filter((row) => row.some((it) => it.x >= band.end)).length < MIN_COLUMN_LINES) continue;
    bands.push(band);
  }

  return bands.length === 1 ? bands[0] : undefined;
}

function crosses(row: TextItem[], band: Gutter): boolean {
  return row.some((it) => it.x < band.end && it.x + it.width > band.start);
}

/**
 * Read the left column, then the right — but only across the body of the page.
 *
 * Page furniture spans the full width and belongs to neither column, so a
 * banner heading stays above both and a running footer below them. Keeping
 * those rows whole also keeps them recognisable to the running-text pass, which
 * matches on the line as the reader sees it.
 */
export function orderColumns(rows: TextItem[][], height: number): TextItem[][][] {
  const margin = height * MARGIN_SHARE;
  const isFurniture = (row: TextItem[]): boolean => {
    const y = row[0]?.y ?? 0;
    return y <= margin || y >= height - margin;
  };

  const body = rows.filter((row) => !isFurniture(row));
  const gutter = findGutter(body);
  if (!gutter) return [rows];

  const top = rows.filter((row) => isFurniture(row) && (row[0]?.y ?? 0) >= height - margin);
  const bottom = rows.filter((row) => isFurniture(row) && (row[0]?.y ?? 0) <= margin);
  const left: TextItem[][] = [];
  const right: TextItem[][] = [];

  for (const row of body) {
    const leftPart = row.filter((it) => it.x + it.width <= gutter.start);
    const rightPart = row.filter((it) => it.x >= gutter.end);
    // A run that straddles the gutter belongs to neither side; keeping it with
    // the left column preserves its reading position better than dropping it.
    const straddling = row.filter((it) => !leftPart.includes(it) && !rightPart.includes(it));
    if (leftPart.length + straddling.length > 0) left.push([...leftPart, ...straddling]);
    if (rightPart.length > 0) right.push(rightPart);
  }

  return [top, left, right, bottom].filter((group) => group.length > 0);
}

/**
 * Rows in reading order, laid out on a character grid.
 *
 * Each group is measured from its own left edge, so the right-hand column of a
 * spread does not arrive indented by half a page — indentation that survives
 * cleaning, since `collapseSpaces` treats a line's leading whitespace as
 * structure, and would cost tokens on every line of the column.
 */
export function layoutPage(items: TextItem[], height: number): Line[] {
  const real = realItems(items);
  if (real.length === 0) return [];

  const page = metricsOf(real);
  const groups = orderColumns(toRows(real, page.tolerance), height);

  return groups.flatMap((rows) => {
    const metrics = { ...page, origin: Math.min(...rows.flat().map((it) => it.x)) };
    return rows.map((row) => toLine(row, metrics));
  });
}

// --------------------------------------------------------------------------
// paragraphs
// --------------------------------------------------------------------------

/**
 * Insert a blank line where the leading opens up.
 *
 * Without this a page is one unbroken run of lines, and `unwrap` deliberately
 * skips text holding no blank line at all — so a PDF's hard wrapping would
 * never be undone, which is most of what cleaning a PDF is for.
 */
export function toParagraphs(lines: Line[]): string {
  if (lines.length === 0) return '';

  const gaps: number[] = [];
  for (let i = 1; i < lines.length; i++) {
    const gap = (lines[i - 1] as Line).y - (lines[i] as Line).y;
    if (gap > 0) gaps.push(gap);
  }
  const usual = median(gaps);

  const out: string[] = [];
  lines.forEach((line, i) => {
    const previous = lines[i - 1];
    if (previous && breaksParagraph(previous, line, usual)) out.push('');
    out.push(line.text);
  });
  return out.join('\n');
}

/**
 * A jump back up the page means the reading order moved to the next column, and
 * the last line of one column has nothing to do with the first line of the
 * next — without the break `unwrap` would join them into a single sentence.
 */
function breaksParagraph(previous: Line, line: Line, usual: number): boolean {
  const gap = previous.y - line.y;
  return gap < 0 || (usual > 0 && gap > usual * PARAGRAPH_GAP);
}

// --------------------------------------------------------------------------
// running headers and footers
// --------------------------------------------------------------------------

/** Furniture lives in the top or bottom band of the page. */
const MARGIN_SHARE = 0.12;
/** Below this many pages there is too little evidence to call anything repeated. */
const MIN_PAGES = 4;
/** A line has to appear in this share of the pages that have any text at all. */
const REPEAT_SHARE = 0.6;
/** Two baselines this close, in points, are the same position on the page. */
const POSITION_TOLERANCE = 3;

const PAGE_COUNTER = /\b(?:page\s+)?\d+(?:\s*(?:of|\/)\s*\d+)?\b/gi;

/**
 * A page counter reads differently on every page, so a run of digits inside one
 * is normalised — but only inside one. Normalising every digit would collapse
 * annual headings, section numbers and dates, which are meaning rather than
 * furniture.
 */
function furnitureKey(line: Line): string {
  // Padding is not part of the text: the character grid is derived from each
  // page's own metrics, so the same header is spaced differently on a page
  // whose body happens to use a narrower font.
  const text = line.text.replace(/\s+/g, ' ').trim();
  const normalised = PAGE_COUNTER.test(text) ? text.replace(PAGE_COUNTER, '#') : text;
  PAGE_COUNTER.lastIndex = 0;
  return `${Math.round(line.y / POSITION_TOLERANCE)}|${normalised}`;
}

export interface PageLines {
  index: number;
  height: number;
  lines: Line[];
}

/**
 * Drop text repeated at the same place on most pages, keeping the first copy.
 *
 * One copy carries the semantic context — which document this is, which section
 * — at negligible cost, and dropping every copy loses that outright. Matching is
 * on position *and* near-exact text: the fixture repeats its footer sentence
 * twice in the body of the last page, and text alone would delete those too.
 */
export function suppressRunningText(pages: PageLines[]): number {
  const withText = pages.filter((page) => page.lines.length > 0);
  if (withText.length < MIN_PAGES) return 0;

  const seen = new Map<string, PageLines[]>();
  for (const page of withText) {
    const margin = page.height * MARGIN_SHARE;
    for (const line of page.lines) {
      if (line.y > margin && line.y < page.height - margin) continue;
      const key = furnitureKey(line);
      seen.set(key, [...(seen.get(key) ?? []), page]);
    }
  }

  let suppressed = 0;
  for (const [key, appearances] of seen) {
    if (appearances.length < withText.length * REPEAT_SHARE) continue;
    for (const page of appearances.slice(1)) {
      const before = page.lines.length;
      page.lines = page.lines.filter((line) => furnitureKey(line) !== key);
      suppressed += before - page.lines.length;
    }
  }
  return suppressed;
}

// --------------------------------------------------------------------------
// hyphenation
// --------------------------------------------------------------------------

/**
 * Rejoin a word split across a line break. Opt-in, and off by default:
 * `inter-\nnational` should rejoin and `state-\nof-the-art` must not, and
 * without a dictionary nothing here can tell them apart.
 */
export function dehyphenate(text: string): string {
  return text.replace(/([A-Za-z]{2,})-\n([a-z]+)/g, '$1$2');
}
