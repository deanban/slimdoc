/**
 * Line-level recognition for meeting transcripts. Everything here is pure and
 * string-only; `transcript.ts` owns merging, naming and rendering.
 */

export interface Utterance {
  /** null when the line could not be attributed to anybody. */
  speaker: string | null;
  /** Normalised `M:SS` / `H:MM:SS`, or null. */
  time: string | null;
  text: string;
}

/** A clock stamp: `0:43`, `12:04`, `1:05:03`, `00:12:04`. */
const CLOCK = '\\d{1,3}:[0-5]\\d(?::[0-5]\\d)?';
/** Teams' verbose duration: `1 hour 5 minutes 3 seconds`, `0 minutes 43 seconds`. */
const VERBOSE = '(?:(\\d{1,3})\\s+hours?\\s+)?(?:(\\d{1,3})\\s+minutes?\\s+)?(\\d{1,3})\\s+seconds?';

/** `0 minutes 43 seconds0:43` — verbose and short stamp concatenated, alone on a line. */
const TEAMS_STAMP_LINE = new RegExp(`^${VERBOSE}\\s*(${CLOCK})?$`);
/** The redundant echo line: `Ortega, Camila 0 minutes 43 seconds`, short stamp optional. */
const TEAMS_ECHO_LINE = new RegExp(`^(.{1,60}?)\\s+${VERBOSE}\\s*(${CLOCK})?$`);

const BOLD_ONLY = /^(?:__|\*\*)\s*(.+?)\s*(?:__|\*\*)$/;
const LEADING_CLOCK = new RegExp(`^\\[?(${CLOCK})\\]?\\s*[-–—]?\\s*(.{1,60}?)\\s*:\\s*(.*)$`);
const TRAILING_CLOCK = new RegExp(`^(.{1,60}?)\\s+\\[?(${CLOCK})\\]?\\s*:?\\s*(.*)$`);
const COLON_SPEAKER = /^(.{1,60}?)\s*:\s+(\S.*)$/;
const BARE_CLOCK = new RegExp(`^\\[?(${CLOCK})\\]?$`);
const CUE_TIMING = new RegExp(`^(?:(\\d{1,3}):)?(\\d{1,3}):([0-5]\\d)(?:[.,](\\d{1,3}))?\\s*-->`);
const VOICE_SPAN = /^<v(?:\.[^\s>]+)*\s+([^>]+)>([\s\S]*?)(?:<\/v>)?$/i;

/** Lowercase words that legitimately sit inside a surname. */
const NAME_PARTICLES = new Set([
  'de', 'del', 'della', 'da', 'das', 'dos', 'di', 'du', 'la', 'le', 'van', 'von',
  'der', 'den', 'ter', 'ten', 'bin', 'ibn', 'al', 'el', 'st', 'mac', 'mc', 'y',
]);

