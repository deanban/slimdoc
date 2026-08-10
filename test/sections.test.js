/**
 * Cleaning inside the section loop rather than over the joined document.
 *
 * The claim that `clean.ts` could be left alone and simply fed extracted text
 * was false: `unwrap` merges what were two independent pages, and
 * `collapseSpaces` destroys coordinate-derived columns. Cleaning each section
 * on its own is what buys the boundary back.
 */

import assert from 'node:assert/strict';
import test from 'node:test';

import { cleanDocument } from '../dist/sections.js';
import { cleanWithStats } from '../dist/clean.js';
import { EXTRACT_DEFAULTS, mergeExtract, resolveExtractOptions } from '../dist/types.js';

const doc = (sections, format = 'pptx') => ({
  text: sections.map((s) => s.text).join('\n\n'),
  format,
  source: '<test>',
  warnings: [],
  sections,
});

/**
 * Two shapes per slide, separated by the blank line the extractors put between
 * adjacent shapes. That blank is what gives `unwrap` a paragraph structure to
 * work with — see the single-paragraph case below for what happens without one.
 */
const DECK = doc([
  { index: 1, label: 'Refit Status', text: 'Hull plating is\nahead of schedule.\n\nDock four\nis clear.' },
  { index: 2, label: 'Propulsion', text: 'Warp coils are\nstill in the yard.\n\nDelivery slips\nto stardate 7412.' },
]);

// --------------------------------------------------------------------------
// documents without sections
// --------------------------------------------------------------------------

test('sections: a document with no sections cleans exactly as before', () => {
  const plain = { text: 'One  two\n\n\n\nthree', format: 'text', source: '<test>', warnings: [] };
  const expected = cleanWithStats(plain.text, { preset: 'balanced' });

  const out = cleanDocument(plain, { preset: 'balanced' });
  assert.equal(out.text, expected.text);
  assert.deepEqual(out.stats, expected.stats);
  assert.deepEqual(out.sections, []);
});

// --------------------------------------------------------------------------
// the boundary
// --------------------------------------------------------------------------

test('sections: unwrap joins within a section and never across one', () => {
  const { text } = cleanDocument(DECK, { preset: 'balanced' });

  assert.match(text, /^Hull plating is ahead of schedule\.$/m);
  assert.match(text, /^Delivery slips to stardate 7412\.$/m);
  assert.doesNotMatch(text, /clear\. Warp/);
});

/**
 * `unwrap` used to skip a run of text holding no blank line at all, which kept
 * `clean()` idempotent at `maxBlankLines: 0` and cost whole documents
 * everywhere else: a slide or a PDF page with one wrapped paragraph and no
 * blank line stayed wrapped, line for line.
 *
 * What it does now is restrict rather than skip. With no paragraph structure to
 * go on it joins only a break that could not be a paragraph boundary — a line
 * stopping mid-sentence continued by one starting mid-sentence — which is
 * exactly the break a hard wrap makes. Two sentences on two lines are left
 * alone, because there the break might mean something.
 */
test('sections: a lone wrapped paragraph is unwrapped, one that might not be is not', () => {
  const wrapped = doc([{ index: 1, text: 'Hull plating is\nahead of schedule.' }]);
  assert.equal(cleanDocument(wrapped, { preset: 'balanced' }).text, 'Hull plating is ahead of schedule.\n');

  const sentences = doc([{ index: 1, text: 'Hull plating is ahead.\nDelivery slips to stardate 7412.' }]);
  assert.equal(
    cleanDocument(sentences, { preset: 'balanced' }).text,
    'Hull plating is ahead.\nDelivery slips to stardate 7412.\n',
  );
});

/** At `maxBlankLines: 0` even that is unsafe, since a previous run has erased the evidence. */
test('sections: the restricted join is off where a second run could not repeat it', () => {
  const wrapped = doc([{ index: 1, text: 'Hull plating is\nahead of schedule.' }]);
  assert.equal(
    cleanDocument(wrapped, { preset: 'aggressive' }).text,
    'Hull plating is\nahead of schedule.\n',
  );
});

test('sections: a blank line separates sections even at maxBlankLines 0', () => {
  const { text } = cleanDocument(DECK, { preset: 'aggressive' });

  assert.equal(text.split('\n\n').length, 2);
  assert.ok(text.endsWith('\n'));
  assert.doesNotMatch(text, /\n\n\n/);
});

test('sections: an empty section contributes nothing, not a blank run', () => {
  const sparse = doc([
    { index: 1, label: 'One', text: 'Real content.' },
    { index: 2, label: 'Two', text: '   \n  ' },
    { index: 3, label: 'Three', text: 'More content.' },
  ]);

  const { text, sections } = cleanDocument(sparse, { preset: 'balanced' });
  assert.equal(text, 'Real content.\n\nMore content.\n');
  assert.deepEqual(sections.map((s) => s.index), [1, 3]);
});

// --------------------------------------------------------------------------
// headings
// --------------------------------------------------------------------------

