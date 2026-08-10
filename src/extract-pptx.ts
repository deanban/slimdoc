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
  rootAttributes,
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
import { readZipEntries, type EntryReader } from './zip.js';

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

type Entries = Map<string, EntryReader>;

function partOf(entries: Entries, name: string): XmlNode | undefined {
  const reader = entries.get(name);
  return reader ? parseXml(reader()) : undefined;
}

function relsOf(entries: Entries, part: string): ReturnType<typeof readRels> {
  return readRels(entries.get(relsPartFor(part))?.());
}

interface SlideRef {
  part: string;
  hidden: boolean;
}

/** Enough of a slide part to hold its root element, and no more. */
const ROOT_HEAD_BYTES = 8192;

/**
 * The slide parts in presentation order, named but not yet parsed.
 *
 * Parsing them here is what `--pages` is asked to avoid: it is reached for
 * because a deck is large, and every slide the id list named was parsed in full
 * before the selection could discard it. All that is needed to *number* the
 * slides is which of them are hidden, and that is one attribute on the document
 * element.
 *
 * So the read is bounded to the head of the part rather than the whole of it. It
 * was not, and the comment here claimed an unselected slide "costs its opening
 * tag" while the code inflated every byte of it to find that tag — which meant
 * `--pages 3` paid for the whole deck, and a single oversized slide nobody asked
 * for could trip `maxEntryBytes` and abort the run. With `hiddenContent` set the
 * flag changes nothing and the ternary below never reads at all.
 */
function slideRefs(entries: Entries, presentation: XmlNode, hiddenContent: boolean): SlideRef[] {
  const rels = relsOf(entries, PRESENTATION_PART);
  const list = child(presentation, 'p', 'sldIdLst');
  const refs: SlideRef[] = [];

  for (const sldId of list ? children(list, 'p', 'sldId') : []) {
    const rel = rels.get(sldId.attrs['r:id'] ?? '');
    if (!rel || rel.external || !SLIDE_RELATIONSHIP.test(rel.type)) continue;

    const part = resolvePart(PRESENTATION_PART, rel.target);
    const reader = entries.get(part);
    if (!reader) continue;

    refs.push({
      part,
      hidden: hiddenContent ? false : isTrue(rootAttributes(reader(ROOT_HEAD_BYTES))['show']) === false,
    });
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

/**
 * A slide that contributed nothing. Spelled out rather than spread from the
 * running totals, which is what a `{ ...totals, blocks: [] }` here did: adding
 * that back into the totals counted every image and merged cell so far a second
 * time, and the warning a user reads to see what was lost reported double.
 */
function emptyOutput(): ShapeOutput {
  return { blocks: [], images: 0, captionedImages: 0, mergedCells: 0, skippedCharts: [], chartNotes: [] };
}

function addTotals(into: ShapeOutput, one: ShapeOutput): void {
  into.images += one.images;
  into.captionedImages += one.captionedImages;
  into.mergedCells += one.mergedCells;
  into.skippedCharts.push(...one.skippedCharts);
  into.chartNotes.push(...one.chartNotes);
}

/** Below this many slides there is too little evidence to call anything repeated. */
const MIN_SLIDES = 4;
/** A block has to appear on this share of the slides read to be deck furniture. */
const REPEAT_SHARE = 0.6;

/**
 * Drop a block repeated identically across most slides, keeping the first copy.
 *
 * The same contract `suppressRunningText` implements for PDF pages, and for the
 * same reason: a deck's footer, tagline or standing disclaimer is written once per
 * slide and read once by a reader. One copy carries it; the rest are duplication
 * the deck's own template inserted.
 *
 * The threshold counts *slides*, not appearances, and drops from every slide after
 * the first — the two things the PDF version got wrong. Measured on the real
 * 12-slide deck here, this is what removes the ten identical auto-generated image
 * captions that survive `meaningfulAlt`.
 */
function suppressRepeatedBlocks(sections: Section[]): number {
  if (sections.length < MIN_SLIDES) return 0;

  const slidesWith = new Map<string, Set<Section>>();
  for (const section of sections) {
    for (const block of section.text.split('\n\n')) {
      const key = block.trim();
      if (key === '') continue;
      const slides = slidesWith.get(key);
      if (slides) slides.add(section);
      else slidesWith.set(key, new Set([section]));
    }
  }

  const furniture = new Set<string>();
  for (const [key, slides] of slidesWith) {
    if (slides.size >= sections.length * REPEAT_SHARE) furniture.add(key);
  }
  if (furniture.size === 0) return 0;

  const seen = new Set<string>();
  let suppressed = 0;
  for (const section of sections) {
    const kept = section.text.split('\n\n').filter((block) => {
      const key = block.trim();
      if (!furniture.has(key) || !seen.has(key)) {
        seen.add(key);
        return true;
      }
      suppressed += 1;
      return false;
    });
    section.text = kept.join('\n\n');
  }
  return suppressed;
}

/**
 * A deck that read as no text at all, when there were slides to read it from.
 *
 * The failure this exists for is a namespace slimdoc does not know: every lookup
 * misses, no element matches, and extraction *succeeds* with an empty string. An
 * ISO-Strict deck did exactly that, and nothing in 391 tests noticed, because a
 * silent empty result looks the same as a legitimately blank deck. It is not the
 * same thing, and the difference is worth a sentence to the user.
 *
 * Genuinely image-only decks exist, so this is a warning and not an error — but
 * they are rare enough that saying so is the right trade. `read` counts the
 * slides actually opened, so skipping every slide via `--pages` stays quiet.
 */
function emptyTextWarning(read: number, text: string, images: number): string | undefined {
  if (read === 0 || text.trim() !== '') return undefined;
  const because = images > 0 ? ` — the ${images} shape${images === 1 ? '' : 's'} found carried no text` : '';
  return `read ${read} slide${read === 1 ? '' : 's'} but found no text at all${because}`;
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

  // Selection runs over *every* slide, hidden ones included, so a slide keeps
  // the number PowerPoint gives it. Numbering what survived the filter instead
  // meant `--pages 6` and `## Slide 6` named different slides depending on
  // `--hidden`, and a page reference read out of the output could not be used
  // to ask for that page again.
  const all = slideRefs(entries, presentation, opts.hiddenContent);
  const selection = selectPages(all.length, opts.pages, opts.limits.maxPages);

  const slide = slideSize(presentation);
  const totals = emptyOutput();
  const sections: Section[] = [];
  const inheritance = new Map<string, Inheritance>();
  let hidden = 0;

  for (const page of selection.pages) {
    const ref = all[page - 1];
    if (!ref) continue;
    if (ref.hidden) {
      hidden += 1;
      continue;
    }

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
    const root = partOf(entries, ref.part);
    if (!root) continue;
    const tree = child(child(root, 'p', 'cSld') ?? root, 'p', 'spTree');
    const output = tree ? serialiseSpTree(tree, ctx) : emptyOutput();
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

  const repeated = opts.dropRunningHeaders ? suppressRepeatedBlocks(sections) : 0;
  const text = sections.map((s) => s.text).join('\n\n');
  const empty = emptyTextWarning(sections.length, text, totals.images);

  return {
    text,
    format: 'pptx',
    options: opts,
    source,
    warnings: [
      ...warningsFor(totals, hidden, selection.dropped),
      ...(repeated > 0
        ? [`suppressed ${repeated} block${repeated === 1 ? '' : 's'} repeated across slides`]
        : []),
      ...(empty ? [empty] : []),
    ],
    sections,
  };
}
