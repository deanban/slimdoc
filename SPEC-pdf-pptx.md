# slimdoc — PDF and presentation support (design + plan)

> Companion to `SPEC.md`. Same rules apply: shared signatures are a contract.
> Revision 2, after adversarial review. This document adds two source formats
> (`pdf`, `pptx`), fixes one pre-existing bug (docx tables), and changes two lines of
> `SPEC.md` — the dependency rule and the Node floor.

## What shipped, and where it differs from this document

All seven phases are implemented. Three decisions were taken differently, each
deliberately:

**Phase 4 is the fenced fallback only.** No coordinate clustering, no confidence gate,
no pipe tables reconstructed from a PDF. A run of three or more rows that line up is
preserved verbatim in a fenced block; that is the whole of it. The gate was the design's
largest correctness risk for a benefit the corpus does not demonstrate — a malformed
pipe table asserts a structure that is not in the file, and the fenced block asserts
nothing while preserving the same information. If the gate is built later it upgrades
what the existing flag emits.

**`ExtractOptions.inferTables` is named `preserveTables`**, because preserving alignment
is what it now does. `--no-tables` is unchanged.

**`Section` is exposed on `SectionedDoc`, an internal supertype of `ExtractedDoc`.**
`ExtractedDoc` itself is untouched and `Section` is not exported from the package root,
so the "internal for now" decision holds. `cleanDocument` *is* exported, because a
library caller reaching for `clean()` on a paged document would otherwise silently lose
the section boundary the CLI gets for free.

Two smaller notes. `src/cli.ts` was split into `cli.ts`, `cli-options.ts` and
`cli-report.ts` before the new flags landed, since it was already over this project's
400-line file limit. And the acceptance corpus is the generated `kitchen-sink.*`
fixtures plus ad-hoc runs against real PDFs on the author's machine; the real-world
corpus this document asks for — an exported deck, an academic paper, an OCR'd document,
a third-party-generated PPTX — has not been assembled, so the quality claims rest on
narrower evidence than intended. Running against real files was not wasted: it is what
found the subscript-ordering and split-word bugs that the fixtures did not.

## The shape of the problem

The two formats look similar from the CLI and are nothing alike underneath.

**PPTX is structured.** It is OOXML: a zip of XML where tables are `<a:tbl>`, charts
carry their real `<c:ser>` data, and diagram text sits in `diagrams/data1.xml`. Little
needs inferring — but reading order, visibility and inherited properties still do.

**PDF is inference.** A PDF has no table semantics, no paragraphs, no reading order —
only glyph runs at coordinates. Every structure slimdoc emits from a PDF is
reconstructed and can be wrong. That asymmetry drives most of the decisions below.

## The default output contract

`SPEC.md` promises "meaning fully preserved". That is not achievable for image-heavy
PDFs and presentations, and pretending otherwise produces bad defaults. The narrower,
honest contract:

> **Default output contains visible, non-duplicated textual content in conservative
> reading order. Hidden content, speaker notes, full chart series, page labels, and
> speculative structure are opt-in.**

Every default in `ExtractOptions` below derives from that sentence, and it is the tie
breaker for questions this document does not anticipate.

### Decisions taken

| Decision | Choice |
|---|---|
| PDF engine | `unpdf`, lazy-imported |
| Node floor | **Raised to `>=22`** |
| OOXML reading | Hand-rolled bounded ZIP reader + `saxes` (namespace-aware) |
| PDF tables | Coordinate clustering behind a confidence gate (Phase 4) |
| Failed table gate | Fenced preformatted block, sanitized first |
| Scanned PDFs | Per-page markers; refuse only if *every* selected page is textless |
| PPTX extras | Chart data (opt-in), SmartArt text, per-section stats |
| Sections | **Internal** for now, not public API |
| Speaker notes | Out of scope (see Deferred) |
| Tables and code | One shared output contract, fixed in Phase 0 before new formats |

## Table and code output contracts

Three shipping formats mangle tables, each in a different way, and the HTML path mangles
code. None of this is work created by PDF and PPTX — it is a pre-existing defect that
the new formats would otherwise inherit and multiply. Phase 0 fixes it once and defines
the contract every later extractor reuses.

### What the three formats do today

Verified reproductions against the shipped code, using a 4×3 table:

