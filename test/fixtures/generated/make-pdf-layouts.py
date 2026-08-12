#!/usr/bin/env python3
"""Generate the reportlab PDF fixtures — layouts a hand-written generator cannot fake.

`test/fixtures/corpus/make-corpus-pdf.py` places every run itself, at coordinates it
chose. That makes it excellent for asserting what slimdoc does with a known arrangement
and useless for asserting what slimdoc does with an arrangement a *typesetter* chose.
Two of the extractor's heuristics turned out to be tuned to the corpus generator's habits
rather than to real typesetting:

- paragraph detection assumed inter-paragraph leading exceeds 1.5x the line leading. Real
  typesetting uses roughly 1.2-1.45x, and when no gap clears the bar the page ends up with
  no blank line at all, which switches `unwrap` off for the whole page.
- column detection assumed a table produces more than one clear vertical band. A
  two-column table produces exactly one, which is the single case the guard admits.

reportlab decides the leading, the justification and the cell metrics here, so neither
fixture can quietly agree with the code.

Deterministic: `rl_config.invariant` fixes /CreationDate, /ID and the producer string, so
re-running produces a byte-identical file. Verify with:

    shasum -a 256 *.pdf && python3 make-pdf-layouts.py && shasum -a 256 *.pdf

Usage:  python3 test/fixtures/generated/make-pdf-layouts.py
"""

from __future__ import annotations

import os

from reportlab import rl_config

# Must be set before any document is constructed: it is what removes the clock
# from /CreationDate and /ID, and the reportlab version from /Producer.
rl_config.invariant = 1

from reportlab.lib import colors
from reportlab.lib.enums import TA_JUSTIFY
from reportlab.lib.pagesizes import letter
from reportlab.lib.styles import getSampleStyleSheet
from reportlab.lib.units import inch
from reportlab.platypus import Paragraph, SimpleDocTemplate, Spacer, Table, TableStyle

HERE = os.path.dirname(os.path.abspath(__file__))

# --------------------------------------------------------------------------
# justified prose — paragraph detection and unwrap
# --------------------------------------------------------------------------

PROSE = (
    "The reconstruction of reading order from a page description language is necessarily "
    "an inference, since the file records only where ink is placed and never what any of "
    "it means to a reader who encounters it in sequence. Justified setting widens the "
    "interword spaces on every line but the last, which is precisely the signal a naive "
    "column detector reads as structure rather than as typography."
)

SECOND = (
    "A second paragraph exists so that the page has a paragraph boundary to find. The "
    "leading between these two paragraphs is whatever the stylesheet says it is, which is "
    "the point: a threshold tuned to a generator that leaves a full blank line between "
    "paragraphs will not fire here, and the failure is silent."
)

THIRD = (
    "A third paragraph makes the run long enough that a missed boundary costs real tokens. "
    "Every line in this block is hard-wrapped by the typesetter, and joining them back into "
    "one line per paragraph is most of what cleaning a PDF is for."
)


def justified_prose(path: str) -> None:
    styles = getSampleStyleSheet()
    body = styles["BodyText"].clone("justified")
    body.alignment = TA_JUSTIFY
    body.fontSize = 11
    body.leading = 14          # reportlab's own ratio, not one chosen to pass a test
    body.spaceAfter = 6        # 20pt gap against 14pt leading = 1.43x

    doc = SimpleDocTemplate(
        path, pagesize=letter, invariant=1,
        title="Justified prose", author="slimdoc fixtures", subject="paragraph detection",
    )
    doc.build([Paragraph(t, body) for t in (PROSE, SECOND, THIRD)])


# --------------------------------------------------------------------------
# a two-column table — column detection must not eat it
# --------------------------------------------------------------------------

ROWS = [
    ["Deck", "Crew"],
    ["Deck 36", "12"],
    ["Deck 10", "0"],
    ["Deck 4", "7"],
    ["Deck 2", "19"],
    ["Deck 1", "31"],
]


def two_column_table(path: str) -> None:
    """A real Table flowable: reportlab computes the column widths and the gutter.

    The label column is short and the value column shorter, which is what makes the
    single vertical band between them look exactly like a page gutter.
    """
    styles = getSampleStyleSheet()
    table = Table(ROWS, colWidths=[2.4 * inch, 1.2 * inch], hAlign="LEFT")
    table.setStyle(
        TableStyle(
            [
                ("FONTNAME", (0, 0), (-1, 0), "Helvetica-Bold"),
                ("FONTNAME", (0, 1), (-1, -1), "Helvetica"),
                ("FONTSIZE", (0, 0), (-1, -1), 11),
                ("ALIGN", (1, 0), (1, -1), "RIGHT"),
                ("LINEBELOW", (0, 0), (-1, 0), 0.5, colors.black),
                ("BOTTOMPADDING", (0, 0), (-1, -1), 6),
            ]
        )
    )

    doc = SimpleDocTemplate(
        path, pagesize=letter, invariant=1,
        title="Crew allocation", author="slimdoc fixtures", subject="column detection",
    )
    doc.build(
        [
            Paragraph("Crew allocation by deck", styles["Heading2"]),
            Spacer(1, 12),
            table,
            Spacer(1, 18),
            Paragraph(
                "The table above is the only structure on this page. Every value belongs "
                "to the deck named on its own row.",
                styles["BodyText"],
            ),
        ]
    )


# --------------------------------------------------------------------------
# rotated text matrix — rotation must be composed before layout
# --------------------------------------------------------------------------

ROTATED_ROWS = [
    ["FLOOR", "AREA", "UNITS", "VALUE"],
    ["1ST", "8,411", "3", "0.7"],
    ["2ND", "9,942", "2", "0.4"],
    ["3RD", "7,655", "5", "1.2"],
    ["4TH", "6,300", "1", "0.9"],
]

ROTATED_COLUMNS = [72, 180, 260, 330]


def rotated_text(path: str) -> None:
    """Text written with a 90-degree-rotated matrix, displayed upright via /Rotate 90.

    The shape of a sideways-scanned-then-regenerated form: every run's matrix is
    [0, s, -s, 0], one run per cell, rows stacked along user-space x. Reading the
    raw coordinates as upright text groups a visual *column* into one line and
    butt-joins its numbers.
    """
    from reportlab.pdfgen.canvas import Canvas

    c = Canvas(path, pagesize=letter, invariant=1)
    c.setTitle("Rotated assessment form")
    c.setAuthor("slimdoc fixtures")
    c.setSubject("text-matrix rotation")
    c.setPageRotation(90)
    c.setFont("Helvetica", 10)
    c.saveState()
    c.rotate(90)
    # After rotate(90), drawString(u, v) lands at user-space (-v, u): u advances
    # along user y (the rotated line), -v picks the user x the row sits at.
    c.drawString(72, -80, "Floor area assessment, drawn sideways")
    for row_index, row in enumerate(ROTATED_ROWS):
        x_row = 110 + row_index * 16
        for cell, start in zip(row, ROTATED_COLUMNS):
            c.drawString(start, -x_row, cell)
    c.restoreState()
    c.showPage()
    c.save()


if __name__ == "__main__":
    justified_prose(os.path.join(HERE, "justified-prose.pdf"))
    two_column_table(os.path.join(HERE, "two-column-table.pdf"))
    rotated_text(os.path.join(HERE, "rotated-text.pdf"))
    for name in ("justified-prose.pdf", "two-column-table.pdf", "rotated-text.pdf"):
        path = os.path.join(HERE, name)
        print(f"wrote {name} ({os.path.getsize(path)} bytes)")
