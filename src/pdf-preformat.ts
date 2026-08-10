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
 * grid is derived from coordinates and rounds.
 */
function isGrid(rows: string[]): boolean {
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
