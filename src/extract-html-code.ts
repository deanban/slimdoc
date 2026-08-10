/**
 * The code half of the output contract: fencing, language identifiers, and the
 * indentation that must not be collapsed.
 *
 * Detection here leans the opposite way to table detection, deliberately. A
 * wrongly-fenced paragraph costs a few tokens and is visible; silently
 * collapsed indentation turns `def f(x):` / `    return x` into something that
 * is not Python any more, and the damage is invisible. So a container that
 * merely looks code-ish gets its whitespace protected.
 */

import { fencedBlock } from './utils/fence.js';
import type { ParkingLot } from './utils/parking.js';

const PRE = /<pre\b([^>]*)>([\s\S]*?)<\/pre\s*>/gi;
const CODEISH_CLASS = /(^|[-_ ])(code|highlight|snippet|sourcecode|codeblock)([-_ ]|$)/i;
const CONTAINER = /<(div|section|figure)\b([^>]*)>((?:(?!<\1\b)[\s\S])*?)<\/\1\s*>/gi;
const MULTILINE_CODE = /<code\b([^>]*)>([\s\S]*?)<\/code\s*>/gi;
const INLINE_CODE = /<code\b[^>]*>([\s\S]*?)<\/code\s*>/gi;

/** Hosts whose embeds are genuinely code the page does not otherwise contain. */
const CODE_EMBED =
  /<iframe\b[^>]*\bsrc\s*=\s*["']?(https?:\/\/(?:gist\.github\.com|codepen\.io|jsfiddle\.net|codesandbox\.io|stackblitz\.com|replit\.com)[^"'\s>]*)/gi;

// The delimiter class covers `class="language-js"` as well as a bare token,
// since the match runs against a raw attribute chunk including its quotes.
const LANGUAGE = /(?:^|[\s"'=])(?:language|lang|highlight)-([a-z0-9+#]{1,15})\b/i;
const DATA_LANG = /\bdata-lang(?:uage)?\s*=\s*["']?([a-z0-9+#]{1,15})/i;

/** The language identifier a source supplies, if any. One token, and it helps. */
function languageOf(...attrChunks: string[]): string | undefined {
  for (const chunk of attrChunks) {
    const named = LANGUAGE.exec(chunk) ?? DATA_LANG.exec(chunk);
    if (named?.[1]) return named[1].toLowerCase();
  }
  return undefined;
}

/**
 * A gist's code is fetched by script and genuinely is not in the HTML, so the
 * URL is the most any extractor can recover. Without this the page keeps a
 * dangling "Full source on GitHub:" followed by nothing.
 *
 * Must run before `DROP_WITH_CONTENT` deletes the whole `<iframe>`.
 */
export function markCodeEmbeds(html: string): string {
  return html.replace(CODE_EMBED, (_m: string, url: string) => `<p>[embedded: ${url}]</p><iframe`);
}

export interface CodeParking {
  html: string;
  /** Inner HTML -> plain text, supplied by the extractor that owns entities. */
  plainText: (inner: string) => string;
  lot: ParkingLot;
  /** The caller's line-break sentinel, emitted around every block-level marker. */
  blockBreak: string;
}

/**
 * Park every block whose whitespace must survive, as a finished fenced block.
 *
 * A block-level container is replaced whole, which also swallows the tag that
 * would have supplied its breaks, so `blockBreak` is emitted around the marker:
 * two adjacent blocks restored back to back would otherwise weld their fences
 * into one six-backtick line that closes and reopens nothing.
 */
export function parkCode(
  html: string,
  plainText: (inner: string) => string,
  lot: ParkingLot,
  blockBreak: string,
): string {
  const parkBlock = (text: string): string =>
    `${blockBreak}${blockBreak}${lot.park(text)}${blockBreak}${blockBreak}`;

  let out = html.replace(PRE, (_m: string, attrs: string, inner: string) => {
    const openingCode = /<code\b([^>]*)>/i.exec(inner);
    const lang = languageOf(attrs, openingCode?.[1] ?? '');
    return parkBlock(fencedBlock(plainText(inner), lang));
  });

  out = out.replace(CONTAINER, (whole: string, _tag: string, attrs: string, inner: string) => {
    const cls = /\bclass\s*=\s*["']([^"']*)["']/i.exec(attrs)?.[1] ?? '';
    // A container wrapping an already-parked <pre> is handled; re-fencing its
    // marker would nest a fence inside a fence.
    if (!CODEISH_CLASS.test(cls) || lot.contains(inner)) return whole;
    const text = plainText(inner);
    return text.trim() ? parkBlock(fencedBlock(text, languageOf(attrs, cls))) : whole;
  });

  return out.replace(MULTILINE_CODE, (whole: string, attrs: string, inner: string) => {
    if (!/\r?\n/.test(inner.trim()) || lot.contains(inner)) return whole;
    return lot.park(fencedBlock(plainText(inner), languageOf(attrs)));
  });
}

/**
 * Inline `<code>` keeps its backticks — cheap, and it separates identifiers
 * from prose for a model. Runs after the multi-line cases have been parked.
 */
export function markInlineCode(
  html: string,
  plainText: (inner: string) => string,
  lot: ParkingLot,
): string {
  return html.replace(INLINE_CODE, (whole: string, inner: string) => {
    const text = plainText(inner).replace(/\s+/g, ' ').trim();
    if (!text || text.includes('`')) return whole;
    // Parked rather than written back into the stream: `plainText` has already
    // decoded the entities, and everything left in the stream is decoded again
    // on the way out, which would turn `&amp;lt;` into `<` instead of `&lt;`.
    return lot.park(`\`${text}\``);
  });
}
