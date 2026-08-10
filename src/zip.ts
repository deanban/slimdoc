/**
 * A read-only, bounded ZIP reader — enough of the format to open an OOXML
 * package, and no more.
 *
 * Hand-rolling this is defensible where hand-rolling an XML parser is not: the
 * container is stable and well documented, and most of the format's scary
 * surface does not apply to a reader. We never write archives, so there is no
 * CRC to generate; OOXML part names are ASCII by ECMA-376, so there is no
 * filename-encoding problem; ZIP64 is detected and refused rather than
 * implemented; and entries are read by name and never written to disk, so
 * path traversal is not reachable.
 *
 * Laziness is the point, and it mirrors the `convertImage` handler in
 * `extract.ts` that keeps a .docx's images from ever being stringified: a deck
 * with forty photographs must not inflate a single one of them to read its
 * slide text.
 */

import { inflateRawSync } from 'node:zlib';

import { UnsupportedFormatError } from './errors.js';
import type { Limits } from './types.js';

const EOCD_SIGNATURE = 0x06054b50;
const CENTRAL_SIGNATURE = 0x02014b50;
const LOCAL_SIGNATURE = 0x04034b50;
const ZIP64_LOCATOR_SIGNATURE = 0x07064b50;

const EOCD_SIZE = 22;
const CENTRAL_SIZE = 46;
const LOCAL_SIZE = 30;
const ZIP64_LOCATOR_SIZE = 20;
/** A trailing archive comment can push the end record this far from the end. */
const MAX_COMMENT = 0xffff;
/** A size field pinned to all-ones means the real value lives in a ZIP64 extra. */
const ZIP64_MARKER = 0xffffffff;

const STORED = 0;
const DEFLATED = 8;

function refuse(message: string): never {
  throw new UnsupportedFormatError(message, 'zip');
}

interface Entry {
  name: string;
  method: number;
  compressed: number;
  uncompressed: number;
  localOffset: number;
}

/**
 * The end record is the only fixed point in a zip: everything is found from it.
 *
 * It has to be found by scanning backwards for its signature, because the
 * archive comment that follows it has no length known in advance. Which means
 * the scan can find those four bytes *inside* the comment — and a comment is
 * arbitrary bytes, so this is not exotic — and then every offset taken from the
 * decoy is nonsense and the archive is refused as truncated when nothing about
 * it is.
 *
 * The record itself says how long the comment is, and in a real one that length
 * runs exactly to the end of the file. Checking it is what tells a record from
 * a passage that merely looks like one.
 */
function findEndRecord(buf: Buffer): number {
  const earliest = Math.max(0, buf.length - MAX_COMMENT - EOCD_SIZE);
  for (let at = buf.length - EOCD_SIZE; at >= earliest; at--) {
    if (buf.readUInt32LE(at) !== EOCD_SIGNATURE) continue;
    if (buf.readUInt16LE(at + 20) === buf.length - at - EOCD_SIZE) return at;
  }
  return refuse('is not a readable zip archive — no end-of-central-directory record');
}

/**
 * A ZIP64 archive is refused by name. Truncating its 64-bit sizes to the 32-bit
 * fields would read the wrong bytes and report success, which is worse than a
 * refusal the user can act on.
 */
function rejectZip64(buf: Buffer, endRecord: number): void {
  const locator = endRecord - ZIP64_LOCATOR_SIZE;
  if (locator < 0) return;
  if (buf.readUInt32LE(locator) === ZIP64_LOCATOR_SIGNATURE) {
    refuse('is a ZIP64 archive, which slimdoc does not read');
  }
}

