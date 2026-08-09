import { readFile } from 'node:fs/promises';
import { extname } from 'node:path';
import mammoth from 'mammoth';

import type { ExtractedDoc, SourceFormat } from './types.js';
import { htmlToText, meaningfulAlt } from './extract-html.js';
import { rtfToText } from './extract-rtf.js';

/** Thrown for inputs we deliberately refuse; the CLI turns these into messages. */
export class UnsupportedFormatError extends Error {
  readonly format: string;

  constructor(message: string, format = 'unknown') {
    super(message);
    this.name = 'UnsupportedFormatError';
    this.format = format;
  }
}

export const SUPPORTED_EXTENSIONS: readonly string[] = [
  '.docx',
  '.md', '.markdown', '.mdx',
  '.txt', '.text', '.log',
  '.csv', '.tsv',
  '.json', '.yaml', '.yml',
  '.html', '.htm',
  '.rtf',
];

const MARKDOWN_EXTENSIONS = new Set(['.md', '.markdown', '.mdx']);
const HTML_EXTENSIONS = new Set(['.html', '.htm', '.xhtml']);

// mammoth ships an `export =` .d.ts that predates convertToMarkdown, so the
// two entry points we need are declared here rather than guessed at.
interface MammothMessage {
  type: string;
  message: string;
}
interface MammothResult {
  value: string;
  messages: MammothMessage[];
}
interface MammothImage {
  contentType: string;
  altText?: string;
}
interface MammothApi {
  convertToHtml(
    input: { buffer: Buffer },
    options: { convertImage: unknown; ignoreEmptyParagraphs?: boolean },
  ): Promise<MammothResult>;
  images: { imgElement(f: (image: MammothImage) => Promise<Record<string, string>>): unknown };
}
const mammothApi = mammoth as unknown as MammothApi;

// --------------------------------------------------------------------------
// Detection
// --------------------------------------------------------------------------

function startsWith(buf: Buffer, bytes: readonly number[]): boolean {
  if (buf.length < bytes.length) return false;
  return bytes.every((b, i) => buf[i] === b);
}

const ZIP_MAGIC = [0x50, 0x4b, 0x03, 0x04]; // PK\x03\x04
const OLE2_MAGIC = [0xd0, 0xcf, 0x11, 0xe0]; // legacy .doc/.xls/.ppt
const PDF_MAGIC = [0x25, 0x50, 0x44, 0x46]; // %PDF

/**
 * A zip that carries a `word/document.xml` entry is a .docx. The entry name is
 * stored uncompressed in every local file header, so a substring scan is both
 * correct enough and far cheaper than unzipping just to sniff.
 */
function looksLikeDocx(buf: Buffer): boolean {
  if (!startsWith(buf, ZIP_MAGIC)) return false;
  return buf.includes('word/document.xml', 0, 'latin1');
}

function looksLikeRtf(buf: Buffer): boolean {
  return buf.subarray(0, 5).toString('latin1') === '{\\rtf';
}

const HTML_LEAD = /^\s*(?:<\?xml[^>]*>\s*)?(?:<!doctype\s+html|<html\b|<head\b|<body\b)/i;
const HTML_FRAGMENT = /<\/(?:p|div|span|td|tr|li|h[1-6]|table|body|html)\s*>|<br\s*\/?>/i;

function looksLikeHtml(sample: string): boolean {
  if (HTML_LEAD.test(sample)) return true;
  const matches = sample.match(new RegExp(HTML_FRAGMENT.source, 'gi'));
  return matches !== null && matches.length >= 2;
}

export function detectFormat(buf: Buffer, filename?: string): SourceFormat {
  const ext = filename ? extname(filename).toLowerCase() : '';

  if (looksLikeDocx(buf)) return 'docx';
  // Trust a .docx extension only if the bytes are at least a zip: a .doc file
  // misnamed .docx should reach the "re-save as .docx" error, not mammoth.
  if (ext === '.docx' && startsWith(buf, ZIP_MAGIC)) return 'docx';
  if (looksLikeRtf(buf)) return 'rtf';
  if (ext === '.rtf') return 'rtf';
  if (HTML_EXTENSIONS.has(ext)) return 'html';
  if (MARKDOWN_EXTENSIONS.has(ext)) return 'markdown';

  const sample = decodeLossy(buf.subarray(0, 4096));
  if (looksLikeHtml(sample)) return 'html';
  return 'text';
}

// --------------------------------------------------------------------------
// Decoding
// --------------------------------------------------------------------------

function decodeLossy(buf: Buffer): string {
  return buf.toString('utf8');
}

/**
 * Decode as UTF-8 or UTF-16, dropping a leading BOM. Throws on binary input.
 *
 * The messages name no source: every caller of these errors already prefixes one
 * (`slimdoc: <file>: ...`), which is why the `rejectKnownBinary` refusals omit it too.
 */
