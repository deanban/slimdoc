#!/usr/bin/env python3
"""Generate kitchen-sink.html — the hostile HTML corpus fixture for slimdoc.

No third-party dependencies. The only non-trivial machinery is the PNG
synthesiser (a handful of length-prefixed chunks around a zlib stream), lifted
from test/fixtures/make-docx.py so the two fixtures stay stylistically twinned.

Everything is deterministic — seeded pixel noise, no clock, no `random` — so
re-running the script produces a byte-identical file and the fixture stays
diff-clean. Verify with:

    shasum -a 256 kitchen-sink.html && python3 make-corpus-html.py && \\
    shasum -a 256 kitchen-sink.html

Usage:  python3 test/fixtures/corpus/make-corpus-html.py
"""

from __future__ import annotations

import base64
import os
import struct
import zlib

HERE = os.path.dirname(os.path.abspath(__file__))
OUT = os.path.join(HERE, "kitchen-sink.html")


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

    Noise on purpose: it barely compresses, so a base64 data: URI built from it
    is tens of kilobytes. That is what makes "no base64 survived extraction"
    assertions meaningful — a 1x1 pixel would prove nothing.
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


def data_uri(width: int, height: int, seed: int) -> str:
    b64 = base64.b64encode(make_png(width, height, seed)).decode("ascii")
    return "data:image/png;base64," + b64


# --------------------------------------------------------------------------
# Invisible / lookalike characters, named so the source stays readable
# --------------------------------------------------------------------------

NBSP = " "      # non-breaking space
SHY = "­"       # soft hyphen
ZWSP = "​"      # zero-width space
ZWNJ = "‌"      # zero-width non-joiner
BOMISH = "﻿"    # zero-width no-break space, mid-document
LDQUO, RDQUO = "“", "”"
LSQUO, RSQUO = "‘", "’"
EMDASH, ENDASH = "—", "–"
ELLIPSIS = "…"
FI, FL = "ﬁ", "ﬂ"   # ligatures
NBHY = "‑"      # non-breaking hyphen


# --------------------------------------------------------------------------
# Sections
# --------------------------------------------------------------------------

def head() -> str:
    """<style> and <script> with real bodies — both must vanish wholesale."""
    return f"""<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="description" content="Utopia Planitia Fleet Yards {EMDASH} refit status">
<meta property="og:title" content="Refit Status: USS Enterprise NCC{NBHY}1701{ENDASH}D">
<title>Refit Status {EMDASH} Utopia Planitia Fleet Yards</title>
<link rel="stylesheet" href="/assets/lcars.css">
<link rel="canonical" href="https://fleetyards.example/refit/1701d">
<style>
  /* Real CSS, several hundred bytes of it: the extractor must drop the whole
     body, not just the tags. A naive tag-stripper leaks these selectors. */
  :root {{ --lcars-orange: #ff9c00; --lcars-blue: #9c9cff; }}
  body {{ font-family: -apple-system, "Segoe UI", sans-serif; line-height: 1.5; }}
  .avatar {{ width: 32px; height: 32px; border-radius: 50%; }}
  .cookie-banner {{ position: fixed; bottom: 0; background: var(--lcars-orange); }}
  nav ul li a:hover {{ text-decoration: underline; }}
  table td {{ padding: 8px 12px; border-bottom: 1px solid #ddd; }}
  @media print {{ nav, .cookie-banner, footer {{ display: none !important; }} }}
</style>
<script>
  // Real JS, including markup inside a string literal, which a regex-based
  // stripper that stops at the first ">" will happily leak.
  window.dataLayer = window.dataLayer || [];
  function gtag() {{ window.dataLayer.push(arguments); }}
  gtag("js", "stardate 47988.1");
  gtag("config", "UA-1701-D", {{ page_title: "<h1>NOT A HEADING</h1>" }});
  document.addEventListener("DOMContentLoaded", function () {{
    var el = document.querySelector(".cookie-banner");
    if (el) el.innerHTML = "<p>We value your privacy</p>";
  }});
</script>
<script type="application/ld+json">
  {{"@context":"https://schema.org","@type":"Article",
   "headline":"Refit Status","author":{{"@type":"Person","name":"Geordi La Forge"}}}}
</script>
</head>
<body>
<!-- An HTML comment that must not survive extraction. TODO(worf): remove. -->"""


