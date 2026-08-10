#!/usr/bin/env python3
"""Generate kitchen-sink.pdf — the hostile PDF corpus fixture for slimdoc.

No third-party dependencies, and no font embedding: a PDF is a handful of
objects, a byte-offset cross-reference table and a trailer, and the base-14
fonts (Helvetica, Helvetica-Bold, Courier) are assumed present in every viewer.
Text is placed the way a real generator places it — `BT /F1 10 Tf x y Td (…) Tj
ET`, one operation per line, at absolute coordinates — because that absence of
structure is exactly what slimdoc has to infer from.

The one non-trivial piece of machinery is the same PNG-style noise generator the
other corpus scripts use, here as a raw `/DeviceRGB` image XObject rather than a
PNG. Deterministic throughout: seeded noise, a fixed `/CreationDate`, a fixed
`/ID`, no clock and no `random`. Re-running produces a byte-identical file, and
the xref offsets are computed from the bytes actually written, never guessed.
Verify with:

    shasum -a 256 kitchen-sink.pdf && python3 make-corpus-pdf.py && \\
    shasum -a 256 kitchen-sink.pdf

What each page is for is documented in README.md; briefly, the deck of pages
covers running headers and footers, a two-column spread whose reading order is
ambiguous, one table that really is on a coordinate grid and one that only looks
like it, an image-only page in the middle of text pages, and words hyphenated
across line breaks.

Usage:  python3 test/fixtures/corpus/make-corpus-pdf.py
"""

from __future__ import annotations

import os
import zlib

HERE = os.path.dirname(os.path.abspath(__file__))
OUT = os.path.join(HERE, "kitchen-sink.pdf")

# US Letter, in points.
PAGE_W, PAGE_H = 612, 792
MARGIN = 54

# A fixed creation date and file ID: a PDF normally stamps the clock into both,
# and a clock would make the fixture unreproducible.
CREATION_DATE = "D:20240101000000Z"
FILE_ID = "5553532d454e5445525052495345313730314400000000"

LEGAL = (
    "Utopia Planitia Fleet Yards internal — not for distribution outside "
    "the Starfleet Corps of Engineers."
)


# --------------------------------------------------------------------------
# WinAnsi text encoding
# --------------------------------------------------------------------------

# Codes 254 and 255 are remapped to the ligature glyphs by the /Differences
# array below; every other entry is stock WinAnsiEncoding. A character missing
# from this table raises rather than being silently replaced — a fixture that
# quietly drops what it claims to test is worse than no fixture.
WINANSI = {
    "‘": 0x91, "’": 0x92, "“": 0x93, "”": 0x94,
    "–": 0x96, "—": 0x97, "…": 0x85, "•": 0x95,
    " ": 0xA0, "­": 0xAD, "©": 0xA9, "°": 0xB0,
    "·": 0xB7, "é": 0xE9, "‑": 0x2D,
    "ﬁ": 0xFF, "ﬂ": 0xFE,
}

NBSP, SHY = " ", "­"
LDQUO, RDQUO, LSQUO, RSQUO = "“", "”", "‘", "’"
EMDASH, ENDASH, ELLIPSIS = "—", "–", "…"
FI, FL, NBHY = "ﬁ", "ﬂ", "‑"


def pdf_string(text: str) -> bytes:
    """A PDF literal string: `(...)`, WinAnsi bytes, backslash-escaped."""
    out = bytearray(b"(")
    for ch in text:
        code = ord(ch) if ord(ch) < 128 else WINANSI.get(ch, -1)
        if code < 0:
            raise ValueError(f"no WinAnsi code for U+{ord(ch):04X} ({ch!r})")
        if code in (0x28, 0x29, 0x5C):  # ( ) \
            out += b"\\" + bytes([code])
        elif 32 <= code < 127:
            out.append(code)
        else:
            out += f"\\{code:03o}".encode("ascii")
    out += b")"
    return bytes(out)


# --------------------------------------------------------------------------
# Content stream operators
# --------------------------------------------------------------------------

def show(x: float, y: float, text: str, font: str = "F1",
         size: float = 10) -> bytes:
    """One line of text at an absolute position. The whole PDF is made of these."""
    return (
        f"BT /{font} {size:g} Tf {x:g} {y:g} Td ".encode("ascii")
        + pdf_string(text)
        + b" Tj ET\n"
    )


