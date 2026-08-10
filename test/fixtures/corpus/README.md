# The kitchen-sink corpus

Four deliberately hostile documents — one per container format — carrying the
same payload of noise, so a result in one format can be compared against the
same result in another. They exist for two jobs:

- **performance measurement** — real-sized inputs (43 kB to 122 kB) with real
  image payloads, not toy fixtures;
- **acceptance testing** — every category of junk slimdoc claims to remove, and
  every category it claims to keep, present at once and interacting.

```
make-corpus-html.py  ->  kitchen-sink.html    43 kB
make-corpus-docx.py  ->  kitchen-sink.docx   109 kB
make-corpus-pptx.py  ->  kitchen-sink.pptx   122 kB
make-corpus-pdf.py   ->  kitchen-sink.pdf     97 kB
```

Both the generators and their output are committed, as elsewhere in this
repository. Regenerate with `python3 test/fixtures/corpus/make-corpus-*.py`.

Alongside them, one narrow set that is not a kitchen sink:

```
make-rotated-pdfs.py  ->  rotated-{0,90,180,270}.pdf   4 kB each
```

Four five-page documents with byte-identical content streams, differing only in
each page's `/Rotate`. They must extract to identical text, and are five pages
because the defect they were written for — a page height taken from the rotated
viewport, so the margin band that marks page furniture reached a third of the
way down the page — cannot appear until running-header suppression has the four
pages it needs before it will call anything repeated.

Measure with `node test/bench.js` (after `npm run build`). It reports extracted
size, tokens per preset, timing and the resident set between documents, and is
deliberately **not** part of `npm test` — it measures rather than asserts.

## Rules the generators follow

- **Python 3 standard library only** — `os`, `struct`, `zlib`, `zipfile`,
  `base64`. No reportlab, python-docx, python-pptx, lxml or pillow. A `.docx`
  and a `.pptx` are zips of XML; a PNG is length-prefixed chunks around a zlib
  stream; a PDF is objects, a byte-offset xref table and a trailer. All of it is
  hand-written, following `test/fixtures/make-docx.py`, which is the precedent.

  This rule is right for what these fixtures are for and it has a blind spot, which
  two adversarial reviews walked straight into. A fixture we write encodes the
  assumptions we hold: where the extractor guessed, these files guessed the same way
  and the test passed for the wrong reason. `make-corpus-pptx.py` writes `<a:buChar>`
  into every paragraph it wants bulleted, so the corpus proved slimdoc reads explicit
  bullets while every real deck lost all of its; `make-corpus-pdf.py` places its lines
  at coordinates we chose, with a generous inter-paragraph gap, so the paragraph
  detector was tuned to our gap and found no paragraphs at all on a real page. See
  "The three tiers" below for what covers that now.
- **Byte-identical reruns.** Fixed zip timestamps (`2024-01-01T00:00:00`),
  `external_attr = 0o644 << 16`, fixed part ordering, `sorted()` media, a fixed
  PDF `/CreationDate` and `/ID`. Any randomness comes from a hand-rolled seeded
  LCG — never `random`, never the clock. Running a generator twice produces the
  same sha256.
- **Images carry real bytes.** Every image is LCG noise, which barely
  compresses, so each is tens of kilobytes. A 1×1 pixel would make a "no encoded
  image data reached the output" assertion meaningless.
- Invented people, ships and companies are Star Trek, per this repository's
  fixture convention.

## Noise category → the behaviour it exercises