def nav_and_banner() -> str:
    """Boilerplate chrome: nav lists and a cookie banner."""
    return f"""
<nav class="site-nav" aria-label="Primary">
\t<ul>
\t\t<li><a href="/">Home</a></li>
\t\t<li><a href="/fleet">Fleet</a></li>
\t\t<li><a href="/fleet/refit">Refit</a></li>
\t\t<li><a href="/yards">Yards</a></li>
\t\t<li><a href="/personnel">Personnel</a></li>
\t\t<li><a href="/login">Sign in</a></li>
\t</ul>
</nav>

<div class="cookie-banner" role="dialog" aria-label="Cookie consent">
  <p>We value your privacy. We and our 847 partners store and{NBSP}access
     information on your device to personalise content{ELLIPSIS}</p>
  <button type="button">Accept all</button>
  <button type="button">Manage preferences</button>
</div>

<div id="breadcrumbs"><a href="/">Home</a> &rsaquo; <a href="/fleet">Fleet</a>
   &rsaquo; <span>NCC{NBHY}1701{NBHY}D</span></div>
"""


def prose() -> str:
    """Hard-wrapped prose at ~60 columns, plus hyphen-split words and unicode junk.

    The paragraph below is the unwrap test: the sentences are broken mid-clause
    at column ~60 the way a mail client or a pasted PDF breaks them, and two
    words are split across the break with a real hyphen.
    """
    return f"""
<h1>Refit Status{NBSP}{EMDASH}{NBSP}USS Enterprise</h1>

<p class="byline">Filed by Geordi La{NBSP}Forge, Chief Engineer{ZWSP} {ELLIPSIS}
   reviewed by Cmdr.{NBSP}Data</p>

<p>
The Utopia{NBSP}Planitia yards report that the plasma inter-
mix chamber tolerances have drifted by four microns since
the last refit, which the diagnostic subroutine flagged as
{LDQUO}within nominal{RDQUO} {EMDASH} a classi{FI}cation the Daystrom Insti-
tute disputes. Warp {FL}ux stability held at 99.7{NBSP}% across
all eighteen test cycles{ELLIPSIS} the remaining variance sits in
the star{SHY}board nacelle, which Lt.{NBSP}Barclay rebuilt in
2367 and which has never quite matched its twin.
</p>

<p>Captain Picard{RSQUO}s standing order {ENDASH} {LSQUO}no shortcuts on the
   containment {FI}eld{RSQUO} {ENDASH} still applies. 🖖 Engineering signed
   off{ZWNJ} at 0400{BOMISH} hours. Dr.{NBSP}Crusher noted the crew{RSQUO}s
   fatigue index: 3.2{NBSP}%{ENDASH}4.1{NBSP}%, trending down. 🚀🛠️</p>

<p>Tab-indented and space-padded, on purpose:</p>
<p>
\tThis line begins with a real tab character.
\t\tThis one with two tabs, and it is followed by
        eight spaces of indentation on the next line
        which is not code and must not be treated as code.
</p>






<p>Six blank source lines precede this paragraph. They collapse.</p>
"""


def images() -> str:
    """A mix of alt text quality, plus a tracking pixel and a big data: URI."""
    return f"""
<h2>Imagery</h2>

<figure>
  <img src="/assets/warp-core-trend.png"
       alt="Warp core output by quarter, 2364 to 2370, rising to 1.9 teradynes">
  <figcaption>Figure{NBSP}1 {EMDASH} warp core output trend</figcaption>
</figure>

<p><img src="/assets/image1.png" alt="image1.png" width="480" height="320"></p>
<p><img src="/assets/deck-plan.png" alt="Picture 3" width="480" height="320"></p>
<p><img class="avatar" src="/assets/laforge.jpg" alt="avatar"></p>
<p><img class="avatar" src="/assets/data.jpg" alt="DSC_0041.JPG"></p>
<p><img src="/assets/spacer.gif" width="1" height="1"></p>
<p><img src="/assets/nacelle-detail.png"></p>

<p>An inline avatar carried as an encoded payload {EMDASH} tens of kilobytes of
   real noise, so the "no encoded image bytes survived" assertion in the test
   suite can search the output for the literal string and find nothing:</p>
<p><img class="avatar" alt="avatar"
     src="{data_uri(72, 72, 4242)}"></p>

<p>And a tracking pixel, encoded the same way, with no alt at all:</p>
<img width="1" height="1" style="display:none"
     src="{data_uri(48, 48, 77)}">
<img src="https://pixel.tal-shiar.example/t.gif?uid=1701D&amp;ev=pageview"
     width="1" height="1" alt="">

<svg width="120" height="40" role="img" aria-label="Starfleet delta">
  <title>Starfleet delta</title>
  <path d="M10 30 L60 5 L110 30 Z" fill="#ff9c00"/>
  <text x="20" y="38" font-size="8">delta</text>
</svg>

<video controls width="320" poster="/assets/poster.png">
  <source src="/assets/briefing.mp4" type="video/mp4">
  <track kind="captions" src="/assets/briefing.vtt" srclang="en">
  Your browser does not support the video tag.
</video>

<noscript>
  <p>Enable JavaScript to see the live diagnostic dashboard.</p>
  <img src="https://pixel.tal-shiar.example/ns.gif" width="1" height="1" alt="">
</noscript>
"""


