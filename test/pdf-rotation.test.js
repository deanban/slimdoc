/**
 * Text written with a rotated matrix — the sideways-scanned-form shape.
 *
 * Reading the raw coordinates as upright text groups a visual column into one
 * line and butt-joins its numbers: `9,942 2 9,942` became `9,9429,9429,942` on
 * the real form this suite reproduces. Rotation has to be composed into the
 * coordinates before any layout inference runs.
 */

import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import test from 'node:test';

import { extractFromFile } from '../dist/extract.js';
import { toLines } from '../dist/pdf-layout.js';
import { quarterTurn, dominantTurn, uprightPlacement } from '../dist/utils/rotation.js';
import { localFixture } from './helpers/local.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROTATED_PDF = join(HERE, 'fixtures', 'generated', 'rotated-text.pdf');

// --------------------------------------------------------------------------
// quarter turns from a text matrix
// --------------------------------------------------------------------------

test('rotation: quarterTurn reads the four axis-aligned matrices at any scale', () => {
  assert.equal(quarterTurn([1, 0, 0, 1, 5, 5]), 0);
  assert.equal(quarterTurn([10, 0, 0, 10, 5, 5]), 0);
  assert.equal(quarterTurn([0, 6.47, -6.47, 0, 461, 61]), 90);
  assert.equal(quarterTurn([-10, 0, 0, -10, 5, 5]), 180);
  assert.equal(quarterTurn([0, -10, 10, 0, 5, 5]), 270);
});

test('rotation: quarterTurn refuses off-axis and degenerate matrices', () => {
  assert.equal(quarterTurn([7.07, 7.07, -7.07, 7.07, 0, 0]), undefined);
  assert.equal(quarterTurn([0, 0, 0, 0, 0, 0]), undefined);
});

test('rotation: dominantTurn needs a strong shared non-zero turn', () => {
  assert.equal(dominantTurn(Array(10).fill(90)), 90);
  assert.equal(dominantTurn([...Array(9).fill(90), 0]), 90);
  assert.equal(dominantTurn([...Array(5).fill(90), ...Array(5).fill(0)]), undefined);
  assert.equal(dominantTurn(Array(10).fill(0)), undefined);
  assert.equal(dominantTurn([]), undefined);
  assert.equal(dominantTurn([...Array(9).fill(180), undefined]), 180);
});

test('rotation: uprightPlacement maps each turn back to reading coordinates', () => {
  const placed = { x: 461.1, y: 110.7, width: 16.2, height: 6.5 };

  const up90 = uprightPlacement(placed, 90, 612, 792);
  assert.ok(Math.abs(up90.x - 110.7) < 0.01, `90° x was ${up90.x}`);
  assert.ok(Math.abs(up90.y - (612 - 461.1)) < 0.01, `90° y was ${up90.y}`);
  assert.equal(up90.width, placed.width);
  assert.equal(up90.height, placed.height);

  const up180 = uprightPlacement(placed, 180, 612, 792);
  assert.ok(Math.abs(up180.x - (612 - 461.1 - 16.2)) < 0.01, `180° x was ${up180.x}`);
  assert.ok(Math.abs(up180.y - (792 - 110.7)) < 0.01, `180° y was ${up180.y}`);

  const up270 = uprightPlacement(placed, 270, 612, 792);
  assert.ok(Math.abs(up270.x - (792 - 110.7)) < 0.01, `270° x was ${up270.x}`);
  assert.ok(Math.abs(up270.y - 461.1) < 0.01, `270° y was ${up270.y}`);
});

// --------------------------------------------------------------------------
// the layout guard: inconsistent geometry must not butt-join runs
// --------------------------------------------------------------------------

/**
 * A run starting well before the previous run's right edge is geometry the
 * left-to-right layout cannot explain. Joining the two invents a token —
 * `9,942` + `2` becomes `9,9422` — so the benign failure is a space.
 */
test('layout: a run overlapping backwards by a full character gets a space, not a join', () => {
  const lines = toLines([
    { str: 'AAAAA', x: 100, y: 500, width: 30, height: 10 },
    { str: 'BB', x: 105, y: 500, width: 12, height: 10 },
  ]);

  assert.equal(lines.length, 1);
  assert.match(lines[0].text, /AAAAA\s+BB/, `runs were butt-joined: "${lines[0].text}"`);
});

// --------------------------------------------------------------------------
// the generated rotated fixture, end to end
// --------------------------------------------------------------------------

test('pdf: rotated text keeps every value on its own row with separators', async () => {
  const doc = await extractFromFile(ROTATED_PDF);
  const text = doc.sections.map((s) => s.text).join('\n');

  for (const row of [
    ['FLOOR', 'AREA', 'UNITS', 'VALUE'],
    ['1ST', '8,411', '3', '0.7'],
    ['2ND', '9,942', '2', '0.4'],
    ['3RD', '7,655', '5', '1.2'],
    ['4TH', '6,300', '1', '0.9'],
  ]) {
    assert.match(
      text,
      new RegExp(`^\\s*${row.join('\\s+').replace(/[.]/g, '\\.')}\\s*$`, 'm'),
      `row "${row.join(' ')}" did not survive:\n${text}`,
    );
  }
});

test('pdf: rotated text never merges adjacent cells into one token', async () => {
  const doc = await extractFromFile(ROTATED_PDF);
  const text = doc.sections.map((s) => s.text).join('\n');

  assert.doesNotMatch(text, /\d,\d{3}\d/, 'digit runs from separate cells were merged');
  assert.doesNotMatch(text, /[A-Z]{2,}\d/, 'a label was merged with a number');
});

test('pdf: rotated text is read top-to-bottom in the displayed orientation', async () => {
  const doc = await extractFromFile(ROTATED_PDF);
  const text = doc.sections.map((s) => s.text).join('\n');
  const at = (needle) => {
    const i = text.indexOf(needle);
    assert.notEqual(i, -1, `"${needle}" is missing:\n${text}`);
    return i;
  };

  assert.ok(at('drawn sideways') < at('FLOOR'), 'title should precede the header row');
  assert.ok(at('1ST') < at('2ND') && at('2ND') < at('3RD'), 'rows out of order');
});

test('pdf: composing rotation is announced on the warnings channel', async () => {
  const doc = await extractFromFile(ROTATED_PDF);

  assert.ok(
    doc.warnings.some((w) => /rotat/i.test(w)),
    `no rotation warning in: ${doc.warnings.join('; ')}`,
  );
});

// --------------------------------------------------------------------------
// the real form
// --------------------------------------------------------------------------

test('pdf: the real rotated form keeps each assessment value in its own cell', async (t) => {
  const file = localFixture('form-rotated', t);
  if (file === null) return;

  const doc = await extractFromFile(file);
  const text = doc.sections.map((s) => s.text).join('\n');

  assert.match(text, /9,942\s+2\s+9,942/, 'the quarterly row lost its cell boundaries');
  assert.doesNotMatch(text, /9,9429/, 'adjacent cells were merged into one number');
});
