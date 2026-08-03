import { test } from 'node:test';
import assert from 'node:assert/strict';

import { estimateTokens, computeStats, formatBytes } from '../dist/tokens.js';

const PROSE = [
  'The quick brown fox jumps over the lazy dog.',
  'It was the best of times, it was the worst of times, it was the age of wisdom, it was the age of foolishness.',
  'Following the quarterly review, the leadership team agreed to prioritise onboarding improvements over incremental reporting features.',
  'The parser reads the buffer, detects the format by magic bytes, and dispatches to an extractor. Each extractor returns a normalised markdown string plus a list of warnings.',
];

test('estimateTokens is zero for empty input', () => {
  assert.equal(estimateTokens(''), 0);
});

test('estimateTokens lands near chars/4 on ordinary English prose', () => {
  for (const sample of PROSE) {
    const ratio = sample.length / estimateTokens(sample);
    assert.ok(
      ratio > 3.3 && ratio < 4.8,
      `expected ~4 chars per token, got ${ratio.toFixed(2)} for: ${sample.slice(0, 40)}...`,
    );
  }
});

test('estimateTokens matches a known tokenizer count on a canonical sentence', () => {
  // cl100k_base tokenises this as 10 tokens.
  assert.equal(estimateTokens('The quick brown fox jumps over the lazy dog.'), 10);
});

test('estimateTokens splits long words into chunks', () => {
  assert.equal(estimateTokens('cat'), 1);
  assert.ok(estimateTokens('internationalization') >= 3);
  assert.ok(estimateTokens('antidisestablishmentarianism') > estimateTokens('establishment'));
});

test('estimateTokens keeps a contraction as one word chunk', () => {
  assert.equal(estimateTokens("don't"), 1);
  assert.equal(estimateTokens("it's fine"), estimateTokens('its fine'));
});

test('estimateTokens charges about one token per three digits', () => {
  assert.equal(estimateTokens('123'), 1);
  assert.equal(estimateTokens('123456'), 2);
});

test('estimateTokens charges about one token per CJK character', () => {
  const cjk = '今日は良い天気ですね';
  assert.equal(estimateTokens(cjk), cjk.length);
});

test('estimateTokens ignores plain spaces but charges for line breaks', () => {
  assert.equal(estimateTokens('a b'), estimateTokens('a     b'));
  assert.ok(estimateTokens('a\nb') > estimateTokens('a b'));
  assert.equal(estimateTokens('a\n\n\nb'), estimateTokens('a\nb'));
});

test('estimateTokens is monotonic and deterministic', () => {
  const text = PROSE.join(' ');
  assert.equal(estimateTokens(text), estimateTokens(text));
  assert.ok(estimateTokens(text + text) > estimateTokens(text));
});

test('estimateTokens handles a megabyte of text quickly', () => {
  const big = PROSE.join(' ').repeat(4000);
  const started = process.hrtime.bigint();
  const tokens = estimateTokens(big);
  const ms = Number(process.hrtime.bigint() - started) / 1e6;
  assert.ok(tokens > 0);
  assert.ok(ms < 2000, `estimateTokens took ${ms.toFixed(0)}ms on ${big.length} chars`);
});

test('estimateTokens does not throw on emoji and surrogate pairs', () => {
  assert.ok(estimateTokens('hello 👋🏽 world 🇬🇧') > 0);
});

test('computeStats reports chars, bytes, lines and tokens', () => {
  const before = 'a  b\n\n\nc\n';
  const after = 'a b\nc\n';
  const stats = computeStats(before, after);

  assert.deepEqual(stats.chars, { before: before.length, after: after.length });
  assert.deepEqual(stats.bytes, { before: 9, after: 6 });
  assert.deepEqual(stats.lines, { before: 4, after: 2 });
  assert.equal(typeof stats.tokens.before, 'number');
  assert.equal(typeof stats.tokens.after, 'number');
});

test('computeStats counts bytes not code units for multibyte text', () => {
  const stats = computeStats('é', 'é');
  assert.equal(stats.bytes.before, 2);
  assert.equal(stats.chars.before, 1);
});

test('computeStats savedPct is a percentage with one decimal place', () => {
  const before = 'word '.repeat(100);
  const stats = computeStats(before, 'word '.repeat(50));
  assert.ok(stats.savedPct > 40 && stats.savedPct <= 60);
  assert.equal(stats.savedPct, Math.round(stats.savedPct * 10) / 10);
});

test('computeStats clamps savedPct into 0-100', () => {
  assert.equal(computeStats('', '').savedPct, 0);
  assert.equal(computeStats('a', 'a much longer output than the input').savedPct, 0);
  assert.equal(computeStats('some words here', '').savedPct, 100);
});

test('computeStats counts lines with and without a trailing newline', () => {
  assert.equal(computeStats('', '').lines.before, 0);
  assert.equal(computeStats('a', '').lines.before, 1);
  assert.equal(computeStats('a\n', '').lines.before, 1);
  assert.equal(computeStats('a\nb', '').lines.before, 2);
});

test('formatBytes uses SI units', () => {
  assert.equal(formatBytes(0), '0 B');
  assert.equal(formatBytes(938), '938 B');
  assert.equal(formatBytes(1234), '1.2 kB');
  assert.equal(formatBytes(158_000), '158.0 kB');
  assert.equal(formatBytes(893_152), '893.2 kB');
  assert.equal(formatBytes(5_400_000), '5.4 MB');
});
