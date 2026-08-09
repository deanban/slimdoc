/**
 * Dependency-free HTML -> Markdown-ish text.
 *
 * This is deliberately a tag-rewriter, not a parser: the input is usually a
 * pasted fragment from Outlook/Teams/Google Docs, malformed often enough that a
 * strict parser would be the wrong tool. Correctness target is "no markup and no
 * image payload survives, and the words keep their order".
 *
 * Structure that a streaming rewriter cannot see — tables, code blocks — is
 * parked whole, rendered by the shared emitters, and restored at the end.
 */

import { markCodeEmbeds, markInlineCode, parkCode } from './extract-html-code.js';
import { parkTables } from './extract-html-table.js';
import { createParkingLot, type ParkingLot } from './utils/parking.js';

/** A line break emitted by a tag, kept distinct from insignificant source whitespace. */
const BR = '\u0001';
/** One level of list indentation, immune to the leading-whitespace trim. */
const INDENT = '\u0004';

const DROP_WITH_CONTENT =
  /<(script|style|head|noscript|template|svg|picture|canvas|video|audio|iframe|map|object)\b[^>]*>[\s\S]*?<\/\1\s*>/gi;

/** Same list, but for a stray unclosed opener at the end of a fragment. */
const DROP_UNCLOSED = /<(script|style|svg|picture|canvas|video|audio|iframe)\b[^>]*>[\s\S]*$/i;

const BLOCK_TAGS = new Set([
  'p', 'div', 'section', 'article', 'blockquote', 'table', 'tbody', 'thead',
  'tfoot', 'ul', 'ol', 'dl', 'dt', 'dd', 'form', 'header', 'footer', 'main',
  'nav', 'aside', 'figure', 'figcaption', 'address', 'fieldset', 'hr',
]);

const ENTITIES: Readonly<Record<string, string>> = {
  amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: '\u00a0',
  copy: '©', reg: '®', trade: '™', hellip: '…',
  mdash: '—', ndash: '–', lsquo: '‘', rsquo: '’',
  ldquo: '“', rdquo: '”', sbquo: '‚', bdquo: '„',
  laquo: '«', raquo: '»', bull: '•', middot: '·',
  lsaquo: '‹', rsaquo: '›', sdot: '⋅', asymp: '≈',
  deg: '°', plusmn: '±', times: '×', divide: '÷',
  frac12: '½', frac14: '¼', frac34: '¾', sup2: '²',
  sup3: '³', micro: 'µ', para: '¶', sect: '§',
  dagger: '†', Dagger: '‡', permil: '‰', prime: '′',
  Prime: '″', euro: '€', pound: '£', yen: '¥',
  cent: '¢', larr: '←', rarr: '→', harr: '↔',
  darr: '↓', uarr: '↑', ne: '≠', le: '≤', ge: '≥',
  minus: '−', shy: '­', ensp: '\u2002', emsp: '\u2003',
  thinsp: '\u2009', zwnj: '\u200c', zwj: '\u200d', iexcl: '¡',
  iquest: '¿', eacute: 'é', egrave: 'è', agrave: 'à',
  ccedil: 'ç', uuml: 'ü', ouml: 'ö', auml: 'ä',
  szlig: 'ß', ntilde: 'ñ', check: '✓', star: '☆',
};

