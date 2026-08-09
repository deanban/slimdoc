import type { PageRange } from './utils/ranges.js';

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

export type SourceFormat = 'docx' | 'pdf' | 'pptx' | 'markdown' | 'html' | 'rtf' | 'text';

export interface ExtractedDoc {
  text: string;
  format: SourceFormat;
  /** File path, or `<stdin>` / `<clipboard>`. */
  source: string;
  warnings: string[];
}

/**
 * Resource caps. `maxPages` alone is not a guard: it protects neither against a
 * handful of pathological pages carrying millions of text items, nor against a
 * small file that inflates enormously.
 */
export interface Limits {
  /** Reject the file outright above this. */
  maxInputBytes: number;
  /** Total inflated size across every zip entry actually read. */
  maxInflatedBytes: number;
  /** One inflated zip entry. */
  maxEntryBytes: number;
  /** Applied to SELECTED pages, not to document length. */
  maxPages: number;
  /** PDF text items before the page is abandoned. */
  maxItemsPerPage: number;
}

export const DEFAULT_LIMITS: Limits = {
  maxInputBytes: 100_000_000,
  maxInflatedBytes: 200_000_000,
  maxEntryBytes: 50_000_000,
  maxPages: 500,
  maxItemsPerPage: 50_000,
};

/**
 * Decisions about *reading* a document, as opposed to normalising one.
 *
 * Every default derives from one sentence: default output contains visible,
 * non-duplicated textual content in conservative reading order. Hidden content,
 * full chart series, page labels and speculative structure are opt-in.
 */
export interface ExtractOptions {
  /** 1-based inclusive ranges. Empty means all. */
  pages: PageRange[];
  /** `## Page 3` / `## Slide 3 — Title` markers. */
  sectionHeadings: boolean;
  /** PDF: suppress text repeated across most pages. */
  dropRunningHeaders: boolean;
  /** PDF: rejoin `inter-\nnational`. */
  dehyphenate: boolean;
  /** PDF: keep a gridlike region's alignment in a preformatted block. */
  preserveTables: boolean;
  /** PPTX: emit chart `<c:ser>` data as a table. */
  chartData: boolean;
  /** PPTX: emit SmartArt text as a nested list. */
  diagramText: boolean;
  /** PPTX: include slides marked `show="0"` and off-slide shapes. */
  hiddenContent: boolean;
  limits: Limits;
}

export const EXTRACT_DEFAULTS: ExtractOptions = {
  pages: [],
  sectionHeadings: false,   // a slide's title is already in its text; markers duplicate it
  dropRunningHeaders: true, // removes duplication, squarely within the contract
  dehyphenate: false,       // opt-in: corrupts real compounds like `state-of-the-art`
  preserveTables: true,     // preserving alignment asserts no structure, so it is safe
  chartData: false,         // opt-in: a full series can dwarf a ten-token slide
  diagramText: true,        // visible text that is otherwise lost entirely
  hiddenContent: false,     // "visible ... content", per the contract
  limits: DEFAULT_LIMITS,
};

/** What a caller may pass: every field optional, `limits` included field by field. */
export type ExtractOverrides = Partial<Omit<ExtractOptions, 'limits'>> & { limits?: Partial<Limits> };

export function resolveExtractOptions(options: ExtractOverrides = {}): ExtractOptions {
  return {
    ...EXTRACT_DEFAULTS,
    ...options,
    limits: { ...DEFAULT_LIMITS, ...options.limits },
  };
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
