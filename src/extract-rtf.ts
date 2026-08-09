/**
 * Minimal, best-effort de-RTF.
 *
 * The motivating input is a Word/Outlook clipboard paste, where every embedded
 * image arrives as a multi-megabyte hex blob inside `{\pict ...}`. Dropping
 * those destination groups is the whole point; faithful formatting is not.
 */

import { renderTable } from './utils/markdown-table.js';

/** Destination groups whose contents are metadata or binary, never prose. */
const SKIP_DESTINATIONS = new Set([
  'fonttbl', 'colortbl', 'stylesheet', 'listtable', 'listoverridetable',
  'info', 'pict', 'object', 'objdata', 'themedata', 'colorschememapping',
  'datastore', 'latentstyles', 'rsidtbl', 'generator', 'xmlnstbl',
  'filetbl', 'revtbl', 'upr', 'mmathPr', 'wgrffmtfilter', 'nonesttables',
  'header', 'footer', 'headerl', 'headerr', 'headerf', 'footerl', 'footerr',
  'footerf', 'ftnsep', 'ftnsepc', 'aftnsep', 'aftnsepc', 'bkmkstart',
  'bkmkend', 'shppict', 'nonshppict', 'fldinst', 'panose', 'falt',
]);

/**
 * Marks a `\cell` boundary until the table pass runs.
 *
 * A tab cannot do this job: `tabsToSpaces` and `collapseSpaces` in clean.ts
 * turn a tab-separated row into indistinguishable prose, which is exactly how
 * RTF tables used to be destroyed after extraction had done its part.
 */
const CELL_MARK = '\u001f';

/**
 * Marks a row boundary: `\row`, `\trowd`, or a paragraph break outside a table.
 *
 * A newline cannot do this job either. Word writes a multi-paragraph table cell
 * as `\intbl ...\par ...\cell`, so splitting rows on newlines tore the first
 * line of such a cell out of the table and left it stranded as prose above it.
 */
const ROW_MARK = '\u001e';

/**
 * Both sentinels, wherever they came from. A document may legitimately contain
 * U+001F (as `\u31`, `\'1f`, or a raw byte); left alone it fabricates a table
 * out of ordinary prose, so document text is scrubbed of both marks and only
 * the ones this scanner emits itself reach the table pass.
 */
const SENTINELS = new RegExp(`[${ROW_MARK}${CELL_MARK}]`, 'g');

/** Breaks that end a paragraph, and so end a table row when outside a table. */
const PARAGRAPH_BREAKS = new Set(['par', 'sect', 'page']);

/** Control words that emit whitespace rather than formatting. */
const BREAKS: Readonly<Record<string, string>> = {
  par: '\n',
  line: '\n',
  sect: '\n\n',
  page: '\n\n',
  softline: '\n',
  row: ROW_MARK,
  cell: CELL_MARK,
  nestcell: CELL_MARK,
  nestrow: ROW_MARK,
  tab: '\t',
  emdash: '—',
  endash: '–',
  emspace: ' ',
  enspace: ' ',
  qmspace: ' ',
  bullet: '•',
  lquote: '‘',
  rquote: '’',
  ldblquote: '“',
  rdblquote: '”',
  ltrmark: '',
  rtlmark: '',
  zwbo: '',
  zwj: '',
  zwnj: '',
};

interface Block {
  text: string;
  /** Rendered as Markdown pipe rows, so it needs a blank line on either side. */
  table: boolean;
}

/** One cell on one line, matching what `escapeCell` does inside a real table. */
function flattenCell(cell: string): string {
  return cell.replace(/\s+/g, ' ').trim();
}

/**
 * Turn each run of cell-marked rows into a Markdown table.
 *
 * Rows are delimited by `ROW_MARK`, never by newlines: a `\line` or a `\par`
 * inside a cell is cell content, and the emitter collapses it to a space.
 *
 * RTF has no table header concept, so the first row of a run is treated as one
 * — the same best-effort call the HTML path makes for a `<table>` whose first
 * row happens to use `<th>`.
 */
