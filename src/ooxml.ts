/**
 * OOXML reading: a namespace-aware parse into a small tree, plus relationship
 * resolution.
 *
 * `extract-html.ts` is deliberately a tolerant tag rewriter because pasted
 * Outlook fragments are malformed. That precedent does not transfer here. An
 * OOXML package is structured XML, and its prefixes are conventional rather
 * than guaranteed — `a:`, `p:` and `r:` are what PowerPoint emits, but ECMA-376
 * permits any prefix and third-party generators do vary. A tag scanner would be
 * a correctness trap, so every element and attribute is resolved by namespace
 * URI and re-keyed onto the canonical prefix callers can then match on.
 */

import { SaxesParser, type SaxesAttributeNS, type SaxesTagNS } from 'saxes';

import { UnsupportedFormatError } from './errors.js';

const CANONICAL: Readonly<Record<string, string>> = {
  'http://schemas.openxmlformats.org/drawingml/2006/main': 'a',
  'http://schemas.openxmlformats.org/presentationml/2006/main': 'p',
  'http://schemas.openxmlformats.org/officeDocument/2006/relationships': 'r',
  'http://schemas.openxmlformats.org/drawingml/2006/chart': 'c',
  'http://schemas.openxmlformats.org/drawingml/2006/diagram': 'dgm',
  'http://schemas.openxmlformats.org/markup-compatibility/2006': 'mc',
  'http://schemas.openxmlformats.org/package/2006/relationships': 'pr',
};

export interface XmlNode {
  /** Canonical prefix (`a`, `p`, `r`, …), or the raw URI when unrecognised. */
  ns: string;
  local: string;
  /** Un-namespaced attributes by local name; namespaced ones as `r:id`. */
  attrs: Record<string, string>;
  children: XmlNode[];
  /** This element's own text, up to its first child. */
  text: string;
  /** The text that followed this element inside its parent. */
  tail: string;
}

function prefixOf(uri: string): string {
  return CANONICAL[uri] ?? uri;
}

function attributeKey(attr: SaxesAttributeNS): string {
  return attr.uri === '' ? attr.local : `${prefixOf(attr.uri)}:${attr.local}`;
}

function toNode(tag: SaxesTagNS): XmlNode {
  const attrs: Record<string, string> = {};
  for (const attr of Object.values(tag.attributes)) {
    if (attr.prefix === 'xmlns' || attr.name === 'xmlns') continue;
    attrs[attributeKey(attr)] = attr.value;
  }
  return { ns: prefixOf(tag.uri), local: tag.local, attrs, children: [], text: '', tail: '' };
}

/**
 * `mc:AlternateContent` wraps one `mc:Choice` per feature set plus an
 * `mc:Fallback`. The Choice carries the real shape tree and the Fallback is
 * usually a flattened picture of it, so the Choice is preferred and the wrapper
 * disappears — no caller should have to know the element exists.
 */
function unwrapAlternateContent(node: XmlNode): XmlNode[] {
  if (node.ns !== 'mc' || node.local !== 'AlternateContent') return [node];
  const chosen =
    node.children.find((c) => c.ns === 'mc' && c.local === 'Choice') ??
    node.children.find((c) => c.ns === 'mc' && c.local === 'Fallback');
  return chosen ? chosen.children : [];
}

export function parseXml(source: string | Buffer): XmlNode {
  const parser = new SaxesParser<{ xmlns: true }>({ xmlns: true });
  const stack: XmlNode[] = [];
  let root: XmlNode | undefined;
  let failure: Error | undefined;

  parser.on('error', (e) => {
    failure ??= e;
  });
  parser.on('opentag', (tag) => {
    stack.push(toNode(tag));
  });
  // Text after a child belongs *after* that child, not appended to everything
  // the element owns: `one<a:r>two</a:r>three` is three fragments in that order,
  // and an element that swept them all into one string would read `onethreetwo`.
  const addText = (text: string): void => {
    const top = stack[stack.length - 1];
    if (!top) return;
    const previous = top.children[top.children.length - 1];
    if (previous) previous.tail += text;
    else top.text += text;
  };
  parser.on('text', addText);
  parser.on('cdata', addText);
  parser.on('closetag', () => {
    const node = stack.pop();
    if (!node) return;
    const parent = stack[stack.length - 1];
    if (parent) parent.children.push(...unwrapAlternateContent(node));
    else root = node;
  });

  parser.write(typeof source === 'string' ? source : source.toString('utf8')).close();

  if (failure) throw new UnsupportedFormatError(`contains malformed XML: ${failure.message}`, 'ooxml');
  if (!root) throw new UnsupportedFormatError('contains no XML document element', 'ooxml');
  return root;
}

