/**
 * Page- and slide-structured documents: clean each section, then join.
 *
 * Cleaning the joined document instead would be wrong in two visible ways —
 * `unwrap` merges the last line of one page with the first line of the next,
 * and `collapseSpaces` erases columns that only exist because of coordinates.
 * Running the cleaner inside the loop also makes per-section stats exact and
 * keeps the sections synchronised with the text that was emitted from them.
 */

import { clean } from './clean.js';
import { computeStats, estimateTokens } from './tokens.js';
import { resolveExtractOptions } from './types.js';
import type {
  CleanOptions,
  ExtractOptions,
  ExtractOverrides,
  ExtractedDoc,
  SourceFormat,
  Stats,
} from './types.js';

/** Internal. One page of a PDF or slide of a deck. */
export interface Section {
  /** 1-based, as the source numbers it. */
  index: number;
  /** A slide title; undefined for a PDF page. */
  label?: string;
  text: string;
}

/**
 * `ExtractedDoc` with the structure the extractor found. The public type is
 * left alone and `Section` stays internal: page filtering and serialisation
 * need it, library callers so far do not.
 */
export interface SectionedDoc extends ExtractedDoc {
  sections?: Section[];
  /**
   * The options the extraction actually ran under. Cleaning is where section
   * headings are emitted, so without this a caller had to pass the same options
   * to `extractFromFile` and to `cleanDocument` for either to be honoured — and
   * passing them only to the extractor silently did nothing.
   */
  options?: ExtractOptions;
}

export interface SectionStats {
  index: number;
  label?: string;
  chars: number;
  tokens: number;
}

export interface CleanedDoc {
  text: string;
  stats: Stats;
  /** Empty for a document with no sections. */
  sections: SectionStats[];
}

const SECTION_NOUN: Partial<Record<SourceFormat, string>> = {
  pdf: 'Page',
  pptx: 'Slide',
};

function headingFor(section: Section, format: SourceFormat): string {
  const noun = SECTION_NOUN[format] ?? 'Section';
  const title = section.label === undefined ? '' : ` — ${section.label}`;
  return `## ${noun} ${section.index}${title}`;
}

/**
 * The heading joins its section *before* cleaning, so `--aggressive` strips its
 * hashes like any other heading and `--stats` counts the tokens it costs.
 */
function bodyOf(section: Section, format: SourceFormat, headings: boolean): string {
  return headings ? `${headingFor(section, format)}\n\n${section.text}` : section.text;
}

export function cleanDocument(
  doc: SectionedDoc,
  cleanOptions?: Partial<CleanOptions>,
  extractOptions?: ExtractOverrides,
): CleanedDoc {
  const sections = doc.sections;
  if (sections === undefined || sections.length === 0) {
    const cleaned = clean(doc.text, cleanOptions);
    return { text: cleaned, stats: computeStats(doc.text, cleaned), sections: [] };
  }

  const { sectionHeadings } = resolveExtractOptions(extractOptions ?? doc.options);
  const parts: string[] = [];
  const stats: SectionStats[] = [];

  for (const section of sections) {
    const text = clean(bodyOf(section, doc.format, sectionHeadings), cleanOptions);
    if (text === '') continue;
    // The newline that will join this section to the one before it is counted
    // here, so the per-section figures `--stats` prints add up to the document
    // the user is looking at rather than falling short by one per join.
    const joiner = parts.length === 0 ? 0 : 1;
    parts.push(text);
    stats.push({
      index: section.index,
      ...(section.label === undefined ? {} : { label: section.label }),
      chars: text.length + joiner,
      tokens: estimateTokens(text),
    });
  }

  // Each cleaned section already ends in a newline, so a single joining newline
  // is the blank line between them — and it survives `maxBlankLines: 0`,
  // because it is never inside a section for `limitBlankLines` to squeeze.
  const joined = parts.join('\n');
  return { text: joined, stats: computeStats(doc.text, joined), sections: stats };
}
