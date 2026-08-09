/**
 * PDF extraction.
 *
 * A PDF has no paragraphs, no reading order and no table semantics — only glyph
 * runs at coordinates. Every structure asserted below is reconstructed and can
 * be wrong, which is why the fixture includes a two-column spread whose reading
 * order by `y` alone is nonsense, a page with no text at all, and a footer that
 * is repeated seven times and also appears twice as real body text.
 */

import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import test from 'node:test';

import { extractFromFile, SUPPORTED_EXTENSIONS } from '../dist/extract.js';
import { cleanDocument } from '../dist/sections.js';
import { toLines, layoutPage } from '../dist/pdf-layout.js';

const PDF = join(dirname(fileURLToPath(import.meta.url)), 'fixtures', 'corpus', 'kitchen-sink.pdf');

async function read(extract = {}, cleanOpts = { preset: 'balanced' }) {
  const doc = await extractFromFile(PDF, extract);
  return { doc, ...cleanDocument(doc, cleanOpts, extract) };
}

const at = (text, needle) => {
  const i = text.indexOf(needle);
  return i === -1 ? Infinity : i;
};

// --------------------------------------------------------------------------
// pages
// --------------------------------------------------------------------------

test('pdf: every page becomes a section', async () => {
  const { doc } = await read();

  assert.equal(doc.format, 'pdf');
  assert.deepEqual(doc.sections.map((s) => s.index), [1, 2, 3, 4, 5, 6, 7]);
  assert.ok(doc.sections.every((s) => s.label === undefined), 'a PDF page has no title');
});

/**
 * An image-only cover, advertisement or diagram page must not fail the whole
 * document — it is reported and the other six pages are still extracted.
 */
test('pdf: a page with no extractable text is marked, not fatal', async () => {
  const { doc, text } = await read();

  assert.match(text, /\[page 5: no extractable text\]/);
  assert.ok(doc.warnings.some((w) => /1 page has no extractable text/.test(w)), doc.warnings.join('; '));
});

test('pdf: --pages reads only what was asked for', async () => {
  const { doc, text } = await read({ pages: [[1, 2]] });

  assert.deepEqual(doc.sections.map((s) => s.index), [1, 2]);
  assert.doesNotMatch(text, /Sign-off/);
});

// --------------------------------------------------------------------------
// reading order
// --------------------------------------------------------------------------

/**
 * The two-column spread. Ordering by `y` alone interleaves the columns into
 * nonsense — "Structural teardown began on stardate / Warp core recertification
 * followed the / 47901.2 and ran eleven days …".
 */
test('pdf: a two-column spread is read down one column and then the other', async () => {
  const { text } = await read();

  assert.ok(at(text, 'reproduced here') < at(text, 'Warp core recertification'));
  assert.ok(at(text, 'Warp core recertification') < at(text, 'recorded as unusual'));
  assert.doesNotMatch(text, /stardate Warp core recertification/);
});

test('pdf: a single-column page keeps its order', async () => {
  const { text } = await read();

  assert.ok(at(text, 'Refit Status') < at(text, 'Stardate 47988.1'));
  assert.ok(at(text, 'Stardate 47988.1') < at(text, 'The Utopia Planitia yards report'));
});

