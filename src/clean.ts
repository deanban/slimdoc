import { resolveOptions, type CleanOptions, type Stats } from './types.js';
import {
  createProtection,
  isBlockPlaceholder,
  protect,
  restore,
  stripSentinels,
  collapseDropMarks,
  DROP_MARK,
} from './clean-protect.js';
import { stripMedia } from './clean-media.js';
import {
  compactTables,
  isBlockStart,
  isTableRow,
  stripMarkdown,
  unescapeMarkdown,
} from './clean-markdown.js';
import { computeStats } from './tokens.js';
import { tidyTranscript } from './transcript.js';

const cp = (code: number): string => String.fromCodePoint(code);
const charClass = (codes: readonly number[]): string => codes.map(cp).join('');

/** Vertical tab and form feed are line breaks in practice; so are U+2028/U+2029. */
const LINE_BREAK = new RegExp(`\r\n|\r|[\x0b\x0c${charClass([0x2028, 0x2029])}]`, 'g');

const INVISIBLE = new RegExp(
  `[${charClass([
    0x00ad, 0x061c, 0x180e, 0x200b, 0x200c, 0x200d, 0x200e, 0x200f,
    0x2060, 0x2066, 0x2067, 0x2068, 0x2069, 0xfeff,
  ])}]`,
  'g',
);
/** C0 and C1 controls, keeping only \n and \t. */
const CONTROLS = /[\x00-\x08\x0b\x0c\x0e-\x1f\x7f-\x9f]/g;

const EMOJI = new RegExp(
  `[\\p{Extended_Pictographic}\\p{Regional_Indicator}\\p{Emoji_Modifier}${charClass([
    0xfe0e, 0xfe0f, 0x20e3, 0x200d,
  ])}]`,
  'gu',
);

const PUNCTUATION_FOLD: ReadonlyArray<readonly [string, readonly number[]]> = [
  ["'", [0x2018, 0x2019, 0x201a, 0x201b, 0x2032, 0x00b4, 0x02bc]],
  ['"', [0x201c, 0x201d, 0x201e, 0x201f, 0x2033, 0x00ab, 0x00bb]],
  ['-', [0x2010, 0x2011, 0x2013, 0x2014, 0x2015, 0x2043, 0x2212]],
  ['...', [0x2026]],
  [' ', [0x00a0, 0x1680, 0x2000, 0x2001, 0x2002, 0x2003, 0x2004, 0x2005, 0x2006,
    0x2007, 0x2008, 0x2009, 0x200a, 0x202f, 0x205f, 0x3000]],
  ['->', [0x2192]],
  ['<-', [0x2190]],
  ['=>', [0x21d2]],
  ['<=', [0x2264]],
  ['>=', [0x2265]],
  ['x', [0x00d7]],
];

const FOLD_MAP = new Map<string, string>();
for (const [to, codes] of PUNCTUATION_FOLD) {
  for (const code of codes) FOLD_MAP.set(cp(code), to);
}
// Every key is non-ASCII, so none of them is a character-class metacharacter.
const FOLDABLE = new RegExp(`[${[...FOLD_MAP.keys()].join('')}]`, 'g');

const LEADING_BULLET = new RegExp(
  `^([ \t]*)[${charClass([
    0x2022, 0x00b7, 0x25cf, 0x25cb, 0x25aa, 0x25a0, 0x2023, 0x2043, 0x25e6, 0x2219,
  ])}][ \t]*`,
  'gm',
);

const HEADING_LINE = /^[ \t]{0,3}#{1,6}(?:[ \t]|$)/;
const RULE_LINE = /^ {0,3}(?:=+|-+|(?:\*[ \t]*){3,}|(?:_[ \t]*){3,})[ \t]*$/;
const LINK_REF_DEF = /^[ \t]{0,3}\[[^\]\n]+\]:/;

export function clean(text: string, options?: Partial<CleanOptions>): string {
  const opts = resolveOptions(options);
  const store = createProtection();

  let s = stripSentinels(text).replace(LINE_BREAK, '\n');
  if (opts.preserveCode) s = protect(s, store);
  if (opts.stripInvisible) s = s.replace(INVISIBLE, '').replace(CONTROLS, '');
  if (opts.normalizeUnicode) s = s.normalize('NFKC');
  if (opts.asciiPunctuation) s = foldPunctuation(s);
  if (opts.stripEmoji) s = removeEmoji(s);
  if (opts.tabsToSpaces) s = s.replace(/\t/g, ' ');
  if (opts.stripMedia) s = stripMedia(s);
  if (opts.unescapeMarkdown) s = unescapeMarkdown(s);
  if (opts.compactTables) s = compactTables(s);
  if (opts.collapseSpaces) s = collapseSpaces(s, opts.stripMarkdown);
  if (opts.trimLines) s = trimLines(s);
  if (opts.unwrap) s = unwrap(s);

  const maxBlank = blankLineLimit(opts.maxBlankLines);
  s = limitBlankLines(s, maxBlank);
  if (opts.transcript) {
    // Runs before stripMarkdown: a Teams export marks the speaker with `__Name__`, and
    // without that emphasis the header is indistinguishable from the utterance above it.
    // The tidy pass deletes whole lines, so blank runs have to be squeezed again.
    s = limitBlankLines(tidyTranscript(s), maxBlank);
  }
  if (opts.stripMarkdown) s = limitBlankLines(stripMarkdown(s), maxBlank);

  if (opts.preserveCode) s = restore(s, store);
  return finalise(s);
}

