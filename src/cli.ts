#!/usr/bin/env node
import { createRequire } from 'node:module';
import { mkdir, writeFile } from 'node:fs/promises';
import { realpathSync } from 'node:fs';
import { basename, dirname, extname, join } from 'node:path';
import { pathToFileURL } from 'node:url';

import { parseInvocation, USAGE, UsageError, validate, type Invocation } from './cli-options.js';
import { dim, label, num, onDiskSize, reportStats, writeErr } from './cli-report.js';
import { messageOf, UnsupportedFormatError } from './errors.js';
import { extractFromBuffer, extractFromFile } from './extract.js';
import { readClipboard, readStdinBuffer, writeClipboard } from './io.js';
import { cleanDocument, type SectionedDoc, type SectionStats } from './sections.js';
import { looksLikeTranscript } from './transcript.js';
import type { SourceFormat, Stats } from './types.js';

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
      --pages <range>     3-7,12 — pages (PDF) or slides (PPTX)
      --section-headings  emit \`## Page 3\` / \`## Slide 3 — Title\` markers
      --hidden            include hidden slides and off-slide text
      --chart-data        emit PPTX chart series as tables
      --no-diagram-text   skip SmartArt text
      --dehyphenate       rejoin words split across PDF line breaks
      --no-tables         do not preserve aligned PDF regions as code blocks
      --no-running-headers  keep text repeated on every PDF page
      --max-pages <n>     cap on the pages actually read (default 500)
Other
  -s, --stats             print a before/after report to stderr
  -q, --quiet             suppress warnings and the stats banner
  -h, --help    -V, --version

Token counts are a heuristic estimate, not a real tokenizer.
`;

function inputErrorMessage(e: unknown): string {
  if (e instanceof UnsupportedFormatError) return e.message;
  const code = (e as NodeJS.ErrnoException | null)?.code;
  if (code === 'ENOENT') return 'no such file';
  if (code === 'EISDIR') return 'is a directory';
  if (code === 'EACCES') return 'permission denied';
  return messageOf(e);
}

/**
 * What a cleaned document should be called on disk.
 *
 * The decision is the format slimdoc *read*, not a list of extensions to rewrite.
 * A list is what was here before, and PDF was never added to it, so a cleaned PDF
 * went back out under a `.pdf` name no reader can open — while `--out` refused
 * that exact target and the README promised the extension was corrected.
 *
 * `refusesInPlace` already draws this line for `--write`: a text or Markdown
 * source is still text or Markdown after cleaning and keeps its name, `.csv` and
 * `.json` included. Everything else became Markdown-ish text on the way through
 * and is named for what it now holds. Sharing the predicate is what stops the two
 * output paths from disagreeing again the next time a format lands.
 */
function outputName(source: string, format: SourceFormat): string {
  if (source.startsWith('<')) return `${source.replace(/[<>]/g, '')}.md`;
  const base = basename(source);
  const ext = extname(base);
  if (ext !== '' && !convertsToMarkdown(format)) return base;
  return `${base.slice(0, base.length - ext.length)}.md`;
}

/**
 * Output names for a whole run, with collisions resolved rather than overwritten.
 *
 * `reports/q1/summary.pdf` and `reports/q2/summary.pdf` are one ordinary glob
 * apart, and writing both to `summary.md` destroys the first result invisibly:
 * the run succeeds, and the file that survives looks correct. The containing
 * directory is what the user distinguished them by, so it is what disambiguates
 * them here.
 */
function outputNames(docs: SectionedDoc[]): Map<string, string> {
  const names = new Map<string, string>();
  const taken = new Set<string>();

  for (const { source, format } of docs) {
    const preferred = outputName(source, format);
    let name = preferred;
    if (taken.has(name)) {
      const parent = basename(dirname(source));
      const ext = extname(preferred);
      const stem = preferred.slice(0, preferred.length - ext.length);
      name = parent === '' || parent === '.' ? preferred : `${parent}-${stem}${ext}`;
      for (let n = 2; taken.has(name); n++) name = `${stem}-${n}${ext}`;
    }
    taken.add(name);
    names.set(source, name);
  }
  return names;
}

interface Result {
  doc: SectionedDoc;
  text: string;
  stats: Stats;
  sections: SectionStats[];
  source: string;
  sourceBytes?: number;
}

async function collect(inv: Invocation): Promise<{ docs: SectionedDoc[]; failed: boolean }> {
  const docs: SectionedDoc[] = [];
  let failed = false;

  const extract = inv.extractOpts;

  if (inv.clipboard) {
    const text = await readClipboard();
    const doc = await extractFromBuffer(Buffer.from(text, 'utf8'), { extract });
    docs.push({ ...doc, source: '<clipboard>' });
    return { docs, failed };
  }

  if (inv.files.length === 0) {
    const buf = await readStdinBuffer();
    if (buf === null) throw new UsageError('no input — give a file, pipe stdin, or use --clipboard');
    const doc = await extractFromBuffer(buf, { extract });
    docs.push({ ...doc, source: '<stdin>' });
    return { docs, failed };
  }

  for (const file of inv.files) {
    try {
      docs.push(await extractFromFile(file, extract));
    } catch (e) {
      writeErr(`slimdoc: ${file}: ${inputErrorMessage(e)}`);
      failed = true;
    }
  }
  return { docs, failed };
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

/**
 * True when reading this format produced Markdown-ish text rather than something
 * still of the same kind. Such a document cannot be written back over its source,
 * and must not keep a name that claims it is still a deck, a PDF or a web page.
 */
function convertsToMarkdown(format: SourceFormat): boolean {
  return format !== 'text' && format !== 'markdown';
}

/** True when rewriting the input in place would destroy a file we cannot regenerate. */
function refusesInPlace(doc: SectionedDoc): boolean {
  return convertsToMarkdown(doc.format);
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
    const names = outputNames(results.map((r) => r.doc));
    for (const r of results) {
      const preferred = outputName(r.doc.source, r.doc.format);
      const name = names.get(r.doc.source) ?? preferred;
      if (!inv.quiet && name !== preferred) {
        writeErr(dim(`slimdoc: ${label(r.doc.source)}: written as ${name} to avoid overwriting another result`));
      }
      await writeFile(join(inv.outDir, name), r.text, 'utf8');
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

function cleanEach(inv: Invocation, docs: SectionedDoc[]): { results: Result[]; failed: boolean } {
  const wantsHint = !inv.quiet && (inv.stats || process.stderr.isTTY === true);
  const results: Result[] = [];
  let hinted = false;
  let failed = false;

  for (const doc of docs) {
    if (!inv.quiet) {
      for (const warning of doc.warnings) writeErr(dim(`slimdoc: ${label(doc.source)}: ${warning}`));
    }
    if (wantsHint && !hinted && !inv.cleanOpts.transcript && looksLikeTranscript(doc.text)) {
      writeErr(dim(TRANSCRIPT_HINT));
      hinted = true;
    }
    try {
      const cleaned = cleanDocument(doc, inv.cleanOpts, inv.extractOpts);
      results.push({ doc, ...cleaned, source: doc.source, sourceBytes: onDiskSize(doc.source) });
    } catch (e) {
      writeErr(`slimdoc: ${doc.source}: ${messageOf(e)}`);
      failed = true;
    }
  }
  return { results, failed };
}

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

  let docs: SectionedDoc[];
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

  const cleaned = cleanEach(inv, docs);
  const results = cleaned.results;
  if (cleaned.failed) failed = true;

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
