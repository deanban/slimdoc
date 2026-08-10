/**
 * PPTX extraction, asserted through the full `extract -> per-section clean ->
 * join` pipeline rather than at the extraction boundary.
 *
 * The fixture is deliberately hostile: its slide order is permuted, one slide
 * is hidden, one text box sits off the canvas, the master and layout carry text
 * that must never appear, and a group shape scales its children by four. Every
 * one of those is a way a naive reader goes wrong, and each has a test here.
 */

import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import test from 'node:test';

import { extractFromFile, SUPPORTED_EXTENSIONS } from '../dist/extract.js';
import { cleanDocument } from '../dist/sections.js';
import { chartText } from '../dist/pptx-charts.js';
import { diagramList } from '../dist/pptx-diagrams.js';
import { parseXml } from '../dist/ooxml.js';
import { extractPptx } from '../dist/extract-pptx.js';
import { localFixture } from './helpers/local.js';
import { deckOf, slideXml, textBox } from './helpers/deck.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const DECK = join(HERE, 'fixtures', 'corpus', 'kitchen-sink.pptx');

async function read(extract = {}, cleanOpts = { preset: 'balanced' }) {
  const doc = await extractFromFile(DECK, extract);
  return { doc, ...cleanDocument(doc, cleanOpts, extract) };
}

/** Where `needle` first appears, or Infinity. Used to assert reading order. */
const at = (text, needle) => {
  const i = text.indexOf(needle);
  return i === -1 ? Infinity : i;
};

// --------------------------------------------------------------------------
// slide order
// --------------------------------------------------------------------------

test('pptx: presentation order comes from sldIdLst, not from the file names', async () => {
  const { doc } = await read();

  assert.equal(doc.format, 'pptx');
  assert.deepEqual(
    doc.sections.map((s) => s.label),
    [
      'Refit Status — USS Enterprise',
      'Agenda',
      'Summary',
      'Deck loading',
      'Propulsion output',
      'Refit sequence',
      'Imagery',
      'Runbook',
    ],
  );
});

test('pptx: sections are numbered as the reader sees them', async () => {
  const { doc } = await read();
  assert.deepEqual(doc.sections.map((s) => s.index), [1, 2, 3, 4, 5, 6, 7, 8]);
});

test('pptx: --pages selects slides by presentation position', async () => {
  const { doc } = await read({ pages: [[2, 3]] });

  assert.deepEqual(doc.sections.map((s) => s.label), ['Agenda', 'Summary']);
});

// --------------------------------------------------------------------------
// what must never appear
// --------------------------------------------------------------------------

test('pptx: master and layout text stays out of the output', async () => {
  const { text } = await read();

  assert.doesNotMatch(text, /Click to edit Master/);
  assert.doesNotMatch(text, /MASTER SLIDE NUMBER/);
  assert.doesNotMatch(text, /Second level/);
});

test('pptx: a hidden slide is excluded by default and returns with --hidden', async () => {
  const { text } = await read();
  assert.doesNotMatch(text, /HIDDEN SLIDE MARKER/);
  assert.doesNotMatch(text, /4\.2 million credits/);

  const shown = await read({ hiddenContent: true });
  assert.match(shown.text, /HIDDEN SLIDE MARKER/);
  assert.equal(shown.doc.sections.length, 9);
});

test('pptx: a text box off the canvas is not visible content', async () => {
  const { text } = await read();
  assert.doesNotMatch(text, /SCRATCH: do not present/);
  assert.doesNotMatch(text, /Ask Riker/);

  assert.match((await read({ hiddenContent: true })).text, /SCRATCH: do not present/);
});

test('pptx: no image payload reaches the output', async () => {
  const { text } = await read();
  assert.doesNotMatch(text, /base64/);
  assert.ok(text.length < 6000, `output is ${text.length} chars, so something binary leaked`);
});

// --------------------------------------------------------------------------
// reading order
// --------------------------------------------------------------------------

test('pptx: the title placeholder leads its slide, then the body', async () => {
  const { text } = await read();

  assert.ok(at(text, 'Refit Status') < at(text, 'Utopia Planitia Fleet Yards…'));
  assert.ok(at(text, 'Summary') < at(text, 'The Utopia Planitia yards report'));
});

