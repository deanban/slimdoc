#!/usr/bin/env node
import { createRequire } from 'node:module';
import { mkdir, writeFile } from 'node:fs/promises';
import { realpathSync, statSync } from 'node:fs';
import { basename, extname, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';

import { cleanWithStats } from './clean.js';
import { extractFromBuffer, extractFromFile, UnsupportedFormatError } from './extract.js';
import { readClipboard, readStdinBuffer, writeClipboard } from './io.js';
import { formatBytes } from './tokens.js';
import { looksLikeTranscript } from './transcript.js';
import { resolveOptions } from './types.js';
import type { CleanOptions, ExtractedDoc, Preset, Stats } from './types.js';

const HELP = `slimdoc [file...] [options]

Shrinks documents into clean, token-cheap text for pasting into an LLM.
Reads stdin when no files are given.

Input
  -c, --clipboard         read the system clipboard instead of files/stdin
Output
  -o, --out <file>        write to a file (single input only)
  -D, --out-dir <dir>     write each cleaned input into <dir>
  -w, --write             rewrite the input files in place
  -C, --copy              copy the result to the clipboard
  -j, --json              emit JSON: { source, format, text, stats, warnings }
Presets
      --safe              structure-preserving, minimal edits
      --balanced          default
      --aggressive        also strips markdown decoration and emoji
Fine control (override the preset; every flag has a --no- counterpart)
      --unwrap            join hard-wrapped lines inside paragraphs
      --ascii             fold smart quotes, em-dashes, ellipses to ASCII
      --strip-markdown    drop emphasis markers, keep the words
      --strip-emoji
      --preserve-code     never touch code blocks (on by default)
      --compact-tables
      --normalize-unicode
      --unescape-markdown drop pointless backslash escapes (AI\\-generated)
      --max-blank-lines <n>
      --keep-tabs         alias for --no-tabs-to-spaces
      --no-strip-media    keep images / avatars / data: URIs (they are dropped by default)
Documents
  -t, --transcript        tidy a meeting transcript: drop per-line timestamps and
                          join/leave noise, merge consecutive turns by one speaker
Other
  -s, --stats             print a before/after report to stderr
  -q, --quiet             suppress warnings and the stats banner
  -h, --help    -V, --version

Token counts are a heuristic estimate, not a real tokenizer.
`;

const USAGE = 'usage: slimdoc [file...] [options]   (slimdoc --help for the full list)';

/** Keys of CleanOptions that are plain booleans, so `--x` / `--no-x` can drive them. */
type BooleanCleanKey = {
  [K in keyof CleanOptions]: CleanOptions[K] extends boolean ? K : never;
}[keyof CleanOptions];

const CLEAN_FLAGS: Record<string, BooleanCleanKey> = {
  unwrap: 'unwrap',
  ascii: 'asciiPunctuation',
  'strip-markdown': 'stripMarkdown',
  'strip-emoji': 'stripEmoji',
  'preserve-code': 'preserveCode',
  'compact-tables': 'compactTables',
  'normalize-unicode': 'normalizeUnicode',
  'unescape-markdown': 'unescapeMarkdown',
  'strip-media': 'stripMedia',
  'tabs-to-spaces': 'tabsToSpaces',
  transcript: 'transcript',
};

const PRESET_FLAGS: Record<string, Preset> = {
  safe: 'safe',
  balanced: 'balanced',
  aggressive: 'aggressive',
};

/** Boolean CLI switches whose long name is also their field name. */
const CLI_FLAGS = ['clipboard', 'write', 'copy', 'json', 'stats', 'quiet', 'help', 'version'] as const;
type CliFlag = (typeof CLI_FLAGS)[number];

type Invocation = Record<CliFlag, boolean> & {
  cleanOpts: CleanOptions;
  files: string[];
  out: string | undefined;
  outDir: string | undefined;
};

function isCliFlag(name: string): name is CliFlag {
  return (CLI_FLAGS as readonly string[]).includes(name);
}

type OptionSpec = { type: 'boolean' | 'string'; short?: string };

function optionSpecs(): Record<string, OptionSpec> {
  const specs: Record<string, OptionSpec> = {
    clipboard: { type: 'boolean', short: 'c' },
    out: { type: 'string', short: 'o' },
    'out-dir': { type: 'string', short: 'D' },
    write: { type: 'boolean', short: 'w' },
    copy: { type: 'boolean', short: 'C' },
    json: { type: 'boolean', short: 'j' },
    'max-blank-lines': { type: 'string' },
    'keep-tabs': { type: 'boolean' },
    transcript: { type: 'boolean', short: 't' },
    stats: { type: 'boolean', short: 's' },
    quiet: { type: 'boolean', short: 'q' },
    help: { type: 'boolean', short: 'h' },
    version: { type: 'boolean', short: 'V' },
  };
  for (const name of [...Object.keys(CLEAN_FLAGS), ...Object.keys(PRESET_FLAGS)]) {
    specs[name] ??= { type: 'boolean' };
    specs[`no-${name}`] = { type: 'boolean' };
  }
  for (const name of [...CLI_FLAGS, 'keep-tabs']) {
    specs[`no-${name}`] = { type: 'boolean' };
  }
  return specs;
}

interface ParsedToken {
  kind: string;
  name?: string;
  value?: string | undefined;
}

class UsageError extends Error {}

/**
 * Parse argv by walking the token stream rather than the values map: order decides
 * `--unwrap --no-unwrap`, while a preset only ever sets `preset`, so an explicit
 * flag beats the preset no matter which side of it the flag appears on.
 */
function parseInvocation(argv: string[]): Invocation {
  let parsed;
  try {
    parsed = parseArgs({
      args: argv,
      options: optionSpecs(),
      allowPositionals: true,
      strict: true,
      tokens: true,
    });
  } catch (e) {
    throw new UsageError(messageOf(e));
  }

  const overrides: Partial<CleanOptions> = {};
  const inv = {
    cleanOpts: resolveOptions(),
    files: parsed.positionals,
    out: undefined,
    outDir: undefined,
    ...Object.fromEntries(CLI_FLAGS.map((f) => [f, false])),
  } as Invocation;

  for (const token of parsed.tokens as ParsedToken[]) {
    if (token.kind !== 'option' || token.name === undefined) continue;
    const negated = token.name.startsWith('no-');
    const name = negated ? token.name.slice(3) : token.name;
    const on = !negated;

    const cleanKey = CLEAN_FLAGS[name];
    if (cleanKey !== undefined) {
      overrides[cleanKey] = on;
      continue;
    }
    const preset = PRESET_FLAGS[name];
    if (preset !== undefined) {
      if (on) overrides.preset = preset;
      continue;
    }

    if (isCliFlag(name)) {
      inv[name] = on;
      continue;
    }

    switch (name) {
      case 'keep-tabs':
        overrides.tabsToSpaces = !on;
        break;
      case 'max-blank-lines':
        overrides.maxBlankLines = parseCount(token.value);
        break;
      case 'out':
        inv.out = token.value;
        break;
      case 'out-dir':
        inv.outDir = token.value;
        break;
      default:
        throw new UsageError(`unknown option --${token.name}`);
    }
  }

  inv.cleanOpts = resolveOptions(overrides);
  return inv;
}

function parseCount(value: string | undefined): number {
  const n = Number(value);
  if (value === undefined || value.trim() === '' || !Number.isInteger(n) || n < 0) {
    throw new UsageError(`--max-blank-lines needs a whole number >= 0 (got "${value ?? ''}")`);
  }
  return n;
}

function validate(inv: Invocation): void {
  const noFiles = inv.files.length === 0;
  const hasOut = inv.out !== undefined;
  const hasOutDir = inv.outDir !== undefined;
  const problems: Array<[boolean, string]> = [
    [hasOut && inv.files.length > 1, '--out takes a single input; use --out-dir for several files'],
    [hasOut && hasOutDir, '--out and --out-dir cannot be combined'],
    [inv.write && hasOut, '--write and --out cannot be combined'],
    [inv.write && hasOutDir, '--write and --out-dir cannot be combined'],
    [inv.write && noFiles, '--write needs file arguments; there is nothing to rewrite'],
    [inv.clipboard && !noFiles, '--clipboard cannot be combined with file arguments'],
    [inv.json && (inv.write || hasOutDir), '--json cannot be combined with --write or --out-dir'],
  ];
  for (const [bad, message] of problems) {
    if (bad) throw new UsageError(message);
  }
  if (inv.out !== undefined) rejectBinaryTarget(inv.out);
}

/** Extensions whose readers expect a container, not the Markdown text slimdoc emits. */
const NOT_A_TEXT_TARGET = ['.docx', '.doc', '.rtf', '.pdf', '.odt', '.pages'];

/**
 * Writing text into a `.docx` name produces a file Word opens with "unreadable content".
 * --write and --out-dir already guard this; --out has to as well.
 */
function rejectBinaryTarget(target: string): void {
  const ext = extname(target).toLowerCase();
  if (!NOT_A_TEXT_TARGET.includes(ext)) return;
  const suggestion = `${target.slice(0, target.length - ext.length)}.md`;
  throw new UsageError(
    `slimdoc writes Markdown text, so a ${ext} file would not open — write to ${basename(suggestion)} instead`,
  );
}

function messageOf(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

function inputErrorMessage(e: unknown): string {
  if (e instanceof UnsupportedFormatError) return e.message;
  const code = (e as NodeJS.ErrnoException | null)?.code;
  if (code === 'ENOENT') return 'no such file';
  if (code === 'EISDIR') return 'is a directory';
  if (code === 'EACCES') return 'permission denied';
  return messageOf(e);
}

function writeErr(line: string): void {
  process.stderr.write(`${line}\n`);
}

function colourEnabled(): boolean {
  return process.stderr.isTTY === true && !process.env['NO_COLOR'];
}

function dim(text: string): string {
  return colourEnabled() ? `\u001b[2m${text}\u001b[0m` : text;
}

function num(n: number): string {
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
function onDiskSize(source: string): number | undefined {
  if (source.startsWith('<')) return undefined;
  try {
    return statSync(source).size;
  } catch {
    return undefined;
  }
}

function label(source: string): string {
  return source.startsWith('<') ? source : basename(source);
}

/** Cleaned output is Markdown-ish text, so a binary/markup source gets a `.md` name. */
function outputName(source: string): string {
  if (source.startsWith('<')) return `${source.replace(/[<>]/g, '')}.md`;
  const base = basename(source);
  const ext = extname(base).toLowerCase();
  const rewritten = ['.docx', '.rtf', '.html', '.htm', ''];
  return rewritten.includes(ext) ? `${base.slice(0, base.length - ext.length)}.md` : base;
}

interface Result {
  doc: ExtractedDoc;
  text: string;
  stats: Stats;
  /** Size of the original file, when the input came from disk. */
  sourceBytes?: number;
}

async function collect(inv: Invocation): Promise<{ docs: ExtractedDoc[]; failed: boolean }> {
  const docs: ExtractedDoc[] = [];
  let failed = false;

  if (inv.clipboard) {
    const text = await readClipboard();
    const doc = await extractFromBuffer(Buffer.from(text, 'utf8'));
    docs.push({ ...doc, source: '<clipboard>' });
    return { docs, failed };
  }

  if (inv.files.length === 0) {
    const buf = await readStdinBuffer();
    if (buf === null) throw new UsageError('no input — give a file, pipe stdin, or use --clipboard');
    const doc = await extractFromBuffer(buf);
    docs.push({ ...doc, source: '<stdin>' });
    return { docs, failed };
  }

  for (const file of inv.files) {
    try {
      docs.push(await extractFromFile(file));
    } catch (e) {
      writeErr(`slimdoc: ${file}: ${inputErrorMessage(e)}`);
      failed = true;
    }
  }
  return { docs, failed };
}

function reportStats(results: Result[]): void {
  if (results.length === 1) {
    const only = results[0];
    if (only) {
      writeErr(dim(sourceSizeLine(only.sourceBytes, only.stats.bytes.after) + statsLine(only.stats)));
    }
    return;
  }
  const total: Stats = {
    chars: { before: 0, after: 0 },
    bytes: { before: 0, after: 0 },
    lines: { before: 0, after: 0 },
    tokens: { before: 0, after: 0 },
    savedPct: 0,
  };
  for (const r of results) {
    for (const key of ['chars', 'bytes', 'lines', 'tokens'] as const) {
      total[key].before += r.stats[key].before;
      total[key].after += r.stats[key].after;
    }
    const disk = r.sourceBytes === undefined ? '' : `${formatBytes(r.sourceBytes)} on disk, `;
    writeErr(dim(`${label(r.doc.source)}: ${disk}${statsLine(r.stats)}`));
  }
  writeErr(dim(`total: ${statsLine(total)}`));
}

function joinResults(results: Result[]): string {
  const parts: string[] = [];
  for (let i = 0; i < results.length; i++) {
    const r = results[i];
    if (r === undefined) continue;
    if (i > 0) {
      const previous = parts[parts.length - 1] ?? '';
      parts.push(`${previous.endsWith('\n') ? '\n' : '\n\n'}--- ${label(r.doc.source)} ---\n\n`);
    }
    parts.push(r.text);
  }
  return parts.join('');
}

function jsonPayload(results: Result[]): string {
  const entries = results.map((r) => ({
    source: r.doc.source,
    format: r.doc.format,
    text: r.text,
    stats: r.stats,
    warnings: r.doc.warnings,
  }));
  const body = entries.length === 1 ? entries[0] : entries;
  return `${JSON.stringify(body, null, 2)}\n`;
}

/** True when rewriting the input in place would destroy a file we cannot regenerate. */
function refusesInPlace(doc: ExtractedDoc): boolean {
  return doc.format !== 'text' && doc.format !== 'markdown';
}

async function deliver(inv: Invocation, results: Result[]): Promise<boolean> {
  let failed = false;
  const payload = inv.json ? jsonPayload(results) : joinResults(results);

  if (inv.write) {
    for (const r of results) {
      if (refusesInPlace(r.doc)) {
        writeErr(`slimdoc: ${r.doc.source}: refusing to rewrite a ${r.doc.format} file in place — use --out-dir`);
        failed = true;
        continue;
      }
      await writeFile(r.doc.source, r.text, 'utf8');
    }
  } else if (inv.outDir !== undefined) {
    await mkdir(inv.outDir, { recursive: true });
    for (const r of results) {
      await writeFile(join(inv.outDir, outputName(r.doc.source)), r.text, 'utf8');
    }
  } else if (inv.out !== undefined) {
    await writeFile(inv.out, payload, 'utf8');
  }

  if (inv.copy) {
    await writeClipboard(payload);
    if (!inv.quiet) writeErr(dim(`slimdoc: copied ${num(payload.length)} chars to the clipboard`));
  }

  const wroteSomewhere = inv.write || inv.outDir !== undefined || inv.out !== undefined || inv.copy;
  if (!wroteSomewhere) process.stdout.write(payload);
  return failed;
}

const TRANSCRIPT_HINT =
  'slimdoc: this looks like a meeting transcript — --transcript would strip timestamps and merge speaker turns';

export async function run(argv: string[]): Promise<number> {
  let inv: Invocation;
  try {
    inv = parseInvocation(argv);
    if (!inv.help && !inv.version) validate(inv);
  } catch (e) {
    writeErr(`slimdoc: ${messageOf(e)}`);
    writeErr(USAGE);
    return 2;
  }

  if (inv.help) {
    process.stdout.write(HELP);
    return 0;
  }
  if (inv.version) {
    process.stdout.write(`${readVersion()}\n`);
    return 0;
  }

  let docs: ExtractedDoc[];
  let failed: boolean;
  try {
    ({ docs, failed } = await collect(inv));
  } catch (e) {
    writeErr(`slimdoc: ${messageOf(e)}`);
    if (e instanceof UsageError) {
      writeErr(USAGE);
      return 2;
    }
    return 1;
  }

  const wantsHint = !inv.quiet && (inv.stats || process.stderr.isTTY === true);
  const results: Result[] = [];
  let hinted = false;

  for (const doc of docs) {
    if (!inv.quiet) {
      for (const warning of doc.warnings) writeErr(dim(`slimdoc: ${label(doc.source)}: ${warning}`));
    }
    if (wantsHint && !hinted && !inv.cleanOpts.transcript && looksLikeTranscript(doc.text)) {
      writeErr(dim(TRANSCRIPT_HINT));
      hinted = true;
    }
    try {
      const { text, stats } = cleanWithStats(doc.text, inv.cleanOpts);
      results.push({ doc, text, stats, sourceBytes: onDiskSize(doc.source) });
    } catch (e) {
      writeErr(`slimdoc: ${doc.source}: ${messageOf(e)}`);
      failed = true;
    }
  }

  if (results.length > 0) {
    try {
      if (await deliver(inv, results)) failed = true;
    } catch (e) {
      writeErr(`slimdoc: ${messageOf(e)}`);
      failed = true;
    }
    if (inv.stats && !inv.quiet) reportStats(results);
  }

  return failed ? 1 : 0;
}

/**
 * Resolve the package version from package.json next to `dist/`. `createRequire`
 * anchors on this module's real path, so it works from a global install, an npx
 * cache and a local checkout alike.
 */
function readVersion(): string {
  const require = createRequire(import.meta.url);
  for (const candidate of ['../package.json', './package.json', '../../package.json']) {
    try {
      const pkg = require(candidate) as { name?: string; version?: string };
      if (pkg.name === 'slimdoc' && typeof pkg.version === 'string') return pkg.version;
    } catch {
      // try the next location
    }
  }
  return 'unknown';
}

/** True only when this file was started as a program, so importing it in a test is inert. */
function isEntrypoint(): boolean {
  const entry = process.argv[1];
  if (entry === undefined) return false;
  try {
    return import.meta.url === pathToFileURL(realpathSync(entry)).href;
  } catch {
    return false;
  }
}

if (isEntrypoint()) {
  run(process.argv.slice(2))
    .then((code) => {
      process.exitCode = code;
    })
    .catch((e: unknown) => {
      writeErr(`slimdoc: ${messageOf(e)}`);
      process.exitCode = 1;
    });
}
