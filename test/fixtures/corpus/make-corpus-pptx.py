#!/usr/bin/env python3
"""Generate kitchen-sink.pptx — the hostile PowerPoint corpus fixture for slimdoc.

No third-party dependencies: a .pptx is a zip of PresentationML parts, and a PNG
is a handful of length-prefixed chunks around a zlib stream. Same helpers,
docstring conventions and determinism rules as test/fixtures/make-docx.py —
fixed zip timestamps, fixed part order, sorted media, seeded pixel noise, no
clock and no `random`. Re-running produces a byte-identical file. Verify with:

    shasum -a 256 kitchen-sink.pptx && python3 make-corpus-pptx.py && \\
    shasum -a 256 kitchen-sink.pptx

The deck deliberately breaks the assumptions a naive reader makes:

  * `<p:sldIdLst>` is permuted, so presentation order is not slideN.xml order;
  * one slide is `show="0"` and must not appear in default output;
  * a text box sits entirely off-canvas at negative coordinates;
  * the slide master and layout carry text that must never reach the output;
  * a group shape has a scaling, rotating transform, so child coordinates are
    in the group's own space rather than the slide's;
  * the chart carries real `<c:ser>` caches, and the SmartArt its real text,
    neither of which lives in a `<p:sp>` where a shape walker would find it.

Usage:  python3 test/fixtures/corpus/make-corpus-pptx.py
"""

from __future__ import annotations

import os
import struct
import zlib
import zipfile

HERE = os.path.dirname(os.path.abspath(__file__))
OUT = os.path.join(HERE, "kitchen-sink.pptx")

# Fixed timestamp so the zip is reproducible.
ZIP_DATE = (2024, 1, 1, 0, 0, 0)

XML_DECL = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n'

A = "http://schemas.openxmlformats.org/drawingml/2006/main"
P = "http://schemas.openxmlformats.org/presentationml/2006/main"
R = "http://schemas.openxmlformats.org/officeDocument/2006/relationships"
C = "http://schemas.openxmlformats.org/drawingml/2006/chart"
DGM = "http://schemas.openxmlformats.org/drawingml/2006/diagram"

P_NS = f'xmlns:a="{A}" xmlns:r="{R}" xmlns:p="{P}"'
CT = "application/vnd.openxmlformats-officedocument"

# 16:9 deck, in EMU.
SLIDE_CX, SLIDE_CY = 12192000, 6858000

# Invisible / lookalike characters, named so the source below stays readable.
NBSP, SHY, ZWSP = " ", "­", "​"
LDQUO, RDQUO, LSQUO, RSQUO = "“", "”", "‘", "’"
EMDASH, ENDASH, ELLIPSIS = "—", "–", "…"
FI, FL, NBHY = "ﬁ", "ﬂ", "‑"