test('pptx: shapes that are not placeholders follow, ordered by position', async () => {
  const { text } = await read();

  // Slide 2: the body placeholder sits above the aside at y=5,900,000.
  assert.ok(at(text, 'never quite matched its twin') < at(text, 'no shortcuts on the containment'));
  // Slide 6: two code boxes side by side, left before right, footer last.
  assert.ok(at(text, 'def containment_margin') < at(text, 'Document it like this'));
  assert.ok(at(text, 'Document it like this') < at(text, 'only after containment.lock()'));
});

/**
 * A group's children carry coordinates in the group's own space. This group
 * scales by four and rotates, so reading `a:off` directly puts the children
 * near the slide origin instead of where they are drawn.
 */
test('pptx: a group transform is composed rather than read through', async () => {
  const { text } = await read();

  assert.ok(at(text, 'Nacelle 2, post-teardown') < at(text, 'Photo: Ensign Ro'));
  assert.ok(at(text, 'Warp core output by quarter') < at(text, 'Nacelle 2, post-teardown'));
});

test('pptx: adjacent shapes are separated, so unwrap cannot glue two boxes', async () => {
  const { text } = await read();
  assert.doesNotMatch(text, /twin\. Captain Picard/);
});

// --------------------------------------------------------------------------
// text
// --------------------------------------------------------------------------

test('pptx: bullet depth survives as indentation', async () => {
  const { text } = await read({}, { preset: 'safe' });

  assert.match(text, /^- Propulsion$/m);
  assert.match(text, /^ {2}- Warp field geometry$/m);
  assert.match(text, /^ {4}- Nacelle 2 plasma injectors$/m);
  assert.match(text, /^ {6}- Serial UP.4471$/m);
});

/** Lines that came out as list items, trimmed of their indentation. */
const bulletsIn = (text) =>
  text.split('\n').filter((line) => /^\s*- /.test(line)).map((line) => line.trim().slice(2));

/**
 * PowerPoint does not write a bullet down. A content placeholder inherits its
 * glyph from the layout, which inherits from the master's `<p:bodyStyle>`, and
 * the paragraph itself says nothing at all — so reading only the paragraph's own
 * `pPr`, as slimdoc did, finds no list in a deck that is nothing but lists.
 *
 * This fixture is built on PowerPoint's own default template through
 * python-pptx, so the master, the layouts and the placeholder wiring are
 * Microsoft's. It holds one of each case the resolution has to tell apart, and
 * the two directions are equally important: `titleStyle` carries `buNone` and
 * `otherStyle` carries no bullet at all, so a fix that simply inherits from the
 * master would bullet every title and every caption on every deck.
 */
test('pptx: a bullet inherited from the master is still a bullet', async () => {
  const doc = await extractFromFile(join(HERE, 'fixtures', 'generated', 'inherited-bullets.pptx'));
  const text = doc.sections.map((s) => s.text).join('\n');

  assert.deepEqual(bulletsIn(text), [
    'Warp field geometry', // body placeholder, inherits from bodyStyle
    'Nacelle plasma injectors', // the same
    'Dock and power down', // explicit buChar on the paragraph
    'Drain the plasma manifold', // inherits at lvl 1
    'Cap the conduit', // inherits at lvl 2
  ]);

  // And what must not be bulleted: a title, a line that opted out with buNone,
  // and two paragraphs in a plain text box, which resolve through otherStyle.
  for (const line of [
    'Propulsion',
    'Refit sequence',
    'This line opted out of the list',
    'A caption in a plain text box',
    'A second caption line',
  ]) {
    assert.match(text, new RegExp(`^${line}$`, 'm'), `"${line}" should be plain:\n${text}`);
  }
});

/**
 * The deck that makes the naive version of the fix wrong. Ninety-five
 * paragraphs, none of them bulleted, all of them in plain text boxes — which
 * resolve through the master's `otherStyle` even though its `bodyStyle` does
 * carry a `buChar`. Inherit without asking which style applies and this deck
 * gains ninety-five bullets that are not on any slide.
 */
test('pptx: a deck of plain text boxes gains no bullets', async (t) => {
  const file = localFixture('deck-textboxes', t);
  if (file === null) return;

  const doc = await extractFromFile(file);
  const text = doc.sections.map((s) => s.text).join('\n');

  assert.equal(bulletsIn(text).length, 0, `bulleted:\n${bulletsIn(text).join('\n')}`);
  assert.ok(text.split('\n').filter((l) => l.trim()).length > 80, 'the deck came out empty instead');
});