def line(x1: float, y1: float, x2: float, y2: float,
         width: float = 0.5) -> bytes:
    return f"{width:g} w {x1:g} {y1:g} m {x2:g} {y2:g} l S\n".encode("ascii")


def place_image(name: str, x: float, y: float, w: float, h: float) -> bytes:
    return f"q {w:g} 0 0 {h:g} {x:g} {y:g} cm /{name} Do Q\n".encode("ascii")


# --------------------------------------------------------------------------
# Image XObject
# --------------------------------------------------------------------------

def noise_rgb(width: int, height: int, seed: int) -> bytes:
    """Deterministic RGB noise, as raw samples for a /DeviceRGB XObject.

    Noise on purpose: it barely compresses, so the embedded image is tens of
    kilobytes of real payload. That is what makes "no image bytes reached the
    output" assertions meaningful — a 1x1 pixel would prove nothing.
    """
    state = seed & 0xFFFFFFFF
    raw = bytearray()
    for _i in range(width * height * 3):
        # Numerical Recipes LCG; keeps the fixture independent of the Python
        # version's `random` implementation.
        state = (1664525 * state + 1013904223) & 0xFFFFFFFF
        raw.append((state >> 16) & 0xFF)
    return bytes(raw)


# --------------------------------------------------------------------------
# Page furniture
# --------------------------------------------------------------------------

TOTAL_PAGES = 7


def running_head(title: str) -> bytes:
    """The header every text page repeats — pure boilerplate, page after page."""
    return (
        show(MARGIN, PAGE_H - 40, "UTOPIA PLANITIA FLEET YARDS", size=8)
        + show(PAGE_W - MARGIN - 150, PAGE_H - 40,
               "REFIT DOSSIER " + EMDASH + " CONFIDENTIAL", size=8)
        + line(MARGIN, PAGE_H - 46, PAGE_W - MARGIN, PAGE_H - 46)
        + show(MARGIN, PAGE_H - 66, title, font="F3", size=14)
    )


def running_foot(page_no: int) -> bytes:
    """The footer every text page repeats, including `Page N of M`."""
    return (
        line(MARGIN, 58, PAGE_W - MARGIN, 58)
        + show(MARGIN, 44, LEGAL, size=7)
        + show(PAGE_W - MARGIN - 70, 44,
               f"Page {page_no} of {TOTAL_PAGES}", size=8)
    )


def body_lines(start_y: float, lines: list[str], x: float = MARGIN,
               leading: float = 14, font: str = "F1",
               size: float = 10) -> bytes:
    out = bytearray()
    for i, text in enumerate(lines):
        if text:
            out += show(x, start_y - i * leading, text, font=font, size=size)
    return bytes(out)


# --------------------------------------------------------------------------
# The pages
# --------------------------------------------------------------------------

def page_title() -> bytes:
    """Title page: a heading, hyphen-split prose, and the usual furniture."""
    prose = [
        "The Utopia" + NBSP + "Planitia yards report that the plasma inter-",
        "mix chamber tolerances have drifted by four microns since the",
        "last refit, which the diagnostic subroutine flagged as " + LDQUO
        + "within",
        "nominal" + RDQUO + " " + EMDASH + " a classi" + FI
        + "cation the Daystrom Insti-",
        "tute disputes. Warp " + FL + "ux stability held at 99.7" + NBSP
        + "% across all",
        "eighteen test cycles" + ELLIPSIS + " the remaining variance sits in the",
        "star" + SHY + "board nacelle, which Lt." + NBSP + "Barclay rebuilt in "
        "2367 and",
        "which has never quite matched its twin.",
    ]
    return (
        running_head("Refit Status " + EMDASH + " USS Enterprise")
        + show(MARGIN, PAGE_H - 100,
               "Stardate 47988.1 " + ENDASH + " prepared by Geordi La"
               + NBSP + "Forge", size=11)
        + body_lines(PAGE_H - 140, prose)
        + body_lines(PAGE_H - 280, [
            "Captain Picard" + RSQUO + "s standing order " + ENDASH + " "
            + LSQUO + "no shortcuts on the containment " + FI + "eld" + RSQUO
            + " " + ENDASH + " still applies.",
            "Engineering signed off at 0400 hours. Dr." + NBSP + "Crusher noted "
            "the crew" + RSQUO + "s fatigue index:",
            "3.2" + NBSP + "%" + ENDASH + "4.1" + NBSP + "%, trending down. "
            "Temperature held at 21" + "°" + "C throughout.",
        ])
        + running_foot(1)
    )