LEGAL = (
    "Utopia Planitia Fleet Yards internal " + EMDASH + " not for distribution "
    "outside Starfleet Corps of Engineers."
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
    kilobytes even after the zip deflates it. That is what makes "no image
    bytes reached the output" assertions meaningful — a 1x1 pixel would prove
    nothing.
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
# DrawingML fragments
# --------------------------------------------------------------------------

def esc(text: str) -> str:
    return (
        text.replace("&", "&amp;").replace("<", "&lt;").replace(">", "&gt;")
        .replace('"', "&quot;")
    )


def tp(text: str, level: int = 0, bold: bool = False,
       bullet: bool = False) -> str:
    """One `<a:p>`.

    `level` is the outline depth PowerPoint stores as `lvl`; it is the only
    record that a bullet is nested, since the glyph itself comes from the
    layout. An empty string yields an empty paragraph, which is how a deck
    stores a blank line.
    """
    props = []
    if level:
        props.append(f'lvl="{level}"')
    ppr = f'<a:pPr {" ".join(props)}/>' if props else ""
    if bullet:
        ppr = (
            f'<a:pPr {" ".join(props)}><a:buChar char="•"/></a:pPr>'
            if props else '<a:pPr><a:buChar char="•"/></a:pPr>'
        )
    if not text:
        return f"<a:p>{ppr}<a:endParaRPr lang=\"en-US\"/></a:p>"
    rpr = '<a:rPr lang="en-US" b="1" dirty="0"/>' if bold \
        else '<a:rPr lang="en-US" dirty="0"/>'
    return f"<a:p>{ppr}<a:r>{rpr}<a:t>{esc(text)}</a:t></a:r></a:p>"


def sp(shape_id: int, name: str, x: int, y: int, cx: int, cy: int,
       paras: list[str], ph: str | None = None, ph_idx: int | None = None,
       descr: str | None = None) -> str:
    """A text-bearing autoshape."""
    nv = ""
    if ph is not None:
        idx = f' idx="{ph_idx}"' if ph_idx is not None else ""
        nv = f'<p:ph type="{ph}"{idx}/>'
    descr_attr = f' descr="{esc(descr)}"' if descr else ""
    return (
        "<p:sp><p:nvSpPr>"
        f'<p:cNvPr id="{shape_id}" name="{esc(name)}"{descr_attr}/>'
        '<p:cNvSpPr><a:spLocks noGrp="1"/></p:cNvSpPr>'
        f"<p:nvPr>{nv}</p:nvPr></p:nvSpPr>"
        f'<p:spPr><a:xfrm><a:off x="{x}" y="{y}"/>'
        f'<a:ext cx="{cx}" cy="{cy}"/></a:xfrm>'
        '<a:prstGeom prst="rect"><a:avLst/></a:prstGeom></p:spPr>'
        f'<p:txBody><a:bodyPr wrap="square"/><a:lstStyle/>'
        f"{''.join(paras)}</p:txBody></p:sp>"
    )


def pic(shape_id: int, name: str, rel_id: str, x: int, y: int, cx: int,
        cy: int, descr: str | None) -> str:
    """A picture. `descr` is PowerPoint's alt text."""
    descr_attr = f' descr="{esc(descr)}"' if descr else ""
    return (
        "<p:pic><p:nvPicPr>"
        f'<p:cNvPr id="{shape_id}" name="{esc(name)}"{descr_attr}/>'
        '<p:cNvPicPr><a:picLocks noChangeAspect="1"/></p:cNvPicPr>'
        "<p:nvPr/></p:nvPicPr>"
        f'<p:blipFill><a:blip r:embed="{rel_id}"/>'
        "<a:stretch><a:fillRect/></a:stretch></p:blipFill>"
        f'<p:spPr><a:xfrm><a:off x="{x}" y="{y}"/>'
        f'<a:ext cx="{cx}" cy="{cy}"/></a:xfrm>'
        '<a:prstGeom prst="rect"><a:avLst/></a:prstGeom></p:spPr></p:pic>'
    )


def group(shape_id: int, children: list[str]) -> str:
    """A group whose transform is emphatically not the identity.

    The child extent is a quarter of the group extent and the whole thing is
    rotated 20 degrees, so a reader that takes child `a:off` values as slide
    coordinates places this text in the wrong half of the slide. Reading order
    by raw coordinate is wrong here; document order is right.
    """
    return (
        "<p:grpSp><p:nvGrpSpPr>"
        f'<p:cNvPr id="{shape_id}" name="Group {shape_id - 1}"/>'
        "<p:cNvGrpSpPr/><p:nvPr/></p:nvGrpSpPr>"
        '<p:grpSpPr><a:xfrm rot="1200000">'
        '<a:off x="6858000" y="3900000"/><a:ext cx="4400000" cy="2000000"/>'
        '<a:chOff x="0" y="0"/><a:chExt cx="1100000" cy="500000"/>'
        "</a:xfrm></p:grpSpPr>"
        f"{''.join(children)}</p:grpSp>"
    )


def tc(text: str, span: int = 1, hmerge: bool = False, rowspan: int = 1,
       vmerge: bool = False, bold: bool = False) -> str:
    """One table cell.

    A horizontally merged cell is `gridSpan` on the first cell followed by
    `hMerge="1"` placeholders; a vertically merged one is `rowSpan` followed by
    `vMerge="1"`. The placeholders are real cells with empty text, so a reader
    that ignores the merge attributes emits phantom empty columns.
    """
    attrs = ""
    if span > 1:
        attrs += f' gridSpan="{span}"'
    if hmerge:
        attrs += ' hMerge="1"'
    if rowspan > 1:
        attrs += f' rowSpan="{rowspan}"'
    if vmerge:
        attrs += ' vMerge="1"'
    return (
        f"<a:tc{attrs}><a:txBody><a:bodyPr/><a:lstStyle/>"
        f"{tp(text, bold=bold)}</a:txBody><a:tcPr/></a:tc>"
    )


def tbl_frame(shape_id: int, name: str, x: int, y: int, cx: int, cy: int,
              widths: list[int], rows: list[str]) -> str:
    grid = "".join(f'<a:gridCol w="{w}"/>' for w in widths)
    body = "".join(f'<a:tr h="370840">{r}</a:tr>' for r in rows)
    return (
        "<p:graphicFrame><p:nvGraphicFramePr>"
        f'<p:cNvPr id="{shape_id}" name="{esc(name)}"/>'
        '<p:cNvGraphicFramePr><a:graphicFrameLocks noGrp="1"/>'
        "</p:cNvGraphicFramePr><p:nvPr/></p:nvGraphicFramePr>"
        f'<p:xfrm><a:off x="{x}" y="{y}"/><a:ext cx="{cx}" cy="{cy}"/></p:xfrm>'
        f'<a:graphic><a:graphicData uri="{A}/table">'
        '<a:tbl><a:tblPr firstRow="1" bandRow="1"/>'
        f"<a:tblGrid>{grid}</a:tblGrid>{body}</a:tbl>"
        "</a:graphicData></a:graphic></p:graphicFrame>"
    )


def chart_frame(shape_id: int, rel_id: str) -> str:
    return (
        "<p:graphicFrame><p:nvGraphicFramePr>"
        f'<p:cNvPr id="{shape_id}" name="Chart {shape_id - 1}"/>'
        "<p:cNvGraphicFramePr/><p:nvPr/></p:nvGraphicFramePr>"
        '<p:xfrm><a:off x="700000" y="1500000"/>'
        '<a:ext cx="6000000" cy="4200000"/></p:xfrm>'
        f'<a:graphic><a:graphicData uri="{C}">'
        f'<c:chart xmlns:c="{C}" xmlns:r="{R}" r:id="{rel_id}"/>'
        "</a:graphicData></a:graphic></p:graphicFrame>"
    )


def dgm_frame(shape_id: int) -> str:
    """A SmartArt frame. Its text lives in diagrams/data1.xml, not here."""
    return (
        "<p:graphicFrame><p:nvGraphicFramePr>"
        f'<p:cNvPr id="{shape_id}" name="Diagram {shape_id - 1}"/>'
        "<p:cNvGraphicFramePr/><p:nvPr/></p:nvGraphicFramePr>"
        '<p:xfrm><a:off x="700000" y="1500000"/>'
        '<a:ext cx="10000000" cy="4200000"/></p:xfrm>'
        f'<a:graphic><a:graphicData uri="{DGM}">'
        f'<dgm:relIds xmlns:dgm="{DGM}" xmlns:r="{R}" '
        'r:dm="rId2" r:lo="rId3" r:qs="rId4" r:cs="rId5"/>'
        "</a:graphicData></a:graphic></p:graphicFrame>"
    )


def slide(shapes: list[str], show: bool = True) -> str:
    show_attr = "" if show else ' show="0"'
    return XML_DECL + (
        f"<p:sld {P_NS}{show_attr}><p:cSld><p:spTree>"
        '<p:nvGrpSpPr><p:cNvPr id="1" name=""/><p:cNvGrpSpPr/><p:nvPr/>'
        "</p:nvGrpSpPr>"
        '<p:grpSpPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="0" cy="0"/>'
        '<a:chOff x="0" y="0"/><a:chExt cx="0" cy="0"/></a:xfrm></p:grpSpPr>'
        f"{''.join(shapes)}"
        "</p:spTree></p:cSld>"
        "<p:clrMapOvr><a:masterClrMapping/></p:clrMapOvr></p:sld>"
    )


# --------------------------------------------------------------------------
# Master, layout and theme — all of this text must stay out of the output
# --------------------------------------------------------------------------

_ACCENTS = ["4472C4", "ED7D31", "A5A5A5", "FFC000", "5B9BD5", "70AD47"]

THEME_XML = XML_DECL + (
    f'<a:theme xmlns:a="{A}" name="Utopia">'
    '<a:themeElements><a:clrScheme name="Utopia">'
    '<a:dk1><a:sysClr val="windowText" lastClr="000000"/></a:dk1>'
    '<a:lt1><a:sysClr val="window" lastClr="FFFFFF"/></a:lt1>'
    '<a:dk2><a:srgbClr val="44546A"/></a:dk2>'
    '<a:lt2><a:srgbClr val="E7E6E6"/></a:lt2>'
    + "".join(
        f'<a:accent{i + 1}><a:srgbClr val="{c}"/></a:accent{i + 1}>'
        for i, c in enumerate(_ACCENTS)
    )
    + '<a:hlink><a:srgbClr val="0563C1"/></a:hlink>'
    '<a:folHlink><a:srgbClr val="954F72"/></a:folHlink>'
    "</a:clrScheme>"
    '<a:fontScheme name="Utopia">'
    '<a:majorFont><a:latin typeface="Calibri Light"/><a:ea typeface=""/>'
    '<a:cs typeface=""/></a:majorFont>'
    '<a:minorFont><a:latin typeface="Calibri"/><a:ea typeface=""/>'
    '<a:cs typeface=""/></a:minorFont>'
    "</a:fontScheme>"
    '<a:fmtScheme name="Utopia">'
    "<a:fillStyleLst>"
    + '<a:solidFill><a:schemeClr val="phClr"/></a:solidFill>' * 3
    + "</a:fillStyleLst><a:lnStyleLst>"
    + ('<a:ln w="6350"><a:solidFill><a:schemeClr val="phClr"/></a:solidFill>'
       "</a:ln>") * 3
    + "</a:lnStyleLst><a:effectStyleLst>"
    + "<a:effectStyle><a:effectLst/></a:effectStyle>" * 3
    + "</a:effectStyleLst><a:bgFillStyleLst>"
    + '<a:solidFill><a:schemeClr val="phClr"/></a:solidFill>' * 3
    + "</a:bgFillStyleLst></a:fmtScheme>"
    "</a:themeElements></a:theme>"
)

CLR_MAP = (
    '<p:clrMap bg1="lt1" tx1="dk1" bg2="lt2" tx2="dk2" accent1="accent1" '
    'accent2="accent2" accent3="accent3" accent4="accent4" accent5="accent5" '
    'accent6="accent6" hlink="hlink" folHlink="folHlink"/>'
)

# The master carries three pieces of text. None of them is slide content, and
# none of them may appear in the extracted output — this is the inheritance
# trap: the strings are in the package, just not on any slide.
MASTER_XML = XML_DECL + (
    f"<p:sldMaster {P_NS}><p:cSld><p:spTree>"
    '<p:nvGrpSpPr><p:cNvPr id="1" name=""/><p:cNvGrpSpPr/><p:nvPr/>'
    "</p:nvGrpSpPr>"
    '<p:grpSpPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="0" cy="0"/>'
    '<a:chOff x="0" y="0"/><a:chExt cx="0" cy="0"/></a:xfrm></p:grpSpPr>'
    + sp(2, "Title Placeholder 1", 838200, 365125, 10515600, 1325563,
         [tp("Click to edit Master title style")], ph="title")
    + sp(3, "Text Placeholder 2", 838200, 1825625, 10515600, 4351338,
         [tp("Click to edit Master text styles"),
          tp("Second level", level=1),
          tp("Third level", level=2)], ph="body", ph_idx=1)
    + sp(4, "Footer Placeholder 3", 4038600, 6356350, 4114800, 365125,
         [tp(LEGAL)], ph="ftr", ph_idx=3)
    + sp(5, "Slide Number Placeholder 4", 8685213, 6356350, 2367280, 365125,
         [tp("MASTER SLIDE NUMBER")], ph="sldNum", ph_idx=4)
    + "</p:spTree></p:cSld>"
    + CLR_MAP
    + '<p:sldLayoutIdLst><p:sldLayoutId id="2147483649" r:id="rId1"/>'
    "</p:sldLayoutIdLst></p:sldMaster>"
)

LAYOUT_XML = XML_DECL + (
    f'<p:sldLayout {P_NS} type="obj" preserve="1">'
    '<p:cSld name="Title and Content"><p:spTree>'
    '<p:nvGrpSpPr><p:cNvPr id="1" name=""/><p:cNvGrpSpPr/><p:nvPr/>'
    "</p:nvGrpSpPr>"
    '<p:grpSpPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="0" cy="0"/>'
    '<a:chOff x="0" y="0"/><a:chExt cx="0" cy="0"/></a:xfrm></p:grpSpPr>'
    + sp(2, "Title 1", 838200, 365125, 10515600, 1325563,
         [tp("Click to edit Master title style")], ph="title")
    + sp(3, "Content Placeholder 2", 838200, 1825625, 10515600, 4351338,
         [tp("Click to edit Master text styles")], ph="body", ph_idx=1)
    + "</p:spTree></p:cSld>"
    "<p:clrMapOvr><a:masterClrMapping/></p:clrMapOvr></p:sldLayout>"
)


# --------------------------------------------------------------------------
# Chart and SmartArt parts
# --------------------------------------------------------------------------

def _str_cache(ref: str, values: list[str]) -> str:
    pts = "".join(
        f'<c:pt idx="{i}"><c:v>{esc(v)}</c:v></c:pt>'
        for i, v in enumerate(values)
    )
    return (
        f"<c:strRef><c:f>{ref}</c:f><c:strCache>"
        f'<c:ptCount val="{len(values)}"/>{pts}</c:strCache></c:strRef>'
    )


def _num_cache(ref: str, values: list[float]) -> str:
    pts = "".join(
        f'<c:pt idx="{i}"><c:v>{v}</c:v></c:pt>' for i, v in enumerate(values)
    )
    return (
        f"<c:numRef><c:f>{ref}</c:f><c:numCache>"
        "<c:formatCode>General</c:formatCode>"
        f'<c:ptCount val="{len(values)}"/>{pts}</c:numCache></c:numRef>'
    )


CATEGORIES = ["Q1 2369", "Q2 2369", "Q3 2369", "Q4 2369"]
SERIES = [
    ("Warp core output (TD)", [1.2, 1.4, 1.9, 2.1]),
    ("Impulse reserve (TD)", [0.8, 0.75, 0.9, 0.95]),
]


def chart_xml() -> str:
    """A clustered bar chart whose series caches hold the real numbers.

    The caches are the whole point: the numbers a reader can recover live only
    here, never in a `<p:sp>`, so a shape walker sees an empty frame.
    """
    sers = []
    for i, (name, values) in enumerate(SERIES):
        col = chr(ord("B") + i)
        sers.append(
            f'<c:ser><c:idx val="{i}"/><c:order val="{i}"/>'
            f"<c:tx>{_str_cache(f'Sheet1!${col}$1', [name])}</c:tx>"
            f"<c:cat>{_str_cache('Sheet1!$A$2:$A$5', CATEGORIES)}</c:cat>"
            f"<c:val>{_num_cache(f'Sheet1!${col}$2:${col}$5', values)}</c:val>"
            "</c:ser>"
        )
    return XML_DECL + (
        f'<c:chartSpace xmlns:c="{C}" xmlns:a="{A}" xmlns:r="{R}">'
        "<c:chart><c:title><c:tx><c:rich><a:bodyPr/><a:lstStyle/>"
        f"{tp('Propulsion output by quarter')}"
        "</c:rich></c:tx><c:overlay val=\"0\"/></c:title>"
        '<c:autoTitleDeleted val="0"/>'
        "<c:plotArea><c:layout/>"
        '<c:barChart><c:barDir val="col"/><c:grouping val="clustered"/>'
        '<c:varyColors val="0"/>'
        + "".join(sers)
        + '<c:gapWidth val="150"/><c:axId val="111111111"/>'
        '<c:axId val="222222222"/></c:barChart>'
        '<c:catAx><c:axId val="111111111"/>'
        '<c:scaling><c:orientation val="minMax"/></c:scaling>'
        '<c:delete val="0"/><c:axPos val="b"/>'
        '<c:crossAx val="222222222"/></c:catAx>'
        '<c:valAx><c:axId val="222222222"/>'
        '<c:scaling><c:orientation val="minMax"/></c:scaling>'
        '<c:delete val="0"/><c:axPos val="l"/>'
        '<c:crossAx val="111111111"/></c:valAx>'
        "</c:plotArea>"
        '<c:legend><c:legendPos val="b"/><c:overlay val="0"/></c:legend>'
        '<c:plotVisOnly val="1"/><c:dispBlanksAs val="gap"/>'
        "</c:chart></c:chartSpace>"
    )


DIAGRAM_NODES = [
    "Intake survey",
    "Structural teardown",
    "Warp core recertification",
    "Shakedown cruise",
]


def diagram_data_xml() -> str:
    """SmartArt text, which lives in its own part and in no shape at all."""
    pts = [
        '<dgm:pt modelId="1" type="doc"><dgm:prSet/><dgm:spPr/>'
        '<dgm:t><a:bodyPr/><a:lstStyle/><a:p><a:endParaRPr lang="en-US"/>'
        "</a:p></dgm:t></dgm:pt>"
    ]
    for i, text in enumerate(DIAGRAM_NODES, start=2):
        pts.append(
            f'<dgm:pt modelId="{i}"><dgm:prSet phldrT="[Text]"/><dgm:spPr/>'
            f"<dgm:t><a:bodyPr/><a:lstStyle/>{tp(text)}</dgm:t></dgm:pt>"
        )
    cxns = "".join(
        f'<dgm:cxn modelId="{100 + i}" srcId="1" destId="{i + 2}" '
        f'srcOrd="{i}" destOrd="0"/>'
        for i in range(len(DIAGRAM_NODES))
    )
    return XML_DECL + (
        f'<dgm:dataModel xmlns:dgm="{DGM}" xmlns:a="{A}">'
        f"<dgm:ptLst>{''.join(pts)}</dgm:ptLst>"
        f"<dgm:cxnLst>{cxns}</dgm:cxnLst>"
        "<dgm:bg/><dgm:whole/></dgm:dataModel>"
    )


DIAGRAM_LAYOUT_XML = XML_DECL + (
    f'<dgm:layoutDef xmlns:dgm="{DGM}" xmlns:a="{A}" '
    'uniqueId="urn:example/officeart/2005/8/layout/process1">'
    '<dgm:title val="Refit process"/><dgm:desc val=""/><dgm:catLst/>'
    '<dgm:sampData><dgm:dataModel><dgm:ptLst/><dgm:cxnLst/><dgm:bg/>'
    "<dgm:whole/></dgm:dataModel></dgm:sampData>"
    '<dgm:layoutNode name="root"><dgm:alg type="lin"/><dgm:shape/>'
    "</dgm:layoutNode></dgm:layoutDef>"
)

DIAGRAM_STYLE_XML = XML_DECL + (
    f'<dgm:styleDef xmlns:dgm="{DGM}" xmlns:a="{A}" '
    'uniqueId="urn:example/officeart/2005/8/quickstyle/simple1">'
    '<dgm:title val="Simple"/><dgm:desc val=""/><dgm:catLst/>'
    '<dgm:styleLbl name="node0"><dgm:scene3d><a:camera prst="orthographicFront"/>'
    '<a:lightRig rig="threePt" dir="t"/></dgm:scene3d>'
    '<dgm:sp3d/><dgm:txPr/><dgm:style><a:lnRef idx="0"/><a:fillRef idx="1"/>'
    '<a:effectRef idx="0"/><a:fontRef idx="minor"/></dgm:style>'
    "</dgm:styleLbl></dgm:styleDef>"
)

DIAGRAM_COLORS_XML = XML_DECL + (
    f'<dgm:colorsDef xmlns:dgm="{DGM}" xmlns:a="{A}" '
    'uniqueId="urn:example/officeart/2005/8/colors/accent1_1">'
    '<dgm:title val="Accent 1"/><dgm:desc val=""/><dgm:catLst/>'
    '<dgm:styleLbl name="node0">'
    '<dgm:fillClrLst meth="repeat"><a:schemeClr val="accent1"/></dgm:fillClrLst>'
    '<dgm:linClrLst meth="repeat"><a:schemeClr val="lt1"/></dgm:linClrLst>'
    '<dgm:effectClrLst/><dgm:txLinClrLst/>'
    '<dgm:txFillClrLst meth="repeat"><a:schemeClr val="lt1"/></dgm:txFillClrLst>'
    "<dgm:txEffectClrLst/></dgm:styleLbl></dgm:colorsDef>"
)


# --------------------------------------------------------------------------
# The slides
# --------------------------------------------------------------------------

def slide_title() -> str:
    """Title slide, plus a text box parked entirely off-canvas."""
    return slide([
        sp(2, "Title 1", 838200, 1800000, 10515600, 1325563,
           [tp("Refit Status" + NBSP + EMDASH + NBSP + "USS Enterprise")],
           ph="title"),
        sp(3, "Subtitle 2", 838200, 3200000, 10515600, 1325563,
           [tp("Utopia" + NBSP + "Planitia Fleet Yards" + ELLIPSIS
               + " Stardate 47988.1"),
            tp("Presented by Geordi La" + NBSP + "Forge, Chief Engineer")],
           ph="subTitle", ph_idx=1),
        # Negative x: off the left edge of the canvas entirely. Scratch text
        # a presenter left behind, invisible in the room.
        sp(4, "Off-slide scratch", -6000000, 1200000, 4000000, 2000000,
           [tp("SCRATCH: do not present " + EMDASH + " pricing still unsigned"),
            tp("Ask Riker before the yards briefing.")]),
    ])


def slide_agenda() -> str:
    """Nested bullets, three levels deep, with whitespace abuse in the text."""
    return slide([
        sp(2, "Title 1", 838200, 365125, 10515600, 1325563,
           [tp("Agenda")], ph="title"),
        sp(3, "Content Placeholder 2", 838200, 1825625, 10515600, 4351338, [
            tp("Propulsion", bullet=True),
            tp("Warp field geometry", level=1, bullet=True),
            tp("Nacelle" + NBSP + "2 plasma injectors", level=2, bullet=True),
            tp("Serial UP" + NBHY + "4471", level=3, bullet=True),
            tp("Serial UP" + NBHY + "4472", level=3, bullet=True),
            tp("Structural", bullet=True),
            tp("\tTab-indented line inside a bullet   ", level=1),
            tp("        Eight leading spaces, and trailing ones        ",
               level=1),
            tp(""),
            tp(""),
            tp(""),
            tp("Crew readiness", bullet=True),
        ], ph="body", ph_idx=1),
    ])


def slide_prose() -> str:
    """Hard-wrapped prose with hyphen-split words and unicode junk."""
    lines = [
        "The Utopia" + NBSP + "Planitia yards report that the plasma inter-",
        "mix chamber tolerances have drifted by four microns since",
        "the last refit, which the diagnostic subroutine flagged as",
        LDQUO + "within nominal" + RDQUO + " " + EMDASH + " a classi" + FI
        + "cation the Daystrom Insti-",
        "tute disputes. Warp " + FL + "ux stability held at 99.7" + NBSP + "%",
        "across all eighteen test cycles" + ELLIPSIS + " the variance sits in",
        "the star" + SHY + "board nacelle, which Lt." + NBSP + "Barclay rebuilt",
        "in 2367 and which has never quite matched its twin.",
    ]
    return slide([
        sp(2, "Title 1", 838200, 365125, 10515600, 1325563,
           [tp("Summary")], ph="title"),
        sp(3, "Content Placeholder 2", 838200, 1825625, 10515600, 4351338,
           [tp(line) for line in lines], ph="body", ph_idx=1),
        sp(4, "Aside 3", 838200, 5900000, 10515600, 500000,
           [tp("Captain Picard" + RSQUO + "s order: " + LSQUO
               + "no shortcuts on the containment " + FI + "eld" + RSQUO
               + ZWSP + " \U0001f596")]),
    ])


def slide_table() -> str:
    """Merged cells, both directions, in one grid."""
    w = [1800000, 1600000, 1600000, 1600000, 1600000]
    rows = [
        # "Deck" opens a two-row vertical merge; each shift header spans two.
        tc("Deck", rowspan=2, bold=True) + tc("Alpha shift", span=2, bold=True)
        + tc("", hmerge=True) + tc("Beta shift", span=2, bold=True)
        + tc("", hmerge=True),
        tc("", vmerge=True) + tc("Crew", bold=True) + tc("Load", bold=True)
        + tc("Crew", bold=True) + tc("Load", bold=True),
        tc("36") + tc("12") + tc("61" + NBSP + "%") + tc("9")
        + tc("44" + NBSP + "%"),
        # A four-column merge swallowing an entire row of data.
        tc("10") + tc("Evacuated during the refit " + EMDASH + " no shift data",
                      span=4)
        + tc("", hmerge=True) + tc("", hmerge=True) + tc("", hmerge=True),
        tc("4") + tc("7") + tc("30" + NBSP + "%") + tc("7")
        + tc("31" + NBSP + "%"),
    ]
    hostile = [
        tc("Field", bold=True) + tc("Value", bold=True),
        tc("Regex used by the parser") + tc("^(warp|impulse|thruster)$"),
        tc("Shell snippet") + tc("tricorder --scan | grep dilithium | wc -l"),
        tc("Multi-line note") + tc("Line one of the note.\nLine two, same cell."),
        tc("Empty next") + tc(""),
    ]
    return slide([
        sp(2, "Title 1", 838200, 365125, 10515600, 1000000,
           [tp("Deck loading")], ph="title"),
        tbl_frame(3, "Table 2", 400000, 1500000, 8200000, 1854200, w, rows),
        tbl_frame(4, "Table 3", 400000, 3800000, 5000000, 1854200,
                  [2200000, 2800000], hostile),
        # Single-column table: no grid to speak of, so it should come out as
        # plain lines rather than a one-column Markdown table.
        tbl_frame(5, "Table 4", 6000000, 3800000, 3000000, 1854200, [3000000], [
            tc("Outstanding work orders", bold=True),
            tc("Recalibrate the lateral sensor array"),
            tc("Replace EPS conduit, deck" + NBSP + "12"),
            tc("Purge the Jefferies tube" + NBSP + "17 relay"),
        ]),
    ])


def slide_chart() -> str:
    return slide([
        sp(2, "Title 1", 838200, 365125, 10515600, 1000000,
           [tp("Propulsion output")], ph="title"),
        chart_frame(3, "rId2"),
        sp(4, "Callout 3", 7200000, 1800000, 4200000, 2000000,
           [tp("Q3 is the number the board cares about: 1.9" + NBSP
               + "teradynes, ahead of plan."),
            tp("Source: Daystrom Institute telemetry, stardate 47901.2")]),
    ])


def slide_diagram() -> str:
    return slide([
        sp(2, "Title 1", 838200, 365125, 10515600, 1000000,
           [tp("Refit sequence")], ph="title"),
        dgm_frame(3),
    ])


def slide_images() -> str:
    """Four pictures with varying alt quality, plus the rotated group."""
    return slide([
        sp(2, "Title 1", 838200, 365125, 10515600, 1000000,
           [tp("Imagery")], ph="title"),
        pic(3, "Picture 2", "rId2", 700000, 1600000, 2400000, 2400000,
            "Warp core output by quarter, 2364 to 2370, rising to 1.9 "
            "teradynes"),
        pic(4, "image1.png", "rId3", 3300000, 1600000, 2400000, 2400000,
            "image1.png"),
        pic(5, "Picture 3", "rId4", 5900000, 1600000, 2400000, 2400000, None),
        pic(6, "avatar", "rId5", 8500000, 1600000, 1200000, 1200000, "avatar"),
        group(7, [
            sp(8, "Group label 1", 0, 0, 1100000, 250000,
               [tp("Nacelle" + NBSP + "2, post-teardown")]),
            sp(9, "Group label 2", 0, 250000, 1100000, 250000,
               [tp("Photo: Ensign Ro, stardate 47955.6")]),
        ]),
    ])


def slide_code() -> str:
    """Pasted code on a slide: indentation is all the structure there is."""
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
        "Document it like this:",
        "",
        "```js",
        "warpCore.eject();",
        "```",
        "",
        "The fence above is three backticks, inside the block.",
    ]
    return slide([
        sp(2, "Title 1", 838200, 365125, 10515600, 1000000,
           [tp("Runbook")], ph="title"),
        sp(3, "Code 2", 700000, 1500000, 5200000, 3600000,
           [tp(line) for line in python]),
        sp(4, "Code 3", 6300000, 1500000, 5200000, 3600000,
           [tp(line) for line in markdown]),
        sp(5, "Footer note 4", 838200, 5900000, 10515600, 500000,
           [tp("Call warpCore.eject() only after containment.lock() returns "
               "true.")]),
    ])


