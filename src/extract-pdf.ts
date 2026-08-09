/**
 * PDF -> one section per page, via unpdf.
 *
 * The low-level `getDocumentProxy` path is used rather than `extractTextItems`
 * for one reason: it reads only the *selected* pages, one at a time. Whole
 * document extraction fans out across every page, which is the wrong shape for
 * `--pages 1-3` of a two-thousand-page report and the wrong shape for a cap on
 * how much of a hostile file is ever touched.
 */

import { UnsupportedFormatError } from './errors.js';
import {
  dehyphenate,
  layoutPage,
  suppressRunningText,
  toParagraphs,
  type PageLines,
  type TextItem,
} from './pdf-layout.js';
import type { Section, SectionedDoc } from './sections.js';
import { resolveExtractOptions, type ExtractOptions, type ExtractOverrides } from './types.js';
import { selectPages } from './utils/ranges.js';

/** The subset of pdf.js's text item that layout needs. */
interface RawItem {
  str?: string;
  width?: number;
  height?: number;
  transform?: number[];
}

interface PdfPage {
  getTextContent(): Promise<{ items: RawItem[] }>;
  getViewport(options: { scale: number }): { height: number };
}

interface PdfDocument {
  numPages: number;
  getPage(n: number): Promise<PdfPage>;
}

const DEFAULT_PAGE_HEIGHT = 792;

function toItems(raw: RawItem[], limit: number): TextItem[] {
  const items: TextItem[] = [];
  for (const item of raw.slice(0, limit)) {
    // A marked-content item carries no `str` at all; the transform's last two
    // entries are the run's translation, which is where it sits on the page.
    if (typeof item.str !== 'string' || item.transform === undefined) continue;
    items.push({
      str: item.str,
      x: item.transform[4] ?? 0,
      y: item.transform[5] ?? 0,
      width: item.width ?? 0,
      height: item.height ?? 0,
    });
  }
  return items;
}

async function readPage(pdf: PdfDocument, index: number, opts: ExtractOptions): Promise<PageLines> {
  const page = await pdf.getPage(index);
  const content = await page.getTextContent();
  const items = toItems(content.items, opts.limits.maxItemsPerPage);
  const height = page.getViewport({ scale: 1 }).height || DEFAULT_PAGE_HEIGHT;

  return { index, height, lines: layoutPage(items, height) };
}

function warningsFor(
  textless: number,
  suppressed: number,
  dropped: number,
  truncated: number,
): string[] {
  const warnings: string[] = [];
  warnings.push('PDF structure is reconstructed from glyph positions — reading order is inferred');
  if (textless > 0) {
    warnings.push(
      `${textless} page${textless === 1 ? ' has' : 's have'} no extractable text — they are probably scans`,
    );
  }
  if (suppressed > 0) {
    warnings.push(`suppressed ${suppressed} repeated running header/footer lines, keeping the first`);
  }
  if (dropped > 0) warnings.push(`stopped after the page limit; ${dropped} pages were not read`);
  if (truncated > 0) {
    warnings.push(`${truncated} page${truncated === 1 ? '' : 's'} hit the per-page item cap and were cut short`);
  }
  return warnings;
}

const NO_TEXT = (index: number): string => `[page ${index}: no extractable text]`;

function sectionsFrom(pages: PageLines[], opts: ExtractOptions): Section[] {
  return pages.map((page) => {
    const body = toParagraphs(page.lines);
    const text = body.trim() === '' ? NO_TEXT(page.index) : body;
    return { index: page.index, text: opts.dehyphenate ? dehyphenate(text) : text };
  });
}

export async function extractPdf(
  buf: Buffer,
  source: string,
  options: ExtractOverrides = {},
): Promise<SectionedDoc> {
  const opts = resolveExtractOptions(options);
  const { getDocumentProxy } = await import('unpdf');
  // stderr is slimdoc's own warning channel, and pdf.js is chatty on it: a
  // missing embedded font or an ES2025 built-in the running Node lacks each
  // produce a line that reads like a slimdoc failure and is not one. Errors
  // still surface, as rejections from the calls below.
  const pdf = (await getDocumentProxy(new Uint8Array(buf), { verbosity: 0 })) as unknown as PdfDocument;

  const selection = selectPages(pdf.numPages, opts.pages, opts.limits.maxPages);
  const pages: PageLines[] = [];
  let truncated = 0;

  for (const index of selection.pages) {
    const page = await readPage(pdf, index, opts);
    if (page.lines.length >= opts.limits.maxItemsPerPage) truncated += 1;
    pages.push(page);
  }

  const textless = pages.filter((page) => page.lines.length === 0).length;
  if (pages.length > 0 && textless === pages.length) {
    throw new UnsupportedFormatError(
      'has no extractable text on any selected page — it is a scan. ' +
        `Run: ocrmypdf ${source} searchable.pdf`,
      'pdf-scan',
    );
  }

  const suppressed = opts.dropRunningHeaders ? suppressRunningText(pages) : 0;
  const sections = sectionsFrom(pages, opts);

  return {
    text: sections.map((s) => s.text).join('\n\n'),
    format: 'pdf',
    source,
    warnings: warningsFor(textless, suppressed, selection.dropped, truncated),
    sections,
  };
}