def page_two_column() -> bytes:
    """A two-column spread.

    Both columns are laid down top-to-bottom at their own x, so a reader that
    sorts glyph runs by y alone interleaves them into nonsense. There is no
    marker in the file saying "these are columns" — that has to be inferred
    from the x clustering, or the page has to be read in the order the
    operators appear.
    """
    left = [
        "Structural teardown began on stardate",
        "47901.2 and ran eleven days, four longer",
        "than the yards estimate. The delay came",
        "entirely from the dorsal saucer inter-",
        "connects, which had corroded past the",
        "point where the standard replacement",
        "procedure applies.",
        "",
        "Ensign Ro logged every fastener. The",
        "log is appended as exhibit C and is not",
        "reproduced here.",
    ]
    right = [
        "Warp core recerti" + FI + "cation followed the",
        "usual three-stage protocol: cold soak,",
        "controlled intermix, then a sustained",
        "burn at 20" + NBSP + "% for six hours. Every",
        "stage passed on the " + FI + "rst attempt, which",
        "has not happened at these yards since",
        "2361.",
        "",
        "The Daystrom Institute observer signed",
        "the certi" + FI + "cate without comment, which",
        "Commander Data recorded as unusual.",
    ]
    return (
        running_head("Teardown and recerti" + FI + "cation")
        + body_lines(PAGE_H - 100, left, x=MARGIN)
        + body_lines(PAGE_H - 100, right, x=320)
        + line(303, PAGE_H - 90, 303, 220)
        + running_foot(2)
    )


def page_grid_table() -> bytes:
    """A table that really is on a coordinate grid.

    Column x positions are exact and repeated on every row, and the rules are
    drawn. This is the case where reconstructing a Markdown table from
    coordinates is defensible.
    """
    cols = [MARGIN, 190, 300, 400, 500]
    header = ["Subsystem", "Owner", "Status", "Margin", "Reviewed"]
    rows = [
        ["Warp core", "La Forge", "Green", "12" + NBSP + "%", "yes"],
        ["Deflector", "Data", "Green", "8" + NBSP + "%", "yes"],
        ["Transporters", "O" + RSQUO + "Brien", "Amber", "2" + NBSP + "%", "no"],
        ["Holodeck" + NBSP + "3", "Barclay", "Red", ENDASH + "4" + NBSP + "%",
         "no"],
        ["Sensor array", "Worf", "Amber", "5" + NBSP + "%", "yes"],
    ]
    out = bytearray(running_head("Diagnostics"))
    y = PAGE_H - 110
    for x, text in zip(cols, header):
        out += show(x, y, text, font="F3", size=9)
    out += line(MARGIN, y - 5, PAGE_W - MARGIN, y - 5, width=1)
    for r, row in enumerate(rows):
        ry = y - 20 - r * 18
        for x, text in zip(cols, row):
            out += show(x, ry, text, size=9)
        out += line(MARGIN, ry - 5, PAGE_W - MARGIN, ry - 5, width=0.25)

    # A cell that carries a pipe, and a cell that wraps onto a second line at
    # the same column x — the two shapes that break naive cell splitting.
    ry = y - 20 - len(rows) * 18
    out += show(cols[0], ry, "Parser regex", size=9)
    out += show(cols[1], ry, "^(warp|impulse|thruster)$", size=9)
    out += show(cols[0], ry - 18, "Note", size=9)
    out += show(cols[1], ry - 18, "Line one of the note,", size=9)
    out += show(cols[1], ry - 30, "line two of the same cell.", size=9)
    out += line(MARGIN, ry - 36, PAGE_W - MARGIN, ry - 36, width=1)
    out += running_foot(3)
    return bytes(out)