def slide_closing() -> str:
    return slide([
        sp(2, "Title 1", 838200, 365125, 10515600, 1000000,
           [tp("Sign-off")], ph="title"),
        sp(3, "Content Placeholder 2", 838200, 1825625, 10515600, 3000000, [
            tp("Signed off by the board on 2370" + NBHY + "10" + NBHY + "01.",
               bold=True),
            tp("Questions to Engineering, deck" + NBSP + "36."),
            tp(""),
            tp(LEGAL),
            tp(LEGAL),
        ], ph="body", ph_idx=1),
        sp(4, "Footer 3", 838200, 6100000, 10515600, 400000,
           [tp("Privacy" + NBSP + "|" + NBSP + "Terms" + NBSP + "|" + NBSP
               + "Cookie policy   ")]),
    ])


def slide_hidden() -> str:
    """show="0": present in the package, absent from the room and the output."""
    return slide([
        sp(2, "Title 1", 838200, 365125, 10515600, 1000000,
           [tp("BACKUP " + EMDASH + " unapproved pricing")], ph="title"),
        sp(3, "Content Placeholder 2", 838200, 1825625, 10515600, 4351338, [
            tp("HIDDEN SLIDE MARKER: this string must not appear in default "
               "output."),
            tp("Refit quoted at 4.2 million credits, before the Daystrom "
               "surcharge."),
        ], ph="body", ph_idx=1),
    ], show=False)


