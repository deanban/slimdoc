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
import { preserveGridRegions } from '../dist/pdf-preformat.js';

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
// gridlike regions
// --------------------------------------------------------------------------

/**
 * A PDF carries no table semantics, so slimdoc does not claim any: a region
 * that lines up is preserved verbatim in a fenced block rather than rewritten
 * as a pipe table. A malformed pipe table is worse than plain text — it asserts
 * a structure that was never in the file and lands numbers under the wrong
 * heading — whereas preserving the alignment asserts nothing.
 */
test('pdf: a region on a coordinate grid keeps its alignment in a fenced block', async () => {
  for (const preset of ['safe', 'balanced', 'aggressive']) {
    const { text } = await read({}, { preset });
    const fenced = text.match(/```\n([\s\S]*?)\n```/g) ?? [];

    assert.ok(fenced.length >= 1, `${preset}: nothing was fenced`);
    const table = fenced.find((block) => block.includes('Subsystem'));
    assert.ok(table, `${preset}: the diagnostics grid was not preserved`);
    assert.match(table, /Subsystem +Owner +Status +Margin +Reviewed/, preset);
    assert.match(table, /Warp core +La Forge +Green/, preset);
  }
});

test('pdf: the fenced region is never turned into a pipe table', async () => {
  const { text } = await read();
  assert.doesNotMatch(text, /\| --- \|/);
});

test('pdf: a block that only looks like a grid is preserved the same way', async () => {
  const { text } = await read();
  const fenced = text.match(/```\n([\s\S]*?)\n```/g) ?? [];

  assert.ok(fenced.some((block) => /Deck 36 +engineering/.test(block)));
});

test('pdf: the approximation is warned about', async () => {
  const { doc } = await read();
  assert.ok(
    doc.warnings.some((w) => /columns may be approximate/.test(w)),
    doc.warnings.join('; '),
  );
});

test('pdf: --no-tables leaves the region as ordinary lines', async () => {
  const { doc, text } = await read({ preserveTables: false });

  // The fixture's runbook page contains a fence of its own, so the assertion is
  // that the diagnostics grid is not wrapped in one, not that none exists.
  assert.doesNotMatch(text, /```[\s\S]*Subsystem/);
  assert.ok(!doc.warnings.some((w) => /columns may be approximate/.test(w)));
});

/**
 * A grid whose own content contains a three-backtick run. A fixed wrapper would
 * be closed by it, and everything after would read as prose.
 */
test('grid: a region containing a fence gets a longer one around it', () => {
  const rows = ['open   ```', 'body   code', 'close  ```'].join('\n');
  const { text, regions } = preserveGridRegions(rows);

  assert.equal(regions, 1);
  assert.match(text, /^````\n/);
  assert.ok(text.trim().endsWith('````'), text);
});

test('grid: fewer than three aligned rows is a coincidence, not a layout', () => {
  const { text, regions } = preserveGridRegions('a    b\nc    d');

  assert.equal(regions, 0);
  assert.equal(text, 'a    b\nc    d');
});

test('grid: a blank line ends a region', () => {
  const rows = 'a  b\nc  d\ne  f\n\ng  h\ni  j\n';
  assert.equal(preserveGridRegions(rows).regions, 1);
});

test('pdf: prose and indented code are not mistaken for a grid', async () => {
  const { text } = await read();

  assert.doesNotMatch(text, /```[\s\S]*The Utopia Planitia yards report/);
  assert.match(text, /^ {4}total = 0$/m);
});

// --------------------------------------------------------------------------
// resource limits
// --------------------------------------------------------------------------

test('limits: the page cap counts selected pages and says what it dropped', async () => {
  const { doc } = await read({ limits: { maxPages: 2 } });

  assert.deepEqual(doc.sections.map((s) => s.index), [1, 2]);
  assert.ok(doc.warnings.some((w) => /5 pages were not read/.test(w)), doc.warnings.join('; '));
});

test('limits: a page with too many items is cut short rather than followed', async () => {
  const { doc } = await read({ limits: { maxItemsPerPage: 5 } });

  assert.ok(doc.warnings.some((w) => /item cap/.test(w)), doc.warnings.join('; '));
  assert.ok(doc.text.length < 1500, 'the cap did not actually bound the work');
});

test('limits: an oversized file is refused before it is parsed', async () => {
  await assert.rejects(
    () => extractFromFile(PDF, { limits: { maxInputBytes: 1000 } }),
    (err) => /over the .* input limit/.test(err.message),
  );
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
