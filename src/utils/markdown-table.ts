/**
 * The one table emitter. Every extractor that recognises a table renders it
 * here, so docx, HTML, RTF (and later PPTX and PDF) cannot each invent their
 * own answer to escaping, header handling and merged cells.
 *
 * The leading and trailing bars are load-bearing rather than decorative:
 * `isTableRow` in clean-markdown.ts requires both, and it is what stops
 * `unwrap` from gluing table rows into the surrounding prose.
 */

const MIN_COLUMNS = 2;

/** Flatten one cell to something that cannot break out of its column. */
export function escapeCell(value: string): string {
  return value
    .replace(/\s+/g, ' ')
    .replace(/\|/g, '\\|')
    .trim();
}

function renderRow(cells: string[], width: number): string {
  const padded = Array.from({ length: width }, (_, i) => escapeCell(cells[i] ?? ''));
  return `| ${padded.join(' | ')} |`;
}

/**
 * Render `rows` as GitHub-flavoured Markdown, or `null` when the grid is not a
 * table at all — one column, or no cells. Returning `null` keeps that judgement
 * at the call site, which emits plain lines instead.
 *
 * GFM has no headerless table, and the first row is the header far more often
 * than not — Word emits no `<th>` at all, and RTF has no header concept — so
 * row one is promoted rather than a blank header row being synthesised, which
 * would spend tokens on nothing while still hiding the real header.
 */
export function renderTable(rows: string[][]): string | null {
  const width = rows.reduce((widest, row) => Math.max(widest, row.length), 0);
  if (rows.length === 0 || width < MIN_COLUMNS) return null;

  const separator = `| ${Array.from({ length: width }, () => '---').join(' | ')} |`;
  const [header, ...body] = rows.map((row) => renderRow(row, width));

  return [header, separator, ...body].join('\n');
}
