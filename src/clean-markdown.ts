/**
 * Markdown-shaped transforms: backslash unescaping, decoration stripping and table
 * compaction. All of these run on text whose code regions have already been lifted out,
 * so they never need to reason about code themselves.
 */

const HTML_COMMENT = /<!--[\s\S]*?-->/g;

const BOLD_ITALIC_STAR = /\*\*\*(?!\s)([^*\n]+?)(?<!\s)\*\*\*/g;
const BOLD_STAR = /\*\*(?!\s)([^*\n]+?)(?<!\s)\*\*/g;
const ITALIC_STAR = /(?<![\w*])\*(?!\s)([^*\n]+?)(?<!\s)\*(?![\w*])/g;
const BOLD_ITALIC_UNDER = /___(?!\s)([^_\n]+?)(?<!\s)___/g;
const BOLD_UNDER = /__(?!\s)([^_\n]+?)(?<!\s)__/g;
const ITALIC_UNDER = /(?<![\w_])_(?!\s)([^_\n]+?)(?<!\s)_(?![\w_])/g;
const STRIKE = /~~(?!\s)([^~\n]+?)(?<!\s)~~/g;

const MD_LINK = /(?<!!)\[([^\]\n]*)\]\(([^)\n]*)\)/g;
const MD_IMAGE = /!\[([^\]\n]*)\]\([^)\n]*\)/g;
const AUTOLINK = /<((?:https?|ftp|mailto):[^>\s]+)>/g;

const ATX_HEADING = /^([ \t]{0,3})#{1,6}(?:[ \t]+|$)/;
const ATX_CLOSING = /[ \t]+#+[ \t]*$/;
const BLOCKQUOTE = /^([ \t]{0,3})(?:>[ \t]?)+/;
const HORIZONTAL_RULE = /^ {0,3}(?:(?:\*[ \t]*){3,}|(?:-[ \t]*){3,}|(?:_[ \t]*){3,})$/;
const SETEXT_RULE = /^ {0,3}(?:=+|-+)[ \t]*$/;

const ESCAPE = /\\([\x21-\x2F\x3A-\x40\x5B-\x60\x7B-\x7E])/g;
const ESCAPE_KEEPING_PIPE = /\\([\x21-\x2F\x3A-\x40\x5B-\x60\x7B-\x7B\x7D-\x7E])/g;

/**
 * Mammoth escapes every ASCII punctuation character it emits (`AI\-generated`), which
 * costs a token per escape and reads badly. Drop the backslash before ASCII punctuation;
 * because the scan continues after each match, `\\` collapses to a single `\`.
 */
export function unescapeMarkdown(text: string): string {
  if (text.indexOf('\\') === -1) return text;
  const lines = text.split('\n');
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i] ?? '';
    if (line.indexOf('\\') === -1) continue;
    // Inside a table row `\|` is load-bearing: unescaping it would split the cell.
    lines[i] = line.replace(isTableRow(line) ? ESCAPE_KEEPING_PIPE : ESCAPE, (_m, ch: string) => ch);
  }
  return lines.join('\n');
}

export function stripMarkdown(text: string): string {
  let s = text.replace(HTML_COMMENT, '');
  s = s.replace(MD_IMAGE, '');
  s = s.replace(BOLD_ITALIC_STAR, '$1').replace(BOLD_ITALIC_UNDER, '$1');
  s = s.replace(BOLD_STAR, '$1').replace(BOLD_UNDER, '$1');
  s = s.replace(ITALIC_STAR, '$1').replace(ITALIC_UNDER, '$1');
  s = s.replace(STRIKE, '$1');
  s = s.replace(MD_LINK, '$1');
  s = s.replace(AUTOLINK, '$1');
  return stripBlockMarkers(s);
}

/**
 * Dropping `#`, `>` and rules also drops the boundaries that told `unwrap` where a block
 * ended, so a line that used to be safe would be swallowed on the next run. Wherever a
 * boundary is destroyed a blank line takes its place, which keeps `clean()` idempotent
 * and reads better. `maxBlankLines: 0` squeezes those blanks out again afterwards.
 */
function stripBlockMarkers(text: string): string {
  const lines = text.split('\n');
  const out: string[] = [];
  let needBlank = false;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i] ?? '';
    const isSetext = SETEXT_RULE.test(line) && (lines[i - 1] ?? '').trim() !== '';
    if (HORIZONTAL_RULE.test(line) || isSetext) {
      needBlank = true;
      continue;
    }
    const { text: stripped, wasHeading } = stripLineMarkers(line);
    if (stripped !== line && isBlockStart(line) && !isBlockStart(stripped)) needBlank = true;
    const last = out[out.length - 1] ?? '';
    if (needBlank && out.length > 0 && last.trim() !== '' && stripped.trim() !== '') out.push('');
    needBlank = wasHeading;
    out.push(stripped);
  }
  return out.join('\n');
}

function stripLineMarkers(line: string): { text: string; wasHeading: boolean } {
  const dequoted = line.replace(BLOCKQUOTE, '$1');
  if (!ATX_HEADING.test(dequoted)) return { text: dequoted, wasHeading: false };
  return { text: dequoted.replace(ATX_HEADING, '$1').replace(ATX_CLOSING, ''), wasHeading: true };
}

// The `<` case is a real HTML tag or comment, not an autolink such as `<https://x>`:
// stripMarkdown unwraps autolinks, so treating them as blocks would not survive a
// second run.
const BLOCK_START =
  /^(?:#{1,6}(?:[ \t]|$)|>|\||[-*+][ \t]|\d+[.)][ \t]|`{3,}|~{3,}|<!|<\/?[A-Za-z][A-Za-z0-9-]*(?:[\s/>]|$))/;
const DEEP_INDENT = /^(?: {4,}|\t)/;

/** A line that opens a Markdown block, so a wrapped line above must not absorb it. */
export function isBlockStart(line: string): boolean {
  return DEEP_INDENT.test(line) || BLOCK_START.test(line.replace(/^ {1,3}/, ''));
}

export function isTableRow(line: string): boolean {
  const t = line.trim();
  return t.length >= 2 && t.startsWith('|') && t.endsWith('|') && countPipes(t) >= 2;
}

function countPipes(row: string): number {
  let n = 0;
  for (let i = 0; i < row.length; i++) {
    if (row[i] === '\\') { i++; continue; }
    if (row[i] === '|') n++;
  }
  return n;
}

/** Split on unescaped pipes, dropping the empty cells outside the leading/trailing bar. */
function splitCells(row: string): string[] {
  const cells: string[] = [];
  let cur = '';
  for (let i = 0; i < row.length; i++) {
    const ch = row[i] ?? '';
    if (ch === '\\' && row[i + 1] === '|') { cur += '\\|'; i++; continue; }
    if (ch === '|') { cells.push(cur); cur = ''; continue; }
    cur += ch;
  }
  cells.push(cur);
  return cells.slice(1, -1);
}

const SEPARATOR_CELL = /^[ \t]*(:?)-+(:?)[ \t]*$/;

function compactCell(cell: string): string {
  const sep = SEPARATOR_CELL.exec(cell);
  if (sep) return `${sep[1] ?? ''}---${sep[2] ?? ''}`;
  return cell.trim();
}

export function compactTables(text: string): string {
  if (text.indexOf('|') === -1) return text;
  const lines = text.split('\n');
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i] ?? '';
    if (!isTableRow(line)) continue;
    const cells = splitCells(line.trim()).map(compactCell);
    if (cells.length === 0) continue;
    lines[i] = `| ${cells.join(' | ')} |`;
  }
  return lines.join('\n');
}