| Noise category | Where | slimdoc behaviour under test |
|---|---|---|
| Smart quotes, em/en dashes, ellipsis characters | all four | `asciiPunctuation`: folded in `--balanced`, kept in `--safe` |
| Ligatures `ﬁ` `ﬂ` | html, docx, pptx, pdf | `normalizeUnicode` (NFKC) splits them back into `fi`/`fl` |
| Soft hyphens, zero-width spaces, zero-width no-break space | html, docx, pptx | `stripInvisible` — invisible characters that still cost tokens |
| Non-breaking spaces | all four | normalised to ordinary spaces without eating the word boundary |
| Emoji | html, docx, pptx | `stripEmoji`, on only under `--aggressive` |
| Tab indentation, runs of 8+ spaces | all four | `tabsToSpaces` + `collapseSpaces` — and must **not** fire inside code |
| Trailing whitespace on most lines | html (162 lines), docx, pptx | `trimLines` |
| Six consecutive blank lines / empty paragraphs | all four | `maxBlankLines` |
| Hard-wrapped prose at ~60 columns | all four | `unwrap` rejoins the paragraph without joining across table rows |
| Words hyphenated across a line break (`inter-` / `mix`) | all four | hyphen repair during unwrap — currently **not** repaired; regression anchor |
| Clean 4–5 column table | all four | the GFM table contract: edge pipes, a `\| --- \|` separator, no blank lines between rows |
| Merged cells (colspan / rowspan) | all four | best-effort flattening plus the `N merged cells flattened` warning |
| Single-column table | html, docx, pptx | emitted as plain lines, not a one-column table |
| Cell containing a literal `\|` | all four | escaped as `\|` rather than splitting the row |
| Cell containing a newline (`<br>`, two `<w:p>`, a `<w:br/>`, a wrapped PDF line) | all four | collapsed to a space inside one cell |
| Image with meaningful alt text | all four | survives as `[image: …]` |
| Image with junk auto-alt (`image1.png`, `Picture 3`, `DSC_0041.JPG`, `avatar`) | all four | dropped — the alt is not a caption |
| Image with no alt at all | all four | dropped outright |
| Tracking pixels, 1×1 gifs | html | dropped, and the surrounding paragraph not left dangling |
| Base64 `data:` URIs with tens of kB of real payload | html | `stripMedia` — assert the literal string `base64` never reaches the output |
| Embedded image parts (zip media, PDF XObject) | docx, pptx, pdf | image bytes never leak into text |
| `<script>` and `<style>` with real bodies | html | `DROP_WITH_CONTENT` — the body goes, not just the tags |
| Escaped `&lt;script&gt;alert(1)&lt;/script&gt;` inside `<pre>` | html | **must survive** — see must-not-regress below |
| Fenced block containing its own three-backtick run | all four | computed fence length, `max(3, longest run inside + 1)` |
| Indented Python outside `<pre>` (code-ish container, Courier runs, `HTMLPreformatted`) | all four | `preserveCode` — collapsing the indent destroys the function |
| Inline `<code>` / monospaced runs | html, docx, pptx | keeps its backticks |
| Gist and YouTube `<iframe>` | html | `[embedded: <url>]` rather than a dangling "Full source on GitHub:" |
| Language hints (`class="language-markdown"`, `class="language-html"`) | html | emitted as the fence's language identifier |
| Nav lists, cookie banner, breadcrumbs | html | boilerplate that survives extraction and costs tokens |
| "Related links", footers, repeated legal text (3× in html, 2–3× elsewhere) | all four | repeated-block detection; at minimum, measurable in `--stats` |
| Twelve levels of wrapper `<div>` | html | container soup must cost nothing |
| `<svg>`, `<video>`, `<noscript>`, `<!-- comments -->` | html | dropped |
| Hyperlinks, both labelled and bare-URL | html, docx, pdf | `stripMarkdown` under `--aggressive` turns `[t](url)` into `t` |
| Headings h1–h4 | docx (+ html) | heading levels survive; `--aggressive` drops the hashes |
| Nested bullets, three levels, plus numbered lists | docx, pptx | list nesting survives |
| Bold / italic runs | docx, pptx | emphasis kept by default, dropped under `--aggressive` |
| Chart with real `<c:ser>` caches | pptx | chart data is opt-in; the numbers exist nowhere else in the package |
| SmartArt text in `diagrams/data1.xml` | pptx | diagram text lives outside any `<p:sp>`; a shape walker finds an empty frame |
| Permuted `<p:sldIdLst>` | pptx | presentation order ≠ `slideN.xml` order (see below) |
| Hidden slide (`show="0"`) | pptx | excluded from default output |
| Off-slide text box at negative coordinates | pptx | "visible content" means on the canvas |
| Group shape with a rotating, 4× scaling transform | pptx | child `a:off` values are in the group's space, not the slide's |
| Slide-master and layout placeholder text | pptx | inherited chrome must never reach the output |
| Running headers and footers, `Page N of M` | pdf | page furniture repeated seven times; page labels are opt-in |
| Two-column spread | pdf | reading order by `y` alone interleaves the columns into nonsense |
| Table that really is on a coordinate grid | pdf | the case where coordinate clustering is defensible |
| Pseudo-table: wandering `x`, 2–5 fields per row, no rules | pdf | the confidence gate must **refuse** this and fall back |
| Image-only page among text pages | pdf | per-page "no extractable text" marker, not a whole-document refusal |

## Must-not-regress cases

1. **Escaped code samples survive while real scripts die.** `kitchen-sink.html`
   contains `&lt;script&gt;alert(1)&lt;/script&gt;` inside a `<pre>`, and a real
   `<script>` element immediately after it. The escaped one is text and must
   appear in the output verbatim, in every preset; the real one must not appear
   at all. This works today because `DROP_WITH_CONTENT` matches `<script`, which
   `&lt;script&gt;` is not — a tutorial *about* JavaScript keeps its examples.
   Assert both directions: `alert(1)` present, `fetch("https://pixel.` absent.
2. **`base64` never appears in output.** No prose in any fixture contains the
   word, so a plain substring search is a valid assertion.
3. **Slide-master text never appears.** Search the pptx output for
   `Click to edit Master`, `MASTER SLIDE NUMBER` — all must be absent.
4. **Hidden-slide text never appears by default.** Search for
   `HIDDEN SLIDE MARKER`.
5. **Presentation order is not file order.** `<p:sldIdLst>` resolves to
   `slide1, slide4, slide2, slide7, slide3, slide9, slide8, slide5, slide6`, and
   the hidden slide sits in the middle rather than at the end. Extracted slide
   titles must come out as Refit Status → Agenda → Summary → Deck loading →
   Propulsion output → Refit sequence → Imagery → Runbook.
