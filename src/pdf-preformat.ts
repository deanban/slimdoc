/**
 * Regions of a PDF page that line up, preserved rather than reconstructed.
 *
 * slimdoc deliberately does not turn these into Markdown tables. A PDF has no
 * table semantics at all — only glyph runs at coordinates — so any pipe table
 * built from them is an assertion about structure that is not in the file, and
 * a wrong one lands numbers under the wrong heading while looking authoritative.
 * A fenced block asserts nothing: it says "these characters were arranged like
 * this", which is exactly what the file does say.
 *
 * The alignment survives cleaning because `preserveCode` is on in every preset,
 * and the content is safe to fence because the extractor sanitizes every item
 * as it reads it — otherwise the fence would smuggle ligatures, soft hyphens
 * and smart quotes past the cleaner that exists to remove them.
 */

import { fencedBlock } from './utils/fence.js';

/** Fewer consecutive rows than this is a coincidence, not a layout. */
const MIN_ROWS = 3;
/** Fields are separated by a run of at least this many spaces. */
const FIELD_GAP = /\s{2,}/;
/** A row has to hold at least this many fields to be part of a grid. */
const MIN_FIELDS = 2;
/** A column start may drift this far between rows and still be one column. */
const DRIFT = 2;
/** …and has to appear in this share of the run's rows to be a column at all. */
const ALIGNED_SHARE = 0.7;
/**
 * A field gap this wide is a column boundary rather than a word space. Measured:
 * OCR word noise runs 2-3 characters, a real table's columns 5-10, and the
 * deliberately-ragged fixture block 15-25.
 */
const WIDE_GAP = 4;

/** The middle value, for a gap width that one outlying row cannot move. */
function median(values: number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.floor(sorted.length / 2)] as number;
}

function isGridRow(line: string): boolean {
  const trimmed = line.trim();
  if (trimmed === '') return false;
  return trimmed.split(FIELD_GAP).length >= MIN_FIELDS;
}

/** Where each field after the first begins, in characters from the left. */
function fieldStarts(line: string): number[] {
  const starts: number[] = [];
  for (const gap of line.matchAll(/\S {2,}(?=\S)/g)) {
    starts.push((gap.index ?? 0) + gap[0].length);
  }
  return starts;
}

/**
 * Whether a table's rows agree on how many fields they have.
 *
 * A table's rows do, near enough: a three-column table is `[3, 3, 3]`, allowing
 * for the odd empty cell. Prose does not, and this is what tells the two apart on
 * a scanned page. OCR sprays multi-space runs through ordinary text, so every
 * paragraph line splits into fields — but into a different number of them each
 * time: measured on the real OCR'd paper here, `[6, 5, 7, 2]` and `[7, 5, 5, 4]`
 * against a real table's `[3, 3, 3]` and `[2, 2, 2]`.
 *
 * Without this the aligned-column rule alone still fenced 69 regions across that
 * paper's 8 pages — 498 lines, a quarter of the document, nearly all of it prose.
 * One aligned position recurring in most rows is not rare when every row has half
 * a dozen word boundaries to offer.
 */
function hasStableFieldCount(rows: string[]): boolean {
  const counts = rows.map((row) => row.trim().split(FIELD_GAP).length);
  const tally = new Map<number, number>();
  for (const count of counts) tally.set(count, (tally.get(count) ?? 0) + 1);
  return Math.max(...tally.values()) >= rows.length * ALIGNED_SHARE;
}

/**
 * Whether the runs separating fields are wide enough to be column boundaries.
 *
 * The other half of telling a ragged table from OCR'd prose. `kitchen-sink.pdf`
 * carries a block that is deliberately *not* a table — decks against notes, with
 * a missing cell here and an extra one there — and the contract is that it gets
 * fenced anyway, because a fence asserts nothing about structure. Its field
 * counts are `[3, 3, 4, 2, 3, 5]`, so field-count stability alone would throw it
 * away.
 *
 * What it has that OCR prose does not is distance. Columns are set far apart: that
 * block's gaps run 15-25 characters, and a real table's 5-10. OCR sprays runs of
 * two and three spaces between *words*, which is where the false grids come from.
 * The median gap is the cheapest thing that separates the two, and it does not
 * care how ragged the rows are.
 */
