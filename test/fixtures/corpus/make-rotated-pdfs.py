#!/usr/bin/env python3
"""Generate rotated-{0,90,180,270}.pdf — one document, four page rotations.

Four files carrying byte-for-byte the same content stream, differing only in
each page's `/Rotate`. A viewer turns the paper; the text does not move. Every
glyph stays where it was in unrotated user space, which is also where
`getTextContent()` reports it — so all four must extract to identical text, and
any difference between them is slimdoc reading a rotated page wrongly.

Five pages, because running-header suppression needs four before it will call
anything repeated, and the defect this fixture exists for only shows up once
suppression is running.

Each page carries three kinds of line:

  * a banner at y=750 and a `Page N of 5` counter at y=40 — furniture, in the
    top and bottom margin bands, and meant to be suppressed;
  * a clause at y=660, identical on all five pages, which is *body* text and
    must survive on all five. It sits about 17% down the page: inside the body
    on a page 792 points tall, and inside the top margin band on a page
    mistakenly measured as 612;
  * prose that differs per page, so a wrongly deleted line is visible as a hole
    rather than as a smaller identical document.

Deterministic: a fixed `/CreationDate`, a fixed `/ID`, no clock, no random.
Re-running produces four byte-identical files. Verify with:

    shasum -a 256 rotated-*.pdf && python3 make-rotated-pdfs.py && \\
    shasum -a 256 rotated-*.pdf

Usage:  python3 test/fixtures/corpus/make-rotated-pdfs.py
"""

from __future__ import annotations

import os

HERE = os.path.dirname(os.path.abspath(__file__))

# US Letter, in points. The tall dimension is what the text is positioned
# against; a /Rotate 90 viewport reports the short one.
PAGE_W, PAGE_H = 612, 792

CREATION_DATE = "D:20240101000000Z"
FILE_ID = "5553532d454e5445525052495345313730314400000000"

BANNER = "UTOPIA PLANITIA FLEET YARDS"
# Repeated verbatim on every page, and deliberately not furniture: it is the
# line a page height taken from a rotated viewport pushes into the margin band.
STANDING_CLAUSE = "All figures are provisional pending the Daystrom review."

BODY = [
    [
        "Dry dock four reports the saucer separation servos within tolerance",
        "after the third alignment pass. The starboard nacelle pylon remains",
        "on the schedule agreed at the last review.",
    ],
    [
        "Plasma intermix chamber pressures held steady through the eleven hour",
        "burn-in. Commander La Forge signed off on the injector timing without",
        "a further recalibration.",
    ],
    [
        "The deflector array was re-tuned against the Jupiter Station baseline.",
        "Two emitters were replaced outright; the remainder cleaned inspection",
        "at full output.",
    ],
    [
        "Crew quarters on decks seven through nine are fitted and pressurised.",
        "Environmental control reports no leaks after seventy hours of held",
        "atmosphere.",
    ],
    [
        "Warp core recertification is scheduled for the coming stardate. Until",
        "it completes, the yard classifies this vessel as under refit and not",
        "as available for assignment.",
    ],
]


def pdf_string(text: str) -> bytes:
    """A PDF literal string. The corpus is plain ASCII, so escaping is enough."""
    out = bytearray(b"(")
    for ch in text:
        code = ord(ch)
        if code > 126:
            raise ValueError(f"non-ASCII character {ch!r} in a rotated fixture")
        if code in (0x28, 0x29, 0x5C):  # ( ) \
            out += b"\\" + bytes([code])
        else:
            out.append(code)
    out += b")"
    return bytes(out)


def show(x: float, y: float, text: str, size: float = 10) -> bytes:
    return (
        f"BT /F1 {size:g} Tf {x:g} {y:g} Td ".encode("ascii")
        + pdf_string(text)
        + b" Tj ET\n"
    )


def content_for(page: int) -> bytes:
    out = bytearray()
    out += show(54, 750, BANNER)
    out += show(54, 660, STANDING_CLAUSE)
    for i, text in enumerate(BODY[page - 1]):
        out += show(54, 560 - i * 14, text)
    out += show(54, 40, f"Page {page} of {len(BODY)}")
    return bytes(out)


class Pdf:
    """A minimal indirect-object writer with a real cross-reference table."""

    def __init__(self) -> None:
        self.objects: list[bytes] = []

    def add(self, body: bytes) -> int:
        self.objects.append(body)
        return len(self.objects)

    def add_stream(self, data: bytes) -> int:
        head = f"<< /Length {len(data)} >>\nstream\n".encode("ascii")
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


def build(rotate: int) -> None:
    pdf = Pdf()
    catalog = pdf.add(b"<< /Type /Catalog /Pages 2 0 R >>")
    pages_obj = pdf.add(b"")  # patched once the kids are known
    helv = pdf.add(
        b"<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica "
        b"/Encoding /WinAnsiEncoding >>"
    )
    resources = f"<< /Font << /F1 {helv} 0 R >> >>"

    kids: list[int] = []
    for page in range(1, len(BODY) + 1):
        content = pdf.add_stream(content_for(page))
        kids.append(pdf.add(
            f"<< /Type /Page /Parent {pages_obj} 0 R "
            f"/MediaBox [0 0 {PAGE_W} {PAGE_H}] /Rotate {rotate} "
            f"/Resources {resources} /Contents {content} 0 R >>".encode("ascii")
        ))

    pdf.objects[pages_obj - 1] = (
        "<< /Type /Pages /Count {} /Kids [{}] >>".format(
            len(kids), " ".join(f"{k} 0 R" for k in kids)
        ).encode("ascii")
    )

    info = pdf.add(
        b"<< /Title (Refit Status \\227 rotated) "
        b"/Producer (slimdoc corpus generator) "
        b"/Creator (make-rotated-pdfs.py) "
        + f"/CreationDate ({CREATION_DATE}) /ModDate ({CREATION_DATE}) >>"
        .encode("ascii")
    )

    out = os.path.join(HERE, f"rotated-{rotate}.pdf")
    with open(out, "wb") as fh:
        fh.write(pdf.build(catalog, info))
    print(f"wrote {out} ({os.path.getsize(out)} bytes)")


if __name__ == "__main__":
    for rotation in (0, 90, 180, 270):
        build(rotation)
