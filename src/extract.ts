import { readFile, stat } from 'node:fs/promises';
import { extname } from 'node:path';

import { resolveExtractOptions } from './types.js';
import type { ExtractOverrides, ExtractedDoc, Limits, SourceFormat } from './types.js';
import { UnsupportedFormatError } from './errors.js';
import { htmlToText, meaningfulAlt } from './extract-html.js';
import { rtfToText } from './extract-rtf.js';
import type { SectionedDoc } from './sections.js';
import { formatBytes } from './tokens.js';

export { UnsupportedFormatError };

export const SUPPORTED_EXTENSIONS: readonly string[] = [
  '.docx',
  '.pptx', '.pptm', '.potx',
  '.pdf',
  '.md', '.markdown', '.mdx',
  '.txt', '.text', '.log',
  '.csv', '.tsv',
  '.json', '.yaml', '.yml',
  '.html', '.htm',
  '.rtf',
];

const PPTX_EXTENSIONS = new Set(['.pptx', '.pptm', '.potx']);

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
/**
 * Loaded on first use, not on import.
 *
 * `require('mammoth')` is 43ms of a ~120ms `slimdoc notes.md` run — a third of
 * the process spent building a Word reader for a file that is not Word. All
 * three heavy dependencies are lazy for the same reason: a Markdown or text run
 * must load none of them.
 */
async function loadMammoth(): Promise<MammothApi> {
  return (await import('mammoth')).default as unknown as MammothApi;
}

// --------------------------------------------------------------------------
// Detection
// --------------------------------------------------------------------------

function startsWith(buf: Buffer, bytes: readonly number[]): boolean {
  if (buf.length < bytes.length) return false;
  return bytes.every((b, i) => buf[i] === b);
}

const ZIP_MAGIC = [0x50, 0x4b, 0x03, 0x04]; // PK\x03\x04
const OLE2_MAGIC = [0xd0, 0xcf, 0x11, 0xe0]; // legacy .doc/.xls/.ppt

/**
 * `%PDF` is normally at byte zero, but the specification allows leading bytes
 * before it and mail gateways and scanners produce them. A kilobyte is the
 * conventional tolerance: far enough for real junk, too short for a text file
 * that merely discusses the format to be mistaken for one.
 */
const PDF_HEADER_WINDOW = 1024;

function looksLikePdf(buf: Buffer): boolean {
  return buf.subarray(0, PDF_HEADER_WINDOW).includes('%PDF', 0, 'latin1');
}

/**
 * A zip that carries a `word/document.xml` entry is a .docx. The entry name is
 * stored uncompressed in every local file header, so a substring scan is both
 * correct enough and far cheaper than unzipping just to sniff.
 */
function looksLikeDocx(buf: Buffer): boolean {
  if (!startsWith(buf, ZIP_MAGIC)) return false;
  return buf.includes('word/document.xml', 0, 'latin1');
}