export function children(node: XmlNode, ns: string, local: string): XmlNode[] {
  return node.children.filter((c) => c.ns === ns && c.local === local);
}

export function child(node: XmlNode, ns: string, local: string): XmlNode | undefined {
  return node.children.find((c) => c.ns === ns && c.local === local);
}

/** Every matching element in the subtree, in document order. */
export function descendants(node: XmlNode, ns: string, local: string): XmlNode[] {
  const found: XmlNode[] = [];
  const walk = (current: XmlNode): void => {
    for (const c of current.children) {
      if (c.ns === ns && c.local === local) found.push(c);
      walk(c);
    }
  };
  walk(node);
  return found;
}

/** All text in the subtree, in document order. */
export function textOf(node: XmlNode): string {
  return node.children.reduce((text, c) => text + textOf(c) + c.tail, node.text);
}

/** Enough of a part to have reached its document element, in one bite. */
const ROOT_CHUNK = 4096;

/**
 * The document element's attributes, without building the tree beneath it.
 *
 * A slide's `show` attribute decides whether the slide is in the document at
 * all, and that has to be known for *every* slide before page selection can
 * number them — while parsing every slide is exactly what page selection exists
 * to avoid. This reads the opening tag and stops, so an unselected slide costs
 * one tag instead of its whole shape tree.
 *
 * Still a real namespace-aware parse rather than a scan for `show=`: the prefix
 * is conventional, the attribute may be namespaced, and a tag scanner here would
 * be the correctness trap this module was written to avoid. Errors past the root
 * tag are ignored because nothing past it is being read.
 */
export function rootAttributes(source: Buffer): Record<string, string> {
  const parser = new SaxesParser<{ xmlns: true }>({ xmlns: true });
  let attrs: Record<string, string> | undefined;

  parser.on('error', () => {});
  parser.on('opentag', (tag) => {
    attrs ??= toNode(tag).attrs;
  });

  const text = source.toString('utf8');
  for (let at = 0; at < text.length && attrs === undefined; at += ROOT_CHUNK) {
    parser.write(text.slice(at, at + ROOT_CHUNK));
  }
  return attrs ?? {};
}

/**
 * `ST_Boolean`, which XSD spells four ways: `1`, `0`, `true`, `false`.
 *
 * PowerPoint writes the digits, so a deck from PowerPoint never exercises the
 * words and a `=== '1'` comparison looks correct for years. Everything else that
 * writes OOXML — an export from Keynote or Slides, a reporting tool built on a
 * library — is free to write `true`, and then a hidden slide is shown and a
 * merged cell speaks. That third-party variance is what this module is for, so
 * the comparison belongs here rather than at each of its call sites.
 *
 * `undefined` back means the attribute was absent or was not a boolean at all,
 * which callers distinguish from `false`.
 */
export function isTrue(value: string | undefined): boolean | undefined {
  const normalised = value?.trim().toLowerCase();
  if (normalised === '1' || normalised === 'true') return true;
  if (normalised === '0' || normalised === 'false') return false;
  return undefined;
}

export interface Relationship {
  type: string;
  target: string;
  /** A hyperlink or linked chart data: the target is a URL, not a part name. */
  external: boolean;
}

export function readRels(source: string | Buffer | undefined): Map<string, Relationship> {
  const rels = new Map<string, Relationship>();
  if (source === undefined) return rels;

  for (const rel of children(parseXml(source), 'pr', 'Relationship')) {
    const id = rel.attrs['Id'];
    if (id === undefined) continue;
    rels.set(id, {
      type: rel.attrs['Type'] ?? '',
      target: rel.attrs['Target'] ?? '',
      external: rel.attrs['TargetMode'] === 'External',
    });
  }
  return rels;
}

/** A relationship target, resolved against the folder of the part that owns it. */
export function resolvePart(basePart: string, target: string): string {
  if (target.startsWith('/')) return target.slice(1);

  const segments = basePart.split('/').slice(0, -1);
  for (const segment of target.split('/')) {
    if (segment === '.' || segment === '') continue;
    if (segment === '..') segments.pop();
    else segments.push(segment);
  }
  return segments.join('/');
}

/** The `_rels/<name>.rels` part that carries `part`'s relationships. */
export function relsPartFor(part: string): string {
  const cut = part.lastIndexOf('/');
  return `${part.slice(0, cut + 1)}_rels/${part.slice(cut + 1)}.rels`;
}
