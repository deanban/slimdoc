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
import { toLines, layoutPage, suppressRunningText } from '../dist/pdf-layout.js';
import { preserveGridRegions } from '../dist/pdf-preformat.js';
import { localFixture } from './helpers/local.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const PDF = join(HERE, 'fixtures', 'corpus', 'kitchen-sink.pdf');

/**
 * Layouts a typesetter chose rather than we did. The corpus generator places
 * every run at a coordinate we picked, so it cannot contradict an assumption we
 * hold; reportlab computes its own leading, justification and column widths.
 */
const TABLE_PDF = join(HERE, 'fixtures', 'generated', 'two-column-table.pdf');
const PROSE_PDF = join(HERE, 'fixtures', 'generated', 'justified-prose.pdf');

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

/**
 * A two-column table, laid out by reportlab rather than by us.
 *
 * `findGutter` refuses to call a page two-column when it finds more than one
 * clear vertical band, reasoning that a table produces one band per column
 * boundary. A two-column table produces exactly one — the single case that guard
 * admits — so the commonest table shape in a report was read as two columns of
 * prose, and every value was separated from the row it belongs to.
 *
 * The damage is invisible in the output: the result reads as clean prose, so a
 * model consuming it associates the numbers with nothing and says so
 * confidently. That is the same failure `pdf-preformat.ts` refuses to risk by
 * emitting pipe tables, arriving one stage earlier.
 */
test('pdf: a two-column table keeps each value with its row', async () => {
  const doc = await extractFromFile(TABLE_PDF);
  const text = doc.sections.map((s) => s.text).join('\n');

  for (const [deck, crew] of [['Deck', 'Crew'], ['Deck 36', '12'], ['Deck 4', '7'], ['Deck 1', '31']]) {
    assert.match(
      text,
      new RegExp(`^\\s*${deck}\\s+${crew}\\s*$`, 'm'),
      `"${deck}" lost its value "${crew}":\n${text}`,
    );
  }
  // Read as columns instead, the page becomes every label and then every value,
  // so no line holds a deck and its crew and the last label precedes the first
  // number. Alignment is what the fenced region then preserves.
  assert.ok(at(text, 'Deck 1\n') > at(text, '12'), 'labels and values were split into columns');
});

/**
 * The other side of the same narrowing. Requiring both columns to read as prose
 * must not stop a document that really is two columns from being read as two —
 * so this asserts against a real one, where the column widths, the line lengths
 * and the OCR noise are all somebody else's.
 */
