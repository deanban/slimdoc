/**
 * Protected regions: fenced/indented code blocks and inline code spans are lifted out
 * of the text before any rewriting step runs and put back verbatim at the very end.
 *
 * The placeholders are built from Private Use Area code points because those survive
 * every transform in the pipeline untouched: NFKC leaves PUA alone, they are not
 * Extended_Pictographic (so `stripEmoji` skips them) and they are neither control nor
 * zero-width characters (so `stripInvisible` skips them). Any PUA sentinel already
 * present in the caller's text is removed up front, which makes the tokens unique.
 */

/** Wraps a fenced or indented code block, always alone on its own line. */
export const BLOCK_MARK = '\uE000';
/** Wraps an inline code span, sitting inside a line of prose. */
export const INLINE_MARK = '\uE001';
/** Marks the hole left by removed media or emoji, so line tidying can see it. */
export const DROP_MARK = '\uE002';

const SENTINELS = /[\uE000-\uE002]/g;

const BLOCK_PLACEHOLDER = /^\uE000\d+\uE000$/;
const BLOCK_TOKEN = /\uE000(\d+)\uE000/g;
const INLINE_TOKEN = /\uE001(\d+)\uE001/g;
const DROP_RUN = /[ \t]*\uE002+[ \t]*/g;

export interface Protection {
  blocks: string[];
  inlines: string[];
}

export function createProtection(): Protection {
  return { blocks: [], inlines: [] };
}

/** Strip any sentinel the caller's own text happens to contain. */
export function stripSentinels(text: string): string {
  return text.replace(SENTINELS, '');
}

export function isBlockPlaceholder(line: string): boolean {
  return BLOCK_PLACEHOLDER.test(line);
}

export function protect(text: string, store: Protection): string {
  return protectInline(protectBlocks(text, store), store);
}

export function restore(text: string, store: Protection): string {
  const inlined = text.replace(INLINE_TOKEN, (_m, n: string) => store.inlines[Number(n)] ?? '');
  return inlined.replace(BLOCK_TOKEN, (_m, n: string) => store.blocks[Number(n)] ?? '');
}

interface Fence {
  char: string;
  length: number;
}

/** ``` or ~~~ with at least three markers, indented no more than three spaces. */
function openingFence(line: string): Fence | null {
  const m = /^ {0,3}(`{3,}|~{3,})(.*)$/.exec(line);
  if (!m) return null;
  const run = m[1] ?? '';
  const info = m[2] ?? '';
  // A backtick fence may not carry a backtick in its info string (CommonMark).
  if (run[0] === '`' && info.indexOf('`') !== -1) return null;
  return { char: run[0] ?? '`', length: run.length };
}

function isClosingFence(line: string, fence: Fence): boolean {
  const m = /^ {0,3}(`{3,}|~{3,})[ \t]*$/.exec(line);
  if (!m) return false;
  const run = m[1] ?? '';
  return run[0] === fence.char && run.length >= fence.length;
}

function isBlank(line: string): boolean {
  return line.trim() === '';
}

function isIndentedCodeLine(line: string): boolean {
  return (line.startsWith('    ') || line.startsWith('\t')) && !isBlank(line);
}

/**
 * An indented code block only starts after a blank line, and only when the block above
 * it is not a list — otherwise a wrapped list continuation would be frozen as code and
 * never cleaned.
 */
function startsIndentedCode(lines: string[], i: number): boolean {
  if (!isIndentedCodeLine(lines[i] ?? '')) return false;
  if (i === 0) return true;
  if (!isBlank(lines[i - 1] ?? '')) return false;
  for (let j = i - 1; j >= 0; j--) {
    const prev = lines[j] ?? '';
    if (isBlank(prev)) continue;
    if (/^ {0,3}(?:[-*+][ \t]|\d+[.)][ \t])/.test(prev)) return false;
    return !prev.startsWith('  ');
  }
  return true;
}

function protectBlocks(text: string, store: Protection): string {
  const lines = text.split('\n');
  const out: string[] = [];
  let i = 0;
  while (i < lines.length) {
    const line = lines[i] ?? '';
    const fence = openingFence(line);
    if (fence) {
      const start = i;
      i++;
      while (i < lines.length && !isClosingFence(lines[i] ?? '', fence)) i++;
      if (i < lines.length) i++; // consume the closing fence
      out.push(stash(store.blocks, lines.slice(start, i).join('\n'), BLOCK_MARK));
      continue;
    }
    if (startsIndentedCode(lines, i)) {
      const start = i;
      while (i < lines.length && (isIndentedCodeLine(lines[i] ?? '') || isBlank(lines[i] ?? ''))) i++;
      let end = i;
      while (end > start && isBlank(lines[end - 1] ?? '')) end--; // trailing blanks are not code
      out.push(stash(store.blocks, lines.slice(start, end).join('\n'), BLOCK_MARK));
      i = end;
      continue;
    }
    out.push(line);
    i++;
  }
  return out.join('\n');
}

function stash(bucket: string[], value: string, mark: string): string {
  bucket.push(value);
  return `${mark}${bucket.length - 1}${mark}`;
}

/** Code spans are matched within a single line: a paired run of N backticks. */
function protectInline(text: string, store: Protection): string {
  if (text.indexOf('`') === -1) return text;
  const lines = text.split('\n');
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i] ?? '';
    if (line.indexOf('`') === -1 || isBlockPlaceholder(line)) continue;
    lines[i] = protectInlineInLine(line, store);
  }
  return lines.join('\n');
}

function protectInlineInLine(line: string, store: Protection): string {
  let out = '';
  let i = 0;
  while (i < line.length) {
    const tick = line.indexOf('`', i);
    if (tick === -1) return out + line.slice(i);
    out += line.slice(i, tick);
    const run = runLength(line, tick);
    const close = findRun(line, tick + run, run);
    if (close === -1) {
      out += line.slice(tick, tick + run);
      i = tick + run;
      continue;
    }
    out += stash(store.inlines, line.slice(tick, close + run), INLINE_MARK);
    i = close + run;
  }
  return out;
}

function runLength(line: string, from: number): number {
  let n = 0;
  while (line[from + n] === '`') n++;
  return n;
}

/** Index of the next backtick run of exactly `n` ticks, or -1. */
function findRun(line: string, from: number, n: number): number {
  let i = from;
  while (i < line.length) {
    const tick = line.indexOf('`', i);
    if (tick === -1) return -1;
    const m = runLength(line, tick);
    if (m === n) return tick;
    i = tick + m;
  }
  return -1;
}

/**
 * Tidy the holes left behind by media/emoji removal: a line that carried nothing but
 * dropped content disappears completely (so it does not become a stray blank line),
 * and an inline hole never leaves a double space behind.
 */
export function collapseDropMarks(
  text: string,
  dropLine?: (line: string) => boolean,
): string {
  const lines = text.split('\n');
  const out: string[] = [];
  for (const line of lines) {
    if (dropLine && dropLine(line)) continue;
    if (line.indexOf(DROP_MARK) === -1) {
      out.push(line);
      continue;
    }
    const tidied = tidyDropMarks(line);
    if (tidied.trim() === '') continue;
    out.push(tidied);
  }
  return out.join('\n');
}

function tidyDropMarks(line: string): string {
  return line.replace(DROP_RUN, (m: string, offset: number, whole: string) => {
    const atStart = offset === 0;
    const atEnd = offset + m.length === whole.length;
    if (atStart || atEnd) return '';
    return /[ \t]/.test(m) ? ' ' : '';
  });
}
