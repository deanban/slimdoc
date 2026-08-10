<div align="center">

# slimdoc

**Documents are written for people and office apps. Prompts are not.**

`slimdoc` turns Word files, PowerPoint decks, PDFs, Markdown, HTML, RTF, transcripts, and plain
text into clean, token-cheap input for an LLM.

[![npm](https://img.shields.io/npm/v/slimdoc?logo=npm&color=cb3837)](https://www.npmjs.com/package/slimdoc)
[![CI](https://github.com/deanban/slimdoc/actions/workflows/ci.yml/badge.svg)](https://github.com/deanban/slimdoc/actions/workflows/ci.yml)
[![node](https://img.shields.io/node/v/slimdoc?logo=node.js&color=5fa04e)](https://nodejs.org)
[![license](https://img.shields.io/npm/l/slimdoc?color=blue)](LICENSE)

```bash
npx slimdoc report.docx | pbcopy
```

</div>

Out go the embedded avatars, the footer repeated on every page, and the 80 spaces of layout
padding. What is left is the text you actually wanted, in an order a model can work with, which
leaves more of the context window for the job itself.

## Token-saving scorecard

| Input | Estimated tokens saved |
|---|---:|
| HTML | **93.0%** |
| RTF | **75.9%** |
| Transcript text | **44.0%** |
| DOCX file | **37.0%** |
| Markdown | **30.1%** |

These figures measure reduction only, not extraction fidelity. They come from the project
scorecard, and your documents will vary.

## Usage

```bash
slimdoc notes.docx                    # clean it; print Markdown to stdout
slimdoc *.md --out-dir clean/         # process a folder's worth of files
pbpaste | slimdoc | pbcopy            # clean whatever is on the clipboard
slimdoc -c -C                         # same workflow, no pipes
slimdoc meeting.docx -t -s            # tidy a transcript and show the savings
slimdoc deck.pptx --chart-data        # include the numbers behind charts
slimdoc report.pdf --pages 3-7        # send only the pages that matter
slimdoc report.pdf --section-headings # keep page boundaries visible
```

Input can come from files, piped stdin, or the system clipboard. Output can go to stdout, a file,
a directory, the clipboard, or JSON. That makes `slimdoc` useful at a terminal, inside a script,
and as a small preprocessing step in a larger LLM pipeline.

## What you get

- Cleaner context, because images, base64 payloads, document chrome, invisible characters,
  excessive whitespace, and repeated page or slide furniture are all removed.
- Structure that survives. Tables remain tables, lists remain lists, code keeps its exact
  whitespace, and pages and slides stay separate while they are cleaned.
- Less manual prep. Point it at the file you already have; there is no copy-paste cleanup ritual
  and no intermediate conversion step.
- Control when you need it. Select pages, include hidden slide content, pull chart series,
  preserve section labels, or choose how aggressively to compact the text.
- Receipts. `--stats` shows before-and-after characters, lines, bytes, and estimated tokens, and
  extraction warnings say what was omitted or approximated.

## Documents, handled on their own terms

### Word, HTML, RTF, Markdown, and text

The everyday cleanup is deliberately boring, and very effective.

`slimdoc` removes image payloads, avatars, Office metadata, zero-width characters, soft hyphens,
stray control codes, trailing whitespace, tabs, runs of spaces, and stacks of blank lines. In the
default `--balanced` mode it also normalizes smart punctuation to ASCII, unwraps hard-wrapped
prose, compacts Markdown tables, and removes pointless backslash escapes left by Word conversion.

HTML gets a little more care. Scripts, styles, media containers, and raw markup go away, while
links, lists, headings, emphasis, tables, inline code, and fenced code survive. Meaningful image
captions stay as `[image: ...]`; filenames, `avatar`, and repetitive Office-generated alt-text
disclaimers do not. Embedded code that is only available by URL leaves a useful
`[embedded: ...]` marker instead of vanishing.

RTF is treated as content rather than formatting archaeology. Picture blobs, font tables, color
tables, headers, footers, and other control data are discarded. Unicode text and real tables come
through.

### PowerPoint

A deck is more than a bag of text boxes, so `slimdoc` reads one in presentation order, a slide at
a time.

- Titles lead their slides. Body text, bullets, grouped shapes, and author-inserted fields follow
  in a conservative reading order.
- Hidden slides, off-canvas text, master and layout prompts, slide numbers, and automatic dates
  stay out by default. Add `--hidden` when the hidden material is the point.
- Tables become GitHub-flavored Markdown tables.
- SmartArt becomes a nested list. Use `--no-diagram-text` to leave it out.
- Chart titles, axis titles, categories, and series names are visible text, so they are included
  by default. `--chart-data` adds cached series values as a table.
- Footers, standing disclaimers, and other blocks repeated across most slides are kept once
  instead of once per slide. `--no-running-headers` keeps every copy.
- Meaningful image descriptions survive; image bytes and boilerplate captions do not.
- Strict Open XML presentations work alongside the usual PowerPoint format.

Mixed or unsupported chart types are skipped conservatively and reported. An image-only or
otherwise textless deck is reported too, so it does not quietly produce an empty result and
pretend everything worked.

Need three slides from a 200-slide deck? `--pages 8-10` reads the selected slides rather than the
whole deck's contents. Slide numbering still matches PowerPoint, including the positions held by
hidden slides.

### PDF

PDF is the hard one. It stores glyphs at coordinates, not paragraphs, tables, or even a reliable
reading order, so `slimdoc` reconstructs carefully and says so.

- Two-column pages are read down the first column, then the second.
- Headers and footers repeated across a document are kept once and suppressed after that. Use
  `--no-running-headers` to retain every occurrence.
- Hanging indents and coordinate padding are flattened so normal prose can unwrap cleanly instead
  of masquerading as code.
- Grid-like regions keep their alignment in fenced blocks. `slimdoc` will not invent a Markdown
  table and risk putting a number under the wrong heading.
- `--dehyphenate` rejoins words split across line breaks, such as `inter-` / `national`. It is
  opt-in because no dictionary-free rule can tell every real compound from a line-break hyphen.
- `--pages 3-7,12` extracts only the pages you care about. `--section-headings` adds `## Page 3`
  markers, and `--stats` breaks the result down page by page.
- A partly scanned PDF keeps its text pages and marks the pages with no extractable text. A fully
  scanned PDF is refused with an `ocrmypdf` hint instead of returning nothing.

Extraction from a PDF is necessarily an approximation. Preserving alignment is safer than
asserting structure the file never contained.

## Meeting transcripts

Exported meetings are spectacularly wasteful. Five lines of metadata and a base64 profile photo
can surround one sentence.

`--transcript` understands Microsoft Teams (including its Word export), Zoom, Google Meet, Otter,
WebVTT, and SRT. It merges consecutive turns from the same speaker, shortens unambiguous names,
keeps one useful timestamp per turn, removes duplicate captions, and drops join, leave, and
recording chatter.

<table>
<tr><th>Before</th><th>After</th></tr>
<tr><td>

```text
[a 5 KB base64 profile photo]
__Picard, Jean-Luc__
0 minutes 43 seconds0:43
Picard, Jean-Luc 0 minutes 43 seconds
Morning all, shall we get started?
```

</td><td>

```text
Jean-Luc [0:43]: Morning all, shall we get started?
```

</td></tr>
</table>

On a measured 14-minute Teams meeting exported to Word, transcript cleanup reduced a 2,604-token
image-free conversion to 1,641 cl100k tokens, or **37% less context**. That is the honest
comparison. Counting the removal of base64 avatars would make the result look enormous, but any
competent converter should remove those before tokenization.

If a document looks like a transcript and `--transcript` is missing, `slimdoc` points it out
rather than silently guessing.

## Tables and code survive

Compacting a document is easy if structure is allowed to break. `slimdoc` does the slower, more
useful thing.

Tables from DOCX, PPTX, HTML, and RTF become GitHub-flavored Markdown tables with one row per
line. Pipes inside cells are escaped and multi-line cells are flattened. Merged cells have no
Markdown equivalent, so their values are repeated across the span and the approximation is
reported.

Code blocks are never cleaned internally, in any preset. Indentation stays exact and inline code
keeps its backticks. If a code sample contains its own Markdown fence, `slimdoc` automatically
uses a longer outer fence so the block remains valid.

## Pick a cleanup level

| | `--safe` | `--balanced` (default) | `--aggressive` |
|---|:---:|:---:|:---:|
| whitespace, invisible characters, media | yes | yes | yes |
| ASCII punctuation and paragraph unwrapping | no | yes | yes |
| remove Markdown decoration and emoji | no | no | yes |

`--safe` is the light touch and `--balanced` is the useful default. `--aggressive` keeps the words
but drops emphasis markers, link URLs, heading hashes, and emoji to squeeze harder.

You can override every individual behavior, and every flag has a `--no-` counterpart:

```bash
slimdoc notes.md --aggressive --no-strip-emoji
slimdoc page.html --safe --unwrap --ascii
```

## Your files stay yours

The default is non-destructive. `slimdoc` writes to stdout and leaves the source file exactly
where it found it.

| Command | What happens to the original |
|---|---|
| `slimdoc notes.md` | untouched; result goes to stdout |
| `slimdoc notes.md -o clean.md` | untouched; a new file is created |
| `slimdoc *.docx -D clean/` | untouched; one Markdown file per input |
| `slimdoc notes.md -C` | untouched; result goes to the clipboard |
| `slimdoc notes.md -w` | **overwritten in place** |

`--write` is the only destructive option, and it refuses formats that in-place rewriting would
corrupt:

```console
$ slimdoc report.docx -w
slimdoc: report.docx: refusing to rewrite a docx file in place — use --out-dir
```

The output is Markdown text, never a Word, PowerPoint, or PDF file. For the same reason, `--out`
rejects binary-looking targets such as `clean.docx` instead of creating a file Word cannot open.

Batch output is collision-safe. `a/report.pdf` and `b/report.pdf` become `clean/report.md` and
`clean/b-report.md`, and names that differ only by case are treated as collisions on macOS and
Windows too. Nothing is silently overwritten.

## Install

```bash
npm install -g slimdoc      # then: slimdoc file.docx
npx slimdoc file.docx       # or run it without installing
```

Requires Node 22 or newer. A global install also provides `slim` as a shorter alias.

There are three runtime dependencies: `mammoth` for Word, `unpdf` for PDF, and `saxes` for OOXML.
They load only when the format needs them, so cleaning a Markdown or text file does not pay to
initialize document readers it will never use.

## Formats

First-class inputs:

| Kind | Extensions |
|---|---|
| Word | `.docx` |
| PowerPoint | `.pptx`, `.pptm`, `.potx` |
| PDF | `.pdf` |
| Web and rich text | `.html`, `.htm`, `.rtf` |
| Text-shaped | `.md`, `.markdown`, `.mdx`, `.txt`, `.text`, `.log`, `.csv`, `.tsv`, `.json`, `.yaml`, `.yml`, and other valid UTF-8 or UTF-16 text |

Detection uses magic bytes as well as the extension, so extensionless files and binary input piped
through stdin still work.

Legacy or out-of-scope formats are refused with a useful conversion route. Re-save `.doc` and
`.ppt` as `.docx` and `.pptx`, export `.xls` and `.xlsx` as CSV, and export Keynote or
OpenDocument presentations as PPTX or PDF.

Resource limits are on by default: 100 MB input, 500 selected pages, bounded ZIP inflation, and
bounded PDF items per page. The stdin and clipboard paths enforce the same input limit while data
arrives, instead of buffering an unlimited payload first.

## Options

<details>
<summary><code>slimdoc --help</code></summary>

```text
Input
  -c, --clipboard         read the system clipboard instead of files/stdin
Output
  -o, --out <file>        write to a file (single input only)
  -D, --out-dir <dir>     write each cleaned input into <dir>
  -w, --write             rewrite the input files in place
  -C, --copy              copy the result to the clipboard
  -j, --json              emit JSON: { source, format, text, stats, warnings }
Presets
      --safe   --balanced   --aggressive
Fine control (every flag has a --no- counterpart)
      --unwrap             --ascii              --strip-markdown
      --strip-emoji        --preserve-code      --compact-tables
      --normalize-unicode  --unescape-markdown  --no-strip-media
      --max-blank-lines <n>                     --keep-tabs
Documents
  -t, --transcript        tidy a meeting transcript
      --pages <range>     3-7,12 — pages (PDF) or slides (PPTX)
      --section-headings  emit `## Page 3` / `## Slide 3 — Title` markers
      --hidden            include hidden slides and off-slide text
      --chart-data        add PPTX chart series numbers as tables
      --no-diagram-text   skip SmartArt text
      --dehyphenate       rejoin words split across PDF line breaks
      --no-tables         do not preserve aligned PDF regions as code blocks
      --no-running-headers  keep text repeated on every page / slide
      --max-pages <n>     cap on the pages actually read (default 500)
Other
  -s, --stats             print a before/after report to stderr
  -q, --quiet
  -h, --help    -V, --version
```

</details>

`--stats` writes to stderr, so the cleaned document on stdout stays pipe-safe. Its token count is
a calibrated heuristic rather than a billing-grade tokenizer.

## What is guaranteed, and what is not

The cleaner has hard promises, enforced by the test suite:

- Cleaning does not drop words across headings, lists, tables, quotes, and emphasis in any preset.
- Cleaning twice gives the same result as cleaning once.
- Two paragraphs are not glued together.
- Fenced, indented, and inline code survives byte for byte.

Extraction is a different stage. It intentionally leaves out image payloads, repeated page and
slide furniture, hidden slides, and full chart series unless you ask for them. PDF layout is
reconstructed and merged cells are flattened. Each of those decisions shows up in warnings or
stats where it matters.

So the promise is not a magical round trip from every office format. It is something more useful:
visible, non-duplicated text in a conservative reading order, with the lossy edges made explicit.

## Library use

```js
import { cleanDocument, extractFromFile } from 'slimdoc';

const doc = await extractFromFile('deck.pptx', {
  chartData: true,
  pages: [[2, 5]],
});

const { text, stats, sections } = cleanDocument(doc, {
  preset: 'aggressive',
});
```

Use `cleanDocument` rather than `clean` for PDFs and presentations. It cleans each page or slide
independently before joining them, which stops the end of one section from being unwrapped into
the start of the next.

The package also exports format detection, extraction from buffers, transcript tools, token
estimation, stats helpers, presets, and typed cleanup and extraction options.

## License

MIT
