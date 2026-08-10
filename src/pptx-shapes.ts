/**
 * `<p:spTree>` -> ordered text blocks.
 *
 * The shape tree is a paint list, not a reading order: PowerPoint appends a
 * shape wherever the author drew it, and z-order is what the file preserves.
 * Reading order is therefore reconstructed — placeholders first, by their role,
 * then everything else top-to-bottom and left-to-right.
 */

import { child, children, descendants, isTrue, type XmlNode } from './ooxml.js';
import { meaningfulAlt } from './extract-html.js';
import { chartText } from './pptx-charts.js';
import { diagramList } from './pptx-diagrams.js';
import { renderTable } from './utils/markdown-table.js';

/** English Metric Units: a shape's coordinates are in these. */
interface Point {
  x: number;
  y: number;
}

interface Box extends Point {
  cx: number;
  cy: number;
}

/**
 * A group maps its children's coordinate space onto its own box, so a child's
 * `a:off` means nothing until it has been composed with every enclosing group.
 * Rotation and flips are deliberately not composed: they move a shape within
 * its own bounds, which cannot change a top-to-bottom reading order, and doing
 * it properly needs the group centre for no gain.
 */
interface Transform {
  apply(point: Point): Point;
}

const IDENTITY: Transform = { apply: (point) => point };

function numeric(node: XmlNode | undefined, name: string): number | undefined {
  const raw = node?.attrs[name];
  if (raw === undefined) return undefined;
  const value = Number(raw);
  return Number.isFinite(value) ? value : undefined;
}

function boxOf(xfrm: XmlNode | undefined): Box | undefined {
  if (!xfrm) return undefined;
  const off = child(xfrm, 'a', 'off');
  const x = numeric(off, 'x');
  const y = numeric(off, 'y');
  if (x === undefined || y === undefined) return undefined;

  const ext = child(xfrm, 'a', 'ext');
  return { x, y, cx: numeric(ext, 'cx') ?? 0, cy: numeric(ext, 'cy') ?? 0 };
}

function groupTransform(xfrm: XmlNode | undefined, outer: Transform): Transform {
  const box = boxOf(xfrm);
  if (!xfrm || !box) return outer;

  const childOff = child(xfrm, 'a', 'chOff');
  const childExt = child(xfrm, 'a', 'chExt');
  const chx = numeric(childOff, 'x') ?? 0;
  const chy = numeric(childOff, 'y') ?? 0;
  const chcx = numeric(childExt, 'cx') ?? 0;
  const chcy = numeric(childExt, 'cy') ?? 0;
  if (chcx === 0 || chcy === 0) return outer;

  const scaleX = box.cx / chcx;
  const scaleY = box.cy / chcy;
  return {
    apply: (point) =>
      outer.apply({ x: box.x + (point.x - chx) * scaleX, y: box.y + (point.y - chy) * scaleY }),
  };
}

// --------------------------------------------------------------------------
// text
// --------------------------------------------------------------------------

const INDENT = '  ';

function runText(paragraph: XmlNode): string {
  let text = '';
  for (const node of paragraph.children) {
    if (node.ns !== 'a') continue;
    // `a:fld` is an auto-number or date. It carries an `a:t` of its own, which
    // is why runs are read child by child rather than swept up by descendant.
    if (node.local === 'r') text += child(node, 'a', 't')?.text ?? '';
    else if (node.local === 'br') text += '\n';
  }
  return text;
}

/** The deepest list level PresentationML defines. */
const MAX_LEVEL = 8;

/** A `lvlNpPr` from an `a:lstStyle` or one of the master's `p:txStyles`. */
function levelProperties(style: XmlNode | undefined, depth: number): XmlNode | undefined {
  const level = Math.max(0, Math.min(depth, MAX_LEVEL)) + 1;
  return style && child(style, 'a', `lvl${level}pPr`);
}

/**
 * Whether this paragraph is a list item, asking the file the way the file is
 * written.
 *
 * PowerPoint does not write a bullet on the paragraph. A content placeholder
 * inherits its glyph from the layout placeholder's `a:lstStyle`, which inherits
 * from the master's `p:bodyStyle`; the paragraph's own `a:pPr` says nothing
 * unless the author changed something. Reading only the paragraph — as this did
 * — therefore finds no list at all in a deck that is nothing but lists.
 *
 * Inheriting *unconditionally* is the opposite error and a worse one. The
 * master keeps three separate list styles, and which applies is decided by what
 * the shape is: `titleStyle` for a title placeholder, `bodyStyle` for a body
 * one, `otherStyle` for a shape that is not a placeholder at all. In the default
 * PowerPoint template `bodyStyle` carries a `buChar` and `otherStyle` carries
 * nothing — and every paragraph of all three real decks measured here lives in a
 * plain text box. Inherit without asking which style applies and those decks
 * gain hundreds of bullets that are on no slide.
 *
 * The first level to say anything wins, `buNone` included: that is how an author
 * turns a single line off inside an otherwise bulleted placeholder.
 */
