/**
 * PowerPoint packages -> one section per slide.
 *
 * Two rules carry most of the correctness here. Slide order comes from
 * `<p:sldIdLst>` resolved through the presentation's relationships, never from
 * the numbers in `slideN.xml` — reordering and deletion leave those permuted
 * and gapped. And the layout and master are read for *metadata* only: they
 * resolve a placeholder's type and the list style its paragraphs take their
 * bullets from, but their text is chrome ("Click to add title", footers, slide
 * numbers) and never reaches the output.
 */

import { UnsupportedFormatError } from './errors.js';
import {
  child,
  children,
  isTrue,
  parseXml,
  readRels,
  relsPartFor,
  resolvePart,
  type XmlNode,
} from './ooxml.js';
import {
  listStyleOf,
  placeholderOf,
  serialiseSpTree,
  type Inheritance,
  type ShapeOutput,
  type SlideContext,
  type StyleKind,
} from './pptx-shapes.js';
import type { Section, SectionedDoc } from './sections.js';
import { resolveExtractOptions, type ExtractOverrides } from './types.js';
import { selectPages } from './utils/ranges.js';
import { readZipEntries } from './zip.js';

const PRESENTATION_PART = 'ppt/presentation.xml';
const SLIDE_RELATIONSHIP = /\/slide$/;
const LAYOUT_RELATIONSHIP = /\/slideLayout$/;
const MASTER_RELATIONSHIP = /\/slideMaster$/;

/** The master's three list styles, and which shapes resolve through each. */
const MASTER_STYLES: ReadonlyArray<readonly [StyleKind, string]> = [
  ['title', 'titleStyle'],
  ['body', 'bodyStyle'],
  ['other', 'otherStyle'],
];

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
    if (root) refs.push({ part, root, hidden: isTrue(root.attrs['show']) === false });
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
 * What a slide's shapes inherit: placeholder types from the layout, and the
 * list styles a paragraph's bullet resolves through.
 *
 * A slide placeholder often states only its index and inherits the rest, so
 * without the layout the "title and body first" ordering is unreliable. And a
 * paragraph in PowerPoint usually says nothing about its bullet at all — the
 * glyph comes from the layout placeholder's `a:lstStyle`, or failing that from
 * one of the master's three `p:txStyles`. Reading only the paragraph finds no
 * list in a deck that is nothing but lists.
 *
 * Still metadata only: no text from either part reaches the output.
 */
function inheritanceFor(entries: Entries, slidePart: string, cache: Map<string, Inheritance>): Inheritance {
  const inherited: Inheritance = {
    types: new Map(),
    layoutByIdx: new Map(),
    layoutByType: new Map(),
    masterStyles: new Map(),
  };

  const rel = [...relsOf(entries, slidePart).values()].find((r) => LAYOUT_RELATIONSHIP.test(r.type));
  if (!rel || rel.external) return inherited;

  // Keyed by layout rather than by slide: a deck of two hundred slides usually
  // has a handful of layouts over one master, and this is otherwise two XML
  // parses per slide for an answer that does not vary between them.
  const layoutPart = resolvePart(slidePart, rel.target);
  const cached = cache.get(layoutPart);
  if (cached) return cached;
  cache.set(layoutPart, inherited);

  const layout = partOf(entries, layoutPart);
  const tree = layout && child(child(layout, 'p', 'cSld') ?? layout, 'p', 'spTree');
  for (const shape of tree ? children(tree, 'p', 'sp') : []) {
    const ph = placeholderOf(shape);
    if (!ph) continue;

    const idx = ph.attrs['idx'];
    const type = ph.attrs['type'];
    if (idx !== undefined && type !== undefined) inherited.types.set(idx, type);

    const style = listStyleOf(shape);
    if (!style) continue;
    if (idx !== undefined) inherited.layoutByIdx.set(idx, style);
    if (type !== undefined) inherited.layoutByType.set(type, style);
  }

  const masterRel = [...relsOf(entries, layoutPart).values()].find((r) => MASTER_RELATIONSHIP.test(r.type));
  if (!masterRel || masterRel.external) return inherited;

  const master = partOf(entries, resolvePart(layoutPart, masterRel.target));
  const styles = master && child(master, 'p', 'txStyles');
  for (const [kind, name] of MASTER_STYLES) {
    const node = styles && child(styles, 'p', name);
    if (node) inherited.masterStyles.set(kind, node);
  }
  return inherited;
}

function addTotals(into: ShapeOutput, one: ShapeOutput): void {
  into.images += one.images;
  into.captionedImages += one.captionedImages;
  into.mergedCells += one.mergedCells;
  into.skippedCharts.push(...one.skippedCharts);
  into.chartNotes.push(...one.chartNotes);
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
  warnings.push(...new Set(totals.chartNotes));
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
    blocks: [], images: 0, captionedImages: 0, mergedCells: 0, skippedCharts: [], chartNotes: [],
  };
  const sections: Section[] = [];
  const inheritance = new Map<string, Inheritance>();

  for (const page of selection.pages) {
    const ref = included[page - 1];
    if (!ref) continue;

    const rels = relsOf(entries, ref.part);
    const ctx: SlideContext = {
      slide,
      inherited: inheritanceFor(entries, ref.part, inheritance),
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
    sections.push({
      index: page,
      ...(output.title === undefined ? {} : { label: output.title }),
      text,
    });
  }

  return {
    text: sections.map((s) => s.text).join('\n\n'),
    format: 'pptx',
    source,
    warnings: warningsFor(totals, all.length - included.length, selection.dropped),
    sections,
  };
}
