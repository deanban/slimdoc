/**
 * SmartArt data -> a nested list.
 *
 * Diagram text lives in `diagrams/dataN.xml`, outside the shape tree entirely,
 * so a walker that only reads `<p:sp>` finds an empty frame where a diagram is
 * drawn. That makes this text uniquely easy to lose — which is why it is on by
 * default, unlike chart data.
 */

import { child, children, descendants, textOf, type XmlNode } from './ooxml.js';

/** Deeper than this and the indentation costs more than the hierarchy conveys. */
const MAX_DEPTH = 6;
const INDENT = '  ';

/** The connection that means "is a child of". Absent `type` defaults to it. */
const PARENT_OF = 'parOf';

interface Point {
  id: string;
  text: string;
}

/**
 * `type="pres"` points are layout scaffolding — the boxes and arrows the
 * renderer draws — rather than content, and `type="doc"` is the invisible root.
 */
function contentPoints(model: XmlNode): Map<string, Point> {
  const points = new Map<string, Point>();
  for (const pt of descendants(model, 'dgm', 'pt')) {
    const id = pt.attrs['modelId'];
    const type = pt.attrs['type'];
    if (id === undefined || type === 'pres' || type === 'doc') continue;

    const body = child(pt, 'dgm', 't');
    points.set(id, { id, text: body ? textOf(body).replace(/\s+/g, ' ').trim() : '' });
  }
  return points;
}

interface Edge {
  parent: string;
  order: number;
}

function hierarchy(model: XmlNode): Map<string, Edge> {
  const edges = new Map<string, Edge>();
  const list = child(model, 'dgm', 'cxnLst');

  for (const cxn of list ? children(list, 'dgm', 'cxn') : []) {
    if ((cxn.attrs['type'] ?? PARENT_OF) !== PARENT_OF) continue;
    const source = cxn.attrs['srcId'];
    const destination = cxn.attrs['destId'];
    if (source === undefined || destination === undefined) continue;
    edges.set(destination, { parent: source, order: Number(cxn.attrs['srcOrd'] ?? 0) || 0 });
  }
  return edges;
}

function depthOf(id: string, edges: Map<string, Edge>, points: Map<string, Point>): number {
  let depth = 0;
  let current = edges.get(id)?.parent;
  // A malformed diagram can describe a cycle; the point count bounds the walk.
  for (let step = 0; current !== undefined && step <= points.size; step++) {
    if (points.has(current)) depth += 1;
    current = edges.get(current)?.parent;
  }
  return depth;
}

/**
 * The diagram's text as a bulleted list.
 *
 * Ordering follows `srcOrd` within a parent and falls back to document order
 * where the connections do not say — inventing a tree from an ambiguous graph
 * would assert a structure the file does not contain.
 */
export function diagramList(model: XmlNode): string {
  const points = contentPoints(model);
  const edges = hierarchy(model);

  const ordered = [...points.values()]
    .filter((point) => point.text !== '')
    .map((point, index) => ({ point, order: edges.get(point.id)?.order ?? index, index }))
    .sort((a, b) => a.order - b.order || a.index - b.index);

  return ordered
    .map(({ point }) => {
      const depth = Math.min(depthOf(point.id, edges, points), MAX_DEPTH);
      return `${INDENT.repeat(depth)}- ${point.text}`;
    })
    .join('\n');
}