const NAME_TOKEN = /^[\p{L}][\p{L}\p{M}'’.\-]*$/u;

function pad2(n: number): string {
  return n < 10 ? `0${n}` : String(n);
}

/** Seconds -> `M:SS`, or `H:MM:SS` once an hour has elapsed. */
export function formatClock(hours: number, minutes: number, seconds: number): string {
  const total = hours * 3600 + minutes * 60 + seconds;
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  return h > 0 ? `${h}:${pad2(m)}:${pad2(s)}` : `${m}:${pad2(s)}`;
}

/** `00:12:04` -> `12:04`, `0:43` -> `0:43`. */
export function normalizeClock(stamp: string): string {
  const parts = stamp.split(':').map((p) => Number.parseInt(p, 10) || 0);
  if (parts.length === 3) return formatClock(parts[0] ?? 0, parts[1] ?? 0, parts[2] ?? 0);
  return formatClock(0, parts[0] ?? 0, parts[1] ?? 0);
}

/** Drop backslashes mammoth adds before ASCII punctuation, so patterns match either form. */
export function unescapeMarkdown(text: string): string {
  return text.replace(/\\([!-/:-@[-`{-~])/g, '$1');
}

/** Comparison key: unescaped, whitespace-collapsed, lower-cased. */
export function normalizeKey(text: string): string {
  return unescapeMarkdown(text).replace(/\s+/g, ' ').trim().toLowerCase();
}

/** Strip a trailing `(Guest)` / `(External)` qualifier and tidy whitespace. */
export function cleanName(name: string): string {
  return unescapeMarkdown(name)
    .replace(/\s*\([^)]*\)\s*$/, '')
    .replace(/\s+/g, ' ')
    .replace(/[\s,:;]+$/, '')
    .trim();
}

/**
 * A conservative "is this a person's name" test: 1-4 tokens, each capitalised
 * (or a known particle, or a trailing index like `Speaker 1`).
 */
export function isNameLike(candidate: string): boolean {
  const name = cleanName(candidate);
  if (!name || name.length > 48) return false;
  if (/[:;|<>{}=@#*_`"]/.test(name)) return false;
  const parts = name.split(/[\s,]+/).filter(Boolean);
  if (parts.length === 0 || parts.length > 4) return false;
  return parts.every((part, i) => {
    if (/^\d{1,3}$/.test(part)) return parts.length > 1 && i > 0;
    if (!NAME_TOKEN.test(part)) return false;
    const first = part[0] ?? '';
    if (first === first.toLocaleUpperCase() && first !== first.toLocaleLowerCase()) return true;
    return NAME_PARTICLES.has(part.replace(/\.$/, '').toLowerCase());
  });
}

const SYSTEM_EXACT: RegExp[] = [
  /^ai[\s-]?generated content may be incorrect\.?$/i,
  /^this transcript was generated automatically.*$/i,
  /^(?:recording|transcription|live captions?|transcript|meeting|the meeting|the call)\s+(?:has\s+|was\s+|is\s+)?(?:started|stopped|ended|begun|began|resumed|paused|enabled|disabled|turned on|turned off)(?:\s+by\s+.{1,60})?\.?$/i,
  /^(?:muted|unmuted|you are muted|you're muted|your microphone is muted)\.?$/i,
  /^\d{1,4}\s+(?:participants?|people)\s+(?:joined|left|are here)\.?$/i,
];

const SYSTEM_WITH_ACTOR: RegExp[] = [
  /^(.{1,60}?)\s+(?:has\s+|have\s+)?(?:joined|left|rejoined|entered|exited)\s+the\s+(?:meeting|call|conference|channel)\.?$/i,
  /^(.{1,60}?)\s+(?:started|stopped|began|ended|paused|resumed)\s+(?:the\s+)?(?:recording|transcription|transcribing|video|their video|sharing|screen ?sharing|presenting|to present|presentation)\.?$/i,
  /^(.{1,60}?)\s+(?:is presenting|is now presenting|shared screen|shared their screen|stopped sharing|started sharing|left|joined|rejoined|was removed|muted|unmuted|muted themselves|unmuted themselves|turned on their video|turned off their video)\.?$/i,
];

/** Whole-line join/leave/recording chatter. Never matches a fragment of speech. */
export function isSystemLine(line: string): boolean {
  const text = unescapeMarkdown(line).replace(/\s+/g, ' ').trim();
  if (!text || text.length > 140) return false;
  if (SYSTEM_EXACT.some((re) => re.test(text))) return true;
  for (const re of SYSTEM_WITH_ACTOR) {
    const m = re.exec(text);
    if (!m) continue;
    const actor = m[1] ?? '';
    // A bare `X left.` is only noise when X reads as a name; otherwise it is speech.
    if (/\bthe\s+(?:meeting|call|conference|channel)\b/i.test(text) || isNameLike(actor)) return true;
  }
  return false;
}

/** Avatar leftovers: an image that stripMedia already emptied, or a bare initials line. */
export function isNoiseLine(line: string): boolean {
  const text = unescapeMarkdown(line).trim();
  if (!text) return true;
  if (/^\[?(?:img|image|photo|avatar|icon)\]?$/i.test(text)) return true;
  if (/^!\[[^\]]*\]\([^)]*\)$/.test(text)) return true;
  if (/^!\[[^\]]*\]\[[^\]]*\]$/.test(text)) return true;
  if (/^[A-Z]{1,3}$/.test(text)) return true;
  // Teams exports icon glyphs from a private-use font; they carry no meaning.
  if (/^[\p{Co}\p{So}\p{Sk}\p{Cf}]{1,4}$/u.test(text)) return true;
  return false;
}

/** `0 minutes 43 seconds0:43` -> `0:43`. */
export function matchTeamsStamp(line: string): string | null {
  const m = TEAMS_STAMP_LINE.exec(unescapeMarkdown(line).trim());
  if (!m) return null;
  const short = m[4];
  if (short) return normalizeClock(short);
  return formatClock(Number(m[1] ?? 0), Number(m[2] ?? 0), Number(m[3] ?? 0));
}

/** `Picard, Jean-Luc 0 minutes 43 seconds` -> speaker + `0:43`. */
export function matchTeamsEcho(line: string): { speaker: string; time: string } | null {
  const m = TEAMS_ECHO_LINE.exec(unescapeMarkdown(line).trim());
  if (!m) return null;
  const name = m[1] ?? '';
  if (!isNameLike(name)) return null;
  const short = m[5];
  return {
    speaker: cleanName(name),
    time: short ? normalizeClock(short) : formatClock(Number(m[2] ?? 0), Number(m[3] ?? 0), Number(m[4] ?? 0)),
  };
}

export function matchBoldName(line: string): string | null {
  const m = BOLD_ONLY.exec(unescapeMarkdown(line).trim());
  if (!m) return null;
  const name = m[1] ?? '';
  return isNameLike(name) ? cleanName(name) : null;
}

/** A WebVTT/SRT cue timing line; returns the normalised start stamp. */
export function matchCueTiming(line: string): string | null {
  const m = CUE_TIMING.exec(line.trim());
  if (!m) return null;
  return formatClock(Number(m[1] ?? 0), Number(m[2] ?? 0), Number(m[3] ?? 0));
}

/** A stamp alone on a line: `12:04`, `[00:12:04]`. */
export function matchBareStamp(line: string): string | null {
  const m = BARE_CLOCK.exec(unescapeMarkdown(line).trim());
  return m?.[1] ? normalizeClock(m[1]) : null;
}

/** Lines that are structure, not speech, and must never be read as a speaker. */
function isBlockMarker(raw: string): boolean {
  if (/^ {4,}|^\t/.test(raw)) return true;
  return /^\s*(?:[|#>]|```|~~~|[-*+]\s|\d+[.)]\s)/.test(raw);
}

export interface SpeakerLine {
  speaker: string;
  time: string | null;
  rest: string;
}

/**
 * Zoom / Meet / Otter shapes: `[00:12:04] Name: text`, `Name  12:04`,
 * `Name (Guest) 0:12 text`, `Name: text`.
 * `known` lets a single-word speaker be recognised once it has been seen with a stamp.
 */
export function matchSpeakerLine(raw: string, known: ReadonlySet<string>): SpeakerLine | null {
  if (isBlockMarker(raw)) return null;
  const line = unescapeMarkdown(raw).trim();
  if (!line) return null;

  const lead = LEADING_CLOCK.exec(line);
  if (lead && isNameLike(lead[2] ?? '')) {
    return { speaker: cleanName(lead[2] ?? ''), time: normalizeClock(lead[1] ?? ''), rest: (lead[3] ?? '').trim() };
  }

  const trail = TRAILING_CLOCK.exec(line);
  if (trail && isNameLike(trail[1] ?? '')) {
    return { speaker: cleanName(trail[1] ?? ''), time: normalizeClock(trail[2] ?? ''), rest: (trail[3] ?? '').trim() };
  }

  const colon = COLON_SPEAKER.exec(line);
  if (colon && isNameLike(colon[1] ?? '')) {
    const name = cleanName(colon[1] ?? '');
    const multiWord = name.split(/[\s,]+/).filter(Boolean).length > 1;
    if (multiWord || known.has(normalizeKey(name))) {
      return { speaker: name, time: null, rest: (colon[2] ?? '').trim() };
    }
  }
  return null;
}

/** Strip WebVTT payload markup, returning the voice-span speaker when present. */
export function stripCueMarkup(line: string): { speaker: string | null; text: string } {
  const voice = VOICE_SPAN.exec(line.trim());
  if (voice) {
    const name = cleanName(voice[1] ?? '');
    const body = (voice[2] ?? '').replace(/<[^>]*>/g, '').trim();
    return { speaker: isNameLike(name) ? name : null, text: body };
  }
  return { speaker: null, text: line.replace(/<\/?[0-9:.]+>|<\/?c[^>]*>|<\/?i>|<\/?b>|<\/?u>|<\/?v[^>]*>/gi, '').trim() };
}

/** First `max` lines without splitting the whole string. */
export function firstLines(text: string, max: number): string[] {
  const out: string[] = [];
  let start = 0;
  while (out.length < max) {
    const nl = text.indexOf('\n', start);
    if (nl === -1) {
      out.push(text.slice(start));
      break;
    }
    out.push(text.slice(start, nl));
    start = nl + 1;
  }
  return out;
}

export interface ParseOptions {
  dropSystem: boolean;
}

/**
 * Walk the document once, emitting one utterance per informative line.
 * Redundant Teams scaffolding (avatar, bold name, stamp line) is folded into the
 * utterance it introduces rather than emitted.
 */
export function parseUtterances(text: string, options: ParseOptions): Utterance[] {
  const lines = text.split('\n');
  const out: Utterance[] = [];
  const known = new Set<string>();
  let pendingSpeaker: string | null = null;
  let pendingTime: string | null = null;
  let lastSpeaker: string | null = null;
  let inNote = false;

  // Body text is unescaped so that mammoth-escaped and plain input converge on the
  // same output, which is what keeps a second tidy pass a no-op.
  const emit = (speaker: string | null, time: string | null, body: string): void => {
    const value = unescapeMarkdown(body).trim();
    if (!value) return;
    if (options.dropSystem && isSystemLine(value)) return;
    out.push({ speaker, time, text: value });
    if (speaker) {
      known.add(normalizeKey(speaker));
      lastSpeaker = speaker;
    }
  };

  for (let i = 0; i < lines.length; i += 1) {
    const raw = lines[i] ?? '';
    const line = raw.trim();
    if (!line) {
      inNote = false;
      continue;
    }
    if (inNote) continue;
    if (/^WEBVTT\b/.test(line)) continue;
    if (/^(?:NOTE|STYLE|REGION)\b/.test(line)) {
      inNote = true;
      continue;
    }
    const cue = matchCueTiming(line);
    if (cue) {
      pendingTime = cue;
      continue;
    }
    // An SRT cue index only counts as noise when a timing line follows it.
    if (/^\d{1,6}$/.test(line) && matchCueTiming((lines[i + 1] ?? '').trim())) continue;
    if (isNoiseLine(line)) continue;
    if (options.dropSystem && isSystemLine(line)) continue;

    const bold = matchBoldName(line);
    if (bold) {
      pendingSpeaker = bold;
      continue;
    }
    const stamp = matchTeamsStamp(line);
    if (stamp) {
      pendingTime = stamp;
      continue;
    }
    const echo = matchTeamsEcho(line);
    if (echo) {
      pendingSpeaker = echo.speaker;
      pendingTime = echo.time;
      continue;
    }
    const bare = matchBareStamp(line);
    if (bare) {
      pendingTime = bare;
      continue;
    }
    const speakerLine = matchSpeakerLine(raw, known);
    if (speakerLine) {
      pendingSpeaker = speakerLine.speaker;
      pendingTime = speakerLine.time ?? pendingTime;
      known.add(normalizeKey(speakerLine.speaker));
      if (speakerLine.rest) {
        emit(pendingSpeaker, pendingTime, speakerLine.rest);
        pendingSpeaker = null;
        pendingTime = null;
      }
      continue;
    }

    const cueText = stripCueMarkup(raw);
    if (cueText.speaker) {
      pendingSpeaker = cueText.speaker;
      known.add(normalizeKey(cueText.speaker));
    }
    const body = cueText.text;
    if (!body) continue;
    if (options.dropSystem && isSystemLine(body)) continue;
    emit(pendingSpeaker ?? lastSpeaker, pendingTime, body);
    pendingSpeaker = null;
    pendingTime = null;
  }

  return out;
}