def tables() -> str:
    """Four tables: clean grid, merged cells, single column, and hostile cells."""
    return f"""
<h2>Diagnostics</h2>

<h3>Clean grid</h3>
<table>
  <thead>
    <tr><th>Subsystem</th><th>Owner</th><th>Status</th><th>Margin</th></tr>
  </thead>
  <tbody>
    <tr><td>Warp core</td><td>La Forge</td><td>Green</td><td>12{NBSP}%</td></tr>
    <tr><td>Deflector</td><td>Data</td><td>Green</td><td>8{NBSP}%</td></tr>
    <tr><td>Transporters</td><td>O{RSQUO}Brien</td><td>Amber</td><td>2{NBSP}%</td></tr>
    <tr><td>Holodeck{NBSP}3</td><td>Barclay</td><td>Red</td><td>{ENDASH}4{NBSP}%</td></tr>
  </tbody>
</table>

<h3>Merged cells (colspan and rowspan)</h3>
<table>
  <tr>
    <th rowspan="2">Deck</th>
    <th colspan="2">Alpha shift</th>
    <th colspan="2">Beta shift</th>
  </tr>
  <tr><th>Crew</th><th>Load</th><th>Crew</th><th>Load</th></tr>
  <tr><td>36</td><td>12</td><td>61{NBSP}%</td><td>9</td><td>44{NBSP}%</td></tr>
  <tr><td>10</td><td colspan="4">Evacuated during the refit {EMDASH} no shift data</td></tr>
  <tr><td rowspan="2">4</td><td>7</td><td>30{NBSP}%</td><td>7</td><td>31{NBSP}%</td></tr>
  <tr><td>8</td><td>35{NBSP}%</td><td>6</td><td>28{NBSP}%</td></tr>
</table>

<h3>Single column</h3>
<table>
  <tr><th>Outstanding work orders</th></tr>
  <tr><td>Recalibrate the lateral sensor array</td></tr>
  <tr><td>Replace EPS conduit, deck{NBSP}12</td></tr>
  <tr><td>Purge the Jefferies tube{NBSP}17 plasma relay</td></tr>
</table>

<h3>Hostile cells</h3>
<table>
  <tr><th>Field</th><th>Value</th></tr>
  <tr><td>Regex used by the parser</td><td>^(warp|impulse|thruster)$</td></tr>
  <tr><td>Shell snippet</td><td>tricorder --scan | grep dilithium | wc -l</td></tr>
  <tr>
    <td>Multi-line note</td>
    <td>Line one of the note.<br>Line two of the same cell.<br>Line three.</td>
  </tr>
  <tr><td>Empty next</td><td></td></tr>
  <tr><td colspan="2">A full-width footnote row that spans both columns.</td></tr>
</table>
"""


def code() -> str:
    """Code cases, including the escaped-script sample that MUST survive."""
    return f"""
<h2>Runbook</h2>

<p>Call <code>warpCore.eject()</code> only after <code>containment.lock()</code>
   returns <code>true</code>; the <code>--force</code> flag is not a substitute.</p>

<p>A Markdown example whose body contains its own three-backtick fence. A fixed
   three-backtick wrapper would produce broken nesting here:</p>
<pre><code class="language-markdown">Document the ejection sequence like this:

```js
warpCore.eject();      // two spaces of padding here matter
```

The fence above is three backticks, inside this block.</code></pre>

<p>An escaped script sample. slimdoc drops real &lt;script&gt; elements but this
   one is text, and it MUST come through intact:</p>
<pre><code class="language-html">&lt;script&gt;alert(1)&lt;/script&gt;
&lt;p&gt;If this line is missing, escaped code samples regressed.&lt;/p&gt;
&lt;img src=x onerror=alert(2)&gt;</code></pre>

<script>
  // This one is real and must die, immediately after the escaped sample above.
  fetch("https://pixel.tal-shiar.example/beacon", {{ method: "POST" }});
</script>

<p>Python, outside any &lt;pre&gt;, in a code-ish container. The indentation is
   the semantics {EMDASH} collapse it and the function changes meaning:</p>
<div class="highlight sourcecode">
<code>def containment_margin(readings):
    total = 0
    for r in readings:
        if r.stable:
            total += r.margin
        else:
            total -= r.margin * 2
    return total / len(readings)</code>
</div>

<p>Full source on GitHub:</p>
<iframe src="https://gist.github.com/laforge/1701d0a1b2c3d4e5f6a7b8c9d0e1f2a3.pibb"
        width="100%" height="300" frameborder="0"
        title="warp-core-diagnostic.py"></iframe>

<p>And an embedded player nobody needs:</p>
<iframe src="https://www.youtube.com/embed/dQw4w9WgXcQ" width="560" height="315"
        allowfullscreen title="Refit timelapse"></iframe>
"""