const ENTITY_RE = /&(#[0-9]{1,7}|#[xX][0-9a-fA-F]{1,6}|[a-zA-Z][a-zA-Z0-9]{1,31});/g;

/** Decode named + numeric entities in a single pass, so `&amp;lt;` stays `&lt;`. */
function decodeEntities(text: string): string {
  return text.replace(ENTITY_RE, (match: string, body: string) => {
    if (body.startsWith('#')) {
      const code = body[1] === 'x' || body[1] === 'X'
        ? Number.parseInt(body.slice(2), 16)
        : Number.parseInt(body.slice(1), 10);
      if (Number.isFinite(code) && code > 0 && code <= 0x10ffff) {
        try {
          return String.fromCodePoint(code);
        } catch {
          return match;
        }
      }
      return match;
    }
    const named = ENTITIES[body];
    return named === undefined ? match : named;
  });
}

/** Read an attribute out of a raw start tag, quoted or bare. */
function attr(tag: string, name: string): string | null {
  const re = new RegExp(`\\b${name}\\s*=\\s*("([^"]*)"|'([^']*)'|([^\\s"'>]+))`, 'i');
  const m = re.exec(tag);
  if (!m) return null;
  return decodeEntities(m[2] ?? m[3] ?? m[4] ?? '');
}

const TRIVIAL_ALT =
  /^(image\s*\d*|images|avatar|photo|picture|logo|icon|emoji|graphic|spacer|banner|cid:.*)$/i;

/**
 * The SPEC's `stripMedia` rule: keep an alt only when it reads like a real
 * caption. A filename or the bare word "image" is noise an LLM cannot use.
 */
export function meaningfulAlt(alt: string | null | undefined): string | null {
  if (!alt) return null;
  const trimmed = alt.trim().replace(/\s+/g, ' ');
  if (trimmed.length < 3) return null;
  if (TRIVIAL_ALT.test(trimmed)) return null;
  if (/^[\w %.-]+\.(png|jpe?g|gif|webp|svg|bmp|tiff?|ico)$/i.test(trimmed)) return null;
  if (/^data:/i.test(trimmed)) return null;
  return trimmed;
}

function stripTags(fragment: string): string {
  return fragment.replace(/<[^>]*>/g, '');
}

/** Verbatim text of a code block: entities resolved, surrounding blank lines gone. */
function codeText(inner: string): string {
  return decodeEntities(stripTags(inner)).replace(/^\r?\n/, '').replace(/\s+$/, '');
}

/** Text of one table cell. Tags become spaces so `<p>a</p><p>b</p>` is not `ab`. */
function cellText(inner: string): string {
  return decodeEntities(inner.replace(/<[^>]*>/g, ' '));
}

function wrapEmphasis(inner: string, marker: string): string {
  const m = /^(\s*)([\s\S]*?)(\s*)$/.exec(inner);
  const core = m?.[2] ?? '';
  if (!core || !stripTags(core).trim()) return inner;
  return `${m?.[1] ?? ''}${marker}${core}${marker}${m?.[3] ?? ''}`;
}

/**
 * A stateful tag replacer: list depth and ordered-list counters need memory
 * that a pure per-tag mapping cannot carry. State is local to one call.
 */
function replaceStructure(html: string): string {
  const lists: Array<{ ordered: boolean; seen: number }> = [];

  return html.replace(
    /<(\/?)([a-zA-Z][a-zA-Z0-9-]*)\b[^>]*>/g,
    (_raw: string, slash: string, rawName: string) => {
      const name = rawName.toLowerCase();
      const isClose = slash === '/';

      if (name === 'ul' || name === 'ol') {
        if (isClose) lists.pop();
        else lists.push({ ordered: name === 'ol', seen: 0 });
        // A nested list emits nothing at all: each `<li>` supplies its own
        // break, and a blank line here would terminate the parent list and
        // orphan the sub-items from the bullet they belong to.
        return lists.length > 0 ? '' : BR + BR;
      }
      if (name === 'li') {
        if (isClose) return '';
        const list = lists.at(-1);
        const marker = list?.ordered ? `${(list.seen += 1)}. ` : '- ';
        return `${BR}${INDENT.repeat(Math.max(0, lists.length - 1))}${marker}`;
      }
      if (name === 'br') return BR;
      if (name === 'tr') return BR;
      const heading = /^h([1-6])$/.exec(name);
      if (heading) {
        return isClose ? BR + BR : `${BR}${BR}${'#'.repeat(Number(heading[1]))} `;
      }
      if (BLOCK_TAGS.has(name)) return BR + BR;
      return '';
    },
  );
}

function replaceMedia(html: string): { html: string; droppedImages: number } {
  let droppedImages = 0;
  const out = html.replace(/<(?:img|image|source)\b[^>]*>/gi, (tag: string) => {
    droppedImages += 1;
    const alt = meaningfulAlt(attr(tag, 'alt') ?? attr(tag, 'title'));
    return alt ? `[image: ${alt}]` : '';
  });
  return { html: out, droppedImages };
}

/**
 * Entities are decoded exactly once: either here, into a parked value, or by
 * `normaliseWhitespace` for everything still in the stream. So a link that is
 * emitted as Markdown is decoded and parked, while a link that degrades to its
 * own text is handed back raw for the single decode still to come — otherwise
 * `&amp;amp;` would arrive as `&` instead of `&amp;`. `attr` already decodes,
 * which is the other reason an emitted href has to be parked rather than
 * written back into the stream.
 */
function replaceLinks(html: string, lot: ParkingLot): string {
  return html.replace(
    /<a\b([^>]*)>([\s\S]*?)<\/a\s*>/gi,
    (_m: string, rawAttrs: string, inner: string) => {
      const raw = stripTags(inner).replace(/\s+/g, ' ').trim();
      const text = decodeEntities(raw);
      const href = attr(`<a${rawAttrs}>`, 'href');
      if (!href || !/^https?:\/\//i.test(href)) return raw;
      if (!text) return lot.park(href);
      if (text === href || text === href.replace(/\/+$/, '')) return raw;
      return lot.park(`[${text}](${href})`);
    },
  );
}

function normaliseWhitespace(html: string): string {
  // Source whitespace is insignificant in HTML; only the BRs we inserted are.
  let out = html.replace(/[ \t\r\n\f\v]+/g, ' ');
  out = decodeEntities(out);
  out = out.replace(/[\u200b\u200c\u200d\ufeff]/g, '');
  out = out.replace(/data:[a-zA-Z0-9.+/-]*;?[a-zA-Z0-9=;,._+/%-]*/g, '');

  out = out.replace(new RegExp(`[ ]*${BR}[ ]*`, 'g'), '\n');
  out = out
    .split('\n')
    .map((line) => line.replace(/\s+$/, '').replace(/^(#{1,6} |- )?[ \t]+/, '$1'))
    .join('\n');
  out = out.replace(new RegExp(INDENT, 'g'), '  ');
  out = out.replace(/^(?:- |#{1,6} )?[ \t]*$/gm, '');
  return out.replace(/\n{3,}/g, '\n\n');
}

export interface HtmlExtraction {
  text: string;
  droppedImages: number;
  /** Cells whose rowspan/colspan was approximated by repetition. */
  mergedCells: number;
}

export function htmlToText(html: string): HtmlExtraction {
  const lot = createParkingLot();

  let out = html.replace(/<!--[\s\S]*?-->/g, '');
  out = out.replace(/<!\[CDATA\[[\s\S]*?\]\]>/g, '');
  out = out.replace(/<![^>]*>/g, '');
  // The embed URL must be captured before the <iframe> itself is deleted.
  out = markCodeEmbeds(out);
  out = out.replace(DROP_WITH_CONTENT, '');
  out = out.replace(DROP_UNCLOSED, '');

  out = parkCode(out, codeText, lot, BR);
  const tables = parkTables(out, { cellText, lot, blockBreak: BR });
  out = markInlineCode(tables.html, codeText, lot);

  out = out.replace(/<(strong|b)\b[^>]*>([\s\S]*?)<\/\1\s*>/gi, (_m, _t, inner: string) =>
    wrapEmphasis(inner, '**'),
  );
  out = out.replace(/<(em|i)\b[^>]*>([\s\S]*?)<\/\1\s*>/gi, (_m, _t, inner: string) =>
    wrapEmphasis(inner, '*'),
  );

  const media = replaceMedia(out);
  out = replaceLinks(media.html, lot);
  out = replaceStructure(out);
  // Anything left that still looks like a tag (an unbalanced `<`) goes too.
  out = out.replace(/<[^>\n]{0,200}>/g, '');

  out = lot.restore(normaliseWhitespace(out));

  return { text: out.trim(), droppedImages: media.droppedImages, mergedCells: tables.merged };
}
