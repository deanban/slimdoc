/**
 * argv in, a validated `Invocation` out. Nothing here touches the filesystem or
 * writes to a stream, so every refusal is a thrown `UsageError` the caller
 * turns into a message.
 */

import { basename, extname } from 'node:path';
import { parseArgs } from 'node:util';

import { messageOf } from './errors.js';
import { resolveOptions } from './types.js';
import type { CleanOptions, Preset } from './types.js';

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

/** Boolean CLI switches whose long name is also their field name. */
const CLI_FLAGS = ['clipboard', 'write', 'copy', 'json', 'stats', 'quiet', 'help', 'version'] as const;
type CliFlag = (typeof CLI_FLAGS)[number];

export type Invocation = Record<CliFlag, boolean> & {
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
    applyToken(inv, overrides, name, !negated, token.value);
  }

  inv.cleanOpts = resolveOptions(overrides);
  return inv;
}

function applyToken(
  inv: Invocation,
  overrides: Partial<CleanOptions>,
  name: string,
  on: boolean,
  value: string | undefined,
): void {
  const cleanKey = CLEAN_FLAGS[name];
  if (cleanKey !== undefined) {
    overrides[cleanKey] = on;
    return;
  }
  const preset = PRESET_FLAGS[name];
  if (preset !== undefined) {
    if (on) overrides.preset = preset;
    return;
  }
  if (isCliFlag(name)) {
    inv[name] = on;
    return;
  }

  switch (name) {
    case 'keep-tabs':
      overrides.tabsToSpaces = !on;
      break;
    case 'max-blank-lines':
      overrides.maxBlankLines = parseCount(value);
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
