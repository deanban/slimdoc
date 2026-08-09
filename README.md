# slimdoc

Shrink any document — Word, Markdown, HTML, RTF or pasted text — into clean,
token-cheap input for an LLM.

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

Node 18.17+. One dependency (`mammoth`, for Word files).

## Use it

```bash
slimdoc notes.docx                  # clean it, print to stdout
slimdoc *.md --out-dir clean/       # many files at once
pbpaste | slimdoc | pbcopy          # clean whatever you just copied
slimdoc -c -C                       # same thing, without the pipes
slimdoc meeting.docx -t -s          # a meeting transcript, with a size report
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

**Tables keep their shape.** A table in a `.docx`, `.html` or `.rtf` source comes out as
a GitHub-flavoured Markdown table — leading and trailing pipes, a separator row, one row
per line — rather than as a column of orphaned cells. Merged cells have no Markdown
equivalent, so they are flattened by repeating the value across the span, and the run
reports `N merged cells flattened` on stderr so you know the association was
approximated. Tables keep the blank line that terminates them in every mode, including
`--aggressive`.

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
Other
  -s, --stats             print a before/after report to stderr
  -q, --quiet
  -h, --help    -V, --version
```

`--stats` prints to stderr, so `slimdoc doc.docx | pbcopy` stays clean.
Token counts are a heuristic estimate, not a real tokenizer.

## Formats

`.docx`, `.md`, `.html`, `.rtf`, `.txt`, and anything else that is UTF-8 text.
Detection uses magic bytes as well as the extension, so an extension-less file works.

Legacy `.doc` and `.pdf` are not supported; `slimdoc` tells you what to run instead
(`textutil -convert docx`, `pdftotext file.pdf - | slimdoc`).

## Library use

```js
import { clean, extractFromFile } from 'slimdoc';

const doc = await extractFromFile('meeting.docx');
const text = clean(doc.text, { preset: 'aggressive', transcript: true });
```

## License

MIT
