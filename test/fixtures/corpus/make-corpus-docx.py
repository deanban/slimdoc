#!/usr/bin/env python3
"""Generate kitchen-sink.docx — the hostile Word corpus fixture for slimdoc.

No third-party dependencies: a .docx is just a zip of XML parts, and a PNG is a
handful of length-prefixed chunks around a zlib stream. Same approach, helpers
and conventions as test/fixtures/make-docx.py, scaled up to a document that
carries every category of noise the corpus README lists.

Deterministic throughout — fixed zip timestamps, fixed part order, sorted media,
seeded pixel noise, no clock and no `random` — so re-running produces a
byte-identical file. Verify with:

    shasum -a 256 kitchen-sink.docx && python3 make-corpus-docx.py && \\
    shasum -a 256 kitchen-sink.docx

Usage:  python3 test/fixtures/corpus/make-corpus-docx.py
"""

from __future__ import annotations

import os
import struct
import zlib
import zipfile

HERE = os.path.dirname(os.path.abspath(__file__))
OUT = os.path.join(HERE, "kitchen-sink.docx")

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

# Invisible / lookalike characters, named so the source below stays readable.
NBSP, SHY, ZWSP = " ", "­", "​"
LDQUO, RDQUO, LSQUO, RSQUO = "“", "”", "‘", "’"
EMDASH, ENDASH, ELLIPSIS = "—", "–", "…"
FI, FL, NBHY = "ﬁ", "ﬂ", "‑"

LEGAL = (
    "This document is intended solely for the addressee and may contain "
    "information proprietary to the Utopia Planitia Fleet Yards. If you are "
    "not the intended recipient, notify the sender and delete all copies."
)


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
    kilobytes even after the zip deflates it. That is what makes "no base64
    reached the output" assertions meaningful — a 1x1 pixel would prove nothing.
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

def esc(text: str) -> str:
    return text.replace("&", "&amp;").replace("<", "&lt;").replace(">", "&gt;")


def run(text: str, bold: bool = False, italic: bool = False,
        mono: bool = False) -> str:
    props = ""
    if bold:
        props += "<w:b/>"
    if italic:
        props += "<w:i/>"
    if mono:
        props += '<w:rFonts w:ascii="Consolas" w:hAnsi="Consolas"/>'
    rpr = f"<w:rPr>{props}</w:rPr>" if props else ""
    # A literal newline in `text` becomes a soft line break, which is how Word
    # stores a shift-enter — the in-cell newline case the corpus needs.
    body = "".join(
        ('<w:br/>' if i else '') + f'<w:t xml:space="preserve">{esc(part)}</w:t>'
        for i, part in enumerate(text.split("\n"))
    )
    return f"<w:r>{rpr}{body}</w:r>"


def para(*runs: str, style: str | None = None) -> str:
    ppr = f'<w:pPr><w:pStyle w:val="{style}"/></w:pPr>' if style else ""
    return f"<w:p>{ppr}{''.join(runs)}</w:p>"


def text_para(text: str, style: str | None = None, bold: bool = False,
              italic: bool = False) -> str:
    return para(run(text, bold=bold, italic=italic), style=style)


def code_para(text: str) -> str:
    """A monospaced paragraph with its leading whitespace preserved.

    Word has no code block, so a pasted snippet arrives as ordinary paragraphs
    whose indentation lives entirely in `xml:space="preserve"` text. Collapse it
    and the Python below changes meaning.
    """
    return para(run(text, mono=True), style="HTMLPreformatted")


def bullet(text: str, level: int = 0) -> str:
    return (
        '<w:p><w:pPr><w:pStyle w:val="ListParagraph"/><w:numPr>'
        f'<w:ilvl w:val="{level}"/><w:numId w:val="1"/>'
        "</w:numPr></w:pPr>"
        f"{run(text)}</w:p>"
    )


def numbered(text: str, level: int = 0) -> str:
    return (
        '<w:p><w:pPr><w:pStyle w:val="ListParagraph"/><w:numPr>'
        f'<w:ilvl w:val="{level}"/><w:numId w:val="2"/>'
        "</w:numPr></w:pPr>"
        f"{run(text)}</w:p>"
    )


