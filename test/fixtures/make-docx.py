#!/usr/bin/env python3
"""Generate the .docx test fixtures for slimdoc from scratch.

No third-party dependencies: a .docx is just a zip of XML parts, and a PNG is
a handful of length-prefixed chunks around a zlib stream. Everything here is
deterministic (fixed zip timestamps, seeded pixel noise) so re-running the
script produces a byte-identical file and the fixtures stay diff-clean.

Usage:  python3 test/fixtures/make-docx.py
"""

from __future__ import annotations

import os
import struct
import zlib
import zipfile

HERE = os.path.dirname(os.path.abspath(__file__))

# Fixed timestamp so the zip is reproducible.
ZIP_DATE = (2024, 1, 1, 0, 0, 0)

NS = (
    'xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main" '
    'xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" '
    'xmlns:wp="http://schemas.openxmlformats.org/drawingml/2006/wordprocessingDrawing" '
    'xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" '
    'xmlns:pic="http://schemas.openxmlformats.org/drawingml/2006/picture"'
)

XML_DECL = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n'


# --------------------------------------------------------------------------
# PNG synthesis
# --------------------------------------------------------------------------

def _chunk(tag: bytes, data: bytes) -> bytes:
    return (
        struct.pack(">I", len(data))
        + tag
        + data
        + struct.pack(">I", zlib.crc32(tag + data) & 0xFFFFFFFF)
    )


def make_png(width: int, height: int, seed: int = 1234) -> bytes:
    """A deterministic RGB noise PNG.

    Noise on purpose: it barely compresses, so the embedded image is tens of
    kilobytes. That is what makes the "no base64 in the output" assertion in
    test/extract.test.js meaningful — a 1x1 pixel would prove nothing.
    """
    state = seed & 0xFFFFFFFF
    raw = bytearray()
    for _y in range(height):
        raw.append(0)  # filter type 0 (None) for this scanline
        for _x in range(width * 3):
            # Numerical Recipes LCG; keeps the fixture independent of the
            # Python version's `random` implementation.
            state = (1664525 * state + 1013904223) & 0xFFFFFFFF
            raw.append((state >> 16) & 0xFF)

    ihdr = struct.pack(">IIBBBBB", width, height, 8, 2, 0, 0, 0)
    return (
        b"\x89PNG\r\n\x1a\n"
        + _chunk(b"IHDR", ihdr)
        + _chunk(b"IDAT", zlib.compress(bytes(raw), 6))
        + _chunk(b"IEND", b"")
    )


# --------------------------------------------------------------------------
# WordprocessingML fragments
# --------------------------------------------------------------------------

def para(text: str, style: str | None = None, bold: bool = False) -> str:
    ppr = f"<w:pPr><w:pStyle w:val=\"{style}\"/></w:pPr>" if style else ""
    rpr = "<w:rPr><w:b/></w:rPr>" if bold else ""
    return (
        f"<w:p>{ppr}<w:r>{rpr}"
        f'<w:t xml:space="preserve">{text}</w:t></w:r></w:p>'
    )


def bullet(text: str, level: int = 0) -> str:
    return (
        "<w:p><w:pPr><w:numPr>"
        f'<w:ilvl w:val="{level}"/><w:numId w:val="1"/>'
        "</w:numPr></w:pPr>"
        f'<w:r><w:t xml:space="preserve">{text}</w:t></w:r></w:p>'
    )


def table(rows: list[list[str]]) -> str:
    out = ["<w:tbl>"]
    for row in rows:
        out.append("<w:tr>")
        for cell in row:
            out.append(
                "<w:tc><w:tcPr/>"
                f'<w:p><w:r><w:t xml:space="preserve">{cell}</w:t></w:r></w:p>'
                "</w:tc>"
            )
        out.append("</w:tr>")
    out.append("</w:tbl>")
    return "".join(out)


def image_para(rel_id: str, doc_pr_id: int, name: str, descr: str | None) -> str:
    """An inline DrawingML picture — the shape a real Word export uses."""
    descr_attr = f' descr="{descr}"' if descr else ""
    return (
        "<w:p><w:r><w:drawing>"
        '<wp:inline distT="0" distB="0" distL="0" distR="0">'
        '<wp:extent cx="952500" cy="952500"/>'
        f'<wp:docPr id="{doc_pr_id}" name="{name}"{descr_attr}/>'
        "<a:graphic><a:graphicData "
        'uri="http://schemas.openxmlformats.org/drawingml/2006/picture">'
        "<pic:pic>"
        f'<pic:nvPicPr><pic:cNvPr id="{doc_pr_id}" name="{name}"{descr_attr}/>'
        "<pic:cNvPicPr/></pic:nvPicPr>"
        f'<pic:blipFill><a:blip r:embed="{rel_id}"/>'
        "<a:stretch><a:fillRect/></a:stretch></pic:blipFill>"
        '<pic:spPr><a:xfrm><a:off x="0" y="0"/>'
        '<a:ext cx="952500" cy="952500"/></a:xfrm>'
        '<a:prstGeom prst="rect"><a:avLst/></a:prstGeom></pic:spPr>'
        "</pic:pic></a:graphicData></a:graphic>"
        "</wp:inline></w:drawing></w:r></w:p>"
    )