function hasWideGaps(rows: string[]): boolean {
  const gaps = rows.flatMap((row) => [...row.trim().matchAll(/ {2,}/g)].map((gap) => gap[0].length));
  return gaps.length > 0 && median(gaps) >= WIDE_GAP;
}

/**
 * Whether a run of candidate rows is a grid rather than a paragraph.
 *
 * Two fields separated by two spaces is not evidence of anything: justified
 * setting widens every interword space, and the character grid these lines are
 * laid out on turns that into runs of two and three. Counting fields alone
 * therefore fenced ordinary prose — 25 blocks over eight pages of one real
 * paper, several of them whole paragraphs — and fenced content is exempt from
 * cleaning, so each false positive costs twice: the spacing is preserved *and*
 * the unwrapping is skipped.
 *
 * What a table has and prose does not is a column: a place where field after
 * field begins, row after row. A character of drift is allowed, because the
 * grid is derived from coordinates and rounds. And its rows agree on how many
 * fields they hold, which is what survives OCR spacing when alignment does not.
 */
function isGrid(rows: string[]): boolean {
  // Either signal will do. A tidy table has stable field counts even when its
  // columns sit two spaces apart; a ragged one has wide gaps even when cells are
  // missing. OCR'd prose has neither, which is the whole point.
  if (!hasStableFieldCount(rows) && !hasWideGaps(rows)) return false;

  const starts = rows.map(fieldStarts);
  const needed = rows.length * ALIGNED_SHARE;

  for (const column of new Set(starts.flat())) {
    const rowsHere = starts.filter((row) => row.some((at) => Math.abs(at - column) <= DRIFT));
    if (rowsHere.length >= needed) return true;
  }
  return false;
}

export interface Preformatted {
  text: string;
  /** How many regions were preserved; non-zero means the caller owes a warning. */
  regions: number;
}

/**
 * Wrap every run of `MIN_ROWS` or more aligned rows in a fence long enough that
 * the block's own content cannot close it.
 *
 * No language identifier: the block is not code, and claiming otherwise would
 * invite a reader to interpret it as one.
 */
export function preserveGridRegions(text: string): Preformatted {
  const lines = text.split('\n');
  const out: string[] = [];
  let run: string[] = [];
  let regions = 0;

  const flush = (): void => {
    if (run.length >= MIN_ROWS && isGrid(run)) {
      regions += 1;
      // A block needs a blank line on either side, or the fence welds onto the
      // paragraph above it and stops being a fence at all.
      if (out.length > 0 && out[out.length - 1] !== '') out.push('');
      out.push(fencedBlock(run.join('\n')), '');
    } else {
      out.push(...run);
    }
    run = [];
  };

  for (const line of lines) {
    if (isGridRow(line)) run.push(line);
    else {
      flush();
      out.push(line);
    }
  }
  flush();

  return { text: out.join('\n'), regions };
}

/**
 * Markers a PDF writes a list with. These are literal glyphs in the file, not
 * markup slimdoc added.
 */