function isListItem(properties: XmlNode | undefined, styles: BulletStyles, depth: number): boolean {
  const chain = [properties, ...styles.map((style) => levelProperties(style, depth))];
  for (const level of chain) {
    if (!level) continue;
    if (child(level, 'a', 'buNone')) return false;
    if (child(level, 'a', 'buChar') || child(level, 'a', 'buAutoNum')) return true;
  }
  return false;
}

/** The list styles a shape's paragraphs resolve through, nearest first. */
type BulletStyles = ReadonlyArray<XmlNode | undefined>;

function paragraphText(paragraph: XmlNode, styles: BulletStyles): string {
  const properties = child(paragraph, 'a', 'pPr');
  const depth = Number(properties?.attrs['lvl'] ?? 0) || 0;
  const text = runText(paragraph);
  if (text.trim() === '') return '';

  const indent = INDENT.repeat(Math.max(0, Math.min(depth, MAX_LEVEL)));
  // A numbered list becomes bullets: the ordinal lives in the master's list
  // style rather than in the paragraph, so any number here would be invented.
  return `${indent}${isListItem(properties, styles, depth) ? '- ' : ''}${text}`;
}

function bodyText(shape: XmlNode, ctx: SlideContext): string {
  const body = child(shape, 'p', 'txBody');
  if (!body) return '';

  const styles = bulletStyles(shape, ctx);
  return children(body, 'a', 'p')
    .map((paragraph) => paragraphText(paragraph, styles))
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

// --------------------------------------------------------------------------
// tables
// --------------------------------------------------------------------------

interface TableResult {
  text: string;
  merged: number;
}

function cellText(cell: XmlNode): string {
  const body = child(cell, 'a', 'txBody');
  if (!body) return '';
  return children(body, 'a', 'p').map(runText).join('\n');
}

/**
 * Unlike HTML, PresentationML emits the continuation cells of a merge as real
 * `<a:tc>` elements carrying `hMerge` or `vMerge` and no text — so the grid is
 * already rectangular and only needs filling in. Markdown has neither rowspan
 * nor colspan, so a merged value repeats across what it spanned and the caller
 * warns that an association was approximated.
 */
function tableGrid(table: XmlNode): TableResult {
  const rows: string[][] = [];
  let merged = 0;

  for (const tr of children(table, 'a', 'tr')) {
    const row: string[] = [];
    const cells = children(tr, 'a', 'tc');
    for (let column = 0; column < cells.length; column++) {
      const cell = cells[column] as XmlNode;
      if (Number(cell.attrs['gridSpan'] ?? 1) > 1 || Number(cell.attrs['rowSpan'] ?? 1) > 1) merged++;

      const previousRow = rows[rows.length - 1];
      if (isTrue(cell.attrs['hMerge'])) row[column] = row[column - 1] ?? '';
      else if (isTrue(cell.attrs['vMerge'])) row[column] = previousRow?.[column] ?? '';
      else row[column] = cellText(cell);
    }
    rows.push(row);
  }

  const rendered = renderTable(rows);
  return { text: rendered ?? rows.map((row) => row.join(' ').trim()).join('\n'), merged };
}

// --------------------------------------------------------------------------
// the walk
// --------------------------------------------------------------------------

const TITLE_RANK = 0;

/** Placeholder roles, in the order a slide is read rather than painted. */
const PLACEHOLDER_RANK: Readonly<Record<string, number>> = {
  ctrTitle: TITLE_RANK,
  title: TITLE_RANK,
  subTitle: 1,
  body: 1,
};

const UNRANKED = 2;

interface Candidate {
  rank: number;
  position: Point | undefined;
  order: number;
  node: XmlNode;
}

/** Which of the master's three list styles a shape's text resolves through. */
export type StyleKind = 'title' | 'body' | 'other';

/** What a shape inherits from outside the slide: read once per slide. */
export interface Inheritance {
  /** Placeholder `idx` -> type, from the slide layout. */
  types: Map<string, string>;
  /** The layout placeholder's own `a:lstStyle`, found by `idx` or by type. */
  layoutByIdx: Map<string, XmlNode>;
  layoutByType: Map<string, XmlNode>;
  /** The master's `p:txStyles`, which are `a:lstStyle` in all but name. */
  masterStyles: Map<StyleKind, XmlNode>;
}

export interface SlideContext {
  slide: { cx: number; cy: number };
  inherited: Inheritance;
  hiddenContent: boolean;
  chartData: boolean;
  diagramText: boolean;
  /** A relationship id on this slide, resolved to its parsed part. */
  part(relationshipId: string): XmlNode | undefined;
}

export interface ShapeOutput {
  blocks: string[];
  images: number;
  captionedImages: number;
  mergedCells: number;
  /** The title placeholder's text, when the slide has one. */
  title?: string;
  /** Charts recognised but out of scope, with the reason for each. */
  skippedCharts: string[];
  /** What a chart's own values need said about them: staleness, caps, bad indices. */
  chartNotes: string[];
}

const NON_VISUAL = ['nvSpPr', 'nvPicPr', 'nvGraphicFramePr'];

/** The `p:ph` that makes a shape a placeholder, if it is one. */
export function placeholderOf(shape: XmlNode): XmlNode | undefined {
  const nonVisual = NON_VISUAL.map((name) => child(shape, 'p', name)).find(Boolean);
  const properties = nonVisual && child(nonVisual, 'p', 'nvPr');
  return properties && child(properties, 'p', 'ph');
}

/** A shape's own overrides for its list levels, which outrank the layout's. */
export function listStyleOf(shape: XmlNode): XmlNode | undefined {
  const body = child(shape, 'p', 'txBody');
  return body && child(body, 'a', 'lstStyle');
}

/**
 * A placeholder may state only its index and inherit the type from the layout;
 * ECMA-376 makes `body` the default when neither says otherwise.
 */
function placeholderType(ph: XmlNode, types: Map<string, string>): string {
  const idx = ph.attrs['idx'];
  return ph.attrs['type'] ?? (idx === undefined ? 'body' : types.get(idx) ?? 'body');
}

function placeholderRank(shape: XmlNode, ctx: SlideContext): number {
  const ph = placeholderOf(shape);
  if (!ph) return UNRANKED;
  return PLACEHOLDER_RANK[placeholderType(ph, ctx.inherited.types)] ?? UNRANKED;
}

/** Placeholder roles the master styles as body text; `sldNum` and `ftr` are not among them. */
const BODY_PLACEHOLDERS = new Set(['body', 'subTitle', 'obj', 'tbl', 'chart', 'clipArt', 'dgm', 'media', 'pic']);

/**
 * The list styles a shape's paragraphs resolve through, nearest first: its own
 * overrides, then the layout placeholder it fills, then the master style for
 * what kind of shape it is.
 *
 * A shape that is not a placeholder resolves through `otherStyle` and nothing
 * else — it fills no layout slot, so there is no layout entry to find. Which is
 * the case that matters: it is most of every deck exported by a tool.
 */
function bulletStyles(shape: XmlNode, ctx: SlideContext): BulletStyles {
  const { types, layoutByIdx, layoutByType, masterStyles } = ctx.inherited;
  const own = listStyleOf(shape);
  const ph = placeholderOf(shape);
  if (!ph) return [own, masterStyles.get('other')];

  const type = placeholderType(ph, types);
  const idx = ph.attrs['idx'];
  const layout = (idx === undefined ? undefined : layoutByIdx.get(idx)) ?? layoutByType.get(type);

  const kind: StyleKind =
    type === 'title' || type === 'ctrTitle' ? 'title' : BODY_PLACEHOLDERS.has(type) ? 'body' : 'other';
  return [own, layout, masterStyles.get(kind)];
}

/**
 * A shape keeps its transform in `spPr`, a graphic frame in a `p:xfrm` of its
 * own. A placeholder often has neither and inherits its geometry from the
 * layout, which is why an absent box means "unknown", never "at the origin".
 */
function shapeBox(shape: XmlNode): Box | undefined {
  const spPr = child(shape, 'p', 'spPr');
  return boxOf(spPr ? child(spPr, 'a', 'xfrm') : child(shape, 'p', 'xfrm'));
}

/** A child's extent lives in the group's space too, so both corners are mapped. */
function place(box: Box | undefined, transform: Transform): Box | undefined {
  if (!box) return undefined;
  const topLeft = transform.apply(box);
  const bottomRight = transform.apply({ x: box.x + box.cx, y: box.y + box.cy });
  return { ...topLeft, cx: bottomRight.x - topLeft.x, cy: bottomRight.y - topLeft.y };
}

/**
 * A shape drawn entirely beyond the slide edges is not visible content.
 *
 * Every comparison is strict, which matters for one case: `<a:ext>` is optional
 * and its absence means the extent is unknown, not that it is zero. Read as
 * zero, a shape flush against the left or top edge has its far corner at
 * exactly 0 — and with `<=` that was "entirely off the slide", so a banner
 * heading at the origin was dropped as hidden content. A shape that stops
 * exactly at the edge has nothing visible either way; keeping it costs a line
 * and losing it costs the line.
 */
function offCanvas(box: Box, slide: { cx: number; cy: number }): boolean {
  return box.x + box.cx < 0 || box.y + box.cy < 0 || box.x > slide.cx || box.y > slide.cy;
}

const SHAPE_KINDS = new Set(['sp', 'pic', 'graphicFrame']);

function collect(tree: XmlNode, transform: Transform, ctx: SlideContext, out: Candidate[]): void {
  for (const node of tree.children) {
    if (node.ns !== 'p') continue;
    if (node.local === 'grpSp') {
      const groupProperties = child(node, 'p', 'grpSpPr');
      const xfrm = groupProperties && child(groupProperties, 'a', 'xfrm');
      collect(node, groupTransform(xfrm, transform), ctx, out);
      continue;
    }
    if (!SHAPE_KINDS.has(node.local)) continue;

    const placed = place(shapeBox(node), transform);
    if (placed && !ctx.hiddenContent && offCanvas(placed, ctx.slide)) continue;

    out.push({ rank: placeholderRank(node, ctx), position: placed, order: out.length, node });
  }
}

/** Placeholders by role first, then the rest top-to-bottom and left-to-right. */
function compare(a: Candidate, b: Candidate): number {
  if (a.rank !== b.rank) return a.rank - b.rank;
  if (a.position === undefined || b.position === undefined) return a.order - b.order;
  if (a.position.y !== b.position.y) return a.position.y - b.position.y;
  if (a.position.x !== b.position.x) return a.position.x - b.position.x;
  return a.order - b.order;
}

function tableOf(frame: XmlNode): XmlNode | undefined {
  return descendants(frame, 'a', 'tbl')[0];
}

/**
 * A graphic frame holds a table, a chart or a diagram. Only the table lives
 * inside the frame; the other two are relationships to parts elsewhere in the
 * package, which is why a walker that reads only the shape tree finds a diagram
 * slide empty.
 */
function serialiseFrame(frame: XmlNode, ctx: SlideContext, out: ShapeOutput): void {
  const table = tableOf(frame);
  if (table) {
    const { text, merged } = tableGrid(table);
    out.mergedCells += merged;
    if (text.trim() !== '') out.blocks.push(text);
    return;
  }

  // Read whatever the flag: `--chart-data` decides whether the *numbers* are
  // worth their tokens, not whether the chart's title and labels are visible
  // text. Gating the part itself left a slide that is a heading and a chart
  // extracting as a heading.
  const chart = descendants(frame, 'c', 'chart')[0];
  const chartPart = chart && ctx.part(chart.attrs['r:id'] ?? '');
  if (chartPart) {
    const { text, skipped, notes } = chartText(chartPart, { values: ctx.chartData });
    if (skipped !== undefined) out.skippedCharts.push(skipped);
    out.chartNotes.push(...notes);
    if (text !== '') out.blocks.push(text);
    return;
  }

  const diagram = ctx.diagramText ? descendants(frame, 'dgm', 'relIds')[0] : undefined;
  const model = diagram && ctx.part(diagram.attrs['r:dm'] ?? '');
  if (model) {
    const list = diagramList(model);
    if (list !== '') out.blocks.push(list);
  }
}

function altOf(shape: XmlNode): string | null {
  const name = descendants(shape, 'p', 'cNvPr')[0];
  return meaningfulAlt(name?.attrs['descr'] ?? name?.attrs['title']);
}

export function serialiseSpTree(tree: XmlNode, ctx: SlideContext): ShapeOutput {
  const candidates: Candidate[] = [];
  collect(tree, IDENTITY, ctx, candidates);
  candidates.sort(compare);

  const out: ShapeOutput = {
    blocks: [], images: 0, captionedImages: 0, mergedCells: 0, skippedCharts: [], chartNotes: [],
  };

  for (const { node, rank } of candidates) {
    if (rank === TITLE_RANK && node.local === 'sp' && out.title === undefined) {
      // The label a section carries has to come from the title placeholder
      // itself: taking the first block instead would caption a slide that opens
      // with a photograph as `[image: …]`.
      const heading = bodyText(node, ctx).split('\n')[0]?.trim();
      if (heading) out.title = heading;
    }
    if (node.local === 'pic') {
      out.images += 1;
      const alt = altOf(node);
      if (alt) {
        out.captionedImages += 1;
        out.blocks.push(`[image: ${alt}]`);
      }
      continue;
    }
    if (node.local === 'graphicFrame') {
      serialiseFrame(node, ctx, out);
      continue;
    }
    const text = bodyText(node, ctx);
    if (text !== '') out.blocks.push(text);
  }

  return out;
}