test('pdf: a vertical gap becomes a paragraph break, so prose can be unwrapped', async () => {
  const { text } = await read();

  assert.match(text, /^The Utopia Planitia yards report that the plasma inter- mix chamber tolerances/m);
  assert.match(text, /^Captain Picard's standing order/m);
});

// --------------------------------------------------------------------------
// running headers and footers
// --------------------------------------------------------------------------

test('pdf: repeated page furniture is kept once and then suppressed', async () => {
  const { doc, text } = await read();

  assert.equal(text.split('UTOPIA PLANITIA FLEET YARDS').length - 1, 1);
  assert.equal(text.split('Page 1 of 7').length - 1, 1);
  assert.doesNotMatch(text, /Page 4 of 7/);
  assert.ok(doc.warnings.some((w) => /running header/.test(w)), doc.warnings.join('; '));
});

/**
 * The same sentence as the footer appears twice in the body of page 7. Matching
 * on text alone would delete it; matching on position as well keeps it.
 */
test('pdf: body text that happens to match the footer survives', async () => {
  const { text } = await read();
  const legal = 'not for distribution outside the Starfleet Corps of Engineers';

  assert.ok(text.split(legal).length - 1 >= 2, 'the body copies on page 7 were suppressed');
});

test('pdf: suppression can be turned off', async () => {
  const { text } = await read({ dropRunningHeaders: false });
  assert.ok(text.split('UTOPIA PLANITIA FLEET YARDS').length - 1 >= 6);
});

// --------------------------------------------------------------------------
// characters
// --------------------------------------------------------------------------

test('pdf: text is sanitized at extraction, before anything is fenced', async () => {
  const { doc } = await read();

  assert.doesNotMatch(doc.text, /[ﬀ-ﬆ]/, 'a ligature survived extraction');
  assert.doesNotMatch(doc.text, /[­​﻿]/, 'an invisible character survived');
  assert.match(doc.text, /classification/);
});

test('pdf: a word split across a line break rejoins only when asked', async () => {
  const plain = await read();
  assert.match(plain.text, /plasma inter- mix chamber/);

  const joined = await read({ dehyphenate: true });
  assert.match(joined.text, /plasma intermix chamber/);
  assert.match(joined.text, /Daystrom Institute disputes/);
});

test('pdf: dehyphenation leaves a real compound alone', async () => {
  const { text } = await read({ dehyphenate: true });
  assert.match(text, /star-board nacelle/);
});

// --------------------------------------------------------------------------
// layout helpers
// --------------------------------------------------------------------------

const item = (str, x, y, width = str.length * 5, height = 9) => ({ str, x, y, width, height });

test('layout: items sharing a baseline become one line, top to bottom', () => {
  const lines = toLines([item('second', 54, 700), item('first', 54, 720), item('also', 200, 720)]);

  assert.equal(lines.length, 2);
  assert.match(lines[0].text, /^first/);
  assert.equal(lines[1].text, 'second');
});

test('layout: a small baseline wobble does not start a new line', () => {
  const lines = toLines([item('super', 54, 721.5), item('base', 40, 720)]);
  assert.equal(lines.length, 1);
});

/**
 * A subscript sits on its own baseline, close enough to belong to the line
 * above it. Found against a real book: grouping walks the page by baseline, so
 * without an explicit sort the subscripts pile up at the end of the line —
 * "θ and θ . This gives … to adapt the model0 1".
 */
test('layout: a subscript stays with the character it belongs to', () => {
  const lines = toLines([
    item('θ', 72, 573.6, 5, 10.5),
    item('0', 77, 571.5, 3, 6.3),
    item('and', 82.6, 573.6, 15.9, 10.5),
    item('θ', 101.1, 573.6, 5, 10.5),
    item('1', 106.1, 571.5, 3, 6.3),
  ]);

  assert.equal(lines.length, 1);
  assert.match(lines[0].text, /^θ0 and θ1$/);
});

/** Two runs that all but touch are one word the engine split on a kerning pair. */
test('layout: a word split across two runs is not given a space', () => {
  const lines = toLines([item('St', 100, 700, 9), item('yle', 109, 700, 12)]);
  assert.equal(lines[0].text, 'Style');
});

test('layout: horizontal position becomes column alignment', () => {
  const lines = toLines([item('def', 54, 700, 16.2), item('body', 75.6, 690, 21.6)]);

  assert.equal(lines[0].text, 'def');
  assert.match(lines[1].text, /^ {4}body$/);
});

test('layout: with no gutter the lines come back untouched', () => {
  const items = [item('one', 54, 700), item('two', 54, 690)];
  assert.deepEqual(layoutPage(items, 792).map((l) => l.text), ['one', 'two']);
});

// --------------------------------------------------------------------------
// plumbing
// --------------------------------------------------------------------------

test('pdf: the extension is advertised as supported', () => {
  assert.ok(SUPPORTED_EXTENSIONS.includes('.pdf'));
});

test('pdf: section headings number the pages', async () => {
  const { text } = await read({ sectionHeadings: true }, { preset: 'safe' });

  assert.match(text, /^## Page 1$/m);
  assert.match(text, /^## Page 7$/m);
});

test('pdf: extraction is pure — the same file twice gives the same text', async () => {
  const a = await read();
  const b = await read();

  assert.equal(a.text, b.text);
  assert.deepEqual(a.doc.warnings, b.doc.warnings);
});
