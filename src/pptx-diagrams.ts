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

/**
 * The tree the connections describe: each point's children, in sibling order.
 *
 * A point whose parent is not a content point — absent, or the `doc` root, or
 * scaffolding — is a root of the walk.
 */
function treeOf(points: Map<string, Point>, edges: Map<string, Edge>): Map<string, string[]> {
  const position = new Map([...points.keys()].map((id, index) => [id, index]));
  const tree = new Map<string, string[]>();
  const ROOT = '';

  for (const id of points.keys()) {
    const parent = edges.get(id)?.parent;
    const under = parent !== undefined && points.has(parent) ? parent : ROOT;
    tree.set(under, [...(tree.get(under) ?? []), id]);
  }

  for (const [parent, kids] of tree) {
    tree.set(
      parent,
      [...kids].sort(
        (a, b) =>
          (edges.get(a)?.order ?? 0) - (edges.get(b)?.order ?? 0) ||
          (position.get(a) ?? 0) - (position.get(b) ?? 0),
      ),
    );
  }
  return tree;
}

/**
 * The diagram's text as a bulleted list.
 *
 * Walked as a tree, because `srcOrd` is an ordinal *within a parent*: every
 * first child carries 0, so sorting all the points by it globally interleaves
 * the branches and produces a list asserting a hierarchy the file never
 * described. Roots first, siblings by `srcOrd`, document order to break a tie —
 * and where the connections say nothing at all, document order is the whole
 * answer, since inventing a tree from an ambiguous graph would assert structure
 * the file does not contain either.
 *
 * A point with no text of its own contributes no line but still holds its
 * children, which stay at the depth it was drawn at rather than being indented
 * under a bullet that is not there.
 */
export function diagramList(model: XmlNode): string {
  const points = contentPoints(model);
  const tree = treeOf(points, hierarchy(model));

  const lines: string[] = [];
  const seen = new Set<string>();

  const walk = (id: string, depth: number): void => {
    // A malformed diagram can describe a cycle, and a point reached twice is
    // the only evidence of one this walk needs.
    if (seen.has(id)) return;
    seen.add(id);

    const text = points.get(id)?.text ?? '';
    if (text !== '') lines.push(`${INDENT.repeat(Math.min(depth, MAX_DEPTH))}- ${text}`);
    for (const kid of tree.get(id) ?? []) walk(kid, text === '' ? depth : depth + 1);
  };

  for (const root of tree.get('') ?? []) walk(root, 0);
  // Anything a cycle kept out of the walk still belongs in the output: the text
  // is real even where the hierarchy around it is not.
  for (const [id, point] of points) {
    if (!seen.has(id) && point.text !== '') lines.push(`- ${point.text}`);
  }
  return lines.join('\n');
}
