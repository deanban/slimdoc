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
import { preserveGridRegions } from './pdf-preformat.js';
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
  getViewport(options: { scale: number; rotation?: number }): { height: number };
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

/**
 * One page's lines.
 *
 * `maxItemsPerPage` bounds the *output*, and only that. `getTextContent()` has
 * already built every item on the page by the time the cap is applied, so a page
 * carrying millions of runs costs what it costs and the cap keeps the result
 * from growing to match. Bounding the work itself needs an entry point unpdf
 * does not expose — recorded here as a known limit rather than implied to be a
 * guard, because a cap that reads as protection and is not is worse than none.
 */
async function readPage(
  pdf: PdfDocument,
  index: number,
  opts: ExtractOptions,
): Promise<{ page: PageLines; truncated: boolean }> {
  const page = await pdf.getPage(index);
  const content = await page.getTextContent();
  const cap = opts.limits.maxItemsPerPage;
  const items = toItems(content.items, cap);
  // `rotation: 0` rather than the page's own: `/Rotate` turns the paper, not the
  // text, and the coordinates above are in unrotated space. A default viewport
  // reports 612 for a page 792 points tall, so the 12% band that marks page
  // furniture reached 30% down it and deleted repeated *body* lines as running
  // headers. Height has to be measured in the space the glyphs are placed in.
  const height = page.getViewport({ scale: 1, rotation: 0 }).height || DEFAULT_PAGE_HEIGHT;

  return {
    page: { index, height, lines: layoutPage(items, height) },
    truncated: content.items.length > cap,
  };
}

interface Findings {
  textless: number;
  suppressed: number;
  dropped: number;
  truncated: number;
  regions: number;
}

function warningsFor({ textless, suppressed, dropped, truncated, regions }: Findings): string[] {
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
  if (regions > 0) {
    warnings.push(
      `${regions} possible table${regions === 1 ? '' : 's'} preserved as preformatted text; ` +
        'columns may be approximate',
    );
  }
  return warnings;
}

const NO_TEXT = (index: number): string => `[page ${index}: no extractable text]`;

function sectionsFrom(pages: PageLines[], opts: ExtractOptions): { sections: Section[]; regions: number } {
  let regions = 0;
  const sections = pages.map((page) => {
    const body = toParagraphs(page.lines);
    if (body.trim() === '') return { index: page.index, text: NO_TEXT(page.index) };

    // Dehyphenation runs before the grid pass: a hyphen at a line end joins two
    // lines together, which can change whether a run of rows is contiguous.
    const joined = opts.dehyphenate ? dehyphenate(body) : body;
    const preserved = opts.preserveTables ? preserveGridRegions(joined) : { text: joined, regions: 0 };
    regions += preserved.regions;
    return { index: page.index, text: preserved.text };
  });

  return { sections, regions };
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
    const read = await readPage(pdf, index, opts);
    if (read.truncated) truncated += 1;
    pages.push(read.page);
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
  const { sections, regions } = sectionsFrom(pages, opts);

  return {
    text: sections.map((s) => s.text).join('\n\n'),
    format: 'pdf',
    options: opts,
    source,
    warnings: warningsFor({ textless, suppressed, dropped: selection.dropped, truncated, regions }),
    sections,
  };
}
