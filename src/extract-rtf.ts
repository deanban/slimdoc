/**
 * Minimal, best-effort de-RTF.
 *
 * The motivating input is a Word/Outlook clipboard paste, where every embedded
 * image arrives as a multi-megabyte hex blob inside `{\pict ...}`. Dropping
 * those destination groups is the whole point; faithful formatting is not.
 */

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

/** Control words that emit whitespace rather than formatting. */
const BREAKS: Readonly<Record<string, string>> = {
  par: '\n',
  line: '\n',
  sect: '\n\n',
  page: '\n\n',
  softline: '\n',
  row: '\n',
  cell: '\t',
  nestcell: '\t',
  nestrow: '\n',
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

  const emit = (s: string): void => {
    if (!state.skip) out.push(s);
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
        emit(ch);
      }
      i += 1;
      continue;
    }

    // A backslash: an escape, a hex byte, or a control word.
    const next = rtf[i + 1];
    if (next === undefined) break;

    if (next === '\\' || next === '{' || next === '}') {
      if (swallow > 0) swallow -= 1;
      else emit(next);
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
        else emit(cp1252(parseInt(hex, 16)));
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
      if (!state.skip) out.push(String.fromCharCode(code));
      swallow = state.uc;
      continue;
    }
    const brk = BREAKS[word];
    if (brk !== undefined) {
      emit(brk);
      swallow = 0;
      continue;
    }
    // Anything else is formatting; the `rtf`/`ansi` header words included.
  }

  let text = out.join('');
  text = text.replace(/\r\n?/g, '\n');
  text = text.replace(/[ \t]+\n/g, '\n');
  text = text.replace(/\n{3,}/g, '\n\n');
  return { text: text.trim(), droppedPictures };
}
