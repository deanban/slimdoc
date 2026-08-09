/**
 * Chart caches -> a table.
 *
 * A chart's numbers usually exist nowhere else in the package: the picture is
 * drawn from `<c:numCache>`, and the slide's own text rarely repeats them. That
 * makes them worth having and also makes them expensive — a full series can
 * dwarf the ten tokens of text on the slide it sits on — so this is opt-in.
 *
 * The scope is deliberately narrow. Category/value charts only: bar, column,
 * line, pie, area, doughnut and radar all share `<c:cat>` plus `<c:val>`.
 * Scatter and bubble use `<c:xVal>`/`<c:yVal>`/`<c:bubbleSize>`, and
 * multi-level categories nest, so those are skipped and reported rather than
 * misread into a table that means something else.
 */

import { child, children, descendants, textOf, type XmlNode } from './ooxml.js';
import { renderTable } from './utils/markdown-table.js';

/** Beyond this a series is a data dump rather than a slide. */
const MAX_SERIES = 12;
const MAX_POINTS = 60;

/** Emitted when the chart names no category axis; GFM has no headerless table. */
const CATEGORY_HEADER = 'Category';

export interface ChartResult {
  text: string;
  /** Set when the chart was recognised but its shape is out of scope. */
  skipped?: string;
}

/** The values of a `<c:cat>` or `<c:val>`, in point order. */
function cachedPoints(holder: XmlNode | undefined): string[] {
  if (!holder) return [];
  const points: string[] = [];
  for (const pt of descendants(holder, 'c', 'pt')) {
    const index = Number(pt.attrs['idx'] ?? points.length);
    const value = child(pt, 'c', 'v');
    if (value) points[index] = value.text.trim();
  }
  return Array.from(points, (value) => value ?? '');
}

function seriesName(series: XmlNode, fallback: number): string {
  const name = cachedPoints(child(series, 'c', 'tx'))[0];
  return name === undefined || name === '' ? `Series ${fallback}` : name;
}

function titleOf(chart: XmlNode): string {
  const title = child(chart, 'c', 'title');
  return title ? textOf(title).replace(/\s+/g, ' ').trim() : '';
}

/** The plots slimdoc understands, by the elements they carry rather than by name. */
function categorySeries(chart: XmlNode): { series: XmlNode[]; skipped?: string } {
  const all = descendants(chart, 'c', 'ser');
  if (all.length === 0) return { series: [] };

  const usable = all.filter((series) => child(series, 'c', 'cat') && child(series, 'c', 'val'));
  if (usable.length === 0) {
    return { series: [], skipped: 'it is a scatter, bubble or otherwise non-category chart' };
  }
  if (descendants(chart, 'c', 'multiLvlStrRef').length > 0) {
    return { series: [], skipped: 'its categories are multi-level' };
  }
  return { series: usable.slice(0, MAX_SERIES) };
}

function categoryHeader(chart: XmlNode): string {
  const axis = children(chart, 'c', 'catAx')[0] ?? descendants(chart, 'c', 'catAx')[0];
  const title = axis && child(axis, 'c', 'title');
  const text = title ? textOf(title).replace(/\s+/g, ' ').trim() : '';
  return text === '' ? CATEGORY_HEADER : text;
}

/**
 * A chart part rendered as a caption and a table, or a reason it was not.
 *
 * The cache can be stale, and the real data may live in a workbook that is only
 * linked — there is nothing to do about either but emit what is cached.
 */
export function chartTable(chartSpace: XmlNode): ChartResult {
  const chart = child(chartSpace, 'c', 'chart') ?? chartSpace;
  const { series, skipped } = categorySeries(chart);
  if (skipped !== undefined) return { text: '', skipped };
  if (series.length === 0) return { text: '' };

  const categories = cachedPoints(child(series[0] as XmlNode, 'c', 'cat')).slice(0, MAX_POINTS);
  const columns = series.map((s) => cachedPoints(child(s, 'c', 'val')).slice(0, MAX_POINTS));

  const header = [categoryHeader(chart), ...series.map(seriesName)];
  const rows = categories.map((category, row) => [category, ...columns.map((values) => values[row] ?? '')]);

  const table = renderTable([header, ...rows]);
  if (table === null) return { text: '' };

  const caption = titleOf(chart);
  return { text: caption === '' ? table : `${caption}\n\n${table}` };
}