def hyperlink(rel_id: str, text: str) -> str:
    return (
        f'<w:hyperlink r:id="{rel_id}">'
        f'<w:r><w:rPr><w:rStyle w:val="Hyperlink"/></w:rPr>'
        f'<w:t xml:space="preserve">{esc(text)}</w:t></w:r></w:hyperlink>'
    )


def cell(text: str, span: int = 1, vmerge: str | None = None,
         bold: bool = False) -> str:
    """One table cell.

    `span` emits w:gridSpan (colspan). `vmerge` is "restart" for the first cell
    of a vertical merge and "continue" for the cells it swallows — the rowspan
    case a Markdown table has no way to represent.
    """
    props = ""
    if span > 1:
        props += f'<w:gridSpan w:val="{span}"/>'
    if vmerge == "restart":
        props += '<w:vMerge w:val="restart"/>'
    elif vmerge == "continue":
        props += "<w:vMerge/>"
    # A blank line splits the cell into two paragraphs; a lone newline becomes
    # a soft break inside one run (see `run`). Both are ways a real cell holds
    # a line break, and both have to land in a single Markdown cell.
    paras = "".join(text_para(b, bold=bold) for b in text.split("\n\n"))
    return f"<w:tc><w:tcPr>{props}</w:tcPr>{paras}</w:tc>"


def table(rows: list[str], cols: int) -> str:
    grid = "".join(f'<w:gridCol w:w="{9360 // cols}"/>' for _ in range(cols))
    body = "".join(f"<w:tr>{r}</w:tr>" for r in rows)
    return (
        "<w:tbl><w:tblPr><w:tblStyle w:val=\"TableGrid\"/>"
        '<w:tblW w:w="0" w:type="auto"/></w:tblPr>'
        f"<w:tblGrid>{grid}</w:tblGrid>{body}</w:tbl>"
    )


def image_para(rel_id: str, doc_pr_id: int, name: str,
               descr: str | None) -> str:
    """An inline DrawingML picture — the shape a real Word export uses."""
    descr_attr = f' descr="{esc(descr)}"' if descr else ""
    return (
        "<w:p><w:r><w:drawing>"
        '<wp:inline distT="0" distB="0" distL="0" distR="0">'
        '<wp:extent cx="1905000" cy="1905000"/>'
        f'<wp:docPr id="{doc_pr_id}" name="{name}"{descr_attr}/>'
        "<a:graphic><a:graphicData "
        'uri="http://schemas.openxmlformats.org/drawingml/2006/picture">'
        "<pic:pic>"
        f'<pic:nvPicPr><pic:cNvPr id="{doc_pr_id}" name="{name}"{descr_attr}/>'
        "<pic:cNvPicPr/></pic:nvPicPr>"
        f'<pic:blipFill><a:blip r:embed="{rel_id}"/>'
        "<a:stretch><a:fillRect/></a:stretch></pic:blipFill>"
        '<pic:spPr><a:xfrm><a:off x="0" y="0"/>'
        '<a:ext cx="1905000" cy="1905000"/></a:xfrm>'
        '<a:prstGeom prst="rect"><a:avLst/></a:prstGeom></pic:spPr>'
        "</pic:pic></a:graphicData></a:graphic>"
        "</wp:inline></w:drawing></w:r></w:p>"
    )


# --------------------------------------------------------------------------
# Static parts
# --------------------------------------------------------------------------

def _style(style_id: str, name: str, kind: str = "paragraph") -> str:
    return (
        f'<w:style w:type="{kind}" w:styleId="{style_id}">'
        f'<w:name w:val="{name}"/></w:style>'
    )


STYLES_XML = XML_DECL + (
    f"<w:styles {NS}>"
    + _style("Normal", "Normal")
    + _style("Heading1", "heading 1")
    + _style("Heading2", "heading 2")
    + _style("Heading3", "heading 3")
    + _style("Heading4", "heading 4")
    + _style("ListParagraph", "List Paragraph")
    + _style("HTMLPreformatted", "HTML Preformatted")
    + _style("Quote", "Quote")
    + _style("Hyperlink", "Hyperlink", kind="character")
    + _style("TableGrid", "Table Grid", kind="table")
    + "</w:styles>"
)