def page_pseudo_table() -> bytes:
    """A block that looks tabular and is not.

    The x positions wander by up to eleven points, the number of fields per
    line changes from three to two to four, and there are no rules. A table
    reconstructed from this would be fiction, so the confidence gate should
    refuse it and fall back to lines or a preformatted block.
    """
    # Deterministic jitter from the same LCG the images use, so the wander is
    # reproducible without `random`.
    state = 20240101
    def jitter(span: int) -> int:
        nonlocal state
        state = (1664525 * state + 1013904223) & 0xFFFFFFFF
        return (state >> 16) % span

    fields = [
        ["Deck 36", "engineering", "occupied"],
        ["Deck 12", "EPS conduit replacement pending"],
        ["Deck 4", "crew quarters", "partial", "reopens 47990"],
        ["Deck 10", "evacuated"],
        ["Jefferies 17", "plasma relay", "purge scheduled"],
        ["Cargo 2", "sealed", "hazmat", "Ro", "48001"],
    ]
    out = bytearray(running_head("Deck notes (not a table)"))
    y = PAGE_H - 110
    for r, row in enumerate(fields):
        x = MARGIN + jitter(9)
        for text in row:
            out += show(x, y - r * 20, text, size=9)
            x += 110 + jitter(11)
    out += body_lines(PAGE_H - 280, [
        "The block above is a list that a proportional font happens to line",
        "up. Three of the six rows have a different field count, no rules were",
        "drawn, and the left edge wanders. Reconstructing a grid from it",
        "invents columns that were never there.",
    ])
    out += running_foot(4)
    return bytes(out)


def page_image_only() -> bytes:
    """An image-only page in the middle of text pages.

    No text operators at all, not even the running header — this is what a
    scanned insert or a full-bleed figure looks like, and it is the page a
    per-page "no extractable text" marker exists for.
    """
    return place_image("Im1", 106, 246, 400, 300)


def page_code() -> bytes:
    """Pasted code in Courier: leading spaces are the only structure present."""
    python = [
        "def containment_margin(readings):",
        "    total = 0",
        "    for r in readings:",
        "        if r.stable:",
        "            total += r.margin",
        "        else:",
        "            total -= r.margin * 2",
        "    return total / len(readings)",
    ]
    markdown = [
        "Document the ejection sequence like this:",
        "",
        "```js",
        "warpCore.eject();      // two spaces of padding here matter",
        "```",
        "",
        "The fence above is three backticks, inside this block.",
    ]
    return (
        running_head("Runbook")
        + show(MARGIN, PAGE_H - 100,
               "Indented Python. The indentation is the semantics:", size=10)
        + body_lines(PAGE_H - 122, python, font="F2", size=9, leading=12)
        + show(MARGIN, PAGE_H - 250,
               "A Markdown sample that contains its own fence:", size=10)
        + body_lines(PAGE_H - 272, markdown, font="F2", size=9, leading=12)
        + show(MARGIN, PAGE_H - 400,
               "Call warpCore.eject() only after containment.lock() returns "
               "true; --force is not a substitute.", size=10)
        + running_foot(6)
    )


def page_back_matter() -> bytes:
    """Repeated legal boilerplate, a link, and a sign-off."""
    return (
        running_head("Sign-off")
        + body_lines(PAGE_H - 100, [
            "Signed off by the board on 2370" + NBHY + "10" + NBHY + "01.",
            "",
            LEGAL,
            "",
            LEGAL,
            "",
            "Full detail lives at https://daystrom.example/reports/warp-core "
            "and is",
            "mirrored at https://fleetyards.example/refit/1701d.",
            "",
            "Privacy" + NBSP + "|" + NBSP + "Terms" + NBSP + "|" + NBSP
            + "Cookie policy" + NBSP + "|" + NBSP + "Accessibility",
            "",
            "© 2370 Starfleet Corps of Engineers. All rights reserved.",
        ])
        + running_foot(7)
    )


PAGES = [
    page_title,
    page_two_column,
    page_grid_table,
    page_pseudo_table,
    page_image_only,
    page_code,
    page_back_matter,
]


# --------------------------------------------------------------------------
# PDF object model and writer
# --------------------------------------------------------------------------

