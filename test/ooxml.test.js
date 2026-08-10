/**
 * The namespace-aware OOXML reader.
 *
 * The reason this is a real parser rather than the tolerant tag rewriter
 * `extract-html.ts` uses: `a:`, `p:` and `r:` are what PowerPoint happens to
 * emit, but ECMA-376 permits any prefix, and Google Slides, Keynote export and
 * python-pptx do vary. Half of what follows is that claim under test.
 */

import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import test from 'node:test';

import { child, children, descendants, parseXml, readRels, resolvePart, textOf } from '../dist/ooxml.js';
import { readZipEntries } from '../dist/zip.js';
import { DEFAULT_LIMITS } from '../dist/types.js';

const FIXTURES = join(dirname(fileURLToPath(import.meta.url)), 'fixtures');

const A = 'http://schemas.openxmlformats.org/drawingml/2006/main';
const P = 'http://schemas.openxmlformats.org/presentationml/2006/main';
const R = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships';
const MC = 'http://schemas.openxmlformats.org/markup-compatibility/2006';

// --------------------------------------------------------------------------
// prefixes are conventional, not guaranteed
// --------------------------------------------------------------------------

const POWERPOINT = `<p:sp xmlns:p="${P}" xmlns:a="${A}">
  <p:txBody><a:p><a:r><a:t>Warp core online</a:t></a:r></a:p></p:txBody>
</p:sp>`;

const THIRD_PARTY = `<pres:sp xmlns:pres="${P}" xmlns:draw="${A}">
  <pres:txBody><draw:p><draw:r><draw:t>Warp core online</draw:t></draw:r></draw:p></pres:txBody>
</pres:sp>`;

test('ooxml: a third-party prefix parses to the same tree as PowerPoint\'s', () => {
  const mine = parseXml(POWERPOINT);
  const theirs = parseXml(THIRD_PARTY);

  assert.deepEqual(mine, theirs);
  assert.equal(mine.ns, 'p');
  assert.equal(mine.local, 'sp');
  assert.equal(descendants(mine, 'a', 't')[0].text, 'Warp core online');
});

test('ooxml: a default namespace with no prefix at all is resolved', () => {
  const node = parseXml(`<sp xmlns="${P}"><txBody/></sp>`);
  assert.equal(node.ns, 'p');
  assert.ok(child(node, 'p', 'txBody'));
});

test('ooxml: an unknown namespace keeps its URI rather than being guessed at', () => {
  const node = parseXml('<x:thing xmlns:x="urn:elsewhere"/>');
  assert.equal(node.ns, 'urn:elsewhere');
});

// --------------------------------------------------------------------------
// attributes
// --------------------------------------------------------------------------

test('ooxml: a namespaced attribute does not collide with a plain one', () => {
  // <p:sldId id="256" r:id="rId4"/> is the exact shape that makes this matter:
  // keying attributes by local name alone loses one of the two.
  const node = parseXml(`<p:sldId xmlns:p="${P}" xmlns:r="${R}" id="256" r:id="rId4"/>`);

  assert.equal(node.attrs['id'], '256');
  assert.equal(node.attrs['r:id'], 'rId4');
});

test('ooxml: the relationship attribute is found under the canonical prefix', () => {
  const node = parseXml(`<p:sldId xmlns:p="${P}" xmlns:rel="${R}" rel:id="rId9"/>`);
  assert.equal(node.attrs['r:id'], 'rId9');
});

test('ooxml: namespace declarations are not attributes', () => {
  const node = parseXml(`<p:sp xmlns:p="${P}" name="hull"/>`);
  assert.deepEqual(node.attrs, { name: 'hull' });
});

// --------------------------------------------------------------------------
// mc:AlternateContent
// --------------------------------------------------------------------------

test('ooxml: AlternateContent resolves to its Choice', () => {
  const xml = `<p:spTree xmlns:p="${P}" xmlns:a="${A}" xmlns:mc="${MC}">
    <mc:AlternateContent>
      <mc:Choice Requires="a14"><p:sp><a:t>modern</a:t></p:sp></mc:Choice>
      <mc:Fallback><p:sp><a:t>legacy</a:t></p:sp></mc:Fallback>
    </mc:AlternateContent>
  </p:spTree>`;

  const shapes = children(parseXml(xml), 'p', 'sp');
  assert.equal(shapes.length, 1);
  assert.equal(descendants(shapes[0], 'a', 't')[0].text, 'modern');
});

test('ooxml: AlternateContent with only a Fallback still yields its content', () => {
  const xml = `<p:spTree xmlns:p="${P}" xmlns:a="${A}" xmlns:mc="${MC}">
    <mc:AlternateContent><mc:Fallback><p:sp><a:t>legacy</a:t></p:sp></mc:Fallback></mc:AlternateContent>
  </p:spTree>`;

  assert.equal(descendants(parseXml(xml), 'a', 't')[0].text, 'legacy');
});