function renderCellRuns(text: string): string {
  const blocks: Block[] = [];
  let run: string[][] = [];

  const flush = (): void => {
    if (run.length === 0) return;
    const table = renderTable(run);
    blocks.push(
      table !== null
        ? { text: table, table: true }
        : { text: run.map((cells) => cells.map(flattenCell).join(' ')).join('\n'), table: false },
    );
    run = [];
  };

  for (const segment of text.split(ROW_MARK)) {
    if (segment.includes(CELL_MARK)) {
      // A trailing `\cell` before `\row` leaves an empty final field.
      const cells = segment.split(CELL_MARK);
      if (cells.at(-1)?.trim() === '') cells.pop();
      run.push(cells);
      continue;
    }
    // `\trowd` marks a row boundary too, so a run's rows are separated by an
    // empty segment that carries no content and must not break the run.
    if (segment.trim() === '') {
      if (run.length === 0) blocks.push({ text: '', table: false });
      continue;
    }
    flush();
    blocks.push({ text: segment, table: false });
  }
  flush();

  // A GFM table body runs until a blank line, so prose that follows a table
  // without one is read as another row of it — the same reason the HTML path
  // puts a blank line between a `<table>` and the `<p>` after it.
  return blocks
    .map((block, i) => {
      const previous = blocks[i - 1];
      if (previous === undefined) return block.text;
      return (block.table || previous.table ? '\n\n' : '\n') + block.text;
    })
    .join('');
}

/** cp1252 mappings for 0x80-0x9F; the rest of the range is latin-1. */
const CP1252_HIGH = [
  0x20ac, 0x0081, 0x201a, 0x0192, 0x201e, 0x2026, 0x2020, 0x2021,
  0x02c6, 0x2030, 0x0160, 0x2039, 0x0152, 0x008d, 0x017d, 0x008f,
  0x0090, 0x2018, 0x2019, 0x201c, 0x201d, 0x2022, 0x2013, 0x2014,
  0x02dc, 0x2122, 0x0161, 0x203a, 0x0153, 0x009d, 0x017e, 0x0178,
];

function cp1252(byte: number): string {
  if (byte >= 0x80 && byte <= 0x9f) {
    return String.fromCharCode(CP1252_HIGH[byte - 0x80] ?? byte);
  }
  return String.fromCharCode(byte);
}

interface GroupState {
  /** Everything inside this group is discarded. */
  skip: boolean;
  /** Chars to swallow after each `\uN`, from `\ucN`. */
  uc: number;
}

export interface RtfExtraction {
  text: string;
  droppedPictures: number;
}

/**
 * Walk the RTF byte-for-byte. A hand-rolled scanner rather than regexes
 * because group nesting (and therefore what to skip) cannot be expressed
 * as a regular language.
 */