class Pdf:
    """A minimal indirect-object writer with a real cross-reference table.

    Objects are numbered from 1 and appended in order; `build` records the byte
    offset of each as it writes, so the xref can never drift out of step with
    the body. That is the part a hand-rolled PDF usually gets wrong, and a
    wrong xref makes the fixture useless to a real engine.
    """

    def __init__(self) -> None:
        self.objects: list[bytes] = []

    def add(self, body: bytes) -> int:
        self.objects.append(body)
        return len(self.objects)

    def add_stream(self, extra: str, data: bytes, compress: bool = True) -> int:
        if compress:
            data = zlib.compress(data, 9)
            extra = extra + " /Filter /FlateDecode"
        head = f"<< /Length {len(data)}{extra} >>\nstream\n".encode("ascii")
        return self.add(head + data + b"\nendstream")

    def build(self, root: int, info: int) -> bytes:
        out = bytearray(b"%PDF-1.7\n%\xe2\xe3\xcf\xd3\n")
        offsets: list[int] = []
        for num, body in enumerate(self.objects, start=1):
            offsets.append(len(out))
            out += f"{num} 0 obj\n".encode("ascii") + body + b"\nendobj\n"

        xref_at = len(out)
        n = len(self.objects) + 1
        out += f"xref\n0 {n}\n".encode("ascii")
        out += b"0000000000 65535 f \n"
        for off in offsets:
            out += f"{off:010d} 00000 n \n".encode("ascii")
        out += (
            f"trailer\n<< /Size {n} /Root {root} 0 R /Info {info} 0 R "
            f"/ID [<{FILE_ID}> <{FILE_ID}>] >>\n"
            f"startxref\n{xref_at}\n%%EOF\n"
        ).encode("ascii")
        return bytes(out)


def build() -> None:
    pdf = Pdf()

    # 1 catalog, 2 pages tree — both forward-reference objects allocated below,
    # which is legal and is why the numbers are reserved first.
    catalog = pdf.add(b"<< /Type /Catalog /Pages 2 0 R >>")
    pages_obj = pdf.add(b"")  # patched once the kids are known

    encoding = pdf.add(
        b"<< /Type /Encoding /BaseEncoding /WinAnsiEncoding "
        b"/Differences [254 /fl 255 /fi] >>"
    )
    helv = pdf.add(
        f"<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica "
        f"/Encoding {encoding} 0 R >>".encode("ascii")
    )
    helv_bold = pdf.add(
        f"<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica-Bold "
        f"/Encoding {encoding} 0 R >>".encode("ascii")
    )
    courier = pdf.add(
        f"<< /Type /Font /Subtype /Type1 /BaseFont /Courier "
        f"/Encoding {encoding} 0 R >>".encode("ascii")
    )

    img_w, img_h = 200, 150
    image = pdf.add_stream(
        f" /Type /XObject /Subtype /Image /Width {img_w} /Height {img_h}"
        " /ColorSpace /DeviceRGB /BitsPerComponent 8",
        noise_rgb(img_w, img_h, seed=1234),
    )

    resources = (
        f"<< /Font << /F1 {helv} 0 R /F2 {courier} 0 R /F3 {helv_bold} 0 R >>"
        f" /XObject << /Im1 {image} 0 R >> >>"
    )

    kids: list[int] = []
    for make_page in PAGES:
        content = pdf.add_stream("", make_page())
        kids.append(pdf.add(
            f"<< /Type /Page /Parent {pages_obj} 0 R "
            f"/MediaBox [0 0 {PAGE_W} {PAGE_H}] /Resources {resources} "
            f"/Contents {content} 0 R >>".encode("ascii")
        ))

    pdf.objects[pages_obj - 1] = (
        "<< /Type /Pages /Count {} /Kids [{}] >>".format(
            len(kids), " ".join(f"{k} 0 R" for k in kids)
        ).encode("ascii")
    )

    info = pdf.add(
        b"<< /Title (Refit Status \\227 USS Enterprise) "
        b"/Author (Geordi La Forge) "
        b"/Producer (slimdoc corpus generator) "
        b"/Creator (make-corpus-pdf.py) "
        + f"/CreationDate ({CREATION_DATE}) /ModDate ({CREATION_DATE}) >>"
        .encode("ascii")
    )

    with open(OUT, "wb") as fh:
        fh.write(pdf.build(catalog, info))
    print(f"wrote {OUT} ({os.path.getsize(OUT)} bytes)")


if __name__ == "__main__":
    build()
