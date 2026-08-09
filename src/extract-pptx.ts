/**
 * PowerPoint packages -> one section per slide.
 *
 * Two rules carry most of the correctness here. Slide order comes from
 * `<p:sldIdLst>` resolved through the presentation's relationships, never from
 * the numbers in `slideN.xml` — reordering and deletion leave those permuted
 * and gapped. And the layout and master are read for *metadata* only: they
 * resolve a placeholder's type, but their text is chrome ("Click to add
 * title", footers, slide numbers) and never reaches the output.
 */

import { UnsupportedFormatError } from './errors.js';
import { child, children, parseXml, readRels, relsPartFor, resolvePart, type XmlNode } from './ooxml.js';
import { serialiseSpTree, type ShapeOutput, type SlideContext } from './pptx-shapes.js';
import type { Section, SectionedDoc } from './sections.js';
import { resolveExtractOptions, type ExtractOverrides } from './types.js';
import { selectPages } from './utils/ranges.js';
import { readZipEntries } from './zip.js';

const PRESENTATION_PART = 'ppt/presentation.xml';
const SLIDE_RELATIONSHIP = /\/slide$/;
const LAYOUT_RELATIONSHIP = /\/slideLayout$/;

/** A 4:3 deck in EMU, used only when a malformed package omits `<p:sldSz>`. */
const DEFAULT_SLIDE = { cx: 9144000, cy: 6858000 };

type Entries = Map<string, () => Buffer>;

function partOf(entries: Entries, name: string): XmlNode | undefined {
  const reader = entries.get(name);
  return reader ? parseXml(reader()) : undefined;
}

function relsOf(entries: Entries, part: string): ReturnType<typeof readRels> {
  return readRels(entries.get(relsPartFor(part))?.());
}

interface SlideRef {
  part: string;
  root: XmlNode;
  hidden: boolean;
}

/** The slide parts in presentation order, each already parsed. */
function slideRefs(entries: Entries, presentation: XmlNode): SlideRef[] {
  const rels = relsOf(entries, PRESENTATION_PART);
  const list = child(presentation, 'p', 'sldIdLst');
  const refs: SlideRef[] = [];

  for (const sldId of list ? children(list, 'p', 'sldId') : []) {
    const rel = rels.get(sldId.attrs['r:id'] ?? '');
    if (!rel || rel.external || !SLIDE_RELATIONSHIP.test(rel.type)) continue;

    const part = resolvePart(PRESENTATION_PART, rel.target);
    const root = partOf(entries, part);
    if (root) refs.push({ part, root, hidden: root.attrs['show'] === '0' });
  }
  return refs;
}

function slideSize(presentation: XmlNode): { cx: number; cy: number } {
  const size = child(presentation, 'p', 'sldSz');
  const cx = Number(size?.attrs['cx']);
  const cy = Number(size?.attrs['cy']);
  return cx > 0 && cy > 0 ? { cx, cy } : DEFAULT_SLIDE;
}

/**
 * Placeholder `idx` -> type, from the slide's layout. A slide placeholder often
 * states only its index and inherits the rest, so without this the "title and
 * body first" ordering is unreliable on decks that lean on their layouts.
 */
function placeholderTypes(entries: Entries, slidePart: string): Map<string, string> {
  const types = new Map<string, string>();
  const rel = [...relsOf(entries, slidePart).values()].find((r) => LAYOUT_RELATIONSHIP.test(r.type));
  if (!rel) return types;

  const layout = partOf(entries, resolvePart(slidePart, rel.target));
  const tree = layout && child(child(layout, 'p', 'cSld') ?? layout, 'p', 'spTree');
  for (const shape of tree ? children(tree, 'p', 'sp') : []) {
    const nvSpPr = child(shape, 'p', 'nvSpPr');
    const nvPr = nvSpPr && child(nvSpPr, 'p', 'nvPr');
    const ph = nvPr && child(nvPr, 'p', 'ph');
    const idx = ph?.attrs['idx'];
    if (idx !== undefined && ph?.attrs['type'] !== undefined) types.set(idx, ph.attrs['type']);
  }
  return types;
}

/** The first line of the leading block, which is the title placeholder's text. */
function titleOf(blocks: string[]): string | undefined {
  const first = blocks[0]?.split('\n')[0]?.trim();
  return first === undefined || first === '' ? undefined : first;
}

function addTotals(into: ShapeOutput, one: ShapeOutput): void {
  into.images += one.images;
  into.captionedImages += one.captionedImages;
  into.mergedCells += one.mergedCells;
  into.skippedCharts.push(...one.skippedCharts);
}

function warningsFor(totals: ShapeOutput, hidden: number, dropped: number): string[] {
  const warnings: string[] = [];
  if (totals.images > 0) {
    const kept = totals.captionedImages > 0 ? `, ${totals.captionedImages} kept as [image: ...] captions` : '';
    warnings.push(`dropped ${totals.images} embedded image${totals.images === 1 ? '' : 's'}${kept}`);
  }
  if (totals.mergedCells > 0) warnings.push(`${totals.mergedCells} merged cells flattened`);
  for (const reason of new Set(totals.skippedCharts)) {
    warnings.push(`skipped a chart because ${reason}`);
  }
  if (hidden > 0) {
    warnings.push(`skipped ${hidden} hidden slide${hidden === 1 ? '' : 's'} — use --hidden to include them`);
  }
  if (dropped > 0) warnings.push(`stopped after the page limit; ${dropped} slides were not read`);
  return warnings;
}

export function extractPptx(
  buf: Buffer,
  source: string,
  options: ExtractOverrides = {},
): SectionedDoc {
  const opts = resolveExtractOptions(options);
  const entries = readZipEntries(buf, opts.limits);

  const presentation = partOf(entries, PRESENTATION_PART);
  if (!presentation) {
    throw new UnsupportedFormatError('is a zip but carries no ppt/presentation.xml', 'pptx');
  }

  const all = slideRefs(entries, presentation);
  const included = opts.hiddenContent ? all : all.filter((ref) => !ref.hidden);
  const selection = selectPages(included.length, opts.pages, opts.limits.maxPages);

  const slide = slideSize(presentation);
  const totals: ShapeOutput = {
    blocks: [], images: 0, captionedImages: 0, mergedCells: 0, skippedCharts: [],
  };
  const sections: Section[] = [];

  for (const page of selection.pages) {
    const ref = included[page - 1];
    if (!ref) continue;

    const rels = relsOf(entries, ref.part);
    const ctx: SlideContext = {
      slide,
      placeholderTypes: placeholderTypes(entries, ref.part),
      hiddenContent: opts.hiddenContent,
      chartData: opts.chartData,
      diagramText: opts.diagramText,
      part: (id) => {
        const rel = rels.get(id);
        return rel && !rel.external ? partOf(entries, resolvePart(ref.part, rel.target)) : undefined;
      },
    };
    const tree = child(child(ref.root, 'p', 'cSld') ?? ref.root, 'p', 'spTree');
    const output = tree ? serialiseSpTree(tree, ctx) : { ...totals, blocks: [] };
    addTotals(totals, output);

    // Shapes are separated by a blank line: `canJoin` refuses to join across
    // one, which is what stops `unwrap` gluing two independent text boxes.
    const text = output.blocks.join('\n\n');
    const label = titleOf(output.blocks);
    sections.push({ index: page, ...(label === undefined ? {} : { label }), text });
  }

  return {
    text: sections.map((s) => s.text).join('\n\n'),
    format: 'pptx',
    source,
    warnings: warningsFor(totals, all.length - included.length, selection.dropped),
    sections,
  };
}
