/**
 * The bounded ZIP reader.
 *
 * slimdoc reads untrusted files by design, so most of these tests are about
 * what the reader *refuses*. The archives are hand-built here rather than
 * checked in: a ZIP64 locator, a lying size field and a compression bomb are
 * all easier to write as bytes than to obtain as fixtures.
 */

import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { deflateRawSync } from 'node:zlib';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import test from 'node:test';

import { readZipEntries } from '../dist/zip.js';
import { DEFAULT_LIMITS } from '../dist/types.js';

const FIXTURES = join(dirname(fileURLToPath(import.meta.url)), 'fixtures');

const STORED = 0;
const DEFLATED = 8;

const limits = (over = {}) => ({ ...DEFAULT_LIMITS, ...over });

/**
 * Build an archive from `entries`, each `{ name, body, method, declared }`.
 * `body` is the stored bytes exactly as they go on disk; `declared` overrides
 * the uncompressed size written into the headers, which is how a lying archive
 * is expressed.
 */
function buildZip(entries, { zip64 = false, comment = '' } = {}) {
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

const stored = (name, text) => ({ name, body: Buffer.from(text, 'utf8'), method: STORED });

function deflated(name, text) {
  return { name, body: deflateRawSync(Buffer.from(text, 'utf8')), method: DEFLATED };
}

// --------------------------------------------------------------------------
// reading
// --------------------------------------------------------------------------

test('zip: a stored entry comes back byte-identical', () => {
  const entries = readZipEntries(buildZip([stored('a.xml', '<a/>')]), limits());
  assert.deepEqual([...entries.keys()], ['a.xml']);
  assert.equal(entries.get('a.xml')().toString('utf8'), '<a/>');
});

test('zip: a deflated entry is inflated on demand', () => {
  const text = '<p>'.repeat(500);
  const entries = readZipEntries(buildZip([deflated('big.xml', text)]), limits());
  assert.equal(entries.get('big.xml')().toString('utf8'), text);
});

test('zip: a real .docx yields its document part', async () => {
  const buf = await readFile(join(FIXTURES, 'sample.docx'));
  const entries = readZipEntries(buf, limits());

  assert.ok(entries.has('word/document.xml'));
  assert.match(entries.get('word/document.xml')().toString('utf8'), /^<\?xml/);
});

test('zip: a real .pptx yields its presentation part', async () => {
  const buf = await readFile(join(FIXTURES, 'corpus', 'kitchen-sink.pptx'));
  const entries = readZipEntries(buf, limits());

  assert.ok(entries.has('ppt/presentation.xml'));
  assert.match(entries.get('ppt/presentation.xml')().toString('utf8'), /sldIdLst/);
});

test('zip: an archive comment does not hide the end record', () => {
  const buf = buildZip([stored('a.xml', 'hi')], { comment: 'x'.repeat(4000) });
  assert.equal(readZipEntries(buf, limits()).get('a.xml')().toString('utf8'), 'hi');
});

test('zip: duplicate names resolve to the last entry', () => {
  const buf = buildZip([stored('dup.xml', 'first'), stored('dup.xml', 'second')]);
  const entries = readZipEntries(buf, limits());

  assert.equal(entries.size, 1);
  assert.equal(entries.get('dup.xml')().toString('utf8'), 'second');
});

// --------------------------------------------------------------------------
// laziness
// --------------------------------------------------------------------------

/**
 * The point of the whole module: a 40-image deck must never inflate a single
 * PNG. Listing an archive whose entries would be refused proves that nothing is
 * decompressed until it is asked for.
 */
test('zip: nothing is decompressed until an entry is called', () => {
  const buf = buildZip([
    stored('ok.xml', 'fine'),
    { name: 'huge.bin', body: Buffer.alloc(10), method: STORED, declared: 999_000_000 },
  ]);
  const entries = readZipEntries(buf, limits({ maxEntryBytes: 1000 }));

  assert.equal(entries.size, 2);
  assert.equal(entries.get('ok.xml')().toString('utf8'), 'fine');
  assert.throws(() => entries.get('huge.bin')(), /too large/i);
});

// --------------------------------------------------------------------------
// refusals
// --------------------------------------------------------------------------

test('zip: bytes that are not an archive are refused by name', () => {
  assert.throws(() => readZipEntries(Buffer.from('not a zip at all'), limits()), /zip/i);
});

test('zip: a ZIP64 archive is refused rather than truncated', () => {
  const buf = buildZip([stored('a.xml', 'hi')], { zip64: true });
  assert.throws(() => readZipEntries(buf, limits()), /zip64/i);
});

test('zip: an unsupported compression method is named, not guessed at', () => {
  const buf = buildZip([{ name: 'a.xml', body: Buffer.from('x'), method: 12 }]);
  const entries = readZipEntries(buf, limits());
  assert.throws(() => entries.get('a.xml')(), /compression method 12/i);
});

/**
 * The declared size is a claim, not a fact. An entry that says 1 kB and
 * inflates to a gigabyte is the classic zip bomb, so the inflate itself is
 * bounded rather than the header believed.
 */
test('zip: an entry that lies about its size is stopped mid-inflate', () => {
  const bomb = deflateRawSync(Buffer.alloc(5_000_000, 0x41));
  const buf = buildZip([{ name: 'bomb.xml', body: bomb, method: DEFLATED, declared: 100 }]);
  const entries = readZipEntries(buf, limits({ maxEntryBytes: 50_000 }));

  assert.throws(() => entries.get('bomb.xml')(), /too large/i);
});

test('zip: the inflated total is capped across entries, not just per entry', () => {
  const buf = buildZip([stored('a.xml', 'a'.repeat(600)), stored('b.xml', 'b'.repeat(600))]);
  const entries = readZipEntries(buf, limits({ maxInflatedBytes: 1000 }));

  assert.equal(entries.get('a.xml')().length, 600);
  assert.throws(() => entries.get('b.xml')(), /too large|budget/i);
});

test('zip: re-reading an entry does not spend the budget twice', () => {
  const buf = buildZip([stored('a.xml', 'a'.repeat(600))]);
  const entries = readZipEntries(buf, limits({ maxInflatedBytes: 1000 }));

  assert.equal(entries.get('a.xml')().length, 600);
  assert.equal(entries.get('a.xml')().length, 600);
});