/**
 * The deck with explicit bullets, which must come through the new resolution
 * unchanged and un-multiplied.
 *
 * Worth recording what these three real decks turned out to be: not one of them
 * uses a content placeholder. Every paragraph in all three sits in a plain text
 * box, which is why they are all guards against over-bulleting and why none of
 * them can demonstrate inheritance working — that is what the python-pptx
 * fixture above is for. A deck exported by a tool rather than typed in
 * PowerPoint is apparently made this way, and it is the shape slimdoc will meet.
 */
test('pptx: a real deck keeps exactly the bullets that are written in it', async (t) => {
  const file = localFixture('deck-mixed', t);
  if (file === null) return;

  const doc = await extractFromFile(file);
  const bullets = bulletsIn(doc.sections.map((s) => s.text).join('\n'));
  const written = bullets.filter((line) => !/^(Category|Series): /.test(line));

  assert.equal(written.length, 14, `expected the 14 buChar paragraphs, got:\n${written.join('\n')}`);
  assert.ok(written.includes('Production pilot with clinical team'), written.join('\n'));
});

/**
 * The body of `containment_margin` changes meaning if the indent collapses, and
 * the damage is invisible in a diff of prose.
 */
test('pptx: indented code keeps its indentation', async () => {
  for (const preset of ['safe', 'balanced', 'aggressive']) {
    const { text } = await read({}, { preset });
    assert.match(text, /^ {4}total = 0$/m, preset);
    assert.match(text, /^ {8}if r\.stable:$/m, preset);
    assert.match(text, /^ {12}total \+= r\.margin$/m, preset);
  }
});

test('pptx: an image keeps a real caption and drops a junk one', async () => {
  const { doc, text } = await read();

  assert.match(text, /\[image: Warp core output by quarter, 2364 to 2370, rising to 1\.9 teradynes\]/);
  assert.doesNotMatch(text, /image1\.png/);
  assert.doesNotMatch(text, /\[image: avatar\]/);
  assert.ok(doc.warnings.some((w) => /dropped 4 embedded images.*1 kept/.test(w)), doc.warnings.join('; '));
});

// --------------------------------------------------------------------------
// tables
// --------------------------------------------------------------------------

/** Every contiguous run of pipe-table lines in `text`. */
function tableBlocks(text) {
  const blocks = [];
  let current = [];
  for (const line of text.split('\n')) {
    if (line.trim().startsWith('|')) current.push(line.trim());
    else if (current.length > 0) {
      blocks.push(current);
      current = [];
    }
  }
  if (current.length > 0) blocks.push(current);
  return blocks;
}

test('pptx: a table renders as GitHub-flavoured Markdown', async () => {
  const { text } = await read();
  const [first] = tableBlocks(text);

  assert.ok(first, 'no pipe table in the output');
  assert.match(first[0], /^\| Deck \|/);
  assert.equal(first[1], '| --- | --- | --- | --- | --- |');
  for (const row of first) {
    assert.ok(row.startsWith('|') && row.endsWith('|'), row);
  }
});

test('pptx: merged cells are flattened by repetition, and the user is told', async () => {
  const { doc, text } = await read();
  const [first] = tableBlocks(text);

  assert.match(first[0], /\| Alpha shift \| Alpha shift \| Beta shift \| Beta shift \|/);
  assert.match(first[2], /^\| Deck \|/);
  assert.ok(doc.warnings.some((w) => /merged cells flattened/.test(w)), doc.warnings.join('; '));
});

test('pptx: a pipe inside a cell is escaped rather than splitting the row', async () => {
  const { text } = await read();
  assert.match(text, /tricorder --scan \\\| grep dilithium \\\| wc -l/);
});

test('pptx: a cell holding a line break collapses to one line', async () => {
  const { text } = await read();
  assert.match(text, /\| Multi-line note \| Line one of the note\. Line two, same cell\. \|/);
});