export function rtfToText(rtf: string): RtfExtraction {
  const out: string[] = [];
  const stack: GroupState[] = [];
  let state: GroupState = { skip: false, uc: 1 };
  let droppedPictures = 0;
  /** Set when `\*` was just seen: the next control word names a destination. */
  let pendingIgnorable = false;
  /** Unicode replacement chars still to swallow after a `\uN`. */
  let swallow = 0;
  /** Inside a table row: set by `\trowd`/`\intbl`/`\cell`, cleared by `\row`. */
  let inTable = false;

  /** A mark this scanner produced; never document content. */
  const emit = (s: string): void => {
    if (!state.skip) out.push(s);
  };

  /** Document content, which may not carry a sentinel of its own. */
  const emitText = (s: string): void => {
    if (state.skip) return;
    const scrubbed = s.replace(SENTINELS, '');
    if (scrubbed !== '') out.push(scrubbed);
  };

  const n = rtf.length;
  let i = 0;

  while (i < n) {
    const ch = rtf[i] as string;

    if (ch === '{') {
      stack.push(state);
      state = { skip: state.skip, uc: state.uc };
      pendingIgnorable = false;
      i += 1;
      continue;
    }
    if (ch === '}') {
      state = stack.pop() ?? { skip: false, uc: 1 };
      pendingIgnorable = false;
      swallow = 0;
      i += 1;
      continue;
    }
    if (ch === '\r' || ch === '\n') {
      i += 1;
      continue;
    }
    if (ch !== '\\') {
      if (swallow > 0) {
        swallow -= 1;
      } else {
        emitText(ch);
      }
      i += 1;
      continue;
    }

    // A backslash: an escape, a hex byte, or a control word.
    const next = rtf[i + 1];
    if (next === undefined) break;

    if (next === '\\' || next === '{' || next === '}') {
      if (swallow > 0) swallow -= 1;
      else emitText(next);
      i += 2;
      continue;
    }
    if (next === '*') {
      pendingIgnorable = true;
      i += 2;
      continue;
    }
    if (next === '\n' || next === '\r') {
      emit('\n');
      i += 2;
      continue;
    }
    if (next === "'") {
      const hex = rtf.slice(i + 2, i + 4);
      i += 4;
      if (/^[0-9a-fA-F]{2}$/.test(hex)) {
        if (swallow > 0) swallow -= 1;
        else emitText(cp1252(parseInt(hex, 16)));
      }
      continue;
    }
    if (!/[a-zA-Z]/.test(next)) {
      // A non-alphabetic control symbol (\~, \-, \_ ...). Only the ones that
      // carry text are worth keeping.
      if (next === '~') emit(' ');
      else if (next === '_') emit('-');
      i += 2;
      continue;
    }

    let j = i + 1;
    while (j < n && /[a-zA-Z]/.test(rtf[j] as string)) j += 1;
    const word = rtf.slice(i + 1, j);
    let numText = '';
    if (rtf[j] === '-') {
      numText = '-';
      j += 1;
    }
    while (j < n && rtf[j] !== undefined && /[0-9]/.test(rtf[j] as string)) {
      numText += rtf[j] as string;
      j += 1;
    }
    // A single space after a control word is its delimiter, not content.
    if (rtf[j] === ' ') j += 1;
    i = j;

    if (pendingIgnorable) {
      pendingIgnorable = false;
      if (word === 'pict') droppedPictures += 1;
      state.skip = true;
      continue;
    }
    if (SKIP_DESTINATIONS.has(word)) {
      if (word === 'pict') droppedPictures += 1;
      state.skip = true;
      continue;
    }
    if (word === 'uc') {
      state.uc = Number(numText) || 0;
      continue;
    }
    if (word === 'u' && numText !== '') {
      let code = Number(numText);
      if (code < 0) code += 65536;
      emitText(String.fromCharCode(code));
      swallow = state.uc;
      continue;
    }
    if (word === 'trowd' || word === 'intbl' || word === 'nesttableprops') {
      // `\trowd` opens a row definition, so whatever precedes it is not part of
      // the first cell. `\intbl` recurs once per paragraph inside the row and so
      // marks the context without closing anything.
      if (word === 'trowd') emit(ROW_MARK);
      inTable = true;
      continue;
    }
    const brk = BREAKS[word];
    if (brk !== undefined) {
      if (brk === CELL_MARK) inTable = true;
      else if (brk === ROW_MARK) inTable = false;
      // Outside a table a paragraph break also ends any row being gathered;
      // inside one it is cell content, which is what a multi-paragraph cell is
      // made of.
      const paragraph = !inTable && PARAGRAPH_BREAKS.has(word);
      emit(paragraph ? `${brk.slice(0, -1)}${ROW_MARK}` : brk);
      swallow = 0;
      continue;
    }
    // Anything else is formatting; the `rtf`/`ansi` header words included.
  }

  let text = out.join('');
  text = text.replace(/\r\n?/g, '\n');
  text = renderCellRuns(text);
  text = text.replace(/[ \t]+\n/g, '\n');
  text = text.replace(/\n{3,}/g, '\n\n');
  return { text: text.trim(), droppedPictures };
}
