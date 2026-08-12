/**
 * Running headers and footers: text repeated at the same place on most pages.
 */

import type { Line, PageLines } from './pdf-layout.js';

/** Furniture lives in the top or bottom band of the page. */
export const MARGIN_SHARE = 0.12;
/** Below this many pages there is too little evidence to call anything repeated. */
const MIN_PAGES = 4;
/** A line has to appear in this share of the pages that have any text at all. */
const REPEAT_SHARE = 0.6;
/** Two baselines this close, in points, are the same position on the page. */
const POSITION_TOLERANCE = 3;

/** `page 4`, `4 of 12`, `4/12` — a number that announces itself as a counter. */
const PAGE_COUNTER = /\bpage\s+\d+(?:\s*(?:of|\/)\s*\d+)?|\b\d+\s*(?:of|\/)\s*\d+\b/gi;
/** …and the form that announces nothing, but is the whole line: `4`, `- 4 -`. */
const COUNTER_ALONE = /^[[(]?[-–—]?\s*\d+\s*[-–—]?[)\]]?$/;

/**
 * A page counter reads differently on every page, so a run of digits inside one
 * is normalised — but only inside one.
 *
 * Which is why the counter has to be recognised by its *form* rather than by
 * containing a number. Matching any `\d+` collapsed `Annual Report 2023` and
 * `Annual Report 2026` into one key, and `Section 3` and `Section 4` into
 * another, and then deleted every copy but the first: a running head is often
 * the only line on the page that says which year or which section the reader is
 * in, so what got dropped was the meaning and what survived was the wrong one.
 * Furniture is what repeats; a number that changes the sense of the line is not
 * furniture.
 */
function furnitureKey(line: Line): string {
  // Padding is not part of the text: the character grid is derived from each
  // page's own metrics, so the same header is spaced differently on a page
  // whose body happens to use a narrower font.
  const text = line.text.replace(/\s+/g, ' ').trim();
  const normalised = COUNTER_ALONE.test(text) ? '#' : text.replace(PAGE_COUNTER, '#');
  return `${Math.round(line.y / POSITION_TOLERANCE)}|${normalised}`;
}

/**
 * Drop text repeated at the same place on most pages, keeping the first copy.
 *
 * One copy carries the semantic context — which document this is, which section
 * — at negligible cost, and dropping every copy loses that outright. Matching is
 * on position *and* near-exact text: the fixture repeats its footer sentence
 * twice in the body of the last page, and text alone would delete those too.
 */
export function suppressRunningText(pages: PageLines[]): number {
  const withText = pages.filter((page) => page.lines.length > 0);
  if (withText.length < MIN_PAGES) return 0;

  // A `Set` per key, not a list: what makes a line furniture is appearing on
  // most *pages*, and a list counts appearances instead. Three identical margin
  // lines on one page of a four-page document cleared `REPEAT_SHARE` on their
  // own — and because that page was then in the list three times, `slice(1)`
  // still contained it and the filter took every copy, including the first one
  // this function exists to keep. Insertion order follows `withText`, so the
  // first element is still the earliest page.
  const seen = new Map<string, Set<PageLines>>();
  for (const page of withText) {
    const margin = page.height * MARGIN_SHARE;
    for (const line of page.lines) {
      if (line.y > margin && line.y < page.height - margin) continue;
      const key = furnitureKey(line);
      const pages = seen.get(key);
      if (pages) pages.add(page);
      else seen.set(key, new Set([page]));
    }
  }

  let suppressed = 0;
  for (const [key, appearances] of seen) {
    if (appearances.size < withText.length * REPEAT_SHARE) continue;
    for (const page of [...appearances].slice(1)) {
      const before = page.lines.length;
      page.lines = page.lines.filter((line) => furnitureKey(line) !== key);
      suppressed += before - page.lines.length;
    }
  }
  return suppressed;
}
