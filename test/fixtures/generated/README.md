# Fixtures written by a third-party generator

Small documents produced by `reportlab` and `python-pptx` rather than by hand.

## Why this exists

`test/fixtures/corpus/` is hand-written under a deliberate rule: Python standard library
only, every byte placed by us. That rule is right for what the corpus is for — it makes
the fixtures byte-reproducible, dependency-free and precise about what is on the page.

It also has a blind spot, and two adversarial reviews walked straight into it. A fixture
we write encodes the assumptions we hold. Where the extractor guesses, our fixture guesses
the same way, and the test passes for the wrong reason:

- `make-corpus-pptx.py` writes `<a:buChar>` into every paragraph it wants bulleted. Real
  PowerPoint writes nothing and lets the paragraph inherit from the master. So the corpus
  proved slimdoc reads explicit bullets while every real deck lost all of its.
- `make-corpus-pdf.py` places its lines at coordinates we chose, with a generous
  inter-paragraph gap. Real typesetting leaves roughly 1.2–1.45× the line leading. The
  paragraph detector was tuned to our gap, and on a real page found no paragraphs at all —
  which silently switched `unwrap` off for the whole page.

A generator that decides its own leading, justification and cell metrics cannot agree with
the code by construction. That is the entire job of this directory.

```
make-pdf-layouts.py       ->  justified-prose.pdf      paragraph detection, unwrap
                              two-column-table.pdf     column detection vs a real table
                              rotated-text.pdf         rotated text matrix composed upright
make-pptx-inheritance.py  ->  inherited-bullets.pptx   placeholder inheritance chain
```

`inherited-bullets.pptx` is built on python-pptx's default template, so its master,
layouts and placeholder wiring are Microsoft's: `titleStyle` carries `buNone`, `bodyStyle`
carries `buChar="•"`, `otherStyle` carries neither. Those three are what a correct bullet
resolution has to tell apart, and no deck we hand-write would establish them.

## Rules these generators follow

- **Deterministic.** `rl_config.invariant` for reportlab; pinned core properties and zip
  entry dates for python-pptx. Running a generator twice produces the same sha256.
- **Small.** These assert behaviour, not performance — `kitchen-sink.*` measures that.
  All three together are under 35 kB.
- **Generated output is committed**, as elsewhere in this repository, so the suite does not
  need Python to run.

Regenerate with:

```
python3 test/fixtures/generated/make-pdf-layouts.py
python3 test/fixtures/generated/make-pptx-inheritance.py
```

Requires `reportlab` and `python-pptx`. Neither is a dependency of slimdoc itself, and
neither is needed to run `npm test`.

## The third tier

Real documents — an exported deck, an academic paper, a rotated form — are other people's
files and are not committed. They live in the gitignored `test/fixtures/local/`, and
`test/fixtures/local-manifest.json` records what each one proves so the coverage stays
visible on a clone that has none of them. Tests needing one skip with a notice.