test('pptx: a single-column table is emitted as plain lines', async () => {
  // Plain lines, not a bogus one-column pipe table — and `unwrap` is then free
  // to join them in the presets that reflow prose, exactly as the HTML path
  // behaves. That is the cost of refusing to assert a structure that was never
  // really there.
  const { doc, text } = await read();

  assert.match(doc.text, /^Outstanding work orders\nRecalibrate the lateral sensor array$/m);
  assert.match(text, /Outstanding work orders/);
  assert.doesNotMatch(text, /\| Outstanding work orders/);
});

test('pptx: a table is separated from its neighbours by a blank line, at every preset', async () => {
  for (const preset of ['safe', 'balanced', 'aggressive']) {
    const { text } = await read({}, { preset });
    const lines = text.split('\n');

    lines.forEach((line, i) => {
      const isRow = line.trim().startsWith('|');
      const nextIsRow = (lines[i + 1] ?? '').trim().startsWith('|');
      if (isRow !== nextIsRow && line.trim() !== '' && (lines[i + 1] ?? '').trim() !== '') {
        assert.fail(`${preset}: table boundary with no blank line:\n${line}\n${lines[i + 1]}`);
      }
    });
  }
});

// --------------------------------------------------------------------------
// charts
// --------------------------------------------------------------------------

/**
 * The series cache is the only place these numbers exist in the package — the
 * chart is drawn from it, and nothing else in the deck repeats them. It is also
 * opt-in: a full series can dwarf the ten tokens of text on the slide it sits on.
 *
 * What is *not* opt-in is the chart's writing. A title, an axis label, the
 * category names and the series names are text the reader sees on the slide, and
 * the default contract keeps visible text — `--chart-data` was gating the whole
 * chart part, so a slide whose only content was a titled chart came out empty.
 */
test('pptx: a chart keeps its writing by default and its numbers on request', async () => {
  const plain = await read();
  const slide = plain.doc.sections.find((s) => s.label === 'Propulsion output').text;
  assert.match(slide, /Propulsion output by quarter/);
  assert.match(slide, /Q1 2369, Q2 2369, Q3 2369, Q4 2369/);
  assert.match(slide, /Warp core output \(TD\), Impulse reserve \(TD\)/);
  assert.doesNotMatch(plain.text, /0\.75/, 'the series numbers are still opt-in');
  assert.doesNotMatch(slide, /\| --- \|/, 'no table without the numbers to fill it');

  const { text } = await read({ chartData: true });
  assert.match(text, /Propulsion output by quarter/);
  assert.match(text, /\| Warp core output \(TD\) \| Impulse reserve \(TD\) \|/);
  assert.match(text, /\| Q3 2369 \| 1\.9 \| 0\.9 \|/);
});

test('pptx: a chart lands on the slide it belongs to', async () => {
  const { doc } = await read({ chartData: true });
  const slide = doc.sections.find((s) => s.label === 'Propulsion output');

  assert.match(slide.text, /Impulse reserve/);
});

/**
 * A chart's numbers come from a cache written when the workbook was last
 * refreshed, and the workbook itself may not be in the package at all. Nothing
 * can be done about that but say so — a stale number presented as current is
 * worse than a number with a caveat.
 */
test('pptx: emitted chart numbers say where they came from', async () => {
  const plain = await read();
  const { doc } = await read({ chartData: true });

  assert.ok(doc.warnings.some((w) => /cache/.test(w)), doc.warnings.join('; '));
  assert.ok(!plain.doc.warnings.some((w) => /cache/.test(w)), 'nothing is cached until numbers are');
});

/**
 * `idx` is an attribute of a file, which is to say it is whatever the file says.
 * It was used to index the point array directly, so a 600-byte part claiming
 * `idx="20000000"` cost a 20-million-element array — a second and a half, half a
 * gigabyte — and a larger one failed with a raw `RangeError` from deep inside
 * `Array.from` rather than as a rejected document.
 */