NUMBERING_XML = XML_DECL + (
    f"<w:numbering {NS}>"
    '<w:abstractNum w:abstractNumId="0">'
    '<w:lvl w:ilvl="0"><w:numFmt w:val="bullet"/><w:lvlText w:val="•"/></w:lvl>'
    '<w:lvl w:ilvl="1"><w:numFmt w:val="bullet"/><w:lvlText w:val="o"/></w:lvl>'
    '<w:lvl w:ilvl="2"><w:numFmt w:val="bullet"/><w:lvlText w:val="▪"/></w:lvl>'
    "</w:abstractNum>"
    '<w:abstractNum w:abstractNumId="1">'
    '<w:lvl w:ilvl="0"><w:numFmt w:val="decimal"/><w:lvlText w:val="%1."/></w:lvl>'
    '<w:lvl w:ilvl="1"><w:numFmt w:val="lowerLetter"/><w:lvlText w:val="%2."/></w:lvl>'
    "</w:abstractNum>"
    '<w:num w:numId="1"><w:abstractNumId w:val="0"/></w:num>'
    '<w:num w:numId="2"><w:abstractNumId w:val="1"/></w:num>'
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

REL = "http://schemas.openxmlformats.org/officeDocument/2006/relationships"

DOC_RELS_XML = XML_DECL + (
    '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/'
    'relationships">'
    f'<Relationship Id="rId1" Type="{REL}/styles" Target="styles.xml"/>'
    f'<Relationship Id="rId2" Type="{REL}/numbering" Target="numbering.xml"/>'
    f'<Relationship Id="rId10" Type="{REL}/image" Target="media/image1.png"/>'
    f'<Relationship Id="rId11" Type="{REL}/image" Target="media/image2.png"/>'
    f'<Relationship Id="rId12" Type="{REL}/image" Target="media/image3.png"/>'
    f'<Relationship Id="rId13" Type="{REL}/image" Target="media/image4.png"/>'
    f'<Relationship Id="rId20" Type="{REL}/hyperlink" '
    'Target="https://fleetyards.example/refit/1701d" TargetMode="External"/>'
    f'<Relationship Id="rId21" Type="{REL}/hyperlink" '
    'Target="https://daystrom.example/reports/warp-core" TargetMode="External"/>'
    "</Relationships>"
)

SECT_PR = (
    "<w:sectPr>"
    '<w:pgSz w:w="12240" w:h="15840"/>'
    '<w:pgMar w:top="1440" w:right="1440" w:bottom="1440" w:left="1440"/>'
    "</w:sectPr>"
)


def write_docx(path: str, body: str, media: dict[str, bytes]) -> None:
    document = XML_DECL + (
        f"<w:document {NS}><w:body>{body}{SECT_PR}</w:body></w:document>"
    )
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
# Body sections
# --------------------------------------------------------------------------

def front_matter() -> list[str]:
    return [
        text_para("Refit Status " + EMDASH + " USS Enterprise", style="Heading1"),
        text_para(
            "Utopia" + NBSP + "Planitia Fleet Yards" + NBSP + ELLIPSIS
            + " Stardate 47988.1",
            italic=True,
        ),
        text_para(LEGAL, style="Quote"),
        # Whitespace abuse: a tab-indented line, a run of eight spaces, and
        # trailing whitespace, all inside ordinary prose paragraphs.
        text_para("\tTab-indented line, straight from a pasted mail client.   "),
        text_para("        Eight leading spaces, and trailing ones too.        "),
        text_para(""),
        text_para(""),
        text_para(""),
        text_para(""),
        text_para(""),
        text_para(""),
        text_para("Six empty paragraphs precede this line."),
    ]


def prose() -> list[str]:
    """Hard-wrapped prose with words hyphenated across the breaks.

    Word stores each of these as its own paragraph, which is exactly the shape
    that defeats a naive unwrapper: the sentences must be rejoined and the
    "inter-" / "mix" split repaired.
    """
    wrapped = [
        "The Utopia" + NBSP + "Planitia yards report that the plasma inter-",
        "mix chamber tolerances have drifted by four microns since",
        "the last refit, which the diagnostic subroutine flagged as",
        LDQUO + "within nominal" + RDQUO + " " + EMDASH + " a classi" + FI
        + "cation the Daystrom Insti-",
        "tute disputes. Warp " + FL + "ux stability held at 99.7" + NBSP
        + "% across",
        "all eighteen test cycles" + ELLIPSIS + " the remaining variance sits",
        "in the star" + SHY + "board nacelle, which Lt." + NBSP + "Barclay",
        "rebuilt in 2367 and which has never matched its twin.",
    ]
    return [
        text_para("Summary", style="Heading2"),
        *[text_para(line) for line in wrapped],
        para(
            run("Captain Picard" + RSQUO + "s standing order " + ENDASH + " "),
            run(LSQUO + "no shortcuts on the containment " + FI + "eld" + RSQUO,
                italic=True),
            run(" " + ENDASH + " still applies. "),
            run("Engineering signed off", bold=True),
            run(" at 0400" + ZWSP + " hours. \U0001f596 \U0001f680"),
        ),
        para(
            run("Full detail lives in "),
            hyperlink("rId20", "the refit dossier"),
            run(", mirrored at "),
            hyperlink("rId21", "https://daystrom.example/reports/warp-core"),
            run("."),
        ),
    ]


def headings_and_lists() -> list[str]:
    return [
        text_para("Findings", style="Heading2"),
        text_para("Propulsion", style="Heading3"),
        text_para("Warp field geometry", style="Heading4"),
        bullet("Warp core output up 12" + NBSP + "% year on year"),
        bullet("Dilithium articulation within tolerance"),
        bullet("Nacelle" + NBSP + "2 plasma injectors replaced", level=1),
        bullet("Injector " + NBHY + " serial UP" + NBHY + "4471", level=2),
        bullet("Injector " + NBHY + " serial UP" + NBHY + "4472", level=2),
        bullet("Containment field holding at 99.7" + NBSP + "%"),
        text_para("Sequence", style="Heading4"),
        numbered("Take the core offline and vent the intermix chamber."),
        numbered("Isolate the EPS taps on decks" + NBSP + "11 through 14."),
        numbered("Confirm with Engineering before the purge.", level=1),
        numbered("Log the stardate in the yards ledger.", level=1),
        numbered("Bring the core back to 20" + NBSP + "% and hold."),
        text_para("Related links", style="Heading3"),
        bullet("Refit status: USS Enterprise NCC" + NBHY + "1701" + NBHY + "C"),
        bullet("Refit status: USS Defiant"),
        bullet("About Utopia Planitia"),
        bullet("Subscribe to the yards newsletter"),
    ]


def images() -> list[str]:
    """Four pictures: meaningful alt, junk alt, junk name, and no alt at all."""
    return [
        text_para("Imagery", style="Heading2"),
        image_para("rId10", 1, "chart.png",
                   "Warp core output by quarter, 2364 to 2370, rising to 1.9 "
                   "teradynes"),
        text_para("Figure" + NBSP + "1 " + EMDASH + " warp core output trend",
                  italic=True),
        image_para("rId11", 2, "image1.png", "image1.png"),
        image_para("rId12", 3, "Picture 3", None),
        image_para("rId13", 4, "avatar", "avatar"),
    ]


def tables() -> list[str]:
    """Four tables: clean grid, merged cells, single column, hostile cells."""
    clean = table([
        "".join([cell("Subsystem", bold=True), cell("Owner", bold=True),
                 cell("Status", bold=True), cell("Margin", bold=True)]),
        "".join([cell("Warp core"), cell("La Forge"), cell("Green"),
                 cell("12" + NBSP + "%")]),
        "".join([cell("Deflector"), cell("Data"), cell("Green"),
                 cell("8" + NBSP + "%")]),
        "".join([cell("Transporters"), cell("O" + RSQUO + "Brien"),
                 cell("Amber"), cell("2" + NBSP + "%")]),
        "".join([cell("Holodeck" + NBSP + "3"), cell("Barclay"), cell("Red"),
                 cell(ENDASH + "4" + NBSP + "%")]),
    ], cols=4)

    merged = table([
        # Row 1: "Deck" starts a vertical merge; the shift headers span two.
        "".join([cell("Deck", vmerge="restart", bold=True),
                 cell("Alpha shift", span=2, bold=True),
                 cell("Beta shift", span=2, bold=True)]),
        "".join([cell("", vmerge="continue"), cell("Crew", bold=True),
                 cell("Load", bold=True), cell("Crew", bold=True),
                 cell("Load", bold=True)]),
        "".join([cell("36"), cell("12"), cell("61" + NBSP + "%"), cell("9"),
                 cell("44" + NBSP + "%")]),
        # A four-column merge swallowing an entire row of data.
        "".join([cell("10"),
                 cell("Evacuated during the refit " + EMDASH + " no shift data",
                      span=4)]),
        "".join([cell("4", vmerge="restart"), cell("7"),
                 cell("30" + NBSP + "%"), cell("7"), cell("31" + NBSP + "%")]),
        "".join([cell("", vmerge="continue"), cell("8"),
                 cell("35" + NBSP + "%"), cell("6"), cell("28" + NBSP + "%")]),
    ], cols=5)

    single = table([
        "".join([cell("Outstanding work orders", bold=True)]),
        "".join([cell("Recalibrate the lateral sensor array")]),
        "".join([cell("Replace EPS conduit, deck" + NBSP + "12")]),
        "".join([cell("Purge the Jefferies tube" + NBSP + "17 plasma relay")]),
    ], cols=1)

    hostile = table([
        "".join([cell("Field", bold=True), cell("Value", bold=True)]),
        "".join([cell("Regex used by the parser"),
                 cell("^(warp|impulse|thruster)$")]),
        "".join([cell("Shell snippet"),
                 cell("tricorder --scan | grep dilithium | wc -l")]),
        "".join([cell("Multi-line note"),
                 cell("Line one of the note.\n\nLine two, same cell."
                      "\n\nLine three.")]),
        "".join([cell("Soft break inside a run"),
                 cell("first half\nsecond half")]),
        "".join([cell("Empty next"), cell("")]),
    ], cols=2)

    return [
        text_para("Diagnostics", style="Heading2"),
        text_para("Clean grid", style="Heading3"),
        clean,
        text_para("Merged cells", style="Heading3"),
        merged,
        text_para("Single column", style="Heading3"),
        single,
        text_para("Hostile cells", style="Heading3"),
        hostile,
    ]


def code() -> list[str]:
    """Pasted code: indentation is the semantics, and a nested fence appears."""
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
    return [
        text_para("Runbook", style="Heading2"),
        para(
            run("Call "), run("warpCore.eject()", mono=True),
            run(" only after "), run("containment.lock()", mono=True),
            run(" returns "), run("true", mono=True),
            run("; the "), run("--force", mono=True),
            run(" flag is not a substitute."),
        ),
        text_para("Indented Python, pasted from a terminal:", style="Heading3"),
        *[code_para(line) for line in python],
        text_para("A Markdown sample containing its own fence:",
                  style="Heading3"),
        *[code_para(line) for line in markdown],
    ]


def back_matter() -> list[str]:
    return [
        text_para("Sign-off", style="Heading2"),
        text_para("Signed off by the board on 2370" + NBHY + "10" + NBHY + "01.",
                  bold=True),
        text_para(LEGAL),
        text_para(LEGAL),
        text_para("Privacy" + NBSP + "|" + NBSP + "Terms" + NBSP + "|"
                  + NBSP + "Cookie policy" + NBSP + "|" + NBSP + "Accessibility"),
        text_para("© 2370 Starfleet Corps of Engineers. All rights "
                  "reserved.    "),
    ]


def build() -> None:
    body = "".join([
        *front_matter(),
        *prose(),
        *headings_and_lists(),
        *images(),
        *tables(),
        *code(),
        *back_matter(),
    ])
    media = {
        "word/media/image1.png": make_png(120, 120, seed=1234),
        "word/media/image2.png": make_png(96, 96, seed=99),
        "word/media/image3.png": make_png(80, 80, seed=31337),
        "word/media/image4.png": make_png(64, 64, seed=8675309),
    }
    write_docx(OUT, body, media)
    print(f"wrote {OUT} ({os.path.getsize(OUT)} bytes)")


if __name__ == "__main__":
    build()
