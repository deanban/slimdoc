import { DROP_MARK, collapseDropMarks } from './clean-protect.js';

/**
 * Media stripping. A pasted Teams/Slack/Google-Docs document is mostly base64 avatars —
 * on the reference transcript 98.9% of the payload — so every removal here is worth far
 * more than the rest of the pipeline combined.
 *
 * Every removal writes a DROP_MARK rather than an empty string. A later line pass turns
 * a line that held nothing but media into no line at all, and an inline hole into a
 * single space, so nothing is left double-spaced or blank.
 */

const HTML_FIGURE = /<figure\b[^>]*>([\s\S]*?)<\/figure\s*>/gi;
const HTML_FIGCAPTION = /<figcaption\b[^>]*>([\s\S]*?)<\/figcaption\s*>/i;
const HTML_PICTURE = /<picture\b[^>]*>[\s\S]*?<\/picture\s*>/gi;
const HTML_SVG = /<svg\b[^>]*?\/>|<svg\b[^>]*>[\s\S]*?<\/svg\s*>/gi;
const HTML_IMG = /<(?:img|image)\b[^>]*?>/gi;
const HTML_TAG = /<[^>]*>/g;

const ALT_ATTR = /\balt\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/i;

// Alt text and link labels are capped: a caption is never 400 characters, and an
// unbounded run of `![` with no closing bracket would otherwise be scanned quadratically.
const MD_IMAGE_INLINE = /!\[([^\]\n]{0,400})\]\([^)\n]*\)/g;
const MD_IMAGE_REF = /!\[([^\]\n]{0,400})\]\[[^\]\n]*\]/g;
const MD_IMAGE_SHORT = /!\[([^\]\n]{0,400})\]/g;

/** A markdown link whose target is a data: URI keeps its text and loses the payload. */
const MD_LINK_DATA = /\[([^\]\n]{0,400})\]\([ \t]*data:[^)\n]*\)/gi;
/** A markdown link whose target is a raw base64 blob keeps its text. */
const MD_LINK_BASE64 = /\[([^\]\n]{0,400})\]\([A-Za-z0-9+/=]{200,}\)/g;

/**
 * Any remaining data: URI, in or out of markup. Bounded by whitespace and the closing
 * delimiters of the syntaxes it can sit in, so it can never run past its own payload.
 * The lookbehind stops it firing inside words such as `metadata:`.
 */
const BARE_DATA_URI = /(?<![A-Za-z0-9])data:[^\s"'<>)\]]*/gi;

/** A pasted avatar usually degrades into a naked base64 run on a line of its own. */
const BASE64_LINE = /^[ \t]*[A-Za-z0-9+/=]{200,}[ \t]*$/;

const IMAGE_EXT = 'png|jpe?g|gif|svg|webp|bmp|ico|tiff?|avif|heic|heif';
/** `[ref]: data:…` or `[ref]: photo.png "title"` — an image reference definition. */
const IMAGE_REF_DEF = new RegExp(
  `^[ \\t]{0,3}\\[[^\\]]+\\]:[ \\t]*(?:data:\\S*|\\S+\\.(?:${IMAGE_EXT}))(?:[ \\t]+["'(].*)?[ \\t]*$`,
  'i',
);
const FILENAME_ALT = new RegExp(`^\\S+\\.(?:${IMAGE_EXT})$`, 'i');

const GENERIC_ALT = new Set([
  'image', 'images', 'avatar', 'photo', 'picture', 'logo', 'icon', 'emoji', 'img',
  'thumbnail', 'banner', 'graphic', 'placeholder',
]);

/**
 * A figure caption is real information; an avatar's alt text is not. Keep alt text only
 * when it reads like a caption someone wrote.
 */
function isMeaningfulAlt(alt: string): boolean {
  const t = alt.trim();
  if (t.length < 3) return false;
  const lower = t.toLowerCase();
  if (GENERIC_ALT.has(lower)) return false;
  if (lower.startsWith('cid:') || lower.startsWith('data:')) return false;
  if (FILENAME_ALT.test(t)) return false;
  if (/^[A-Za-z0-9+/=]{20,}$/.test(t)) return false;
  return true;
}

function imageReplacement(alt: string): string {
  return isMeaningfulAlt(alt) ? `[image: ${alt.trim()}]` : DROP_MARK;
}

function altOf(tag: string): string {
  const m = ALT_ATTR.exec(tag);
  if (!m) return '';
  return m[1] ?? m[2] ?? m[3] ?? '';
}

function figureReplacement(inner: string): string {
  const caption = HTML_FIGCAPTION.exec(inner);
  const text = (caption?.[1] ?? '').replace(HTML_TAG, '').trim();
  if (text) return text;
  const img = /<(?:img|image)\b[^>]*?>/i.exec(inner);
  return img ? imageReplacement(altOf(img[0])) : DROP_MARK;
}

export function stripMedia(text: string): string {
  // Whole-line media goes first: an image reference definition still has to be
  // recognisable as one when we test it, so its data: URI must still be attached.
  let s = dropMediaLines(text);
  // Figures first, so a caption survives before the <img> inside it is removed.
  s = s.replace(HTML_FIGURE, (_m: string, inner: string) => figureReplacement(inner));
  s = s.replace(HTML_PICTURE, () => DROP_MARK);
  s = s.replace(HTML_SVG, () => DROP_MARK);
  s = s.replace(HTML_IMG, (m: string) => imageReplacement(altOf(m)));

  s = s.replace(MD_IMAGE_INLINE, (_m: string, alt: string) => imageReplacement(alt));
  s = s.replace(MD_IMAGE_REF, (_m: string, alt: string) => imageReplacement(alt));
  s = s.replace(MD_IMAGE_SHORT, (_m: string, alt: string) => imageReplacement(alt));

  s = s.replace(MD_LINK_DATA, (_m: string, label: string) => label);
  s = s.replace(MD_LINK_BASE64, (_m: string, label: string) => label);
  s = s.replace(BARE_DATA_URI, () => DROP_MARK);

  return collapseDropMarks(s, isDroppedMediaLine);
}

function isDroppedMediaLine(line: string): boolean {
  return BASE64_LINE.test(line) || IMAGE_REF_DEF.test(line);
}

function dropMediaLines(text: string): string {
  const lines = text.split('\n');
  return lines.some(isDroppedMediaLine)
    ? lines.filter((line) => !isDroppedMediaLine(line)).join('\n')
    : text;
}