function readCentralDirectory(buf: Buffer): Entry[] {
  const endRecord = findEndRecord(buf);
  rejectZip64(buf, endRecord);

  const count = buf.readUInt16LE(endRecord + 10);
  const size = buf.readUInt32LE(endRecord + 12);
  const start = buf.readUInt32LE(endRecord + 16);
  if (start + size > buf.length) refuse('has a truncated central directory');

  const entries: Entry[] = [];
  let at = start;
  for (let i = 0; i < count; i++) {
    if (at + CENTRAL_SIZE > buf.length || buf.readUInt32LE(at) !== CENTRAL_SIGNATURE) {
      refuse('has a damaged central directory');
    }
    const nameLength = buf.readUInt16LE(at + 28);
    const entry: Entry = {
      name: buf.toString('utf8', at + CENTRAL_SIZE, at + CENTRAL_SIZE + nameLength),
      method: buf.readUInt16LE(at + 10),
      compressed: buf.readUInt32LE(at + 20),
      uncompressed: buf.readUInt32LE(at + 24),
      localOffset: buf.readUInt32LE(at + 42),
    };
    if (isZip64(entry)) refuse('is a ZIP64 archive, which slimdoc does not read');
    entries.push(entry);
    at += CENTRAL_SIZE + nameLength + buf.readUInt16LE(at + 30) + buf.readUInt16LE(at + 32);
  }
  return entries;
}

function isZip64(entry: Entry): boolean {
  return (
    entry.compressed === ZIP64_MARKER ||
    entry.uncompressed === ZIP64_MARKER ||
    entry.localOffset === ZIP64_MARKER
  );
}

/**
 * The true start of an entry's bytes. The local header repeats the name and
 * carries its own extra field, whose length routinely differs from the central
 * record's — so the offset cannot be computed from the central directory alone.
 */
function dataOffset(buf: Buffer, entry: Entry): number {
  const header = entry.localOffset;
  if (header + LOCAL_SIZE > buf.length || buf.readUInt32LE(header) !== LOCAL_SIGNATURE) {
    refuse(`entry ${entry.name} has no local header`);
  }
  const start =
    header + LOCAL_SIZE + buf.readUInt16LE(header + 26) + buf.readUInt16LE(header + 28);
  if (start + entry.compressed > buf.length) refuse(`entry ${entry.name} is truncated`);
  return start;
}

function inflate(raw: Buffer, entry: Entry, cap: number): Buffer {
  if (entry.method === STORED) return Buffer.from(raw);
  if (entry.method !== DEFLATED) {
    refuse(`entry ${entry.name} uses compression method ${entry.method}, which slimdoc cannot read`);
  }
  try {
    // The declared size is a claim, not a fact: bounding the output is what
    // stops an entry that says one kilobyte and inflates to a gigabyte.
    return inflateRawSync(raw, { maxOutputLength: cap });
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ERR_BUFFER_TOO_LARGE') {
      refuse(`entry ${entry.name} is too large to inflate within the configured limits`);
    }
    refuse(`entry ${entry.name} is corrupt and could not be inflated`);
  }
}

/**
 * Entry name -> lazy inflater. Nothing is decompressed until it is asked for,
 * and an entry that is read twice is only paid for once.
 *
 * Duplicate names resolve to the last entry, which is what every mainstream
 * reader does with an archive that carries the same part twice.
 */
export function readZipEntries(buf: Buffer, limits: Limits): Map<string, () => Buffer> {
  if (buf.length < EOCD_SIZE) refuse('is too short to be a zip archive');

  const budget = { spent: 0 };
  const readers = new Map<string, () => Buffer>();

  for (const entry of readCentralDirectory(buf)) {
    let cached: Buffer | undefined;
    readers.set(entry.name, () => {
      if (cached !== undefined) return cached;

      const cap = Math.min(limits.maxEntryBytes, limits.maxInflatedBytes - budget.spent);
      if (entry.uncompressed > cap || entry.compressed > cap) {
        refuse(`entry ${entry.name} is too large to read within the configured limits`);
      }
      const start = dataOffset(buf, entry);
      cached = inflate(buf.subarray(start, start + entry.compressed), entry, cap);
      budget.spent += cached.length;
      return cached;
    });
  }

  return readers;
}
