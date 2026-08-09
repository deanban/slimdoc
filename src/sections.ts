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
import { computeStats } from './tokens.js';
import { resolveExtractOptions } from './types.js';
import type {
  CleanOptions,
  ExtractOptions,
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
  extractOptions?: Partial<ExtractOptions>,
): CleanedDoc {
  const sections = doc.sections;
  if (sections === undefined || sections.length === 0) {
    const cleaned = clean(doc.text, cleanOptions);
    return { text: cleaned, stats: computeStats(doc.text, cleaned), sections: [] };
  }

  const { sectionHeadings } = resolveExtractOptions(extractOptions);
  const parts: string[] = [];
  const stats: SectionStats[] = [];

  for (const section of sections) {
    const text = clean(bodyOf(section, doc.format, sectionHeadings), cleanOptions);
    if (text === '') continue;
    parts.push(text);
    stats.push({
      index: section.index,
      ...(section.label === undefined ? {} : { label: section.label }),
      chars: text.length,
      tokens: computeStats('', text).tokens.after,
    });
  }

  // Each cleaned section already ends in a newline, so a single joining newline
  // is the blank line between them — and it survives `maxBlankLines: 0`,
  // because it is never inside a section for `limitBlankLines` to squeeze.
  const joined = parts.join('\n');
  return { text: joined, stats: computeStats(doc.text, joined), sections: stats };
}