def div_soup() -> str:
    """Twelve levels of wrapper divs around two sentences."""
    depth = 12
    opens = "".join(
        f'{" " * (i * 2)}<div class="wrap-{i} layout-col{i % 3} '
        f'js-mount" data-testid="node-{i}">\n'
        for i in range(depth)
    )
    closes = "".join(f'{" " * (i * 2)}</div>\n' for i in reversed(range(depth)))
    inner = (
        " " * (depth * 2)
        + "<p>Twelve wrapper divs surround this sentence. The wrappers carry no\n"
        + " " * (depth * 2)
        + "   content and should cost nothing in the output.</p>\n"
    )
    return "\n<h2>Layout</h2>\n" + opens + inner + closes


def boilerplate() -> str:
    """Related links, repeated legal text, footer."""
    legal = (
        "This transmission is intended solely for the addressee and may contain "
        "information proprietary to the Utopia Planitia Fleet Yards. If you are "
        "not the intended recipient, notify the sender and delete all copies."
    )
    return f"""
<aside class="related">
  <h2>Related links</h2>
  <ul>
\t<li><a href="/refit/1701c">Refit status: USS Enterprise NCC-1701-C</a></li>
\t<li><a href="/refit/defiant">Refit status: USS Defiant</a></li>
\t<li><a href="/yards/mars">About Utopia Planitia</a></li>
\t<li><a href="/newsletter">Subscribe to the yards newsletter</a></li>
\t<li><a href="/refit/1701d?share=twitter">Share on X</a></li>
  </ul>
</aside>

<div class="legal">{legal}</div>

<footer>
  <p>{EMDASH} Utopia Planitia Fleet Yards, Mars Orbital{NBSP}{ELLIPSIS} Stardate 47988.1</p>
  <p>{legal}</p>
  <ul>
    <li><a href="/privacy">Privacy</a></li>
    <li><a href="/terms">Terms</a></li>
    <li><a href="/cookies">Cookie policy</a></li>
    <li><a href="/accessibility">Accessibility</a></li>
  </ul>
  <p class="copyright">&copy; 2370 Starfleet Corps of Engineers. All rights
     reserved.{NBSP}{NBSP}{NBSP}{NBSP}</p>
  <p>{legal}</p>
</footer>

<script src="https://cdn.tal-shiar.example/analytics.min.js" async></script>
<script>window.__INITIAL_STATE__ = {{"user":null,"flags":{{"beta":true}}}};</script>
</body>
</html>
"""


# --------------------------------------------------------------------------
# Whitespace abuse applied to the assembled source
# --------------------------------------------------------------------------

def add_trailing_whitespace(html: str) -> str:
    """Put trailing whitespace on most lines, the way a WYSIWYG export does.

    Deterministic by line index rather than by chance, and skipped inside
    <pre>/<code> blocks so the code fixtures stay byte-exact — trailing spaces
    there would be testing the wrong thing.
    """
    out: list[str] = []
    in_pre = False
    for i, line in enumerate(html.split("\n")):
        if "<pre" in line:
            in_pre = True
        if not in_pre and line.strip() and i % 4 != 0:
            line = line + ("\t" if i % 7 == 0 else "   ")
        if "</pre>" in line:
            in_pre = False
        out.append(line)
    return "\n".join(out)


def build() -> None:
    html = "".join([
        head(),
        nav_and_banner(),
        prose(),
        images(),
        tables(),
        code(),
        div_soup(),
        boilerplate(),
    ])
    html = add_trailing_whitespace(html)
    with open(OUT, "wb") as fh:
        fh.write(html.encode("utf-8"))
    print(f"wrote {OUT} ({os.path.getsize(OUT)} bytes)")


if __name__ == "__main__":
    build()
