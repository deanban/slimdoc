/**
 * Chart caches -> the chart's writing, and on request its numbers.
 *
 * Two different things live in a chart part, and they belong on opposite sides
 * of the default contract. Its *writing* — the title, the axis titles, the
 * category names, the series names — is text the reader sees on the slide, and
 * on a slide that is a chart and a heading it is most of what the slide says.
 * Its *numbers* usually exist nowhere else in the package, since the picture is
 * drawn from `<c:numCache>` and the slide rarely repeats them, which makes them
 * worth having and also makes them expensive: a full series can dwarf the ten
 * tokens of text around it. So the writing is default and the numbers are
 * opt-in, rather than the whole part being gated behind the flag.
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
/** …and when it names no value axis, for the line listing what is plotted. */
const SERIES_HEADER = 'Series';

export interface ChartResult {
  text: string;
  /** Set when the chart was recognised but its shape is out of scope. */
  skipped?: string;
  /** What the caller has to tell the user about where these values came from. */
  notes: string[];
}

export const CHART_NOTES = {
  cached:
    'chart numbers come from the cache saved in the file, which is stale if ' +
    'the workbook changed after it was last drawn',
  points: `a chart carried more than the ${MAX_POINTS} points read from each series`,
  series: `a chart carried more than the ${MAX_SERIES} series read from it`,
  index: 'a chart point gave a position that is not one, and was dropped',
} as const;

const oneLine = (text: string): string => text.replace(/\s+/g, ' ').trim();

interface Points {
  values: string[];
  /** Points at a real position past the cap: the series is longer than this. */
  past: number;
  /** Points at no position at all — negative, fractional, or not a number. */
  bad: number;
}

/**
 * The values of a `<c:cat>` or `<c:val>`, in point order.
 *
 * `idx` is an attribute, which is to say it is whatever the file says, and it
 * used to be handed straight to the array. A 600-byte part claiming
 * `idx="20000000"` bought a twenty-million-element array — a second and a half
 * and half a gigabyte — and a larger one failed inside `Array.from` with a raw
 * `RangeError` rather than as a document slimdoc declined to read. Bounding the
 * index against the cap that was going to be applied anyway costs nothing and
 * makes the cost of a chart proportional to its size on disk.
 */
function cachedPoints(holder: XmlNode | undefined): Points {
  const points: Points = { values: [], past: 0, bad: 0 };
  if (!holder) return points;

  const values: string[] = [];
  for (const pt of descendants(holder, 'c', 'pt')) {
    const index = Number(pt.attrs['idx'] ?? values.length);
    if (!Number.isInteger(index) || index < 0) points.bad += 1;
    else if (index >= MAX_POINTS) points.past += 1;
    else {
      const value = child(pt, 'c', 'v');
      if (value) values[index] = value.text.trim();
    }
  }
  points.values = Array.from(values, (value) => value ?? '');
  return points;
}

/** `position` is 1-based: an unnamed first series is `Series 1`, as a reader counts. */
function seriesName(series: XmlNode, position: number): string {
  const name = cachedPoints(child(series, 'c', 'tx')).values[0];
  return name === undefined || name === '' ? `${SERIES_HEADER} ${position}` : name;
}

function titleOf(node: XmlNode | undefined): string {
  const title = node && child(node, 'c', 'title');
  return title ? oneLine(textOf(title)) : '';
}

function axisTitle(chart: XmlNode, axis: 'catAx' | 'valAx'): string {
  return titleOf(children(chart, 'c', axis)[0] ?? descendants(chart, 'c', axis)[0]);
}

/**
 * What the chart calls itself, above whatever follows.
 *
 * The value axis title is part of it because it is often the only statement of
 * what the numbers are — `Average Latency (seconds)` names the whole picture —
 * and it is dropped when it merely repeats the chart title.
 */
function headingOf(chart: XmlNode): string {
  const lines = [titleOf(chart), axisTitle(chart, 'valAx')].filter((line) => line !== '');
  return [...new Set(lines)].join('\n');
}

interface Usable {
  series: XmlNode[];
  skipped?: string;
  /** Series past the cap, which are not read at all. */
  dropped: number;
}

/** The plots slimdoc understands, by the elements they carry rather than by name. */
function categorySeries(chart: XmlNode): Usable {
  const all = descendants(chart, 'c', 'ser');
  if (all.length === 0) return { series: [], dropped: 0 };

  const usable = all.filter((series) => child(series, 'c', 'cat') && child(series, 'c', 'val'));
  if (usable.length === 0) {
    return { series: [], dropped: 0, skipped: 'it is a scatter, bubble or otherwise non-category chart' };
  }
  if (descendants(chart, 'c', 'multiLvlStrRef').length > 0) {
    return { series: [], dropped: 0, skipped: 'its categories are multi-level' };
  }
  return { series: usable.slice(0, MAX_SERIES), dropped: Math.max(0, usable.length - MAX_SERIES) };
}

function categoryHeader(chart: XmlNode): string {
  return axisTitle(chart, 'catAx') || CATEGORY_HEADER;
}

/**
 * The chart's writing, with no numbers: what it plots, and against what.
 *
 * The two lines are list items rather than plain ones because `unwrap` joins
 * consecutive prose lines, and joined they read as a single sentence in which
 * the last category runs into the first series name.
 */
function summarise(categories: string[], names: string[], header: string): string {
  const lines: string[] = [];
  const listed = categories.map(oneLine).filter((text) => text !== '');
  if (listed.length > 0) lines.push(`- ${header}: ${listed.join(', ')}`);
  if (names.length > 0) lines.push(`- ${SERIES_HEADER}: ${names.map(oneLine).join(', ')}`);
  return lines.join('\n');
}

/**
 * A chart part rendered as its writing, or as its writing and a table, or a
 * reason it was not rendered at all.
 *
 * The cache can be stale, and the real data may live in a workbook that is only
 * linked — there is nothing to do about either but emit what is cached and say
 * so, which is what `notes` carries back.
 */
export function chartText(chartSpace: XmlNode, opts: { values: boolean }): ChartResult {
  const chart = child(chartSpace, 'c', 'chart') ?? chartSpace;
  const { series, skipped, dropped } = categorySeries(chart);
  if (skipped !== undefined) return { text: '', skipped, notes: [] };
  if (series.length === 0) return { text: '', notes: [] };

  const categories = cachedPoints(child(series[0] as XmlNode, 'c', 'cat'));
  const columns = series.map((s) => cachedPoints(child(s, 'c', 'val')));
  const names = series.map((s, i) => seriesName(s, i + 1));

  const all = [categories, ...columns];
  const notes: string[] = [];
  if (dropped > 0) notes.push(CHART_NOTES.series);
  if (all.some((points) => points.past > 0)) notes.push(CHART_NOTES.points);
  if (all.some((points) => points.bad > 0)) notes.push(CHART_NOTES.index);

  const table = opts.values ? withValues(categories.values, columns, [categoryHeader(chart), ...names]) : '';
  if (table !== '') notes.push(CHART_NOTES.cached);

  const heading = headingOf(chart);
  const body = table === '' ? summarise(categories.values, names, categoryHeader(chart)) : table;
  if (body === '') return { text: heading, notes };
  return { text: heading === '' ? body : `${heading}\n\n${body}`, notes };
}

function withValues(categories: string[], columns: Points[], header: string[]): string {
  const rows = categories.map((category, row) => [
    category,
    ...columns.map((column) => column.values[row] ?? ''),
  ]);
  return renderTable([header, ...rows]) ?? '';
}