test('pptx: a hostile point index costs nothing', () => {
  const C = 'http://schemas.openxmlformats.org/drawingml/2006/chart';
  const chartWith = (idx) =>
    parseXml(
      `<c:chartSpace xmlns:c="${C}"><c:chart><c:plotArea><c:barChart><c:ser>` +
        '<c:cat><c:strRef><c:strCache>' +
        `<c:pt idx="0"><c:v>Impulse</c:v></c:pt><c:pt idx="${idx}"><c:v>Warp</c:v></c:pt>` +
        '</c:strCache></c:strRef></c:cat>' +
        '<c:val><c:numRef><c:numCache><c:pt idx="0"><c:v>7</c:v></c:pt></c:numCache></c:numRef></c:val>' +
        '</c:ser></c:barChart></c:plotArea></c:chart></c:chartSpace>',
    );

  for (const idx of ['20000000', '200000000', '-3', 'nonsense']) {
    const started = process.hrtime.bigint();
    const { text, notes } = chartText(chartWith(idx), { values: true });
    const ms = Number(process.hrtime.bigint() - started) / 1e6;

    assert.ok(ms < 100, `idx="${idx}" took ${ms.toFixed(0)}ms`);
    assert.match(text, /Impulse/, `idx="${idx}" lost the points that were real`);
    assert.doesNotMatch(text, /Warp/, `idx="${idx}" was indexed anyway`);
    assert.ok(notes.some((n) => /point/.test(n)), `idx="${idx}": ${notes.join('; ')}`);
  }
});

/** An unnamed series is `Series 1`, because it is the first one and not the zeroth. */
test('pptx: an unnamed series is numbered the way a reader counts', () => {
  const C = 'http://schemas.openxmlformats.org/drawingml/2006/chart';
  const chart = parseXml(
    `<c:chartSpace xmlns:c="${C}"><c:chart><c:plotArea><c:barChart><c:ser>` +
      '<c:cat><c:strRef><c:strCache><c:pt idx="0"><c:v>Impulse</c:v></c:pt></c:strCache></c:strRef></c:cat>' +
      '<c:val><c:numRef><c:numCache><c:pt idx="0"><c:v>7</c:v></c:pt></c:numCache></c:numRef></c:val>' +
      '</c:ser></c:barChart></c:plotArea></c:chart></c:chartSpace>',
  );

  assert.match(chartText(chart, { values: true }).text, /\| Series 1 \|/);
});

/**
 * The real deck. Its four charts carry their subject in the title and nowhere
 * else on the slide: with charts gated behind `--chart-data`, `Accuracy Score
 * (%)` and `Average Latency (seconds)` were absent from the extraction of a deck
 * that is largely about accuracy and latency.
 */
test('pptx: a real deck keeps the writing on its charts', async (t) => {
  const file = localFixture('deck-mixed', t);
  if (file === null) return;

  const doc = await extractFromFile(file);
  const text = doc.sections.map((s) => s.text).join('\n');

  assert.match(text, /Accuracy Score \(%\)/);
  assert.match(text, /Average Latency \(seconds\)/);
  assert.match(text, /Baseline \(before fixes\)/, 'the series names went too');
  assert.doesNotMatch(text, /15\.9/, 'the numbers are still opt-in');
});

/**
 * Scatter and bubble charts store their data as x/y pairs, and a multi-level
 * category axis nests. Reading either through the category/value path would
 * produce a table whose numbers mean something other than what it says, so they
 * are skipped and reported instead.
 */
test('pptx: a chart shape slimdoc does not understand is skipped, not misread', () => {
  const C = 'http://schemas.openxmlformats.org/drawingml/2006/chart';
  const scatter = parseXml(
    `<c:chartSpace xmlns:c="${C}"><c:chart><c:plotArea><c:scatterChart><c:ser>` +
      '<c:xVal><c:numRef><c:numCache><c:pt idx="0"><c:v>1</c:v></c:pt></c:numCache></c:numRef></c:xVal>' +
      '<c:yVal><c:numRef><c:numCache><c:pt idx="0"><c:v>2</c:v></c:pt></c:numCache></c:numRef></c:yVal>' +
      '</c:ser></c:scatterChart></c:plotArea></c:chart></c:chartSpace>',
  );

  const { text, skipped } = chartText(scatter, { values: true });
  assert.equal(text, '');
  assert.match(skipped, /scatter, bubble/);
});

// --------------------------------------------------------------------------
// SmartArt
// --------------------------------------------------------------------------

/**
 * Diagram text lives in `diagrams/data1.xml`, outside any `<p:sp>`, so a shape
 * walker finds an empty frame. It is on by default because it is visible text
 * that is otherwise lost entirely.
 */
test('pptx: SmartArt text is extracted by default', async () => {
  const { doc, text } = await read();
  const slide = doc.sections.find((s) => s.label === 'Refit sequence');

  assert.match(text, /^- Intake survey$/m);
  assert.match(text, /^- Structural teardown$/m);
  assert.match(text, /^- Shakedown cruise$/m);
  assert.match(slide.text, /Warp core recertification/);
});