test('pdf: a real two-column document is still read column by column', async (t) => {
  const file = localFixture('paper-ocr-columns', t);
  if (file === null) return;

  const doc = await extractFromFile(file, { pages: [[4, 4]] });
  const text = doc.sections[0].text;

  // Two consecutive lines of the left column. Interleaved, each would carry the
  // right column's text after it and neither would appear on a line of its own.
  assert.match(text, /^\s*quality {2}products {2}with {2}the {2}thujone {2}note {2}can {2}re-\s*$/m, text.slice(0, 400));
  assert.match(text, /^\s*place {2}the very costfy {2}thujone\./m);
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

/**
 * Header lines built by hand rather than by a fixture, because the shape being
 * tested is a *set* of pages whose headers differ by one number — which is the
 * whole point, and which no single document could hold both sides of.
 */
const headed = (height, ...texts) => ({
  index: 0,
  height,
  lines: texts.map((text, i) => ({ y: height - 30 - i * 14, left: 72, right: 300, text })),
});

/**
 * Suppression keys a header by position and text, normalising the digits in a
 * page counter because a counter reads differently on every page. It used to
 * normalise *any* run of digits: `\b\d+\b`. Under that rule a report whose
 * running head carries the year — the ordinary way a multi-year document is
 * headed — collapsed to one key, and three of its four headers were deleted as
 * repetition. So did `Section 3` and `Section 4`, which are not furniture at
 * all but the only thing on the page saying which section the reader is in.
 *
 * The loss is silent and it is meaning, not noise. Only the counter forms are
 * normalised now: `page N`, `N of M`, `N/M`, and a line that is nothing but a
 * number.
 */
test('pdf: a year in a running head is content, not a page counter', () => {
  const pages = [2023, 2024, 2025, 2026].map((year) => headed(792, `Annual Report ${year}`));
  const suppressed = suppressRunningText(pages);

  assert.equal(suppressed, 0, 'a header differing only by its year was read as one repeated line');
  assert.deepEqual(
    pages.map((p) => p.lines.map((l) => l.text)),
    [['Annual Report 2023'], ['Annual Report 2024'], ['Annual Report 2025'], ['Annual Report 2026']],
  );
});

test('pdf: a section number in a running head is content too', () => {
  const pages = ['Section 3', 'Section 4', 'Section 5', 'Section 6'].map((t) => headed(792, t));

  assert.equal(suppressRunningText(pages), 0);
  assert.deepEqual(pages.map((p) => p.lines.length), [1, 1, 1, 1]);
});

test('pdf: the counter forms are still normalised, so the footer goes', () => {
  for (const counters of [
    ['Page 1 of 4', 'Page 2 of 4', 'Page 3 of 4', 'Page 4 of 4'],
    ['1/4', '2/4', '3/4', '4/4'],
    ['1', '2', '3', '4'],
    ['Page 1', 'Page 2', 'Page 3', 'Page 4'],
  ]) {
    const pages = counters.map((text) => headed(792, 'ACME LOGISTICS', text));
    // The banner is identical on every page, the counter differs on every page:
    // both are furniture, and 6 of the 8 lines are the repetitions.
    assert.equal(suppressRunningText(pages), 6, counters.join(' '));
    assert.deepEqual(pages[3].lines, [], counters.join(' '));
  }
});

/**
 * The end-to-end guard for the same narrowing, on a document nobody here laid
 * out: 38 pages under a running title, footed with a bare page number. Both are
 * furniture and both must still go — tightening the rule must not cost real
 * suppression, which is where most of a PDF's saved tokens come from.
 */
test('pdf: a real paper still loses its running title and page numbers', async (t) => {
  const file = localFixture('paper-single', t);
  if (file === null) return;

  const doc = await extractFromFile(file, { pages: [[1, 8]] });
  const text = doc.sections.map((s) => s.text).join('\n');
  const title = 'TradingAgents: Multi-Agents LLM Financial Trading Framework';

  assert.equal(text.split(title).length - 1, 1, 'the running title was kept on more than one page');
  assert.ok(doc.warnings.some((w) => /suppressed 12 repeated/.test(w)), doc.warnings.join('; '));
});

test('pdf: suppression can be turned off', async () => {
  const { text } = await read({ dropRunningHeaders: false });
  assert.ok(text.split('UTOPIA PLANITIA FLEET YARDS').length - 1 >= 6);
});

// --------------------------------------------------------------------------
// rotation
// --------------------------------------------------------------------------

const rotated = (deg) => join(HERE, 'fixtures', 'corpus', `rotated-${deg}.pdf`);

/**
 * `/Rotate` turns the paper, not the text. Every glyph keeps the position it
 * had in unrotated user space, and that is the space `getTextContent()` reports
 * coordinates in — so the four files, whose content streams are byte-identical,
 * have to extract to the same text.
 *
 * They did not. Page height came from `getViewport({scale: 1})`, which *is*
 * rotated: 612 on a page 792 points tall. Every rule that measures against the
 * height then measured against the wrong one, and the 12% margin band that
 * marks page furniture reached 30% down the page. Body text inside it was
 * collected as a running header and, being genuinely repeated, deleted from
 * every page but the first.
 *
 * The failure needs four pages to appear at all, since suppression will not
 * call anything repeated below that — which is why the fixture has five and why
 * no single-page probe would have found it.
 */
test('pdf: a rotated page is read as the same document', async () => {
  const [upright, ...turned] = await Promise.all(
    [0, 90, 180, 270].map(async (deg) => {
      const doc = await extractFromFile(rotated(deg));
      return { deg, text: doc.sections.map((s) => s.text).join('\n'), warnings: doc.warnings };
    }),
  );

  for (const page of turned) {
    assert.equal(page.text, upright.text, `/Rotate ${page.deg} read differently from /Rotate 0`);
  }
  for (const page of [upright, ...turned]) {
    assert.equal(
      page.text.split('All figures are provisional').length - 1,
      5,
      `/Rotate ${page.deg} lost body text to header suppression:\n${page.text}`,
    );
    assert.ok(
      page.warnings.some((w) => /suppressed 8 repeated/.test(w)),
      `/Rotate ${page.deg}: ${page.warnings.join('; ')}`,
    );
  }
});

/**
 * And the real thing: a scanned filing whose pages carry `/Rotate 90` because
 * that is how they went through the scanner, not because a generator wrote it.
 *
 * It is two pages, so suppression — which needs four — never runs on it, and
 * the deletions the fixture above demonstrates cannot happen here. What it does
 * check is the other consumer of the page height, column ordering, and that the
 * fields of a genuinely rotated form come out at all: this file is the reason
 * to believe pdf.js reports unrotated coordinates in practice and not only by
 * specification.
 */
test('pdf: a real rotated form keeps its fields', async (t) => {
  const file = localFixture('form-rotated', t);
  if (file === null) return;

  const doc = await extractFromFile(file);
  const text = doc.sections.map((s) => s.text).join('\n');

  assert.match(text, /Scan Code/);
  assert.match(text, /Job Number/);
  assert.match(text, /Zoning Floor Area \(sq\. ft\.\)/);
  assert.match(text, /75,503/, 'the total zoning floor area was lost');
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
