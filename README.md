# slimdoc

Shrink any document — Word, PowerPoint, PDF, Markdown, HTML, RTF or pasted text —
into clean, token-cheap input for an LLM.

Pasted documents arrive full of things a model gains nothing from: embedded profile
photos, tab stops, stacks of blank lines, smart quotes, em-dashes, zero-width
characters. `slimdoc` strips all of it and leaves the words.

```bash
npx slimdoc report.docx | pbcopy
```

## Install

```bash
npm install -g slimdoc      # then: slimdoc file.docx
npx slimdoc file.docx       # or don't install at all
```

Node 22+. Three dependencies — `mammoth` (Word), `unpdf` (PDF) and `saxes` (OOXML) —
each loaded lazily, so a run that touches none of those formats loads none of them.

## Use it

```bash
slimdoc notes.docx                  # clean it, print to stdout
slimdoc *.md --out-dir clean/       # many files at once
pbpaste | slimdoc | pbcopy          # clean whatever you just copied
slimdoc -c -C                       # same thing, without the pipes
slimdoc meeting.docx -t -s          # a meeting transcript, with a size report
slimdoc deck.pptx --chart-data      # a slide deck, with its chart numbers
slimdoc report.pdf --pages 3-7      # just those pages
```

Input comes from file arguments, piped stdin, or `--clipboard`.

## Your files are not modified

By default `slimdoc` writes to stdout and leaves the input exactly as it found it.
Nothing is overwritten unless you ask for it.

| | what happens to the original |
|---|---|
| `slimdoc notes.md` | untouched — result goes to stdout |
| `slimdoc notes.md -o clean.md` | untouched — new file |
| `slimdoc *.docx -D clean/` | untouched — new files in `clean/` |
| `slimdoc notes.md -C` | untouched — result to the clipboard |
| `slimdoc notes.md -w` | **overwritten in place** |

`--write` is the only destructive option, and it refuses to run on a format it would
corrupt:

```
$ slimdoc report.docx -w
slimdoc: report.docx: refusing to rewrite a docx file in place — use --out-dir
```

The output is Markdown text, so writing it into a `.docx` filename would leave you with
a file Word cannot open and the original content gone. The same refusal covers `.rtf`
and `.html`.

With `--out-dir` the extension is corrected to match the contents, so
`report.docx` is written as `clean/report.md` rather than a `.docx` that isn't one.

`slimdoc` emits Markdown text, never a Word file, so `--out` rejects a `.docx`,
`.doc`, `.rtf` or `.pdf` target rather than writing a file your reader cannot open:

```
$ slimdoc report.docx -o clean.docx
slimdoc: slimdoc writes Markdown text, so a .docx file would not open — write to clean.md instead
```

## What it removes

Always, in every mode:

- **Images, avatars and embedded media.** Data URIs, `<img>` tags, RTF `{\pict}` blobs,
  orphaned base64. A meaningful caption survives as `[image: …]`; a profile photo does not.
- Zero-width characters, soft hyphens, BOMs, stray control codes.
- Trailing whitespace, tabs, runs of spaces, stacks of blank lines.

In the default `--balanced` mode it also folds smart quotes, em-dashes and ellipses to
ASCII, unwraps hard-wrapped paragraphs, compacts Markdown tables, and removes the
pointless backslash escapes that Word conversion leaves behind.

**Code blocks are never touched**, in any mode — whitespace carries meaning there.

**Tables keep their shape.** A table in a `.docx`, `.pptx`, `.html` or `.rtf` source comes out as
a GitHub-flavoured Markdown table — leading and trailing pipes, a separator row, one row
per line — rather than as a column of orphaned cells. Merged cells have no Markdown
equivalent, so they are flattened by repeating the value across the span, and the run
reports `N merged cells flattened` on stderr so you know the association was
approximated. Tables keep the blank line that terminates them in every mode, including
`--aggressive`.

## Slides and pages

A deck and a PDF are read one slide or page at a time, and each is cleaned on its own
before the pieces are joined. That boundary is the point: without it a sentence at the
foot of one page gets unwrapped into the first line of the next, and a table's columns
are erased by the same space-collapsing that tidies prose.