function looksLikePptx(buf: Buffer): boolean {
  if (!startsWith(buf, ZIP_MAGIC)) return false;
  return buf.includes('ppt/presentation.xml', 0, 'latin1');
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
  if (looksLikePptx(buf)) return 'pptx';
  if (looksLikePdf(buf)) return 'pdf';
  // Trust a .docx extension only if the bytes are at least a zip: a .doc file
  // misnamed .docx should reach the "re-save as .docx" error, not mammoth.
  if (ext === '.docx' && startsWith(buf, ZIP_MAGIC)) return 'docx';
  if (PPTX_EXTENSIONS.has(ext) && startsWith(buf, ZIP_MAGIC)) return 'pptx';
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

/**
 * Which legacy container this is, read from the compound-file directory rather
 * than from the extension. `.ppt` renamed to `.doc` is common enough, and being
 * told to re-save a slide deck as .docx helps nobody.
 */
const OLE2_STREAMS: ReadonlyArray<readonly [string, string]> = [
  ['PowerPoint Document', 'ppt'],
  ['Workbook', 'xls'],
  ['Book', 'xls'],
  ['WordDocument', 'doc'],
];

function ole2Format(buf: Buffer): string {
  for (const [stream, format] of OLE2_STREAMS) {
    // Directory entry names are UTF-16LE inside the compound file.
    if (buf.includes(Buffer.from(stream, 'utf16le'))) return format;
  }
  return 'doc';
}

const LEGACY_ADVICE: Readonly<Record<string, string>> = {
  ppt: 'legacy .ppt is not supported — open it in PowerPoint and re-save as .pptx',
  xls: 'legacy .xls is not supported — spreadsheets are not a slimdoc target; export the sheet as .csv',
};

/** Zips we can name from an entry name, and the route out of each. */
const ZIP_REFUSALS: ReadonlyArray<{ marker: string; format: string; message: string }> = [
  {
    marker: 'xl/workbook.xml',
    format: 'xlsx',
    message: 'Excel workbooks are not supported — export the sheet as .csv',
  },
  {
    marker: 'Index/Document.iwa',
    format: 'key',
    message: 'Keynote files are not supported — export as .pptx or .pdf',
  },
  {
    marker: 'opendocument.presentation',
    format: 'odp',
    message: 'OpenDocument presentations are not supported — export as .pptx',
  },
  {
    marker: 'opendocument.text',
    format: 'odt',
    message: 'OpenDocument text is not supported — export as .docx',
  },
];

/** Refuse the binary formats we can name, each with its conversion recipe. */
function rejectKnownBinary(buf: Buffer, source: string): void {
  if (startsWith(buf, OLE2_MAGIC)) {
    const format = ole2Format(buf);
    const advice =
      LEGACY_ADVICE[format] ??
      `legacy .doc is not supported — re-save as .docx, or run: textutil -convert docx ${source}`;
    throw new UnsupportedFormatError(advice, format);
  }
  if (startsWith(buf, ZIP_MAGIC)) {
    for (const { marker, format, message } of ZIP_REFUSALS) {
      if (buf.includes(marker, 0, 'latin1')) throw new UnsupportedFormatError(message, format);
    }
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
  const mammothApi = await loadMammoth();
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

/**
 * Reject an oversized file before any of it is parsed. The caps live in
 * `ExtractOptions` rather than here so that a library caller reading a known
 * enormous document can raise them deliberately.
 */
function rejectOversized(bytes: number, limits: Limits): void {
  if (bytes <= limits.maxInputBytes) return;
  throw new UnsupportedFormatError(
    `is ${formatBytes(bytes)}, over the ${formatBytes(limits.maxInputBytes)} input limit`,
    'oversized',
  );
}

export async function extractFromBuffer(
  buf: Buffer,
  hint?: { filename?: string; extract?: ExtractOverrides },
): Promise<SectionedDoc> {
  const source = hint?.filename ?? '<buffer>';
  const format = detectFormat(buf, hint?.filename);
  const extract = resolveExtractOptions(hint?.extract);
  rejectOversized(buf.length, extract.limits);

  if (format === 'docx') return extractDocx(buf, source);
  if (format === 'pptx') {
    // Lazily imported, with `saxes` behind it: a Markdown or text run must not
    // pay for a parser it never reaches. `npx slimdoc file.md` is the headline
    // entry point, and cold start is most of what it feels like.
    const { extractPptx } = await import('./extract-pptx.js');
    return extractPptx(buf, source, extract);
  }
  if (format === 'pdf') {
    const { extractPdf } = await import('./extract-pdf.js');
    return extractPdf(buf, source, extract);
  }

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

export async function extractFromFile(
  filePath: string,
  options?: ExtractOverrides,
): Promise<SectionedDoc> {
  // The size comes from `stat`, before the read. Measuring the buffer instead
  // is the one order in which `maxInputBytes` cannot do what it exists for: by
  // then the bytes it was meant to refuse are already in memory, and a file
  // larger than Node will hold at all fails with a `RangeError` about 2 GiB
  // rather than with the limit that was actually exceeded.
  rejectOversized((await stat(filePath)).size, resolveExtractOptions(options).limits);
  const buf = await readFile(filePath);
  const doc = await extractFromBuffer(buf, { filename: filePath, ...(options && { extract: options }) });
  return { ...doc, source: filePath };
}
