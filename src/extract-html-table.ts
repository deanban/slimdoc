/**
 * `<table>` -> a rectangular grid, for the shared Markdown emitter.
 *
 * The surrounding extractor is a streaming tag rewriter, which cannot see row
 * and cell structure or synthesise a separator row. Tables are therefore parked
 * whole — the same trick already used for `<pre>` — parsed here, and restored
 * as finished Markdown once the whitespace squeezing is done.
 *
 * Matching is deliberately tolerant of missing `</td>` and `</tr>`: pasted
 * Outlook and Google Docs fragments frequently omit them.
 */

import { renderTable } from './utils/markdown-table.js';
import type { ParkingLot } from './utils/parking.js';

/**
 * Markdown has no colspan, so a span is expanded by repetition — which makes a
 * malformed `colspan="999"` a token bomb that emits 999 real columns. No
 * genuine document needs more, and a clamped span still reads correctly.
 */
const MAX_SPAN = 64;

/** A table with no nested table inside it, so nesting resolves innermost-first. */
const INNERMOST_TABLE = /<table\b[^>]*>((?:(?!<table\b)[\s\S])*?)<\/table\s*>/i;
const ROW = /<tr\b[^>]*>([\s\S]*?)(?=<tr\b|<\/table\b|$)/gi;
const CELL = /<(t[dh])\b([^>]*)>([\s\S]*?)(?=<\/?t[dhr]\b|<\/table\b|$)/gi;

interface RawCell {
  text: string;
  colspan: number;
  rowspan: number;
}

function span(attrs: string, name: string): number {
  const m = new RegExp(`\\b${name}\\s*=\\s*["']?(\\d{1,3})`, 'i').exec(attrs);
  const n = m ? Number(m[1]) : 1;
  if (!Number.isFinite(n) || n < 1) return 1;
  return Math.min(n, MAX_SPAN);
}

function parseRow(rowHtml: string, cellText: (inner: string) => string): RawCell[] {
  const cells: RawCell[] = [];
  for (const m of rowHtml.matchAll(CELL)) {
    cells.push({
      text: cellText(m[3] ?? ''),
      colspan: span(m[2] ?? '', 'colspan'),
      rowspan: span(m[2] ?? '', 'rowspan'),
    });
  }
  return cells;
}

interface Grid {
  rows: string[][];
  merged: number;
}

/**
 * Expand spans into a dense grid. Markdown has no rowspan or colspan, so a
 * merged cell repeats across the columns and down the rows it spanned — an
 * approximation the caller warns about rather than a lossless translation.
 */
function toGrid(rawRows: RawCell[][]): Grid {
  const rows: string[][] = [];
  const carried = new Map<number, { text: string; left: number }>();
  let merged = 0;

  for (const cells of rawRows) {
    const row: string[] = [];
    let column = 0;
    let next = 0;

    while (next < cells.length || carried.has(column)) {
      const carry = carried.get(column);
      if (carry) {
        row[column] = carry.text;
        carry.left -= 1;
        if (carry.left <= 0) carried.delete(column);
        column += 1;
        continue;
      }
      const cell = cells[next];
      next += 1;
      if (!cell) break;

      if (cell.colspan > 1 || cell.rowspan > 1) merged += 1;
      for (let i = 0; i < cell.colspan; i++) {
        row[column + i] = cell.text;
        if (cell.rowspan > 1) {
          carried.set(column + i, { text: cell.text, left: cell.rowspan - 1 });
        }
      }
      column += cell.colspan;
    }

    rows.push(Array.from(row, (value) => value ?? ''));
  }

  return { rows, merged };
}

export interface ParkedTables {
  html: string;
  merged: number;
}

export interface TableParking {
  /** Inner HTML -> plain text, supplied by the extractor that owns entities. */
  cellText: (inner: string) => string;
  /** The whole lot, not just `park`: a cell may contain something parked already. */
  lot: ParkingLot;
  /** The caller's line-break sentinel, emitted around every marker. */
  blockBreak: string;
}