| Format | What comes out |
|---|---|
| docx | Every cell becomes its own paragraph — 12 orphan blocks, no pipe table at all (mammoth's Markdown writer) |
| html | Cells joined by ` \| ` with no pipes at the row edges, no separator row, and a blank line between every row |
| rtf | `\cell` becomes a tab, and then `tabsToSpaces` + `collapseSpaces` in the cleaner erase the columns entirely |

The RTF case is the sharpest illustration of the wider problem: the extractor *does*
emit structure and the cleaner then destroys it — the same disagreement between
extraction and cleaning that motivates per-section cleaning below.

### Table contract

Every extractor that recognises a table emits GitHub-flavoured Markdown:

- Leading and trailing `|` on every row, and a `| --- |` separator row after the header.
- **No blank lines between rows** — a blank line terminates the table.
- A `|` inside a cell is escaped as `\|`; newlines inside a cell collapse to a space.
  (This document's own table above needed that escape, which is the point.)
- Merged cells are **best-effort flattened**, since Markdown has no rowspan or colspan:
  a horizontally merged cell repeats across the spanned columns, a vertically merged
  cell repeats down the spanned rows, and the document warns `N merged cells flattened`.
- A table with one column, or with no cells, is emitted as plain lines instead.
- A table with no header row has its **first row promoted** to the header. GFM has no
  headerless table, and the alternative — synthesising a blank header — spends tokens on
  nothing while still hiding the real header. Word emits no `<th>` at all and RTF has no
  header concept, so the headerless case is the common one, not the exception.
- A table nested inside a cell is **flattened to its words**. Pipes are escaped on the
  way in, so restoring a rendered inner table spells the cell
  `\| Enterprise \| NCC-1701 \| \| --- \| --- \|` — every byte of the grid and none of
  its meaning. A layout table (one cell wrapping a data table, the shape every Outlook
  mail is built from) degrades to plain lines instead, and there the inner table keeps
  its Markdown.
- A table is separated from its neighbours by a **blank line on either side**, and that
  blank survives every preset. It is part of the contract, not formatting: see below.

Verified to survive `clean.ts`: pipe tables pass through `unwrap` intact, because
`canJoin` refuses to join across `isTableRow` — including a table that directly follows
a paragraph with no blank line between them.

That check is necessary and **not sufficient**, which an earlier revision of this
document got wrong. It tests that the pipes and the separator row survive; it does not
test the table's *boundary*. At `maxBlankLines: 0` (the `aggressive` preset)
`limitBlankLines` used to strip the blank line after a table, and since a GFM table body
runs until a blank line or a block-level structure — and a bare paragraph line is
neither — the following paragraph was silently absorbed as one more row. Pipes intact,
meaning destroyed. Blank lines at a table boundary are therefore preserved at every
preset, including `maxBlankLines: 0`, and `clean()` stays idempotent with them.

### Code contract

- **Fence length is computed, not fixed:** `max(3, longest backtick run inside + 1)`.
  This is a verified bug in shipping code — a `<pre>` containing a Markdown example
  emits a three-backtick fence around content that itself contains three backticks,
  producing broken nesting. The same helper serves the PDF table fallback in Phase 4.
- **Emit a language identifier when the source supplies one** (`class="language-js"`,
  `data-lang`, an `hljs-` variant). One token, and it materially helps a model. HTML
  currently has this information and discards it.
- **Indentation is never collapsed.** Code outside `<pre>` currently loses it silently:
  `def broken(x):` / `    return x + 1` emits with the indent gone, which is not
  degraded formatting but semantically destroyed Python. Containers matching
  `/(^|[-_ ])(code|highlight|snippet|sourcecode|codeblock)([-_ ]|$)/i`, and `<code>`
  elements containing a line break, are protected from whitespace collapsing and fenced.
- **Inline `<code>` keeps its backticks** — cheap, and it separates identifiers from prose.
- **Code embeds leave a trace.** A gist or CodePen `<iframe>` is currently dropped whole,
  leaving a dangling "Full source on GitHub:" with nothing after it. Emit
  `[embedded: <url>]`. For a gist the code genuinely is not in the HTML — it is fetched
  by script — so the URL is the most any extractor can recover.

One interaction that already works and must not regress: `DROP_WITH_CONTENT` deletes
`<script>` and `<style>` *before* `<pre>` blocks are parked, but a correctly-escaped code
sample is `&lt;script&gt;` in the source and does not match. So a tutorial *about*
JavaScript keeps its examples while the page's own tracking scripts still vanish.
Verified, including under `--aggressive`, since `preserveCode` is on in every preset.

**Detection asymmetry, stated deliberately** because it runs opposite to the table gate:
a wrongly-fenced paragraph costs a few tokens and is visible, while silently collapsed
indentation is invisible and corrupting. Code detection therefore leans toward
protecting whitespace when a container looks code-ish, whereas table detection leans
toward refusing when the grid is not convincing.

## Runtime and dependencies

### The Node floor must rise

Verified: published `unpdf@1.8.0` declares `engines: { "node": ">=22" }`. slimdoc
declares `>=18.17`. That is a hard conflict, and the two obvious escapes are both dead
ends:

- **Pinning an older unpdf** — versions ≤1.7.0 carry *no* `engines` field at all, which
  is the absence of a compatibility claim rather than the presence of one. It also
  freezes the package permanently.
- **A different PDF engine** — `pdfjs-dist` requires `>=22.13.0 || >=24`. The maintained
  pdf.js ecosystem has moved past Node 18 and 20 entirely.

Independently of PDFs: **Node 18 reached EOL on 2025-04-30 and Node 20 on 2026-04-30.**
slimdoc's current `engines` field advertises support for two end-of-life runtimes.

So `SPEC.md`'s `Runtime: Node >= 18.17` becomes **`Node >= 22`**. This is a breaking
change to the package and warrants a minor version bump and a README note.

### The dependency rule

`SPEC.md` states:

> Dependencies: **only** `mammoth` (docx). Everything else uses the Node stdlib.

This becomes:

> Dependencies: `mammoth` (docx), `unpdf` (pdf) and `saxes` (OOXML), each imported
> lazily so a run that touches none of those formats loads none of them. The ZIP
> container reader is stdlib.

The rule is kept where it can be kept honestly, and relaxed where hand-rolling would be
false economy. The split, and the reasoning for each half:

**Keep hand-rolled: the ZIP reader.** ~150 lines against a stable, well-documented
container. The scary-sounding surface mostly does not apply to a read-only reader: we
never *write* archives (no CRC generation), OOXML part names are ASCII by ECMA-376 (no
filename-encoding problem), and ZIP64 is detect-and-refuse rather than implement.

**Take a real parser: the XML.** `extract-html.ts` is deliberately a tolerant rewriter
because pasted Outlook fragments are malformed. That precedent does **not** transfer to
a structured XML package. Namespace prefixes are conventional, not guaranteed — `a:`,
`p:`, `r:` are what PowerPoint emits, but ECMA-376 permits any prefix, and third-party
generators (Google Slides, Keynote export, python-pptx) do vary. `mc:AlternateContent`
needs real handling. A tag scanner here would be a correctness trap.

`saxes` is 164 KB with one small dependency, namespace-aware by design (`xmlns: true`),
and streaming — so it composes with the byte caps below. For comparison,
`fast-xml-parser` is 1.28 MB across five transitive dependencies, and `@xmldom/xmldom`
builds a full DOM in memory, which fights the caps.

Lazy import matters for the CLI's feel, and for `npx` cold start specifically — `npx
slimdoc file.docx` is the headline entry point in the README. A Markdown or text run
must load none of the three.

## Architecture

### Data flow — clean per section, then join

The v1 claim that "`clean.ts` is unchanged and extraction just feeds it text" was
**false**, and demonstrably so:

```
"Region    Q1     Q2\nEMEA      4.2    5.1"  ->  "Region Q1 Q2\nEMEA 4.2 5.1"
"Revenue grew\nMarketing spend fell"          ->  "Revenue grew Marketing spend fell"
```

`collapseSpaces` destroys coordinate-derived columns, and `unwrap` merges what were two
independent text boxes. Cleaning is therefore moved *inside* the section loop:

```
  bytes ──> detectFormat ──> dispatch ──> Section[]        (raw, per page/slide)
                                              │
                              document-level passes        (running headers — needs
                                              │             cross-page visibility)
                                              ▼
                                   clean() each section    (independently)
                                              │
                                              ▼
                                    join with delimiters
                                              │
                                    ExtractedDoc { text }
```

This single change buys four things:

- `unwrap` can no longer merge across a page or slide boundary.
- Per-section stats become exact, because each section is cleaned in isolation.
- Sections stay synchronised with the emitted text, removing the inconsistency that
  made a public `sections` field unsafe.
- Page filtering is natural — it is a filter on the array before the loop.

Two details this makes load-bearing:

- **Running-header detection stays a document-level pass before cleaning**, since it
  needs to compare across pages while positions are still known.
- **Section headings and join delimiters count toward final output stats.** They are
  tokens the user pays for.

Within a section, adjacent shapes are serialised **separated by a blank line**, which is
what stops `unwrap` from gluing two text boxes together — `canJoin` already refuses to
join across a blank line.

### Types (`src/types.ts`)

```ts
export type SourceFormat = 'docx' | 'pdf' | 'pptx' | 'markdown' | 'html' | 'rtf' | 'text';
```

`ExtractedDoc` is **unchanged**. `Section` stays internal to the extractors and
`sections.ts`; it is enough to implement page filtering and serialisation without being
public API. It is exposed only if a concrete library-user requirement appears.

```ts
/** Internal. One page of a PDF or slide of a deck. */
interface Section {
  index: number;      // 1-based, as the source numbers it
  label?: string;     // slide title; undefined for a PDF page
  text: string;
}
```

Extraction gets its own options object — these are decisions about *reading* a
document, not normalising one — and every default is derived from the contract above:

```ts
export interface ExtractOptions {
  /** 1-based inclusive ranges. Empty means all.                        */ pages: Array<[number, number]>;
  /** `## Page 3` / `## Slide 3 — Title` markers.                       */ sectionHeadings: boolean;
  /** PDF: suppress text repeated across most pages.                    */ dropRunningHeaders: boolean;
  /** PDF: rejoin `inter-\nnational`.                                   */ dehyphenate: boolean;
  /** PDF: reconstruct confidently-gridlike tables.                     */ inferTables: boolean;
  /** PPTX: emit chart `<c:ser>` data as a table.                       */ chartData: boolean;
  /** PPTX: emit SmartArt text as a nested list.                        */ diagramText: boolean;
  /** PPTX: include slides marked `show="0"` and off-slide shapes.      */ hiddenContent: boolean;
  /** Resource caps — see below.                                        */ limits: Limits;
}

export const EXTRACT_DEFAULTS: ExtractOptions = {
  pages: [],
  sectionHeadings: false,   // a slide's title is already in its text; markers duplicate it
  dropRunningHeaders: true, // removes duplication — squarely within the contract
  dehyphenate: false,       // opt-in: corrupts real compounds like `state-of-the-art`
  inferTables: true,        // the confidence gate is what makes this non-speculative
  chartData: false,         // opt-in: a full series can dwarf a ten-token slide
  diagramText: true,        // visible text that is otherwise lost entirely
  hiddenContent: false,     // "visible ... content" per the contract
  limits: DEFAULT_LIMITS,
};
```

`sectionHeadings: false` is the one default worth revisiting against the real-world
corpus. It follows the contract — page labels are opt-in, and `## Slide 3 — Title`
duplicates a title already present in the slide's own text — but slide boundaries do
carry meaning for an LLM. Sections are always separated by a blank line regardless.

**Signature compatibility.** `SPEC.md` forbids changing shared signatures, so the entry
points extend rather than change, and both remain callable exactly as today:

```ts
extractFromBuffer(buf: Buffer, hint?: { filename?: string; extract?: Partial<ExtractOptions> })
extractFromFile(path: string, options?: Partial<ExtractOptions>)
```

### Resource limits

`maxPages` alone is not a guard. It does not protect against a handful of pathological
pages with millions of text items, a small file that inflates enormously, or a
2,000-page PDF when the user asked for pages 1–3.

```ts
interface Limits {
  maxInputBytes: number;      // reject the file outright above this
  maxInflatedBytes: number;   // total across all read zip entries
  maxEntryBytes: number;      // one inflated zip entry
  maxPages: number;           // applied to SELECTED pages, not document length
  maxItemsPerPage: number;    // PDF text items before bailing on a page
}
```

The page cap applies to **selected** pages, so `--pages 1-3` of a 2,000-page document
processes three pages. PDF pages are processed sequentially rather than fanned out —
unpdf's own guidance is that whole-document extraction fans across every page and that
resource limits remain the caller's responsibility.

### Module layout

```
src/zip.ts             bounded ZIP reader (central dir + inflateRaw)     new, stdlib
src/ooxml.ts           saxes wrapper: namespaced walk, rels resolution   new
src/extract-pptx.ts    slides, tables, charts, SmartArt                  new
src/extract-pdf.ts     unpdf -> positioned items -> Section[]            new
src/pdf-layout.ts      lines, tables, headers                            new
src/sections.ts        page filtering, per-section clean, join           new
src/extract.ts         detection + dispatch + refusals                   edit
src/types.ts           SourceFormat, ExtractOptions, Limits              edit
src/cli.ts             flags, refusals, output names, per-section stats  edit
src/tokens.ts          section-level stats                               edit
```

### `src/zip.ts`

```ts
/** Entry name -> lazy inflater. Nothing is decompressed until asked for. */
export function readZipEntries(buf: Buffer, limits: Limits): Map<string, () => Buffer>
```

Laziness is the point, and mirrors the `convertImage` trick that `extract.ts` already
calls "THE critical line": a 40-image deck must never inflate a single PNG.

- Locate the EOCD record (`0x06054b50`) scanning backwards, bounded by the 64 KB max
  comment length; walk central-directory entries (`0x02014b50`); read each local header
  (`0x04034b50`) for the true data offset, whose name/extra lengths differ from the
  central record's.
- Methods 0 (stored) and 8 (deflate) only; anything else is a named error.
- Detect the ZIP64 locator (`0x07064b50`) and refuse clearly rather than truncating.
- Enforce `maxEntryBytes` / `maxInflatedBytes` and refuse absurd compression ratios.
  slimdoc reads untrusted files by design. Duplicate entry names: last wins. There is
  no path-traversal risk — entries are read by name, never written to disk.

### `src/extract-pptx.ts`

**Slide order** comes from `ppt/presentation.xml` `<p:sldIdLst>`, resolved through
`ppt/_rels/presentation.xml.rels`. Never trust the numeric order of `slide1.xml` —
reordering and deletion leave gaps and permutations.

**Layouts must be read, but not emitted.** This corrects a v1 error. Placeholder types
and bullet levels are frequently *inherited* from `slideLayout`/`slideMaster`, so
ignoring those parts makes "title and body first" unreliable. The rule is therefore:
read layout parts for **metadata resolution**, and do not emit their **text**. Footers,
slide numbers and "Click to add title" prompts stay out for free; genuinely visible
master text is the known trade, and is why `hiddenContent` exists as an escape hatch.

**Reading order** is not z-order — `<p:spTree>` is a paint list. Resolve placeholders by
type (`ctrTitle`/`title`, then `subTitle`/`body`), then sort remaining shapes by
composed position. `<p:grpSp>` requires composing the group transform (`<a:xfrm>` child
offset, extent scaling, rotation, flips), not just reading child offsets.

**Visibility.** Skip slides marked `show="0"` — or `show="false"`, since `ST_Boolean`
is `1`/`0` *and* `true`/`false` and only Microsoft's writer picks the digits — shapes
with `<a:bodyPr>`-less empty placeholders, and shapes positioned entirely outside the
slide bounds, unless `hiddenContent` is set. Microsoft documents notes, invisible objects and off-slide text
as hidden-content categories; extracting them by default would violate the contract.

**Text**: `<a:p>` paragraphs of `<a:t>` runs; `<a:br>` is a newline; `<a:pPr lvl="n">`
gives bullet depth. `<a:fld>` auto-numbers and dates are dropped. Shapes are separated
by a blank line.

**Whether a paragraph is a list item** is a resolution, not an attribute. PowerPoint
writes no bullet on the paragraph: it comes from the shape's own `<a:lstStyle>`, then
the layout placeholder's (matched by `idx`, else by type), then the master's
`<p:txStyles>` — `titleStyle` for a title placeholder, `bodyStyle` for a body one,
`otherStyle` for a shape that is not a placeholder. The first level to carry `buChar`,
`buAutoNum` or `buNone` decides, `buNone` included. Both directions are load-bearing:
reading only the paragraph finds no list in a deck that is all lists, and inheriting
without asking *which* style applies bullets every caption and title on a deck whose
text sits in plain text boxes — which is what tool-exported decks are made of.

**Tables** are `<a:tbl>` → `<a:tr>`/`<a:tc>`. This is **best-effort flattening, not
lossless** — Markdown has no rowspan or colspan. The stated policy: a horizontally
merged cell (`gridSpan`/`hMerge`) repeats its value across the spanned columns; a
vertically merged cell (`rowSpan`/`vMerge`) repeats down the spanned rows; and the
document warns `N merged cells flattened` so the user knows an association was
approximated.

**Charts** (writing by default, numbers opt-in): `<p:graphicFrame>` → `<c:chart r:id>` →
`charts/chartN.xml`. The split follows the default output contract exactly: a chart's
title, axis titles, category names and series names are *visible text on the slide* and
are emitted by default; only the series values are gated behind `--chart-data`, which is
what "full chart series … are opt-in" means. Gating the part itself extracts a slide
that is a heading and a chart as a heading.

Scope is deliberately narrow: **category/value charts only** (`<c:cat>` + `<c:val>`).
Scatter, bubble and multi-level category charts use different structures and are skipped
with a warning rather than misread. Chart caches can be stale or the data externally
linked (`<c:extLst>`); emit what is cached and say so. Cap series and points — and bound
`<c:pt idx>` *before* it reaches an array, since it is a number the file chooses.

**SmartArt**: `<dgm:relIds>` → `diagrams/dataN.xml`. `<dgm:pt>` carries text;
`<dgm:cxn type="parentOf">` gives hierarchy. Skip `type="pres"` points — layout
scaffolding, not content. Ordering needs more than following `parentOf`, so where the
order is ambiguous, fall back to document order rather than inventing a tree.

**Images**: `<p:cNvPr descr=…>` feeds the existing `meaningfulAlt` from
`extract-html.ts`, which already filters the junk auto-generated descriptions
PowerPoint produces.

### `src/extract-pdf.ts` + `src/pdf-layout.ts`

```
unpdf -> per page (sequential) -> text items with coordinates
      -> group into lines by y      tolerance ≈ 0.5 × median glyph height
      -> sort each line by x, insert spaces on gaps
      -> sanitize items (see below)
      -> [Phase 4] table gate
      -> Section per page
      -> document pass: running-header suppression
```

unpdf exposes both `extractTextItems()` and the lower-level `getDocumentProxy()` →
`page.getTextContent()`. **Both retain coordinates** — a v1 claim to the contrary was
wrong. The low-level path is chosen for a different reason: it allows processing only
the *selected* pages, sequentially, under `maxItemsPerPage`, instead of fanning out
across the whole document.

**No image counting.** A v1 error: `getTextContent()` returns neither images nor
structure-tree `/Alt` content, so counting them requires `getOperatorList()` — real work
and real memory. Dropped from scope. Pages with no extractable text are simply reported.

**Mixed scanned documents.** An image-only cover, advertisement or diagram page must not
fail the whole document. Emit `[page 7: no extractable text]`, warn, and **refuse only
when every selected page is textless** — that is when the `ocrmypdf` hint is genuinely
the right advice. Invisible text (`Tr 3`) is kept, since it is the OCR layer under a
scanned page; a consequence worth stating is that an OCR'd scan correctly does not trip
the refusal.

**Running headers and footers** are the biggest token win in a PDF, but v1's rule —
normalise every digit, then drop anything appearing on ≥60% of pages — would collapse
meaningful text like annual headings, section numbers and dates. The safer rule:

- Match on **approximate position plus near-exact text**, not normalised digits.
- Recognise page-counter patterns (`Page 4 of 20`, a bare numeral) **specifically**.
- **Keep the first occurrence** and suppress only later duplicates. One copy carries
  the semantic context at negligible token cost.
- Never suppress a candidate inside a detected table region.
- Disabled below 4 pages — too little evidence.

**Table inference (Phase 4) and its gate.** A malformed pipe table is *worse* than plain
text: it asserts a wrong structure and lands numbers under the wrong header. So:

- Candidate: ≥3 consecutive lines each holding ≥2 gap-separated items.
- Cluster left edges into X bands; require ≥2 bands agreeing within tolerance on ≥80%
  of rows, and consistent cell counts (one header row may deviate).
- Never emit a single-column table; escape any `|` inside a cell.
- Column detection and table detection **compete** — a wide table can look like two
  columns. Table detection runs first; column splitting only applies to regions it
  rejected.

**Gate fails → fenced preformatted block.** Verified: `preserveCode` preserves fenced
content verbatim, so alignment survives cleaning. Three requirements, all necessary:

- Choose a fence **longer than any backtick run inside the block**. Verified failure:
  a table containing ` ```x``` ` inside a ``` fence produces broken nesting.
- No language identifier.
- Warn: `possible table preserved as preformatted text; columns may be approximate`.

**Sanitize before fencing.** Fenced content also bypasses the cleaning slimdoc exists to
do. Verified:

```
OUTSIDE fence: "first \"quoted\" em-dash softhyphen zerowidth"
INSIDE  fence: "ﬁrst  “quoted”  em—dash  soft­hyphen  zero​width"
```

Ligatures, smart quotes, soft hyphens and zero-width characters all survive. The PDF
extractor therefore applies a minimal sanitize (NFKC, invisible-character stripping) to
**all** text items at extraction — simpler than special-casing fenced regions, and
harmless elsewhere since `clean.ts` would do the same. This needs a small shared helper;
`clean.ts` currently performs NFKC inline at `src/clean.ts:85` and exports nothing
reusable.

**Dehyphenation is opt-in and off by default.** `inter-\nnational` should rejoin;
`state-\nof-the-art` must not. Without a dictionary this cannot be done safely, so it
stays a flag until the corpus shows a rule that works.

### Detection and CLI

```ts
looksLikePptx(buf)   // zip containing 'ppt/presentation.xml'
looksLikeXlsx(buf)   // zip containing 'xl/workbook.xml' -> named refusal
```

- `%PDF` is currently matched with `startsWith`, but the spec permits leading junk.
  Scan the first 1 KB.
- The OLE2 refusal must become format-aware: a legacy `.ppt` is currently told to
  "re-save as .docx".
- `SUPPORTED_EXTENSIONS` gains `.pdf`, `.pptx`, `.pptm`, `.potx`.
- `outputName()` rewritten-extension list gains the same; `NOT_A_TEXT_TARGET` gains
  `.pptx`, `.ppt`, `.key`, `.odp`, `.xlsx`.
- `refusesInPlace()` needs **no change** — it already refuses anything that is not
  `text` or `markdown`.

```
Documents
      --pages <range>         3-7,12 — pages (PDF) or slides (PPTX)
      --section-headings      emit `## Page 3` / `## Slide 3 — Title` markers
      --chart-data            add PPTX chart series numbers as tables
      --hidden                include hidden slides and off-slide text
      --dehyphenate           rejoin words split across PDF line breaks
      --no-tables             skip PDF table inference
      --no-diagram-text       skip SmartArt
      --max-pages <n>
```

`--stats` prints a per-section line when the document has sections, counting headings
and delimiters.

## Testing

**Generated fixtures are necessary but not sufficient.** A hand-written generator only
proves the parser recognises its own output — circular for anything involving reading
order. They stay, for deterministic unit coverage of specific structures, following the
`make-docx.py` precedent (stdlib only, fixed zip timestamps, byte-identical reruns):

- `make-pptx.py` — nested bullets; a merged-cell table; a category chart; a SmartArt
  hierarchy; junk auto-alt; a grouped shape with a non-identity transform; permuted
  slide IDs; a hidden slide; an off-slide text box; master text that must not appear.
- `make-pdf.py` — plain paragraphs; hyphenated breaks; a gridlike table; a deliberately
  non-gridlike pseudo-table that must fall back and warn; repeated headers across 6
  pages; two columns; an image-only page among text pages; Identity-H CID text.

**Phase 0 contract regressions** need fixtures in all three existing formats: the docx
table that currently becomes 12 paragraphs, the HTML table missing its pipes and
separator row, the RTF table whose columns the cleaner erases, a `<pre>` containing a
three-backtick run, a code block outside `<pre>` with meaningful indentation, an inline
`<code>`, and a gist `<iframe>`. Each asserts the emitted Markdown **after** cleaning —
three of these bugs are invisible at the extraction boundary and only appear once
`clean.ts` has run.

**A real-world acceptance corpus carries the quality claims.** Exported deck, academic
paper, invoice, two-column report, OCR'd document, chart-heavy deck, and a
third-party-generated PPTX (Google Slides or Keynote export, to exercise namespace
prefixes). Measured per document:

| Metric | Why |
|---|---|
| Final output tokens **after cleaning** | The thing slimdoc optimises |
| Duplicated visible text | Catches header/master/heading regressions |
| Missing visible text | Catches over-aggressive suppression |
| Reading-order errors | The metric generated fixtures cannot produce |
| Runtime and peak memory | Validates the caps |
| `pdftotext` baseline comparison | Are we beating the thing the README currently recommends? |

Use a real tokenizer for benchmarks; it need not become a runtime dependency.

**Every fixture is asserted through the full `extract → per-section clean → join`
pipeline**, not extraction alone. That is the specific failure v1 shipped.

## Plan

| # | Phase | Delivers | Risk |
|---|---|---|---|
| 0 | **Output contracts** | Fix tables in docx/HTML/RTF and code in HTML; establish the two contracts every later extractor reuses | low |
| 1 | **Foundations** | `zip.ts`, `ooxml.ts`, `sections.ts` + per-section cleaning, `ExtractOptions`, detection and improved refusals, Node bump | low |
| 2 | **PPTX core** | Slide order, layout metadata resolution, visible slide-local text, bullets, tables, alt text | medium |
| 3 | **PDF core** | Lazy `unpdf`, sequential selected pages, conservative lines, position-aware header suppression, mixed-scan handling | **high** |
| 4 | **PDF tables** | Confidence gate, fenced fallback, `--pages` | **high** |
| 5 | **PPTX extras** | Chart data (opt-in), SmartArt, per-section stats | medium |
| 6 | **Docs** | README, `SPEC.md` amendments, help text | low |

**Phase 0 comes first and is worth shipping on its own.** slimdoc today mangles tables in
all three formats it already supports, and mangles code in one of them — a `.docx` table
becomes 12 orphan paragraphs, an HTML table loses its pipes and separator row, an RTF
table's columns are erased by the cleaner, and a blog post's Python loses its
indentation silently. Every one of those defects costs *more* tokens while destroying
meaning, which is precisely backwards for this tool.

Doing it first also stops the bleeding: PPTX tables, PDF table inference and the PDF
fenced fallback would otherwise each invent their own answer to the same questions.
After Phase 0 they inherit merge policy, pipe escaping, header handling and safe fence
computation rather than reinventing them.

Phase 3 is where the schedule risk lives; reading-order reconstruction is where PDF
extractors are won or lost, and it should begin with a spike against the real corpus
before heuristics are tuned. Phase 4 is high-risk inference and is the most likely
candidate to be cut if the corpus does not show it earning its keep. Phases 2 and 5 are
medium, not low — layout inheritance, group transforms and chart-type variety are real.

## Deferred

- **Speaker notes** (`notesSlides/`). Near-zero parsing cost once slides are read, but
  they are hidden content by Microsoft's own definition and often the bulk of a deck's
  tokens, so they would ship as `--notes`, off by default.
- **Ruling-line-aware PDF tables** via `getOperatorList()` stroke geometry.
- **OCR fallback** — non-deterministic across machines, and slow.
- **Rich clipboard paste** (`--rich`). Verified: `pbpaste` offers `-Prefer {txt|rtf|ps}`
  and **no HTML flavour**, so copying a web page in a browser reaches slimdoc as
  pre-flattened plain text and never exercises the HTML extractor at all. RTF is
  frequently on the pasteboard and slimdoc already has an RTF extractor, so
  `pbpaste -Prefer rtf` could make "copy a page, get clean text" work end to end. Needs
  testing across browsers before it is promised.
- **Content extraction** (readability). slimdoc strips markup and media but keeps all
  boilerplate text — nav, cookie banners, sponsored copy that is not in an iframe,
  related links, comments, footers. On a news page the article can be under half the
  surviving tokens. A main-content pass is a different tool's job, but it is the single
  largest remaining token win for web pages and should be a conscious decision, not an
  oversight.
- **XLSX** — cheap once the ZIP reader exists, but spreadsheets want a different output
  shape and deserve their own design.
- **`.key` / `.odp`** — named refusals only.