# --------------------------------------------------------------------------
# Package assembly
# --------------------------------------------------------------------------

# (part name, xml, rels) in slideN.xml order. The presentation order below is a
# permutation of this list, which is the whole point of the fixture.
def slide_parts() -> list[tuple[str, str, list[tuple[str, str, str]]]]:
    layout_rel = ("rId1", f"{R}/slideLayout", "../slideLayouts/slideLayout1.xml")
    return [
        ("slide1.xml", slide_title(), [layout_rel]),
        ("slide2.xml", slide_prose(), [layout_rel]),
        ("slide3.xml", slide_chart(),
         [layout_rel, ("rId2", f"{R}/chart", "../charts/chart1.xml")]),
        ("slide4.xml", slide_agenda(), [layout_rel]),
        ("slide5.xml", slide_images(), [
            layout_rel,
            ("rId2", f"{R}/image", "../media/image1.png"),
            ("rId3", f"{R}/image", "../media/image2.png"),
            ("rId4", f"{R}/image", "../media/image3.png"),
            ("rId5", f"{R}/image", "../media/image4.png"),
        ]),
        ("slide6.xml", slide_code(), [layout_rel]),
        ("slide7.xml", slide_table(), [layout_rel]),
        ("slide8.xml", slide_diagram(), [
            layout_rel,
            ("rId2", f"{R}/diagramData", "../diagrams/data1.xml"),
            ("rId3", f"{R}/diagramLayout", "../diagrams/layout1.xml"),
            ("rId4", f"{R}/diagramQuickStyle", "../diagrams/quickStyle1.xml"),
            ("rId5", f"{R}/diagramColors", "../diagrams/colors1.xml"),
        ]),
        ("slide9.xml", slide_hidden(), [layout_rel]),
    ]


