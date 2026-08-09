/**
 * `--pages 3-7,12` — parsed once, applied to PDF pages and PPTX slides alike.
 *
 * Ranges are 1-based and inclusive, because that is how a document numbers
 * itself and how the user reads it off the page.
 */

const SINGLE = /^(\d+)$/;
const SPAN = /^(\d+)\s*-\s*(\d+)$/;

export type PageRange = [number, number];

function parseOne(part: string): PageRange {
  const single = SINGLE.exec(part);
  if (single) {
    const page = Number(single[1]);
    if (page >= 1) return [page, page];
  }
  const span = SPAN.exec(part);
  if (span) {
    const from = Number(span[1]);
    const to = Number(span[2]);
    if (from >= 1 && to >= from) return [from, to];
  }
  throw new RangeError(`"${part}" is not a page or page range like 3 or 3-7`);
}

export function parseRanges(spec: string): PageRange[] {
  return spec.split(',').map((part) => parseOne(part.trim()));
}

export interface Selection {
  /** 1-based page numbers, ascending, deduplicated. */
  pages: number[];
  /** Pages the cap removed. Non-zero means the caller owes the user a warning. */
  dropped: number;
}

/**
 * Which pages to read. An empty `ranges` means all of them.
 *
 * `maxPages` counts *selected* pages rather than document length, so `--pages
 * 1-3` of a 2,000-page PDF reads three pages instead of refusing the file.
 */
export function selectPages(total: number, ranges: PageRange[], maxPages: number): Selection {
  const wanted = new Set<number>();
  const spans: PageRange[] = ranges.length > 0 ? ranges : [[1, total]];

  for (const [from, to] of spans) {
    for (let page = Math.max(1, from); page <= Math.min(total, to); page++) {
      wanted.add(page);
    }
  }

  const selected = [...wanted].sort((a, b) => a - b);
  return { pages: selected.slice(0, maxPages), dropped: Math.max(0, selected.length - maxPages) };
}
