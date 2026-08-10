/**
 * Check `estimateTokens` against a real BPE vocabulary.
 *
 * `src/tokens.ts` is deliberately dependency-free — a BPE table would cost more
 * than the whole package — so its constants are calibrated here instead and the
 * numbers recorded in its comments. This script is not part of the test suite and
 * `gpt-tokenizer` is not a dependency; install it for the run and throw it away:
 *
 *   npm install --no-save gpt-tokenizer
 *   node scripts/calibrate-tokens.mjs [file...]
 *
 * With no arguments it checks the whitespace cases the estimator claims to
 * reproduce exactly. With files, it reports estimator error against the real
 * count for each, which is the number to quote when calibrating a constant.
 *
 * Why whitespace has its own section: the estimator used to price runs of spaces
 * at zero. Reconstructing a PDF's character grid indents every wrapped line and
 * pads between columns, and that was free — so slimdoc's PDF output measured as a
 * 3% saving when cl100k says it was 1-9% *larger* than the text it started from.
 */

import { readFile } from 'node:fs/promises';

import { estimateTokens } from '../dist/tokens.js';

let encode;
try {
  ({ encode } = await import('gpt-tokenizer/encoding/cl100k_base'));
} catch {
  console.error('gpt-tokenizer is not installed. Run: npm install --no-save gpt-tokenizer');
  process.exit(2);
}

const real = (text) => encode(text).length;

/**
 * The whitespace shapes the estimator's comment claims to reproduce exactly. A
 * mismatch here means the comment is now lying, which is worse than being wrong.
 */
const WHITESPACE = [
  ['single space folds into the next word', 'a b'],
  ['a run of spaces is one token', 'a      b'],
  ['length does not matter up to the long-run token', `a${' '.repeat(96)}b`],
  ['past it, runs split again', `a${' '.repeat(256)}b`],
  ['one line break', 'a\nb'],
  ['blank lines still round to one', 'a\n\n\nb'],
  ['a break plus indentation is two', 'a\n    b'],
  ['deep indentation is still two', `a\n${' '.repeat(40)}b`],
  ['prose is unaffected', 'The quick brown fox jumps over the lazy dog.'],
];

let failed = 0;
console.log('whitespace cases (estimator must match cl100k exactly)\n');
for (const [label, text] of WHITESPACE) {
  const [got, want] = [estimateTokens(text), real(text)];
  const mark = got === want ? 'ok  ' : 'FAIL';
  if (got !== want) failed++;
  console.log(`  ${mark} ${label.padEnd(40)} estimate ${String(got).padStart(3)}  real ${String(want).padStart(3)}`);
}

const files = process.argv.slice(2);
if (files.length > 0) {
  console.log('\ndocuments (a few percent of error is expected and acceptable)\n');
  for (const file of files) {
    const text = await readFile(file, 'utf8');
    const [got, want] = [estimateTokens(text), real(text)];
    const error = ((got - want) / want) * 100;
    const sign = error >= 0 ? '+' : '';
    console.log(
      `  ${file.padEnd(44)} estimate ${String(got).padStart(7)}  real ${String(want).padStart(7)}  ${sign}${error.toFixed(1)}%`,
    );
  }
}

if (failed > 0) {
  console.error(`\n${failed} whitespace case${failed === 1 ? '' : 's'} no longer match. Fix the code or the comment.`);
  process.exit(1);
}
console.log('\nall whitespace cases match.');
