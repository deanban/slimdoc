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
 * `unwrap` skips a run of text holding no blank line at all, which is what
 * keeps `clean()` idempotent at `maxBlankLines: 0`. Per-section cleaning
 * inherits that: a slide carrying one wrapped paragraph and nothing else keeps
 * its line breaks. Pinned here because it is a consequence of the section loop
 * rather than an accident, and because the PDF extractor depends on emitting
 * paragraph structure if it wants its pages unwrapped.
 */
test('sections: a lone wrapped paragraph keeps its breaks', () => {
  const single = doc([{ index: 1, text: 'Hull plating is\nahead of schedule.' }]);
  assert.equal(cleanDocument(single, { preset: 'balanced' }).text, 'Hull plating is\nahead of schedule.\n');
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