```bash
slimdoc deck.pptx --pages 2-5,9      # slides, as the reader numbers them
slimdoc report.pdf --section-headings # emit `## Page 3` markers
slimdoc deck.pptx --stats            # a token count per slide
```

**PowerPoint.** Slide order comes from the presentation, not from the file names inside
the `.pptx` — a reordered deck reports the order you present it in. Hidden slides,
text boxes dragged off the canvas, and the "Click to edit Master title style" chrome
that lives on the layout are all left out; `--hidden` brings the first two back. Tables
become Markdown tables, SmartArt becomes a nested list, and `--chart-data` emits a
chart's series as a table — those numbers usually exist nowhere else in the file.

**PDF.** A PDF has no paragraphs, no reading order and no tables in it — only glyph runs
at coordinates — so everything slimdoc emits from one is reconstructed, and it says so
on stderr. Two-column spreads are read down one column and then the other. A header or
footer repeated on every page is kept once and then suppressed, which is the single
biggest saving in a long report. A region that lines up is preserved verbatim in a code
block rather than rewritten as a Markdown table: a wrong table asserts a structure that
was never in the file and lands numbers under the wrong heading, while preserving the
alignment asserts nothing. `--dehyphenate` rejoins `inter-` / `national` across a line
break; it is off by default because nothing without a dictionary can tell that from
`state-of-the-art`.

### Presets

| | `--safe` | `--balanced` (default) | `--aggressive` |
|---|---|---|---|
| whitespace, invisibles, media | yes | yes | yes |
| ASCII punctuation, unwrapping | no | yes | yes |
| strip Markdown decoration, emoji | no | no | yes |

`--aggressive` keeps every word but drops emphasis markers, link URLs and heading
hashes. Any individual behaviour can be overridden — every flag has a `--no-`
counterpart, e.g. `slimdoc --aggressive --no-strip-emoji`.

## Meeting transcripts

`--transcript` handles the exported-transcript formats: Microsoft Teams (including the
"export to Word" version), Zoom, Google Meet, Otter, WebVTT and SRT.

A Teams export spends five lines and about 5 KB on every utterance:

```
[a 5 KB base64 profile photo]
__Picard, Jean-Luc__
0 minutes 43 seconds0:43
Picard, Jean-Luc 0 minutes 43 seconds
Morning all, shall we get started?
```

`slimdoc meeting.docx -t` turns each of those into:

```
Jean-Luc [0:43]: Morning all, shall we get started?
```

Consecutive turns by one speaker are merged, per-line timestamps drop to one per turn,
and join/leave/recording chatter goes away. Without the flag, `slimdoc` notices the
shape and says so rather than guessing.

Measured on a real 14-minute Teams meeting exported to Word:

| | |
|---|---|
| `.docx` on disk | 158.2 kB |
| naive Word→Markdown conversion | 893,152 chars (98.9% base64 avatars) |
| `slimdoc meeting.docx` | 10,011 chars |
| `slimdoc meeting.docx -t` | 6,910 chars — **~1,878 tokens** |

## Guarantees

Enforced by the test suite, not just intended:

- **No word is ever lost** in default mode. (Verified word-for-word on real documents.)
- **Idempotent** — cleaning twice gives the same result as cleaning once.
- Two paragraphs are never glued into one.
- Fenced, indented and inline code survives byte-identical.

## Options

```
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
      --chart-data        emit PPTX chart series as tables
      --no-diagram-text   skip SmartArt text
      --dehyphenate       rejoin words split across PDF line breaks
      --no-tables         do not preserve aligned PDF regions as code blocks
      --no-running-headers  keep text repeated on every PDF page
      --max-pages <n>     cap on the pages actually read (default 500)
Other
  -s, --stats             print a before/after report to stderr
  -q, --quiet
  -h, --help    -V, --version
```

`--stats` prints to stderr, so `slimdoc doc.docx | pbcopy` stays clean.
Token counts are a heuristic estimate, not a real tokenizer.

## Formats

`.docx`, `.pptx`, `.pdf`, `.md`, `.html`, `.rtf`, `.txt`, and anything else that is
UTF-8 text. Detection uses magic bytes as well as the extension, so an extension-less
file works.

The legacy binary formats are refused by name, with the conversion to run instead:
`.doc` (`textutil -convert docx`), `.ppt`, `.xls`, `.xlsx`, `.key` and `.odp`. A PDF
that is a scan is refused too, naming `ocrmypdf` — but only when *every* selected page
is textless, so an image-only cover in a text document costs you nothing but a
`[page 5: no extractable text]` marker.

## Library use

```js
import { cleanDocument, extractFromFile } from 'slimdoc';

const doc = await extractFromFile('deck.pptx', { chartData: true });
const { text, stats, sections } = cleanDocument(doc, { preset: 'aggressive' });
```

Use `cleanDocument` rather than `clean` for anything with pages or slides: it cleans
each section on its own and then joins them, which is what stops a paragraph on one
page being merged with the first line of the next.

## License

MIT
