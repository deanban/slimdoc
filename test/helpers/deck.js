/**
 * Archives and packages built as bytes, for the cases a generator will not emit.
 *
 * `kitchen-sink.pptx` is one file and has to stay one coherent deck, so it can
 * carry `show="0"` or `show="false"` but not both. Neither python-pptx nor
 * PowerPoint will write the second at all: `ST_Boolean` permits `1`/`0` and
 * `true`/`false` equally, Microsoft writes the digits, and the word forms come
 * from the other writers in the world — Keynote's export, Google Slides, an
 * internal reporting tool. Those are exactly what `ooxml.ts` exists to absorb,
 * and the only way to test them is to write the bytes here.
 */

import { deflateRawSync } from 'node:zlib';

const STORED = 0;
const DEFLATED = 8;

/**
 * Build an archive from `entries`, each `{ name, body, method, declared }`.
 * `body` is the stored bytes exactly as they go on disk; `declared` overrides
 * the uncompressed size written into the headers, which is how a lying archive
 * is expressed.
 */
export function buildZip(entries, { zip64 = false, comment = '' } = {}) {
  const locals = [];
  const centrals = [];
  let offset = 0;

  for (const { name, body, method = STORED, declared } of entries) {
    const nameBytes = Buffer.from(name, 'latin1');
    const uncompressed = declared ?? body.length;

    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(method, 8);
    local.writeUInt32LE(body.length, 18);
    local.writeUInt32LE(uncompressed, 22);
    local.writeUInt16LE(nameBytes.length, 26);
    locals.push(local, nameBytes, body);

    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(method, 10);
    central.writeUInt32LE(body.length, 20);
    central.writeUInt32LE(uncompressed, 24);
    central.writeUInt16LE(nameBytes.length, 28);
    central.writeUInt32LE(offset, 42);
    centrals.push(central, nameBytes);

    offset += 30 + nameBytes.length + body.length;
  }

  const localBytes = Buffer.concat(locals);
  const centralBytes = Buffer.concat(centrals);
  const commentBytes = Buffer.from(comment, 'latin1');

  const locator = Buffer.alloc(zip64 ? 20 : 0);
  if (zip64) locator.writeUInt32LE(0x07064b50, 0);

  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(entries.length, 8);
  eocd.writeUInt16LE(entries.length, 10);
  eocd.writeUInt32LE(centralBytes.length, 12);
  eocd.writeUInt32LE(localBytes.length, 16);
  eocd.writeUInt16LE(commentBytes.length, 20);

  return Buffer.concat([localBytes, centralBytes, locator, eocd, commentBytes]);
}

export const stored = (name, text) => ({ name, body: Buffer.from(text, 'utf8'), method: STORED });

export const deflated = (name, text) => ({
  name,
  body: deflateRawSync(Buffer.from(text, 'utf8')),
  method: DEFLATED,
});

const P = 'http://schemas.openxmlformats.org/presentationml/2006/main';
const A = 'http://schemas.openxmlformats.org/drawingml/2006/main';
const R = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships';
const PR = 'http://schemas.openxmlformats.org/package/2006/relationships';

/** A `<p:sld>` around `body`, with `attrs` on the root — `show="false"` and the like. */
export function slideXml(body, attrs = '') {
  return (
    `<p:sld xmlns:p="${P}" xmlns:a="${A}" xmlns:r="${R}" ${attrs}>` +
    `<p:cSld><p:spTree>${body}</p:spTree></p:cSld></p:sld>`
  );
}

/** A text box holding one paragraph per string, at a position on the slide. */
export function textBox(lines, { x = 100000, y = 100000, cx = 5000000, cy = 1000000 } = {}) {
  const paragraphs = lines.map((line) => `<a:p><a:r><a:t>${line}</a:t></a:r></a:p>`).join('');
  return (
    '<p:sp><p:nvSpPr><p:cNvPr id="2" name="Text"/><p:cNvSpPr/><p:nvPr/></p:nvSpPr>' +
    `<p:spPr><a:xfrm><a:off x="${x}" y="${y}"/><a:ext cx="${cx}" cy="${cy}"/></a:xfrm></p:spPr>` +
    `<p:txBody><a:bodyPr/><a:p/>${paragraphs}</p:txBody></p:sp>`
  );
}

/**
 * The smallest package `extractPptx` will read: a presentation, its
 * relationships, and the slide XML handed in. No layout and no master, so a
 * paragraph here inherits from nothing and says only what it says.
 */
export function deckOf(slides) {
  const ids = slides.map((_, i) => `<p:sldId id="${256 + i}" r:id="rId${i + 1}"/>`).join('');
  const rels = slides
    .map((_, i) => `<Relationship Id="rId${i + 1}" Type="${R}/slide" Target="slides/slide${i + 1}.xml"/>`)
    .join('');

  return buildZip([
    stored(
      'ppt/presentation.xml',
      `<p:presentation xmlns:p="${P}" xmlns:r="${R}">` +
        `<p:sldIdLst>${ids}</p:sldIdLst><p:sldSz cx="9144000" cy="6858000"/></p:presentation>`,
    ),
    stored('ppt/_rels/presentation.xml.rels', `<Relationships xmlns="${PR}">${rels}</Relationships>`),
    ...slides.map((xml, i) => stored(`ppt/slides/slide${i + 1}.xml`, xml)),
  ]);
}
