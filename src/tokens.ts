import type { Stats } from './types.js';

/**
 * Heuristic token estimation. This is deliberately NOT a real tokenizer — pulling in
 * a BPE vocabulary would cost more than the whole package. The shape mimics how BPE
 * behaves on the inputs slimdoc actually sees, and is calibrated so ordinary English
 * prose lands near `chars / 4`.
 */
/**
 * Letters per word chunk. Measured, not guessed: at 4 the estimate ran ~20% hot
 * against ordinary English prose (3.3 chars/token); 5 puts prose at 3.7-4.2
 * chars/token, i.e. the `chars / 4` the spec calls for, and reproduces cl100k
 * exactly on sentences like "The quick brown fox jumps over the lazy dog." (10).
 */
const LETTERS_PER_TOKEN = 5;
const DIGITS_PER_TOKEN = 3;
const PUNCT_PER_TOKEN = 4;

function isAsciiLetter(c: number): boolean {
  return (c >= 0x41 && c <= 0x5a) || (c >= 0x61 && c <= 0x7a);
}

/** Latin-1 supplement through Cyrillic: still word-shaped, still ~4 chars a token. */
function isLetter(c: number): boolean {
  if (c < 0x80) return isAsciiLetter(c);
  return (c >= 0x00c0 && c <= 0x02af) || (c >= 0x0370 && c <= 0x058f) || (c >= 0x0590 && c <= 0x07ff);
}

function isDigit(c: number): boolean {
  return c >= 0x30 && c <= 0x39;
}

/** Han, kana, Hangul: roughly one token per character in every common vocabulary. */
function isCjk(c: number): boolean {
  return (
    (c >= 0x3040 && c <= 0x30ff) ||
    (c >= 0x3400 && c <= 0x4dbf) ||
    (c >= 0x4e00 && c <= 0x9fff) ||
    (c >= 0xac00 && c <= 0xd7af) ||
    (c >= 0xf900 && c <= 0xfaff)
  );
}

function isSpace(c: number): boolean {
  return c === 0x20 || c === 0x09 || c === 0x0a || c === 0x0d || c === 0x0b || c === 0x0c;
}

/** `'` and `’` continue a word when a letter follows: "don't" is one chunk, not three. */
function isWordApostrophe(c: number): boolean {
  return c === 0x27 || c === 0x2019;
}

function isHighSurrogate(c: number): boolean {
  return c >= 0xd800 && c <= 0xdbff;
}

/**
 * Estimate the number of LLM tokens in `text`.
 *
 * Approximate only — expect a few percent of error against any given tokenizer, and
 * more on non-Latin scripts. Never treat the result as a billing figure.
 */
export function estimateTokens(text: string): number {
  const n = text.length;
  let tokens = 0;
  let i = 0;

  while (i < n) {
    const c = text.charCodeAt(i);

    if (isLetter(c)) {
      let j = i + 1;
      while (j < n) {
        const d = text.charCodeAt(j);
        if (isLetter(d)) {
          j++;
        } else if (isWordApostrophe(d) && j + 1 < n && isLetter(text.charCodeAt(j + 1))) {
          j += 2;
        } else {
          break;
        }
      }
      tokens += Math.ceil((j - i) / LETTERS_PER_TOKEN);
      i = j;
      continue;
    }

    if (isDigit(c)) {
      let j = i + 1;
      while (j < n && isDigit(text.charCodeAt(j))) j++;
      tokens += Math.ceil((j - i) / DIGITS_PER_TOKEN);
      i = j;
      continue;
    }

    if (isCjk(c)) {
      tokens += 1;
      i++;
      continue;
    }

    if (isSpace(c)) {
      // A space is absorbed into the token of the word that follows it; only a run
      // containing a line break costs anything.
      let j = i;
      let newline = false;
      while (j < n && isSpace(text.charCodeAt(j))) {
        if (text.charCodeAt(j) === 0x0a) newline = true;
        j++;
      }
      if (newline) tokens += 1;
      i = j;
      continue;
    }

    if (isHighSurrogate(c)) {
      // Astral plane: emoji and rare CJK. Emoji cost 2-3 tokens each; call it 2.
      tokens += 2;
      i += 2;
      continue;
    }

    // Punctuation and symbols. Short runs are one token ("...", "?!"), long rules
    // ("-----------") keep scaling.
    let j = i + 1;
    while (j < n) {
      const d = text.charCodeAt(j);
      if (isLetter(d) || isDigit(d) || isSpace(d) || isCjk(d) || isHighSurrogate(d)) break;
      j++;
    }
    tokens += Math.ceil((j - i) / PUNCT_PER_TOKEN);
    i = j;
  }

  return tokens;
}

function countLines(text: string): number {
  if (text.length === 0) return 0;
  let lines = 0;
  let idx = text.indexOf('\n');
  while (idx !== -1) {
    lines++;
    idx = text.indexOf('\n', idx + 1);
  }
  return text.endsWith('\n') ? lines : lines + 1;
}

/** Round to one decimal place, avoiding float noise like 34.99999999. */
function round1(n: number): number {
  return Math.round(n * 10) / 10;
}

export function computeStats(before: string, after: string): Stats {
  const tokensBefore = estimateTokens(before);
  const tokensAfter = estimateTokens(after);
  const saved = tokensBefore === 0 ? 0 : ((tokensBefore - tokensAfter) / tokensBefore) * 100;

  return {
    chars: { before: before.length, after: after.length },
    bytes: { before: Buffer.byteLength(before, 'utf8'), after: Buffer.byteLength(after, 'utf8') },
    lines: { before: countLines(before), after: countLines(after) },
    tokens: { before: tokensBefore, after: tokensAfter },
    savedPct: round1(Math.min(100, Math.max(0, saved))),
  };
}

const BYTE_UNITS = ['B', 'kB', 'MB', 'GB', 'TB'] as const;

/** SI units, one decimal place above a kilobyte: `938 B`, `1.2 kB`, `158.4 kB`. */
export function formatBytes(n: number): string {
  const negative = n < 0;
  let value = Math.abs(n);
  let unit = 0;
  while (value >= 1000 && unit < BYTE_UNITS.length - 1) {
    value /= 1000;
    unit++;
  }
  const rendered = unit === 0 ? String(Math.round(value)) : value.toFixed(1);
  return `${negative ? '-' : ''}${rendered} ${BYTE_UNITS[unit]}`;
}
