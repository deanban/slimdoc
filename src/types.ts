export type Preset = 'safe' | 'balanced' | 'aggressive';

export interface CleanOptions {
  preset: Preset;
  /** Unicode NFKC normalisation: folds ligatures, fullwidth forms, superscripts. */
  normalizeUnicode: boolean;
  /** BOM, zero-width chars, soft hyphens, stray control characters. */
  stripInvisible: boolean;
  /** Smart quotes, em/en dashes, ellipses and friends folded to ASCII. */
  asciiPunctuation: boolean;
  stripEmoji: boolean;
  tabsToSpaces: boolean;
  /** Runs of spaces collapse to one (leading indentation is preserved). */
  collapseSpaces: boolean;
  /** Strip trailing whitespace from every line. */
  trimLines: boolean;
  /** Maximum consecutive blank lines to keep. 0 means paragraphs sit on adjacent lines. */
  maxBlankLines: number;
  /** Join hard-wrapped lines back into single paragraph lines. */
  unwrap: boolean;
  /** Never rewrite anything inside fenced, indented or inline code. */
  preserveCode: boolean;
  /** Drop emphasis markers, link URLs and heading hashes, keeping the words. */
  stripMarkdown: boolean;
  /** Collapse padding inside Markdown table cells. */
  compactTables: boolean;
  /** Remove pointless backslash escapes (`AI\-generated` -> `AI-generated`). */
  unescapeMarkdown: boolean;
  /** Drop images, avatars, data: URIs and orphaned base64 blobs. */
  stripMedia: boolean;
  /** Run the meeting-transcript tidy pass. */
  transcript: boolean;
}

export const PRESETS: Record<Preset, CleanOptions> = {
  safe: {
    preset: 'safe',
    normalizeUnicode: false,
    stripInvisible: true,
    asciiPunctuation: false,
    stripEmoji: false,
    tabsToSpaces: true,
    collapseSpaces: true,
    trimLines: true,
    maxBlankLines: 2,
    unwrap: false,
    preserveCode: true,
    stripMarkdown: false,
    compactTables: false,
    unescapeMarkdown: false,
    stripMedia: true,
    transcript: false,
  },
  balanced: {
    preset: 'balanced',
    normalizeUnicode: true,
    stripInvisible: true,
    asciiPunctuation: true,
    stripEmoji: false,
    tabsToSpaces: true,
    collapseSpaces: true,
    trimLines: true,
    maxBlankLines: 1,
    unwrap: true,
    preserveCode: true,
    stripMarkdown: false,
    compactTables: true,
    unescapeMarkdown: true,
    stripMedia: true,
    transcript: false,
  },
  aggressive: {
    preset: 'aggressive',
    normalizeUnicode: true,
    stripInvisible: true,
    asciiPunctuation: true,
    stripEmoji: true,
    tabsToSpaces: true,
    collapseSpaces: true,
    trimLines: true,
    maxBlankLines: 0,
    unwrap: true,
    preserveCode: true,
    stripMarkdown: true,
    compactTables: true,
    unescapeMarkdown: true,
    stripMedia: true,
    transcript: false,
  },
};

/** Merge partial user options over the preset they select. */
export function resolveOptions(options: Partial<CleanOptions> = {}): CleanOptions {
  return { ...PRESETS[options.preset ?? 'balanced'], ...options };
}

export type SourceFormat = 'docx' | 'markdown' | 'html' | 'rtf' | 'text';

export interface ExtractedDoc {
  text: string;
  format: SourceFormat;
  /** File path, or `<stdin>` / `<clipboard>`. */
  source: string;
  warnings: string[];
}

export interface Stats {
  chars: { before: number; after: number };
  bytes: { before: number; after: number };
  lines: { before: number; after: number };
  /** Heuristic estimates, not a real tokenizer. */
  tokens: { before: number; after: number };
  /** Reduction by token estimate, 0-100, one decimal place. */
  savedPct: number;
}

export interface TranscriptOptions {
  mergeConsecutive: boolean;
  dropTimestamps: boolean;
  keepFirstTimestamp: boolean;
  dropSystemLines: boolean;
  shortenNames: boolean;
}

export const TRANSCRIPT_DEFAULTS: TranscriptOptions = {
  mergeConsecutive: true,
  dropTimestamps: true,
  keepFirstTimestamp: true,
  dropSystemLines: true,
  shortenNames: true,
};