/**
 * Replace every `<table>` in `html` with a marker for its finished text. A grid
 * that is not really a table — one column, or no cells at all — becomes plain
 * lines instead of a bogus pipe table.
 */
export function parkTables(html: string, { cellText, lot, blockBreak }: TableParking): ParkedTables {
  /**
   * A cell may hold something parked earlier — a `<pre>`, or a table nested in
   * this one and parked by a previous iteration. Those are restored *here*,
   * before `renderTable` runs, rather than left for the final restore: a marker
   * expanded after rendering injects newlines into a finished pipe row and
   * splits one table into two broken ones. Rendering flattens what it must —
   * `escapeCell` already collapses every cell to one line — so a block only
   * keeps its lines where the grid degrades to plain text and nothing breaks.
   * The caller's break sentinels around a restored marker become real newlines,
   * so a nested block never leaves a stray sentinel inside a cell.
   */
  /**
   * The plain-text form of each table already parked, keyed by its marker.
   *
   * A table nested in a cell has no Markdown form that works there: pipes are
   * escaped on the way in, so restoring the rendered inner table spells the cell
   * `\| Enterprise \| NCC-1701 \| \| --- \| --- \|` — every byte of the grid,
   * none of its meaning. The words are what survives translation, so a cell gets
   * those and the separator row is dropped.
   */
  const flattened = new Map<string, string>();

  /**
   * Expand one cell's markers. Which form a nested table takes depends on where
   * the cell lands, and that is not known until the grid has been built: inside
   * a real pipe row it must be flattened to words, but a layout table — one
   * cell wrapping a data table, the shape every Outlook mail is built from —
   * degrades to plain lines, and there the inner table keeps its Markdown.
   */
  const expandCell = (text: string, flatten: boolean): string => {
    let out = text;
    if (flatten) {
      for (const [marker, plain] of flattened) {
        if (out.includes(marker)) out = out.split(marker).join(plain);
      }
    }
    return lot.restore(out).split(blockBreak).join('\n').trim();
  };

  let out = html;
  let merged = 0;

  // Every iteration consumes exactly one `<table>` opener — the innermost match
  // is replaced by a marker holding no tags — so the number of openers is an
  // exact bound and no real document can hit it. The old fixed cap of 100 was a
  // silent data-corruption cliff: table 101 kept its markup, and the generic
  // tag-stripper then glued its cells together into `EnterpriseNCC-1701`.
  const limit = (html.match(/<table\b/gi) ?? []).length;

  for (let guard = 0; guard <= limit; guard++) {
    const match = INNERMOST_TABLE.exec(out);
    if (!match) break;

    const inner = match[1] ?? '';
    // Cells are carried with their markers unexpanded, so both forms stay
    // available until the grid decides which one this table needs.
    const rawRows = [...inner.matchAll(ROW)].map((m) => parseRow(m[1] ?? '', cellText));

    const grid = toGrid(rawRows.filter((cells) => cells.length > 0));
    merged += grid.merged;

    const expand = (flatten: boolean): string[][] =>
      grid.rows.map((row) => row.map((cell) => expandCell(cell, flatten)));

    const table = renderTable(expand(true));
    const text = table ?? expand(false).map((row) => row.join(' ')).join('\n');

    // A table is a block, and the `<table>` tag that would have supplied its
    // breaks is being consumed here. Without them two adjacent markers restore
    // back to back and the first separator row welds onto the second header.
    // These are the caller's own break sentinel, so they collapse with any
    // neighbouring break instead of stacking into blank lines — and a marker
    // nested in a cell has them folded away by `restoredCell`.
    const parked = lot.park(text);
    flattened.set(parked, grid.rows.map((row) => row.join(' ')).join(' ').trim());
    const marker = `${blockBreak}${blockBreak}${parked}${blockBreak}${blockBreak}`;
    out = out.slice(0, match.index) + marker + out.slice(match.index + match[0].length);
  }

  return { html: out, merged };
}