function decodeTextStrict(buf: Buffer): string {
  if (startsWith(buf, [0xff, 0xfe])) {
    return buf.subarray(2).toString('utf16le');
  }
  if (startsWith(buf, [0xfe, 0xff])) {
    // Node only decodes little-endian UTF-16, so byte-swap a copy first.
    // swap16() requires an even length; a trailing odd byte is truncated junk.
    const even = buf.length - ((buf.length - 2) % 2);
    return Buffer.from(buf.subarray(2, even)).swap16().toString('utf16le');
  }

  let text: string;
  try {
    text = new TextDecoder('utf-8', { fatal: true }).decode(buf);
  } catch {
    throw new UnsupportedFormatError(
      'not valid UTF-8 text — it looks like a binary file. ' +
        'Convert it to .docx, .html, .rtf or plain text first.',
      'binary',
    );
  }
  if (text.includes('\u0000')) {
    throw new UnsupportedFormatError(
      'contains NUL bytes — it looks like a binary file.',
      'binary',
    );
  }
  return text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
}

/** Refuse the two binary formats we can name, with the conversion recipe. */
function rejectKnownBinary(buf: Buffer, source: string): void {
  if (startsWith(buf, OLE2_MAGIC)) {
    throw new UnsupportedFormatError(
      'legacy .doc is not supported — re-save as .docx, or run: ' +
        `textutil -convert docx ${source}`,
      'doc',
    );
  }
  if (startsWith(buf, PDF_MAGIC)) {
    throw new UnsupportedFormatError(
      `PDF is not supported — run: pdftotext ${source} - | slimdoc`,
      'pdf',
    );
  }
}

// --------------------------------------------------------------------------
// docx
// --------------------------------------------------------------------------

async function extractDocx(buf: Buffer, source: string): Promise<ExtractedDoc> {
  let images = 0;
  let captioned = 0;

  // THE critical line. mammoth's default converter is `images.dataUri`, which
  // base64-encodes every embedded image into the output — on a real Teams
  // transcript export that is ~99% of the resulting characters. This handler
  // never touches the bytes, so they are never stringified at all.
  const convertImage = mammothApi.images.imgElement(async (image: MammothImage) => {
    images += 1;
    const alt = meaningfulAlt(image.altText);
    if (alt) captioned += 1;
    return { src: '', alt: alt ?? '' };
  });

  // HTML, not Markdown: mammoth's Markdown writer has no table support at all,
  // so a table arrives as one orphan paragraph per cell. Its HTML writer emits
  // real `<table><tr><td>`, which the shared emitter turns into GFM — one table
  // implementation for docx and HTML instead of two.
  const result = await mammothApi.convertToHtml({ buffer: buf }, { convertImage });
  const { text, mergedCells } = htmlToText(result.value);

  const warnings = result.messages
    .filter((m) => m.type !== 'info')
    .map((m) => m.message);
  if (images > 0) {
    const kept = captioned > 0 ? `, ${captioned} kept as [image: ...] captions` : '';
    warnings.push(`dropped ${images} embedded image${images === 1 ? '' : 's'}${kept}`);
  }
  addMergedCellWarning(warnings, mergedCells);

  return { text: normaliseNewlines(text), format: 'docx', source, warnings };
}

/** Markdown has no rowspan or colspan, so the association was approximated. */
function addMergedCellWarning(warnings: string[], mergedCells: number): void {
  if (mergedCells > 0) warnings.push(`${mergedCells} merged cells flattened`);
}

function normaliseNewlines(text: string): string {
  return text.replace(/\r\n?/g, '\n');
}

// --------------------------------------------------------------------------
// Public API
// --------------------------------------------------------------------------

export async function extractFromBuffer(
  buf: Buffer,
  hint?: { filename?: string },
): Promise<ExtractedDoc> {
  const source = hint?.filename ?? '<buffer>';
  const format = detectFormat(buf, hint?.filename);

  if (format === 'docx') return extractDocx(buf, source);

  rejectKnownBinary(buf, source);
  const raw = decodeTextStrict(buf);

  if (format === 'html') {
    const { text, droppedImages, mergedCells } = htmlToText(raw);
    const warnings: string[] = [];
    if (droppedImages > 0) {
      warnings.push(`dropped ${droppedImages} image${droppedImages === 1 ? '' : 's'}`);
    }
    addMergedCellWarning(warnings, mergedCells);
    return { text, format: 'html', source, warnings };
  }

  if (format === 'rtf') {
    const { text, droppedPictures } = rtfToText(raw);
    const warnings = ['RTF extraction is approximate — formatting is discarded'];
    if (droppedPictures > 0) {
      warnings.push(
        `dropped ${droppedPictures} embedded picture${droppedPictures === 1 ? '' : 's'}`,
      );
    }
    return { text, format: 'rtf', source, warnings };
  }

  return { text: normaliseNewlines(raw), format, source, warnings: [] };
}

export async function extractFromFile(filePath: string): Promise<ExtractedDoc> {
  const buf = await readFile(filePath);
  const doc = await extractFromBuffer(buf, { filename: filePath });
  return { ...doc, source: filePath };
}