6. **Indented Python keeps its indentation.** In all four formats. The body of
   `containment_margin` changes meaning if the indent collapses, and the damage
   is invisible in a diff of prose.

## Verifying the fixtures

```bash
cd test/fixtures/corpus

# reproducibility
for f in html docx pptx pdf; do
  before=$(shasum -a 256 kitchen-sink.$f)
  python3 make-corpus-$f.py >/dev/null
  [ "$before" = "$(shasum -a 256 kitchen-sink.$f)" ] || echo "NOT REPRODUCIBLE: $f"
done

# the three OOXML containers
python3 -c "import zipfile; [print(p, zipfile.ZipFile(p).testzip()) \
  for p in ('kitchen-sink.docx','kitchen-sink.pptx')]"

# the pdf, if you have poppler
pdftotext kitchen-sink.pdf -
```

The PDF was additionally checked by parsing its xref table back and confirming
every offset lands exactly on its `N 0 obj`, by rendering it through macOS
CoreGraphics, and by extracting it with `unpdf` — the engine `SPEC-pdf-pptx.md`
selects — which reports 7 pages, page 5 textless, and 4,277 characters.

## Known limitations of the stdlib-only approach

- **The PDF cannot carry emoji or zero-width characters.** It uses the base-14
  Helvetica with `WinAnsiEncoding`, and neither has a glyph or a code point for
  them. Embedding a font would mean shipping font binaries and building a CID
  encoding by hand, which is not worth it for a fixture. Those two categories
  are covered by the other three formats.
- **The PDF's ligatures, non-breaking spaces and soft hyphens are normalised
  during extraction, not by slimdoc.** They are genuinely in the file — `ﬁ` and
  `ﬂ` via an `/Encoding` `/Differences [254 /fl 255 /fi]` array, `0xA0` and
  `0xAD` via WinAnsi — but the PDF specification defines WinAnsi `0xA0` as space
  and `0xAD` as hyphen, and pdf.js maps the ligature glyph names to `fi`/`fl`.
  So the PDF exercises those categories at the byte level only; the normalising
  behaviour itself is tested through html, docx and pptx.
- **The docx emits two mammoth warnings** — `Unrecognised paragraph style:
  'Quote'` and `'HTML Preformatted'`. These are deliberate: real Word documents
  produce exactly these warnings, and the warning path deserves a fixture.
- **No RTF fixture.** RTF is covered by `test/fixtures/sample.rtf`; adding a
  fifth container here would not exercise anything the other four miss.

## Baseline, at the time of writing

Against the build in `dist/` when the corpus was created. These drift with the
extractors — they are a reference point, not an assertion:

| | on disk | extracted | tokens before → after | warnings |
|---|---|---|---|---|
| `kitchen-sink.html` | 43.1 kB | 5.2 kB | ~1,560 → ~1,547 | 10 images dropped, 6 merged cells flattened |
| `kitchen-sink.docx` | 108.9 kB | 4.2 kB | ~1,272 → ~1,258 | 4 images dropped / 1 kept, 5 merged cells flattened |
| `kitchen-sink.pptx` | 122.1 kB | 2.4 kB | ~716 → ~699 | 4 images dropped / 1 kept, 4 merged cells flattened, 1 hidden slide skipped |
| `kitchen-sink.pdf` | 97.3 kB | 4.3 kB | ~997 → ~969 | 1 textless page, 10 running header/footer lines suppressed, 2 regions preserved as preformatted text |

The interesting number is the first column against the second — 122 kB of deck
carries 2.4 kB of meaning, and 109 kB of Word carries 4.2 kB. Whole-corpus peak
RSS is about 97 MB, most of it pdf.js.

The `pptx` row is measured at defaults, so it excludes the chart series; with
`--chart-data` the deck extracts about 2.7 kB. The `pdf` row includes the two
preserved grid regions, which is most of the gap between it and the deck.

## The three tiers

This directory is one of three, and each does a job the others cannot.

**Tier A — real documents, never committed.** `test/fixtures/local/`, gitignored.
`test/fixtures/local-manifest.json` records each file's logical name, filename, sha256
and *what it proves*, so the coverage stays documented on a clone that has none of them.
`test/helpers/local.js` resolves a name and returns `null` with a skip notice when the
file is absent, so the suite is green either way. These are what caught defects the
347-test suite passed straight through, and what refined several of the fixes: the naive
form of the bullet resolution would have added 95 bullets to a real deck.

**Tier B — third-party generated, committed.** `test/fixtures/generated/`, built by
`reportlab` and `python-pptx`. A generator that decides its own leading, justification,
cell metrics and placeholder inheritance cannot agree with our code by construction.
That is the entire job of that directory; see its README.

**Tier C — hand-rolled, here.** Byte-exactness, performance measurement, and the
constructs no library will emit at all: ZIP64, an EOCD signature inside an archive
comment, a hostile `c:pt/@idx`, `show="false"` and `hMerge="true"` in place of the
digits Microsoft writes, a missing `<a:ext>`, `/Rotate 90` on every page of a five-page
document. Some of those are built as bytes inside the tests themselves, via
`test/helpers/deck.js`, because a single kitchen-sink deck can only be one deck.
