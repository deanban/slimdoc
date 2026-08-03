/**
 * Dependency-free HTML -> Markdown-ish text.
 *
 * This is deliberately a tag-rewriter, not a parser: the input is usually a
 * pasted fragment from Outlook/Teams/Google Docs, malformed often enough that a
 * strict parser would be the wrong tool. Correctness target is "no markup and no
 * image payload survives, and the words keep their order".
 */

/** A line break emitted by a tag, kept distinct from insignificant source whitespace. */
const BR = '\u0001';
/** Wraps the index of a parked `<pre>` block. */
const PRE_OPEN = '\u0002';
const PRE_CLOSE = '\u0003';

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
  amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ',
  copy: '©', reg: '®', trade: '™', hellip: '…',
  mdash: '—', ndash: '–', lsquo: '‘', rsquo: '’',
  ldquo: '“', rdquo: '”', sbquo: '‚', bdquo: '„',
  laquo: '«', raquo: '»', bull: '•', middot: '·',
  deg: '°', plusmn: '±', times: '×', divide: '÷',
  frac12: '½', frac14: '¼', frac34: '¾', sup2: '²',
  sup3: '³', micro: 'µ', para: '¶', sect: '§',
  dagger: '†', Dagger: '‡', permil: '‰', prime: '′',
  Prime: '″', euro: '€', pound: '£', yen: '¥',
  cent: '¢', larr: '←', rarr: '→', harr: '↔',
  darr: '↓', uarr: '↑', ne: '≠', le: '≤', ge: '≥',
  minus: '−', shy: '­', ensp: ' ', emsp: ' ',
  thinsp: ' ', zwnj: '‌', zwj: '‍', iexcl: '¡',
  iquest: '¿', eacute: 'é', egrave: 'è', agrave: 'à',
  ccedil: 'ç', uuml: 'ü', ouml: 'ö', auml: 'ä',
  szlig: 'ß', ntilde: 'ñ', check: '✓', star: '☆',
};

const ENTITY_RE = /&(#[0-9]{1,7}|#[xX][0-9a-fA-F]{1,6}|[a-zA-Z][a-zA-Z0-9]{1,31});/g;

/** Decode named + numeric entities in a single pass, so `&amp;lt;` stays `&lt;`. */
export function decodeEntities(text: string): string {
  return text.replace(ENTITY_RE, (match: string, body: string) => {
    if (body.charCodeAt(0) === 0x23 /* # */) {
      const isHex = body[1] === 'x' || body[1] === 'X';
      const code = parseInt(isHex ? body.slice(2) : body.slice(1), isHex ? 16 : 10);
      if (!Number.isFinite(code) || code < 1 || code > 0x10ffff) return match;
      try {
        return String.fromCodePoint(code);
      } catch {
        return match;
      }
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

/** Map one start/end tag to the text that replaces it. */
function replaceTag(name: string, isClose: boolean): string {
  if (name === 'br') return BR;
  // `</li>` emits nothing: the next `<li>` supplies the break, so list items
  // stay on adjacent lines instead of being separated by a blank one.
  if (name === 'li') return isClose ? '' : `${BR}- `;
  if (name === 'tr') return BR;
  if (name === 'td' || name === 'th') return isClose ? ' | ' : '';
  const heading = /^h([1-6])$/.exec(name);
  if (heading) {
    return isClose ? BR + BR : `${BR}${BR}${'#'.repeat(Number(heading[1]))} `;
  }
  if (BLOCK_TAGS.has(name)) return BR + BR;
  return '';
}

export interface HtmlExtraction {
  text: string;
  droppedImages: number;
}

export function htmlToText(html: string): HtmlExtraction {
  let droppedImages = 0;
  let out = html;

  out = out.replace(/<!--[\s\S]*?-->/g, '');
  out = out.replace(/<!\[CDATA\[[\s\S]*?\]\]>/g, '');
  out = out.replace(/<![^>]*>/g, '');
  out = out.replace(DROP_WITH_CONTENT, '');
  out = out.replace(DROP_UNCLOSED, '');

  // <pre> is the one place where whitespace carries meaning; park it whole and
  // put it back as a fenced block once the whitespace squeezing is done.
  const preBlocks: string[] = [];
  out = out.replace(/<pre\b[^>]*>([\s\S]*?)<\/pre\s*>/gi, (_m: string, inner: string) => {
    const code = decodeEntities(stripTags(inner)).replace(/^\r?\n/, '').replace(/\s+$/, '');
    preBlocks.push(code);
    return `${BR}${BR}${PRE_OPEN}${preBlocks.length - 1}${PRE_CLOSE}${BR}${BR}`;
  });

  out = out.replace(/<(?:img|image|source)\b[^>]*>/gi, (tag: string) => {
    droppedImages += 1;
    const alt = meaningfulAlt(attr(tag, 'alt') ?? attr(tag, 'title'));
    return alt ? `[image: ${alt}]` : '';
  });

  out = out.replace(
    /<a\b([^>]*)>([\s\S]*?)<\/a\s*>/gi,
    (_m: string, rawAttrs: string, inner: string) => {
      const text = decodeEntities(stripTags(inner)).replace(/\s+/g, ' ').trim();
      const href = attr(`<a${rawAttrs}>`, 'href');
      if (!href || !/^https?:\/\//i.test(href)) return text;
      if (!text) return href;
      if (text === href || text === href.replace(/\/+$/, '')) return text;
      return `[${text}](${href})`;
    },
  );

  out = out.replace(/<(\/?)([a-zA-Z][a-zA-Z0-9-]*)\b[^>]*>/g, (_raw: string, slash: string, name: string) =>
    replaceTag(name.toLowerCase(), slash === '/'),
  );
  // Anything left that still looks like a tag (an unbalanced `<`) goes too.
  out = out.replace(/<[^>\n]{0,200}>/g, '');

  // Source whitespace is insignificant in HTML; only the BRs we inserted are.
  out = out.replace(/[ \t\r\n\f\v]+/g, ' ');
  out = decodeEntities(out);
  out = out.replace(/[\u200b\u200c\u200d\ufeff]/g, '');
  out = out.replace(/data:[a-zA-Z0-9.+/-]*;?[a-zA-Z0-9=;,._+/%-]*/g, '');

  out = out.replace(new RegExp(`[ ]*${BR}[ ]*`, 'g'), '\n');
  out = out
    .split('\n')
    .map((line) => line.replace(/\s+$/, '').replace(/^(#{1,6} |- )?[ \t]+/, '$1'))
    .join('\n');
  // A table row carries the cell separator we appended after its last cell.
  out = out.replace(/ \| *(?=\n|$)/g, '');
  out = out.replace(/^(?:- |#{1,6} )?[ \t]*$/gm, '');
  out = out.replace(/\n{3,}/g, '\n\n');

  out = out.replace(new RegExp(`${PRE_OPEN}(\\d+)${PRE_CLOSE}`, 'g'), (_m: string, index: string) => {
    const code = preBlocks[Number(index)] ?? '';
    return `\`\`\`\n${code}\n\`\`\``;
  });

  return { text: out.trim(), droppedImages };
}
