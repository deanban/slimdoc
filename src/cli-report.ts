/**
 * Everything the CLI writes to stderr: warnings, the stats banner, and the
 * per-section breakdown. Nothing here decides anything — it formats.
 */

import { statSync } from 'node:fs';
import { basename } from 'node:path';

import type { SectionStats } from './sections.js';
import { formatBytes } from './tokens.js';
import type { Stats } from './types.js';

const ESC = String.fromCharCode(27);
const DIM = `${ESC}[2m`;
const RESET = `${ESC}[0m`;

export function writeErr(line: string): void {
  process.stderr.write(`${line}\n`);
}

function colourEnabled(): boolean {
  return process.stderr.isTTY === true && !process.env['NO_COLOR'];
}

export function dim(text: string): string {
  return colourEnabled() ? `${DIM}${text}${RESET}` : text;
}

export function num(n: number): string {
  return n.toLocaleString('en-US');
}

function pct(before: number, after: number): string {
  if (before === 0) return '0%';
  const p = Math.round(((after - before) / before) * 100);
  return `${p > 0 ? '+' : ''}${p}%`;
}

function statsLine(s: Stats): string {
  return (
    `${num(s.chars.before)} chars -> ${num(s.chars.after)} (${pct(s.chars.before, s.chars.after)})  ` +
    `~${num(s.tokens.before)} -> ~${num(s.tokens.after)} tokens (${pct(s.tokens.before, s.tokens.after)})`
  );
}

/**
 * `stats.chars.before` counts the text we extracted, which for a .docx is measured after
 * embedded images were discarded — and those images are usually most of the file. Without
 * naming the on-disk size the report silently omits the largest saving the tool makes.
 */
function sourceSizeLine(bytes: number | undefined, after: number): string {
  if (bytes === undefined) return '';
  return `${formatBytes(bytes)} on disk -> ${formatBytes(after)} of text\n`;
}

/** Byte size of the input file, or undefined for stdin, clipboard, or an unreadable path. */
export function onDiskSize(source: string): number | undefined {
  if (source.startsWith('<')) return undefined;
  try {
    return statSync(source).size;
  } catch {
    return undefined;
  }
}

export function label(source: string): string {
  return source.startsWith('<') ? source : basename(source);
}

export interface Reportable {
  source: string;
  stats: Stats;
  /** Empty unless the document has pages or slides. */
  sections: SectionStats[];
  /** Size of the original file, when the input came from disk. */
  sourceBytes?: number;
}

function emptyStats(): Stats {
  return {
    chars: { before: 0, after: 0 },
    bytes: { before: 0, after: 0 },
    lines: { before: 0, after: 0 },
    tokens: { before: 0, after: 0 },
    savedPct: 0,
  };
}

/**
 * One line per page or slide. The section heading and the delimiter between
 * sections are counted here too — they are tokens the user pays for.
 */
function writeSections(sections: SectionStats[]): void {
  for (const section of sections) {
    const title = section.label === undefined ? '' : `  ${section.label}`;
    writeErr(dim(`  ${String(section.index).padStart(3)}.${title.padEnd(30)} ~${num(section.tokens)} tokens`));
  }
}

function addInto(total: Stats, one: Stats): void {
  for (const key of ['chars', 'bytes', 'lines', 'tokens'] as const) {
    total[key].before += one[key].before;
    total[key].after += one[key].after;
  }
}

function reportOne(r: Reportable): void {
  writeErr(dim(sourceSizeLine(r.sourceBytes, r.stats.bytes.after) + statsLine(r.stats)));
  writeSections(r.sections);
}

export function reportStats(results: Reportable[]): void {
  const only = results[0];
  if (results.length === 1 && only) {
    reportOne(only);
    return;
  }

  const total = emptyStats();
  for (const r of results) {
    addInto(total, r.stats);
    const disk = r.sourceBytes === undefined ? '' : `${formatBytes(r.sourceBytes)} on disk, `;
    writeErr(dim(`${label(r.source)}: ${disk}${statsLine(r.stats)}`));
    writeSections(r.sections);
  }
  writeErr(dim(`total: ${statsLine(total)}`));
}