test('sections: headings are off by default — a slide title is already in its text', () => {
  assert.doesNotMatch(cleanDocument(DECK, { preset: 'balanced' }).text, /^##/m);
});

test('sections: a slide heading carries its number and title', () => {
  const { text } = cleanDocument(DECK, { preset: 'safe' }, { sectionHeadings: true });
  assert.match(text, /^## Slide 1 — Refit Status$/m);
  assert.match(text, /^## Slide 2 — Propulsion$/m);
});

test('sections: a page has a number and no title', () => {
  const pages = doc([{ index: 7, text: 'Body text.' }], 'pdf');
  const { text } = cleanDocument(pages, { preset: 'safe' }, { sectionHeadings: true });

  assert.match(text, /^## Page 7$/m);
});

/**
 * The heading is prepended before its section is cleaned, not after the join.
 * Added afterwards it would survive `--aggressive` as literal `##` markers,
 * which strips every other heading in the document.
 */
test('sections: a heading is cleaned with its section, so --aggressive strips it', () => {
  const { text } = cleanDocument(DECK, { preset: 'aggressive' }, { sectionHeadings: true });

  assert.doesNotMatch(text, /#/);
  assert.match(text, /^Slide 1 - Refit Status$/m);
});

// --------------------------------------------------------------------------
// stats
// --------------------------------------------------------------------------

test('sections: per-section stats cover every emitted section', () => {
  const { sections } = cleanDocument(DECK, { preset: 'balanced' });

  assert.deepEqual(sections.map((s) => s.index), [1, 2]);
  assert.deepEqual(sections.map((s) => s.label), ['Refit Status', 'Propulsion']);
  assert.ok(sections.every((s) => s.tokens > 0 && s.chars > 0));
});

test('sections: a heading costs the tokens the user pays for it', () => {
  const without = cleanDocument(DECK, { preset: 'balanced' });
  const with_ = cleanDocument(DECK, { preset: 'balanced' }, { sectionHeadings: true });

  assert.ok(with_.sections[0].tokens > without.sections[0].tokens);
  assert.ok(with_.stats.tokens.after > without.stats.tokens.after);
});

test('sections: document stats measure the extracted text against the join', () => {
  const out = cleanDocument(DECK, { preset: 'balanced' });

  assert.equal(out.stats.chars.before, DECK.text.length);
  assert.equal(out.stats.chars.after, out.text.length);
});

/**
 * `extractFromFile(file, { sectionHeadings: true })` and then
 * `cleanDocument(doc)` produced no headings: the option was resolved during
 * extraction and thrown away, and cleaning — where headings are actually
 * emitted — re-resolved from nothing and got the default back. The caller had
 * to pass the same options twice for either to be honoured, and nothing said so.
 *
 * The document now carries the options its extraction ran under, so cleaning
 * agrees with extraction by default and an explicit argument still wins.
 */
test('sections: the options an extraction ran under reach the cleaner', () => {
  const withHeadings = { ...DECK, options: { ...EXTRACT_DEFAULTS, sectionHeadings: true } };

  assert.match(cleanDocument(withHeadings).text, /^## Slide 1/m);
  assert.doesNotMatch(cleanDocument(DECK).text, /^## Slide 1/m);
  assert.doesNotMatch(
    cleanDocument(withHeadings, {}, { sectionHeadings: false }).text,
    /^## Slide 1/m,
    'an explicit argument must still win',
  );
});

/**
 * `--stats` prints a character count per section, and the sections are joined
 * with a newline apiece. Counting only each section's own text left the sum
 * short by one per join, so the per-section figures did not add up to the
 * document the user is looking at.
 */
test('sections: the per-section characters add up to the document', () => {
  const { text, sections } = cleanDocument(DECK);
  assert.equal(sections.reduce((total, s) => total + s.chars, 0), text.length);
});

/**
 * `cleanDocument`'s third argument used to *replace* the options the extraction
 * recorded rather than layer over them: `extractOptions ?? doc.options`. So a
 * caller overriding one unrelated field silently reverted every other field to
 * its default, and `sectionHeadings` — the one option cleaning is responsible
 * for — disappeared mid-run with nothing said.
 */
test('sections: an override layers over the recorded options rather than replacing them', () => {
  const doc = {
    text: 'Body',
    format: 'pptx',
    source: 'deck.pptx',
    warnings: [],
    sections: [{ index: 1, label: 'Intro', text: 'Body' }],
    options: resolveExtractOptions({ sectionHeadings: true }),
  };

  const both = cleanDocument(doc, { preset: 'safe' }, { hiddenContent: true });
  assert.match(both.text, /^## Slide 1 — Intro$/m, 'the recorded sectionHeadings was discarded');

  // And the override still wins where the two disagree.
  const off = cleanDocument(doc, { preset: 'safe' }, { sectionHeadings: false });
  assert.doesNotMatch(off.text, /^## Slide 1/m);
});

test('sections: limits merge field by field across the two option sets', () => {
  const merged = mergeExtract(
    { sectionHeadings: true, limits: { maxPages: 7, maxInputBytes: 99 } },
    { limits: { maxPages: 3 } },
  );

  assert.equal(merged.sectionHeadings, true);
  assert.deepEqual(merged.limits, { maxPages: 3, maxInputBytes: 99 });
});
