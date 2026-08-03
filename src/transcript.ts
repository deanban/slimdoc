import { TRANSCRIPT_DEFAULTS, type TranscriptOptions } from './types.js';
import {
  firstLines,
  isNameLike,
  matchCueTiming,
  matchSpeakerLine,
  matchTeamsEcho,
  matchTeamsStamp,
  normalizeKey,
  parseUtterances,
  type Utterance,
} from './transcript-parse.js';

/** Below this length a live-caption prefix is more likely a real short utterance. */
const MIN_PREFIX_LENGTH = 8;
/** Merged text longer than this gets its own line under the speaker header. */
const INLINE_LIMIT = 200;
/** `looksLikeTranscript` never reads past this many lines. */
const SCAN_LINES = 400;

interface Block {
  speaker: string | null;
  segments: { time: string | null; text: string }[];
}

/**
 * Cheap structural sniff: a WEBVTT header, three or more cue timings, or five or
 * more speaker+timestamp lines. A bare `Name:` line deliberately does not count,
 * so plain chat logs and prose stay out.
 */
export function looksLikeTranscript(text: string): boolean {
  const lines = firstLines(text, SCAN_LINES);
  let cues = 0;
  let hits = 0;
  const known = new Set<string>();

  for (const raw of lines) {
    const line = raw.trim();
    if (!line) continue;
    if (/^WEBVTT\b/.test(line)) return true;
    if (matchCueTiming(line)) {
      cues += 1;
      if (cues >= 3) return true;
      continue;
    }
    if (line.startsWith('|')) continue;
    if (matchTeamsEcho(line) || matchTeamsStamp(line)) {
      hits += 1;
    } else {
      const speaker = matchSpeakerLine(raw, known);
      if (speaker && speaker.time) hits += 1;
    }
    if (hits >= 5) return true;
  }
  return false;
}

/** Drop an exact repeat, and fold a strict prefix into the longer line that follows it. */
function dedupe(utterances: Utterance[]): Utterance[] {
  const out: Utterance[] = [];
  for (const current of utterances) {
    const prev = out[out.length - 1];
    if (prev && normalizeKey(prev.speaker ?? '') === normalizeKey(current.speaker ?? '')) {
      const a = normalizeKey(prev.text);
      const b = normalizeKey(current.text);
      if (a === b) continue;
      if (b.startsWith(a) && a.length >= MIN_PREFIX_LENGTH) {
        prev.text = current.text;
        continue;
      }
      if (a.startsWith(b) && b.length >= MIN_PREFIX_LENGTH) continue;
    }
    out.push({ ...current });
  }
  return out;
}

function toBlocks(utterances: Utterance[], merge: boolean): Block[] {
  const blocks: Block[] = [];
  for (const u of utterances) {
    const prev = blocks[blocks.length - 1];
    const mergeable =
      merge &&
      prev !== undefined &&
      prev.speaker !== null &&
      u.speaker !== null &&
      normalizeKey(prev.speaker) === normalizeKey(u.speaker);
    if (mergeable && prev) {
      prev.segments.push({ time: u.time, text: u.text });
    } else {
      blocks.push({ speaker: u.speaker, segments: [{ time: u.time, text: u.text }] });
    }
  }
  return blocks;
}

/** `La Forge, Geordi` -> `Geordi`; `Jean-Luc Picard` -> `Jean-Luc`. */
function firstNameOf(name: string): string {
  const comma = name.indexOf(',');
  if (comma > 0) return name.slice(comma + 1).trim().split(/\s+/)[0] ?? '';
  const parts = name.split(/\s+/).filter(Boolean);
  return parts[0] ?? '';
}

/**
 * Short names only when every speaker keeps a distinct, unambiguous first name;
 * one collision and the whole transcript stays on full names.
 */
function shortNameMap(blocks: Block[]): Map<string, string> {
  const full = new Map<string, string>();
  for (const block of blocks) {
    if (block.speaker) full.set(normalizeKey(block.speaker), block.speaker);
  }
  const short = new Map<string, string>();
  const seen = new Set<string>();
  for (const [key, name] of full) {
    const first = firstNameOf(name);
    const firstKey = normalizeKey(first);
    if (!first || first.length < 2 || !isNameLike(first)) return new Map();
    if (seen.has(firstKey)) return new Map();
    // A first name that is also somebody's full handle would be ambiguous.
    if (firstKey !== key && full.has(firstKey)) return new Map();
    seen.add(firstKey);
    short.set(key, first);
  }
  return short;
}

function renderBlock(block: Block, names: Map<string, string>, options: TranscriptOptions): string {
  const body = block.segments
    .map((segment) =>
      !options.dropTimestamps && segment.time ? `[${segment.time}] ${segment.text}` : segment.text,
    )
    .join(' ')
    .trim();
  if (!block.speaker) return body;

  const name = names.get(normalizeKey(block.speaker)) ?? block.speaker;
  const stamp =
    options.dropTimestamps && options.keepFirstTimestamp ? block.segments[0]?.time ?? null : null;
  const header = stamp ? `${name} [${stamp}]:` : `${name}:`;
  if (!body) return header;
  return body.length > INLINE_LIMIT ? `${header}\n${body}` : `${header} ${body}`;
}

/**
 * Collapse a meeting transcript to one block per speaker turn. Never invents text,
 * never reorders utterances. Tolerates both mammoth-escaped and plain input.
 */
export function tidyTranscript(text: string, options: Partial<TranscriptOptions> = {}): string {
  const opts: TranscriptOptions = { ...TRANSCRIPT_DEFAULTS, ...options };
  const utterances = dedupe(parseUtterances(text, { dropSystem: opts.dropSystemLines }));
  if (utterances.length === 0) return '';
  const blocks = toBlocks(utterances, opts.mergeConsecutive);
  const names = opts.shortenNames ? shortNameMap(blocks) : new Map<string, string>();
  return blocks
    .map((block) => renderBlock(block, names, opts))
    .filter((rendered) => rendered.length > 0)
    .join('\n\n');
}
