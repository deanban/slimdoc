/**
 * Quarter-turn rotation of a PDF text matrix, and the mapping back upright.
 *
 * A sideways-scanned form writes every glyph run with a rotated matrix. Read
 * as upright coordinates, a visual column groups into one "line" and its
 * numbers butt-join — so the turn has to be composed into the coordinates
 * before any layout inference runs.
 */

export type QuarterTurn = 0 | 90 | 180 | 270;

export interface Placement {
  x: number;
  y: number;
  width: number;
  height: number;
}

/** How far a matrix may lean off an axis, as a share of its scale. */
const AXIS_TOLERANCE = 0.05;
/** The share of a page's runs that must agree before rotation is composed. */
const DOMINANT_SHARE = 0.9;

/** The quarter turn a text matrix applies, or undefined when off-axis. */
export function quarterTurn(transform: number[]): QuarterTurn | undefined {
  const a = transform[0] ?? 0;
  const b = transform[1] ?? 0;
  const scale = Math.hypot(a, b);
  if (scale === 0) return undefined;
  if (Math.abs(b) <= scale * AXIS_TOLERANCE) return a > 0 ? 0 : 180;
  if (Math.abs(a) <= scale * AXIS_TOLERANCE) return b > 0 ? 90 : 270;
  return undefined;
}

/** The non-zero turn most of a page shares, or undefined when upright or mixed. */
export function dominantTurn(turns: (QuarterTurn | undefined)[]): QuarterTurn | undefined {
  const tally = new Map<QuarterTurn, number>();
  for (const turn of turns) {
    if (turn !== undefined) tally.set(turn, (tally.get(turn) ?? 0) + 1);
  }
  for (const [turn, count] of tally) {
    if (turn !== 0 && count >= turns.length * DOMINANT_SHARE) return turn;
  }
  return undefined;
}

/**
 * A rotated run's placement in reading coordinates.
 *
 * `width` is the advance along the run's own baseline and `height` the glyph
 * height, so both carry over; only the position turns. Each mapping sends the
 * run's start to the left end of its upright line and keeps y growing up the
 * displayed page, which is what the baseline sort expects.
 */
export function uprightPlacement(
  placed: Placement,
  turn: QuarterTurn,
  pageWidth: number,
  pageHeight: number,
): Placement {
  const { x, y, width, height } = placed;
  if (turn === 90) return { x: y, y: pageWidth - x, width, height };
  if (turn === 180) return { x: pageWidth - x - width, y: pageHeight - y, width, height };
  if (turn === 270) return { x: pageHeight - y, y: x, width, height };
  return placed;
}