# Presentation order, by slideN.xml file number. Deliberately not 1..9: a
# reader that sorts by file name gets the deck wrong, and the hidden slide
# (slide9) sits in the middle rather than at the end.
SLIDE_ORDER = [1, 4, 2, 7, 3, 9, 8, 5, 6]


def rels(entries: list[tuple[str, str, str]],
         external: set[str] | None = None) -> str:
    external = external or set()
    body = "".join(
        f'<Relationship Id="{rid}" Type="{typ}" Target="{target}"'
        + (' TargetMode="External"/>' if rid in external else "/>")
        for rid, typ, target in entries
    )
    return XML_DECL + (
        '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/'
        f'relationships">{body}</Relationships>'
    )


def presentation_xml() -> str:
    ids = "".join(
        # Slide IDs are not in file order either, and they do not start at 256
        # in a tidy run — real decks accumulate gaps as slides are deleted.
        f'<p:sldId id="{260 + n * 7}" r:id="rId{10 + i}"/>'
        for i, n in enumerate(SLIDE_ORDER)
    )
    return XML_DECL + (
        f'<p:presentation {P_NS} saveSubsetFonts="1">'
        '<p:sldMasterIdLst><p:sldMasterId id="2147483648" r:id="rId1"/>'
        "</p:sldMasterIdLst>"
        f"<p:sldIdLst>{ids}</p:sldIdLst>"
        f'<p:sldSz cx="{SLIDE_CX}" cy="{SLIDE_CY}"/>'
        '<p:notesSz cx="6858000" cy="9144000"/>'
        "</p:presentation>"
    )