test('pptx: SmartArt keeps the order the diagram declares', async () => {
  const { doc } = await read();
  const slide = doc.sections.find((s) => s.label === 'Refit sequence');
  const order = ['Intake survey', 'Structural teardown', 'Warp core recertification', 'Shakedown cruise'];

  const positions = order.map((step) => slide.text.indexOf(step));
  assert.deepEqual([...positions].sort((a, b) => a - b), positions);
  assert.ok(positions.every((p) => p >= 0));
});

test('pptx: --no-diagram-text drops it', async () => {
  const { text } = await read({ diagramText: false });
  assert.doesNotMatch(text, /Intake survey/);
});

/** Layout scaffolding, not content: a presentation point carries no meaning. */
test('pptx: presentation-only diagram points are skipped', async () => {
  const { text } = await read();
  assert.doesNotMatch(text, /\[Text\]/);
});

/**
 * `srcOrd` is an ordinal *within a parent*, so every first child carries 0.
 * Sorting all the points by it globally interleaves the branches: the second
 * parent's first child sorts alongside the first parent's first child, and the
 * list that comes out says a hierarchy the diagram does not have.
 *
 * A tree has to be walked as a tree — from the roots, siblings in `srcOrd`,
 * document order to break a tie.
 */
test('pptx: a diagram with two branches keeps each child under its own parent', () => {
  const DGM = 'http://schemas.openxmlformats.org/drawingml/2006/diagram';
  const A = 'http://schemas.openxmlformats.org/drawingml/2006/main';
  const point = (id, text) =>
    `<dgm:pt modelId="${id}"><dgm:t><a:p><a:r><a:t>${text}</a:t></a:r></a:p></dgm:t></dgm:pt>`;
  const link = (parent, kid, ord) =>
    `<dgm:cxn type="parOf" srcId="${parent}" destId="${kid}" srcOrd="${ord}"/>`;

  // Declared with the branches interleaved, so document order cannot stand in
  // for the tree and the connections have to be the thing that decides.
  const model = parseXml(
    `<dgm:dataModel xmlns:dgm="${DGM}" xmlns:a="${A}"><dgm:ptLst>` +
      point('a', 'Alpha') +
      point('b', 'Beta') +
      point('a1', 'Alpha-one') +
      point('b1', 'Beta-one') +
      point('a2', 'Alpha-two') +
      point('b2', 'Beta-two') +
      '</dgm:ptLst><dgm:cxnLst>' +
      link('a', 'a1', 0) +
      link('b', 'b1', 0) +
      link('a', 'a2', 1) +
      link('b', 'b2', 1) +
      '</dgm:cxnLst></dgm:dataModel>',
  );

  assert.equal(
    diagramList(model),
    ['- Alpha', '  - Alpha-one', '  - Alpha-two', '- Beta', '  - Beta-one', '  - Beta-two'].join('\n'),
  );
});

// --------------------------------------------------------------------------
// ST_Boolean
// --------------------------------------------------------------------------

/**
 * `ST_Boolean` is `1`/`0` *or* `true`/`false`, and both are equally valid.
 * PowerPoint writes the digits, so a deck from PowerPoint never exercises the
 * words — and slimdoc compared against `'1'` and `'0'` as strings, so a deck
 * from any other writer had its hidden slides shown and its merged cells
 * duplicated. Absorbing that variance is the reason `ooxml.ts` exists.
 */
test('pptx: show="false" hides a slide as surely as show="0"', () => {
  const deck = deckOf([
    slideXml(textBox(['The slide everybody sees'])),
    slideXml(textBox(['DRAFT: not for the meeting']), 'show="false"'),
  ]);

  const plain = extractPptx(deck, 'deck.pptx');
  assert.equal(plain.sections.length, 1);
  assert.doesNotMatch(plain.text, /DRAFT/);
  assert.ok(plain.warnings.some((w) => /1 hidden slide/.test(w)), plain.warnings.join('; '));

  assert.equal(extractPptx(deck, 'deck.pptx', { hiddenContent: true }).sections.length, 2);
});

