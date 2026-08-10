/**
 * A parking lot for verbatim text.
 *
 * Extractors squeeze whitespace, and some content must not be squeezed: a code
 * block whose indentation is load-bearing, or a finished Markdown table whose
 * rows must not be reflowed. Such content is parked behind a sentinel before
 * the squeezing runs and restored afterwards.
 *
 * The sentinels are C0 control characters, which `clean.ts` strips anyway, so
 * one that ever escaped restoration cannot reach the output.
 */

const OPEN = '\u0002';
const CLOSE = '\u0003';

/**
 * How many times `restore` re-scans for markers uncovered by the previous pass.
 * Real nesting is only a few levels deep; the bound exists so that a sentinel
 * that arrived in the source text — rather than from `park` — cannot spin.
 */
const MAX_RESTORE_DEPTH = 50;

export interface ParkingLot {
  /** Store `text` and return the marker standing in for it. */
  park(text: string): string;
  /** Put every parked value back, including values parked inside values. */
  restore(text: string): string;
  /** Whether `text` holds a marker — a container that is already handled. */
  contains(text: string): boolean;
}

export function createParkingLot(): ParkingLot {
  const stored: string[] = [];
  const marker = new RegExp(`${OPEN}(\\d+)${CLOSE}`, 'g');

  return {
    park(text: string): string {
      stored.push(text);
      return `${OPEN}${stored.length - 1}${CLOSE}`;
    },
    restore(text: string): string {
      // One pass is not enough: a parked value can itself hold a marker — a
      // <pre> parked before the <td> that contains it, or a table nested in a
      // table — and a single replace would leave that inner marker in the
      // output, where clean.ts strips the sentinels and the content with them.
      // A value can only reference markers parked before it, so the nesting is
      // finite; the loop stops as soon as a pass changes nothing.
      let out = text;
      for (let depth = 0; depth < MAX_RESTORE_DEPTH; depth++) {
        const next = out.replace(marker, (_m: string, index: string) => stored[Number(index)] ?? '');
        if (next === out) return next;
        out = next;
      }
      return out;
    },
    contains(text: string): boolean {
      return text.includes(OPEN);
    },
  };
}