export function cleanWithStats(
  text: string,
  options?: Partial<CleanOptions>,
): { text: string; stats: Stats } {
  const cleaned = clean(text, options);
  return { text: cleaned, stats: computeStats(text, cleaned) };
}

function blankLineLimit(value: number): number {
  return Number.isFinite(value) ? Math.max(0, Math.floor(value)) : 1;
}

/**
 * Fold typographic punctuation to ASCII. Line-leading bullets become `- ` first, so the
 * bullet characters that are also dashes (U+2043) are read as list markers, not dashes.
 * Nothing here adds or removes a space: `a—b` -> `a-b` and ` — ` -> ` - `.
 */
function foldPunctuation(text: string): string {
  const bulleted = text.replace(LEADING_BULLET, '$1- ');
  return bulleted.replace(FOLDABLE, (ch: string) => FOLD_MAP.get(ch) ?? ch);
}

function removeEmoji(text: string): string {
  return collapseDropMarks(text.replace(EMOJI, DROP_MARK));
}

/** Runs of spaces collapse to one, but a line's indentation is structure and stays. */
function collapseSpaces(text: string, normalizeIndent: boolean): string {
  const lines = text.split('\n');
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i] ?? '';
    const indentLength = (/^[ \t]*/.exec(line)?.[0] ?? '').length;
    const body = line.slice(indentLength).replace(/ {2,}/g, ' ');
    const indent = normalizeIndent
      ? ' '.repeat(Math.floor(indentLength / 2) * 2)
      : line.slice(0, indentLength);
    lines[i] = indent + body;
  }
  return lines.join('\n');
}

/** Trailing whitespace goes, including a two-space hard break: the newline survives. */
function trimLines(text: string): string {
  return text.replace(/[ \t]+$/gm, '');
}

/**
 * Join hard-wrapped lines back into one line per paragraph.
 *
 * The guard on documents that contain no blank line at all is what keeps `clean()`
 * idempotent: at `maxBlankLines: 0` the previous run has already put each paragraph on
 * its own line and removed every blank, so without the guard a second run would glue
 * those paragraphs together. A document with no blank lines has no paragraph structure
 * left to recover, so skipping is also the honest answer.
 */
function unwrap(text: string): string {
  const lines = text.split('\n');
  if (!hasInteriorBlankLine(lines)) return text;
  const out: string[] = [];
  for (const line of lines) {
    const prev = out[out.length - 1];
    if (prev !== undefined && canJoin(prev, line)) {
      out[out.length - 1] = `${prev} ${line.trim()}`;
      continue;
    }
    out.push(line);
  }
  return out.join('\n');
}

/** Blank lines that actually separate two paragraphs — not the document's own padding. */
function hasInteriorBlankLine(lines: string[]): boolean {
  let first = -1;
  let last = -1;
  for (let i = 0; i < lines.length; i++) {
    if ((lines[i] ?? '').trim() === '') continue;
    if (first === -1) first = i;
    last = i;
  }
  if (first === -1) return false;
  for (let i = first + 1; i < last; i++) {
    if ((lines[i] ?? '').trim() === '') return true;
  }
  return false;
}

function canJoin(prev: string, next: string): boolean {
  if (prev.trim() === '' || next.trim() === '') return false;
  if (isBlockPlaceholder(prev.trim()) || isBlockPlaceholder(next.trim())) return false;
  if (prev.endsWith('\\')) return false;
  if (HEADING_LINE.test(prev) || isTableRow(prev) || RULE_LINE.test(prev)) return false;
  if (LINK_REF_DEF.test(prev) || LINK_REF_DEF.test(next)) return false;
  return !RULE_LINE.test(next) && !isBlockStart(next);
}

/** Collapse blank runs. Lines are still joined by a newline, so paragraphs stay apart. */
function limitBlankLines(text: string, max: number): string {
  const out: string[] = [];
  let blanks = 0;
  for (const line of text.split('\n')) {
    if (line.trim() === '') {
      blanks++;
      if (blanks <= max) out.push('');
      continue;
    }
    blanks = 0;
    out.push(line);
  }
  return out.join('\n');
}

function finalise(text: string): string {
  const body = text.replace(/^(?:[ \t]*\n)+/, '').replace(/\n(?:[ \t]*\n)*[ \t]*$/, '');
  return body === '' ? '' : `${body}\n`;
}