const LIST_MARKER = /^(?:[-*+•‣◦·]|\d+[.)]|[a-z][.)])[ \t]/i;
/** An opening or closing fence, whatever length `fencedBlock` chose for it. */
const FENCE = /^(`{3,}|~{3,})/;
/** Below this many distinct indent depths, a block's indentation is not nesting. */
const NESTED_LEVELS = 2;
/** Depths sharing no larger divisor than this are coordinates, not indent levels. */
const MIN_INDENT_UNIT = 2;

const indentOf = (line: string): number => (/^ */.exec(line)?.[0].length ?? 0);

function gcd(a: number, b: number): number {
  return b === 0 ? a : gcd(b, a % b);
}

/**
 * Whether a block's indentation is structure or is the character grid's leftover.
 *
 * Two signals, and the second is the one that matters. Code nests, so it has more
 * than one depth: the fixture's Python runs 0, 4, 4, 8, 12, and the fixture says
 * so in its own prose — "the indentation is the semantics". A hard-wrapped
 * paragraph does not nest; its continuation lines sit at the one indent the first
 * line established.
 *
 * But counting depths alone is not enough, and failing to see that is why the
 * first version of this recovered almost nothing. These indents are derived from
 * x-coordinates and they round, so an ordinary paragraph arrives at depths of 3,
 * 5 and 4 — two levels or more, and read as nesting by a rule that only counts.
 * Real indent levels are *regular*: they are multiples of one unit, because an
 * author pressed Tab. 4/8/12 share a divisor of 4; the coordinate noise above
 * shares nothing but 1. That divisor is the test.
 *
 * A flat code block — every line at one depth, nothing nested — reads as a
 * paragraph here and loses its indent. That is the known cost, and it is the
 * right way round: a PDF's indented prose is common and its unnested code is
 * rare, `preserveTables` fences the aligned case before this runs, and the words
 * survive either way.
 */
function isNested(block: string[]): boolean {
  const depths = [...new Set(block.filter((line) => line.trim() !== '').map(indentOf))];
  const levels = depths.filter((depth) => depth > 0);
  if (levels.length < NESTED_LEVELS) return false;
  return levels.reduce(gcd) >= MIN_INDENT_UNIT;
}

/**
 * Drop the leading indentation the character grid put on every line, outside the
 * regions just fenced for their alignment and outside blocks whose indentation
 * nests.
 *
 * `layOut` pads each line out to its own column so a table's alignment survives,
 * and its comment claimed the padding "costs nothing" because `collapseSpaces`
 * removes it during cleaning. Half of that is true: `collapseSpaces` squeezes runs
 * *inside* a line and deliberately preserves the indent, because in Markdown an
 * indent is structure. In a PDF it is usually not structure — it is the
 * x-coordinate of a glyph run — and preserving it cost twice over.
 *
 * It cost tokens: 4.7k-9.9k characters of leading space per real paper, which a
 * whitespace-blind estimator reported as free and which cl100k charges a token
 * per indented line for.
 *
 * And it cost the unwrapping, which is worse. `isBlockStart` reads any line
 * indented four spaces or more as an indented code block, so `canJoin` refused
 * every one of them and `--unwrap` had no measurable effect on any real paper:
 * the hard wrapping that cleaning a PDF is mostly for stayed exactly as it was.
 */
export function flattenIndents(text: string): string {
  const out: string[] = [];
  let fence: string | undefined;
  let block: string[] = [];

  const flush = (): void => {
    if (block.length > 0) {
      out.push(
        ...(isNested(block)
          ? block
          : block.map((line) => (LIST_MARKER.test(line.trimStart()) ? line : line.trimStart()))),
      );
      block = [];
    }
  };

  for (const line of text.split('\n')) {
    const marker = FENCE.exec(line.trimStart())?.[1];

    if (fence !== undefined) {
      // Only a fence at least as long as the opener closes it, and only alone on
      // its own line — the same rule `fencedBlock` writes to.
      if (marker !== undefined && marker.length >= fence.length && line.trim() === marker) {
        fence = undefined;
      }
      out.push(line);
      continue;
    }
    if (marker !== undefined) {
      flush();
      fence = marker;
      out.push(line);
      continue;
    }
    // A blank line ends a block: indentation only means nesting relative to the
    // lines it sits among.
    if (line.trim() === '') {
      flush();
      out.push(line);
      continue;
    }
    block.push(line);
  }
  flush();

  return out.join('\n');
}
