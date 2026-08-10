/**
 * Character-level normalisation shared by the cleaner and the extractors.
 *
 * `clean.ts` owns the full normalisation pipeline, but two of its steps have to
 * be available before cleaning runs: a PDF's fenced preformatted blocks bypass
 * `clean.ts` entirely, so ligatures, soft hyphens and zero-width characters
 * would survive inside them. The PDF extractor sanitizes at extraction instead,
 * which is only safe if it does exactly what the cleaner would have done — so
 * both call the same function.
 */

const cp = (code: number): string => String.fromCodePoint(code);
const charClass = (codes: readonly number[]): string => codes.map(cp).join('');

/** Zero-width and directional marks: no width, still billed as tokens. */
const INVISIBLE = new RegExp(
  `[${charClass([
    0x00ad, 0x061c, 0x180e, 0x200b, 0x200c, 0x200d, 0x200e, 0x200f,
    0x2060, 0x2066, 0x2067, 0x2068, 0x2069, 0xfeff,
  ])}]`,
  'g',
);

/** C0 and C1 controls, keeping only \n and \t. */
const CONTROLS = /[\x00-\x08\x0b\x0c\x0e-\x1f\x7f-\x9f]/g;

export function stripInvisible(text: string): string {
  return text.replace(INVISIBLE, '').replace(CONTROLS, '');
}

/** NFKC plus the invisible strip: what `clean.ts` would do, available early. */
export function sanitizeText(text: string): string {
  return stripInvisible(text.normalize('NFKC'));
}