def presentation_rels() -> str:
    entries = [
        ("rId1", f"{R}/slideMaster", "slideMasters/slideMaster1.xml"),
        ("rId2", f"{R}/theme", "theme/theme1.xml"),
    ]
    entries += [
        (f"rId{10 + i}", f"{R}/slide", f"slides/slide{n}.xml")
        for i, n in enumerate(SLIDE_ORDER)
    ]
    return rels(entries)


def content_types(slide_names: list[str]) -> str:
    over = [
        ("/ppt/presentation.xml",
         f"{CT}.presentationml.presentation.main+xml"),
        ("/ppt/slideMasters/slideMaster1.xml",
         f"{CT}.presentationml.slideMaster+xml"),
        ("/ppt/slideLayouts/slideLayout1.xml",
         f"{CT}.presentationml.slideLayout+xml"),
        ("/ppt/theme/theme1.xml", f"{CT}.theme+xml"),
        ("/ppt/charts/chart1.xml", f"{CT}.drawingml.chart+xml"),
        ("/ppt/diagrams/data1.xml", f"{CT}.drawingml.diagramData+xml"),
        ("/ppt/diagrams/layout1.xml", f"{CT}.drawingml.diagramLayout+xml"),
        ("/ppt/diagrams/quickStyle1.xml", f"{CT}.drawingml.diagramStyle+xml"),
        ("/ppt/diagrams/colors1.xml", f"{CT}.drawingml.diagramColors+xml"),
    ]
    over += [
        (f"/ppt/slides/{n}", f"{CT}.presentationml.slide+xml")
        for n in slide_names
    ]
    body = "".join(
        f'<Override PartName="{part}" ContentType="{ct}"/>' for part, ct in over
    )
    return XML_DECL + (
        '<Types xmlns="http://schemas.openxmlformats.org/package/2006/'
        'content-types">'
        '<Default Extension="rels" ContentType="application/vnd.'
        'openxmlformats-package.relationships+xml"/>'
        '<Default Extension="xml" ContentType="application/xml"/>'
        '<Default Extension="png" ContentType="image/png"/>'
        f"{body}</Types>"
    )


