/**
 * argv in, a validated `Invocation` out. Nothing here touches the filesystem or
 * writes to a stream, so every refusal is a thrown `UsageError` the caller
 * turns into a message.
 */

import { basename, extname } from 'node:path';
import { parseArgs } from 'node:util';

import { messageOf } from './errors.js';
import { resolveExtractOptions, resolveOptions } from './types.js';
import type { CleanOptions, ExtractOptions, ExtractOverrides, Preset } from './types.js';
import { parseRanges } from './utils/ranges.js';

export class UsageError extends Error {}

export const USAGE = 'usage: slimdoc [file...] [options]   (slimdoc --help for the full list)';

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

/** Boolean keys of ExtractOptions, so `--x` / `--no-x` can drive them too. */
type BooleanExtractKey = {
  [K in keyof ExtractOptions]: ExtractOptions[K] extends boolean ? K : never;
}[keyof ExtractOptions];

const EXTRACT_FLAGS: Record<string, BooleanExtractKey> = {
  hidden: 'hiddenContent',
  'section-headings': 'sectionHeadings',
  dehyphenate: 'dehyphenate',
  'running-headers': 'dropRunningHeaders',
};

/** Boolean CLI switches whose long name is also their field name. */
const CLI_FLAGS = ['clipboard', 'write', 'copy', 'json', 'stats', 'quiet', 'help', 'version'] as const;
type CliFlag = (typeof CLI_FLAGS)[number];

export type Invocation = Record<CliFlag, boolean> & {
  cleanOpts: CleanOptions;
  extractOpts: ExtractOptions;
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
    pages: { type: 'string' },
    'max-pages': { type: 'string' },
    transcript: { type: 'boolean', short: 't' },
    stats: { type: 'boolean', short: 's' },
    quiet: { type: 'boolean', short: 'q' },
    help: { type: 'boolean', short: 'h' },
    version: { type: 'boolean', short: 'V' },
  };
  const switches = [...Object.keys(CLEAN_FLAGS), ...Object.keys(PRESET_FLAGS), ...Object.keys(EXTRACT_FLAGS)];
  for (const name of switches) {
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

/**
 * Parse argv by walking the token stream rather than the values map: order decides
 * `--unwrap --no-unwrap`, while a preset only ever sets `preset`, so an explicit
 * flag beats the preset no matter which side of it the flag appears on.
 */
export function parseInvocation(argv: string[]): Invocation {
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

  const overrides: Overrides = { clean: {}, extract: {} };
  const inv = {
    cleanOpts: resolveOptions(),
    extractOpts: resolveExtractOptions(),
    files: parsed.positionals,
    out: undefined,
    outDir: undefined,
    ...Object.fromEntries(CLI_FLAGS.map((f) => [f, false])),
  } as Invocation;

  for (const token of parsed.tokens as ParsedToken[]) {
    if (token.kind !== 'option' || token.name === undefined) continue;
    const negated = token.name.startsWith('no-');
    const name = negated ? token.name.slice(3) : token.name;
    applyToken(inv, overrides, name, !negated, token.value);
  }

  inv.cleanOpts = resolveOptions(overrides.clean);
  inv.extractOpts = resolveExtractOptions(overrides.extract);
  return inv;
}

interface Overrides {
  clean: Partial<CleanOptions>;
  extract: ExtractOverrides;
}

function applyToken(
  inv: Invocation,
  overrides: Overrides,
  name: string,
  on: boolean,
  value: string | undefined,
): void {
  const cleanKey = CLEAN_FLAGS[name];
  if (cleanKey !== undefined) {
    overrides.clean[cleanKey] = on;
    return;
  }
  const extractKey = EXTRACT_FLAGS[name];
  if (extractKey !== undefined) {
    overrides.extract[extractKey] = on;
    return;
  }
  const preset = PRESET_FLAGS[name];
  if (preset !== undefined) {
    if (on) overrides.clean.preset = preset;
    return;
  }
  if (isCliFlag(name)) {
    inv[name] = on;
    return;
  }

  switch (name) {
    case 'keep-tabs':
      overrides.clean.tabsToSpaces = !on;
      break;
    case 'max-blank-lines':
      overrides.clean.maxBlankLines = parseCount(value);
      break;
    case 'pages':
      overrides.extract.pages = parseSelection(value);
      break;
    case 'max-pages':
      overrides.extract.limits = { ...overrides.extract.limits, maxPages: parsePositive(value, '--max-pages') };
      break;
    case 'out':
      inv.out = value;
      break;
    case 'out-dir':
      inv.outDir = value;
      break;
    default:
      throw new UsageError(`unknown option --${name}`);
  }
}

function parseSelection(value: string | undefined): ExtractOptions['pages'] {
  try {
    return parseRanges(value ?? '');
  } catch (e) {
    throw new UsageError(`--pages: ${messageOf(e)}`);
  }
}

function parsePositive(value: string | undefined, flag: string): number {
  const n = Number(value);
  if (value === undefined || !Number.isInteger(n) || n < 1) {
    throw new UsageError(`${flag} needs a whole number >= 1 (got "${value ?? ''}")`);
  }
  return n;
}

function parseCount(value: string | undefined): number {
  const n = Number(value);
  if (value === undefined || value.trim() === '' || !Number.isInteger(n) || n < 0) {
    throw new UsageError(`--max-blank-lines needs a whole number >= 0 (got "${value ?? ''}")`);
  }
  return n;
}

export function validate(inv: Invocation): void {
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
const NOT_A_TEXT_TARGET = [
  '.docx', '.doc', '.rtf', '.pdf', '.odt', '.pages',
  '.pptx', '.pptm', '.potx', '.ppt', '.key', '.odp', '.xlsx',
];

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