// --------------------------------------------------------------------------
// text
// --------------------------------------------------------------------------

test('ooxml: an element owns its own text, and a child owns the text after it', () => {
  const node = parseXml(`<a:p xmlns:a="${A}">lead<a:t>inner</a:t>tail</a:p>`);

  assert.equal(node.text, 'lead', "an element's own text runs up to its first child");
  assert.equal(child(node, 'a', 't').text, 'inner');
  assert.equal(child(node, 'a', 't').tail, 'tail', 'text after a child is held with that child');
});

test('ooxml: textOf walks the subtree in document order', () => {
  const node = parseXml(`<a:p xmlns:a="${A}"><a:r><a:t>Warp </a:t></a:r><a:r><a:t>core</a:t></a:r></a:p>`);
  assert.equal(textOf(node), 'Warp core');
});

/**
 * Mixed content, which every element sweeping up all of its own text gets
 * wrong. `<a:t>Warp <a:br/>core</a:t>` used to read `Warp core` only because
 * both fragments happened to be adjacent in the accumulator; put a word on
 * either side of a child and the order comes out as "everything outside, then
 * everything inside" — which is not what the document says.
 */
test('ooxml: mixed content comes back in the order it was written', () => {
  const node = parseXml(`<a:p xmlns:a="${A}">Warp <a:t>core</a:t> recertification</a:p>`);
  assert.equal(textOf(node), 'Warp core recertification');

  const nested = parseXml(`<a:p xmlns:a="${A}">one<a:r>two<a:t>three</a:t>four</a:r>five</a:p>`);
  assert.equal(textOf(nested), 'onetwothreefourfive');
});

test('ooxml: entities and CDATA are decoded, whitespace is left alone', () => {
  const node = parseXml(`<a:t xmlns:a="${A}">a &amp; b<![CDATA[ & c]]>  d</a:t>`);
  assert.equal(node.text, 'a & b & c  d');
});

// --------------------------------------------------------------------------
// refusals
// --------------------------------------------------------------------------

test('ooxml: malformed XML is refused rather than half-read', () => {
  assert.throws(() => parseXml('<a:p><a:t>unclosed'), /xml/i);
  assert.throws(() => parseXml('not xml at all'), /xml/i);
});

// --------------------------------------------------------------------------
// relationships
// --------------------------------------------------------------------------

const RELS = `<?xml version="1.0"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
  <Relationship Id="rId2" Type="http://x/slide" Target="slides/slide1.xml"/>
  <Relationship Id="rId3" Type="http://x/image" Target="../media/image1.png"/>
  <Relationship Id="rId4" Type="http://x/hyperlink" Target="https://example.test" TargetMode="External"/>
</Relationships>`;

test('rels: every relationship is keyed by id', () => {
  const rels = readRels(RELS);

  assert.equal(rels.get('rId2').target, 'slides/slide1.xml');
  assert.equal(rels.get('rId2').type, 'http://x/slide');
  assert.equal(rels.get('rId4').external, true);
  assert.equal(rels.get('rId2').external, false);
});

test('rels: an absent rels part is an empty map, not a crash', () => {
  assert.equal(readRels(undefined).size, 0);
});

// --------------------------------------------------------------------------
// part resolution
// --------------------------------------------------------------------------

test('parts: a target resolves against the owning part\'s folder', () => {
  assert.equal(resolvePart('ppt/presentation.xml', 'slides/slide1.xml'), 'ppt/slides/slide1.xml');
});

test('parts: a parent reference climbs out of the folder', () => {
  assert.equal(resolvePart('ppt/slides/slide1.xml', '../media/image1.png'), 'ppt/media/image1.png');
  assert.equal(resolvePart('ppt/slides/slide1.xml', '../../docProps/app.xml'), 'docProps/app.xml');
});

test('parts: an absolute target is package-rooted', () => {
  assert.equal(resolvePart('ppt/slides/slide1.xml', '/ppt/media/x.png'), 'ppt/media/x.png');
});

// --------------------------------------------------------------------------
// against the real package
// --------------------------------------------------------------------------

test('ooxml: the corpus deck\'s presentation part parses', async () => {
  const buf = await readFile(join(FIXTURES, 'corpus', 'kitchen-sink.pptx'));
  const entries = readZipEntries(buf, DEFAULT_LIMITS);
  const root = parseXml(entries.get('ppt/presentation.xml')());

  const list = child(root, 'p', 'sldIdLst');
  const ids = children(list, 'p', 'sldId').map((n) => n.attrs['r:id']);

  assert.equal(root.local, 'presentation');
  assert.equal(ids.length, 9);
  assert.ok(ids.every((id) => typeof id === 'string' && id.startsWith('rId')));
});