def build() -> None:
    slides = slide_parts()
    parts: list[tuple[str, bytes]] = []

    def add(name: str, text: str) -> None:
        parts.append((name, text.encode("utf-8")))

    add("[Content_Types].xml", content_types([n for n, _, _ in slides]))
    add("_rels/.rels", rels([
        ("rId1", f"{R}/officeDocument", "ppt/presentation.xml"),
    ]))
    add("ppt/presentation.xml", presentation_xml())
    add("ppt/_rels/presentation.xml.rels", presentation_rels())
    add("ppt/slideMasters/slideMaster1.xml", MASTER_XML)
    add("ppt/slideMasters/_rels/slideMaster1.xml.rels", rels([
        ("rId1", f"{R}/slideLayout", "../slideLayouts/slideLayout1.xml"),
        ("rId2", f"{R}/theme", "../theme/theme1.xml"),
    ]))
    add("ppt/slideLayouts/slideLayout1.xml", LAYOUT_XML)
    add("ppt/slideLayouts/_rels/slideLayout1.xml.rels", rels([
        ("rId1", f"{R}/slideMaster", "../slideMasters/slideMaster1.xml"),
    ]))
    add("ppt/theme/theme1.xml", THEME_XML)
    for name, xml, rel_entries in slides:
        add(f"ppt/slides/{name}", xml)
        add(f"ppt/slides/_rels/{name}.rels", rels(rel_entries))
    add("ppt/charts/chart1.xml", chart_xml())
    add("ppt/diagrams/data1.xml", diagram_data_xml())
    add("ppt/diagrams/layout1.xml", DIAGRAM_LAYOUT_XML)
    add("ppt/diagrams/quickStyle1.xml", DIAGRAM_STYLE_XML)
    add("ppt/diagrams/colors1.xml", DIAGRAM_COLORS_XML)

    media = {
        "ppt/media/image1.png": make_png(120, 120, seed=1234),
        "ppt/media/image2.png": make_png(96, 96, seed=99),
        "ppt/media/image3.png": make_png(80, 80, seed=31337),
        "ppt/media/image4.png": make_png(64, 64, seed=8675309),
    }
    parts.extend((name, data) for name, data in sorted(media.items()))

    with zipfile.ZipFile(OUT, "w", zipfile.ZIP_DEFLATED) as zf:
        for name, data in parts:
            info = zipfile.ZipInfo(name, date_time=ZIP_DATE)
            info.compress_type = zipfile.ZIP_DEFLATED
            info.external_attr = 0o644 << 16
            zf.writestr(info, data)

    print(f"wrote {OUT} ({os.path.getsize(OUT)} bytes)")


if __name__ == "__main__":
    build()