test('pptx: hMerge="true" is a merge, not a cell with text of its own', () => {
  const cell = (text, attrs = '') =>
    `<a:tc ${attrs}><a:txBody><a:bodyPr/><a:p><a:r><a:t>${text}</a:t></a:r></a:p></a:txBody></a:tc>`;
  const table =
    '<p:graphicFrame><p:xfrm><a:off x="0" y="0"/><a:ext cx="5000000" cy="2000000"/></p:xfrm>' +
    '<a:graphic><a:graphicData><a:tbl>' +
    `<a:tr>${cell('Deck')}${cell('Alpha shift')}</a:tr>` +
    // As a writer emits a merge: the origin says how far it spans, the
    // continuation says it is one. Its text is a leftover, never displayed.
    `<a:tr>${cell('Deck 36', 'gridSpan="2"')}${cell('leaked', 'hMerge="true"')}</a:tr>` +
    '</a:tbl></a:graphicData></a:graphic></p:graphicFrame>';

  const doc = extractPptx(deckOf([slideXml(table)]), 'deck.pptx');

  assert.doesNotMatch(doc.text, /leaked/, `a continuation cell emitted its own text:\n${doc.text}`);
  assert.match(doc.text, /\| Deck 36 \| Deck 36 \|/, doc.text);
  assert.ok(doc.warnings.some((w) => /merged cells/.test(w)), doc.warnings.join('; '));
});

// --------------------------------------------------------------------------
// bounded work
// --------------------------------------------------------------------------

/**
 * `--pages 1` has to bound the work, not just the output. Slide order comes
 * from `<p:sldIdLst>`, and every slide it named was parsed in full before page
 * selection ran — so asking for one slide of a two-hundred-slide deck parsed
 * two hundred, and the flag people reach for precisely because a deck is too
 * big did the whole of the expensive thing anyway.
 *
 * A slide nobody asked for is now resolved but not parsed. Unreadable XML in
 * one is the plainest way to observe that from outside: it cannot fail a run
 * that never looks at it.
 */
test('pptx: --pages parses the slides it selected and no others', () => {
  const broken = '<p:sld xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main">' +
    '<p:cSld><p:spTree><<<not xml at all';
  const deck = deckOf([slideXml(textBox(['The slide that was asked for'])), broken, broken]);

  const doc = extractPptx(deck, 'deck.pptx', { pages: [[1, 1]] });
  assert.equal(doc.sections.length, 1);
  assert.match(doc.text, /The slide that was asked for/);

  // And without the selection the same deck is still a malformed package, so
  // the test is measuring what was skipped rather than what was tolerated.
  assert.throws(() => extractPptx(deck, 'deck.pptx'), /malformed XML/);
});

/**
 * The same bound, in bytes. With `--hidden` there is no reason to touch an
 * unselected slide at all — no `show` attribute to read — so a budget covering
 * the slides asked for is enough, where before it had to cover the deck.
 */
test('pptx: an unselected slide is not inflated when nothing needs its flags', () => {
  const filler = (n) => textBox([`Slide ${n} `.repeat(400)]);
  const deck = deckOf([1, 2, 3, 4].map((n) => slideXml(filler(n))));

  const budget = { limits: { maxInflatedBytes: 8_000 } };
  const doc = extractPptx(deck, 'deck.pptx', { ...budget, pages: [[1, 1]], hiddenContent: true });
  assert.match(doc.text, /Slide 1/);

  assert.throws(() => extractPptx(deck, 'deck.pptx', budget), /inflated|limit/);
});

// --------------------------------------------------------------------------
// plumbing
// --------------------------------------------------------------------------

test('pptx: the extension is advertised as supported', () => {
  for (const ext of ['.pptx', '.pptm', '.potx']) {
    assert.ok(SUPPORTED_EXTENSIONS.includes(ext), ext);
  }
});

test('pptx: section headings name the slide', async () => {
  const { text } = await read({ sectionHeadings: true }, { preset: 'safe' });

  assert.match(text, /^## Slide 1 — Refit Status — USS Enterprise$/m);
  assert.match(text, /^## Slide 8 — Runbook$/m);
});

test('pptx: extraction is pure — the same file twice gives the same text', async () => {
  const a = await read();
  const b = await read();

  assert.equal(a.text, b.text);
  assert.deepEqual(a.doc.warnings, b.doc.warnings);
});