STYLES_XML = XML_DECL + (
    f"<w:styles {NS}>"
    '<w:style w:type="paragraph" w:styleId="Normal"><w:name w:val="Normal"/></w:style>'
    '<w:style w:type="paragraph" w:styleId="Heading1">'
    '<w:name w:val="heading 1"/></w:style>'
    '<w:style w:type="paragraph" w:styleId="Heading2">'
    '<w:name w:val="heading 2"/></w:style>'
    '<w:style w:type="paragraph" w:styleId="ListParagraph">'
    '<w:name w:val="List Paragraph"/></w:style>'
    "</w:styles>"
)

NUMBERING_XML = XML_DECL + (
    f"<w:numbering {NS}>"
    '<w:abstractNum w:abstractNumId="0">'
    '<w:lvl w:ilvl="0"><w:numFmt w:val="bullet"/>'
    '<w:lvlText w:val="•"/></w:lvl>'
    '<w:lvl w:ilvl="1"><w:numFmt w:val="bullet"/>'
    '<w:lvlText w:val="o"/></w:lvl>'
    "</w:abstractNum>"
    '<w:num w:numId="1"><w:abstractNumId w:val="0"/></w:num>'
    "</w:numbering>"
)

CONTENT_TYPES_XML = XML_DECL + (
    '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">'
    '<Default Extension="rels" '
    'ContentType="application/vnd.openxmlformats-package.relationships+xml"/>'
    '<Default Extension="xml" ContentType="application/xml"/>'
    '<Default Extension="png" ContentType="image/png"/>'
    '<Override PartName="/word/document.xml" ContentType="application/vnd.'
    'openxmlformats-officedocument.wordprocessingml.document.main+xml"/>'
    '<Override PartName="/word/styles.xml" ContentType="application/vnd.'
    'openxmlformats-officedocument.wordprocessingml.styles+xml"/>'
    '<Override PartName="/word/numbering.xml" ContentType="application/vnd.'
    'openxmlformats-officedocument.wordprocessingml.numbering+xml"/>'
    "</Types>"
)

ROOT_RELS_XML = XML_DECL + (
    '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/'
    'relationships">'
    '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/'
    'officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/>'
    "</Relationships>"
)

DOC_RELS_XML = XML_DECL + (
    '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/'
    'relationships">'
    '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/'
    'officeDocument/2006/relationships/styles" Target="styles.xml"/>'
    '<Relationship Id="rId2" Type="http://schemas.openxmlformats.org/'
    'officeDocument/2006/relationships/numbering" Target="numbering.xml"/>'
    '<Relationship Id="rId10" Type="http://schemas.openxmlformats.org/'
    'officeDocument/2006/relationships/image" Target="media/image1.png"/>'
    '<Relationship Id="rId11" Type="http://schemas.openxmlformats.org/'
    'officeDocument/2006/relationships/image" Target="media/image2.png"/>'
    "</Relationships>"
)


def write_docx(path: str, body: str, media: dict[str, bytes]) -> None:
    document = XML_DECL + f"<w:document {NS}><w:body>{body}</w:body></w:document>"
    parts: list[tuple[str, bytes]] = [
        ("[Content_Types].xml", CONTENT_TYPES_XML.encode("utf-8")),
        ("_rels/.rels", ROOT_RELS_XML.encode("utf-8")),
        ("word/document.xml", document.encode("utf-8")),
        ("word/_rels/document.xml.rels", DOC_RELS_XML.encode("utf-8")),
        ("word/styles.xml", STYLES_XML.encode("utf-8")),
        ("word/numbering.xml", NUMBERING_XML.encode("utf-8")),
    ]
    parts.extend((name, data) for name, data in sorted(media.items()))

    with zipfile.ZipFile(path, "w", zipfile.ZIP_DEFLATED) as zf:
        for name, data in parts:
            info = zipfile.ZipInfo(name, date_time=ZIP_DATE)
            info.compress_type = zipfile.ZIP_DEFLATED
            info.external_attr = 0o644 << 16
            zf.writestr(info, data)


# --------------------------------------------------------------------------
# sample.docx
# --------------------------------------------------------------------------

def build_sample() -> None:
    body = "".join([
        para("Quarterly Review", style="Heading1"),
        para(
            "The team’s “Q3 numbers” came in ahead of plan "
            "— the first time since 2019.",
        ),
        # A meaningful alt: extraction should keep "[image: ...]" and nothing else.
        image_para("rId10", 1, "chart.png", "Revenue by quarter, 2019 to 2024"),
        para("Highlights", style="Heading2"),
        bullet("Revenue up 12% year on year"),
        bullet("Churn down to 1.8%"),
        bullet("Two enterprise logos signed — both multi‑year"),
        bullet("Support backlog cleared", level=1),
        # No alt at all: this is the avatar/decoration case, dropped outright.
        image_para("rId11", 2, "Picture 2", None),
        para("Numbers", style="Heading2"),
        table([
            ["Quarter", "Revenue", "Notes"],
            ["Q1", "1.2M", "flat"],
            ["Q2", "1.4M", "the “big deal” landed"],
            ["Q3", "1.9M", "ahead of plan — see above"],
        ]),
        para("Signed off by the board on 2024‑10‑01.", bold=True),
    ])
    media = {
        "word/media/image1.png": make_png(96, 96, seed=1234),
        "word/media/image2.png": make_png(64, 64, seed=99),
    }
    out = os.path.join(HERE, "sample.docx")
    write_docx(out, body, media)
    print(f"wrote {out} ({os.path.getsize(out)} bytes)")


if __name__ == "__main__":
    build_sample()
