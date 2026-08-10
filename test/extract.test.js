import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import test from 'node:test';

import mammoth from 'mammoth';

import {
  SUPPORTED_EXTENSIONS,
  UnsupportedFormatError,
  detectFormat,
  extractFromBuffer,
  extractFromFile,
} from '../dist/extract.js';

const FIXTURES = join(dirname(fileURLToPath(import.meta.url)), 'fixtures');
const fixture = (name) => join(FIXTURES, name);

// --------------------------------------------------------------------------
// docx
// --------------------------------------------------------------------------

test('docx: keeps heading, list and paragraph structure', async () => {
  const doc = await extractFromFile(fixture('sample.docx'));

  assert.equal(doc.format, 'docx');
  assert.equal(doc.source, fixture('sample.docx'));
  assert.match(doc.text, /^# Quarterly Review$/m);
  assert.match(doc.text, /^## Highlights$/m);
  assert.match(doc.text, /^- Revenue up 12% year on year$/m);
  assert.match(doc.text, /Churn down to 1\\?\.8%/);
  assert.match(doc.text, /Support backlog cleared/);
  // Smart punctuation is preserved here; folding it is clean.ts's job.
  assert.ok(doc.text.includes('—'), 'em dash survives extraction');
  assert.ok(doc.text.includes('“'), 'smart quotes survive extraction');
});

test('docx: no base64 image data ever reaches the output', async () => {
  const path = fixture('sample.docx');
  const bytes = (await readFile(path)).length;
  const doc = await extractFromFile(path);

  assert.ok(bytes > 20000, `fixture should carry real image bytes, got ${bytes}`);
  assert.ok(!doc.text.includes('data:'), 'output must contain no data: URI');
  assert.ok(
    !/[A-Za-z0-9+/]{200,}/.test(doc.text),
    'output must contain no orphan base64 blob',
  );

  // The real bound: output must be in the same order of magnitude as the
  // prose, not the file. sample.docx is ~43 KB, of which ~450 chars is text.
  assert.ok(
    doc.text.length < 2000,
    `expected < 2000 chars of extracted text, got ${doc.text.length}`,
  );
  assert.ok(
    doc.text.length < bytes / 10,
    `output (${doc.text.length}) should be a small fraction of the file (${bytes})`,
  );
});

test('docx: default mammoth would be vastly larger', async () => {
  const path = fixture('sample.docx');
  const withDataUris = await mammoth.convertToMarkdown({ path });
  const ours = await extractFromFile(path);

  assert.ok(
    withDataUris.value.includes('data:image/png;base64,'),
    'sanity check: default mammoth really does inline the images',
  );
  assert.ok(
    ours.text.length < withDataUris.value.length * 0.02,
    `expected < 2% of default mammoth output, got ` +
      `${ours.text.length} vs ${withDataUris.value.length}`,
  );
});

test('docx: a meaningful alt survives as a caption, decoration does not', async () => {
  const doc = await extractFromFile(fixture('sample.docx'));

  assert.ok(doc.text.includes('[image: Revenue by quarter, 2019 to 2024]'));
  assert.ok(!doc.text.includes('![]'), 'the alt-less image leaves nothing behind');
  assert.ok(!/!\[[^\]]*\]\(\)/.test(doc.text), 'no empty markdown image survives');
  assert.ok(
    doc.warnings.some((w) => /dropped 2 embedded images/.test(w)),
    `expected a dropped-images warning, got ${JSON.stringify(doc.warnings)}`,
  );
});

// --------------------------------------------------------------------------
// detectFormat
// --------------------------------------------------------------------------

test('detectFormat: docx by magic bytes with a missing or wrong extension', async () => {
  const buf = await readFile(fixture('sample.docx'));

  assert.equal(detectFormat(buf), 'docx');
  assert.equal(detectFormat(buf, 'mystery'), 'docx');
  assert.equal(detectFormat(buf, 'actually-a-docx.txt'), 'docx');

  const doc = await extractFromBuffer(buf, { filename: 'mystery' });
  assert.equal(doc.format, 'docx');
  assert.match(doc.text, /^# Quarterly Review$/m);
});

test('detectFormat: rtf, html and markdown', async () => {
  const rtf = await readFile(fixture('sample.rtf'));
  const html = await readFile(fixture('sample.html'));
  const md = await readFile(fixture('messy.md'));

  assert.equal(detectFormat(rtf), 'rtf', 'rtf detected by its {\\rtf magic');
  assert.equal(detectFormat(rtf, 'notes.bin'), 'rtf');
  assert.equal(detectFormat(html), 'html', 'html detected by its doctype');
  assert.equal(detectFormat(html, 'page.bin'), 'html');
  assert.equal(detectFormat(md, 'messy.md'), 'markdown');
  assert.equal(detectFormat(md, 'messy.txt'), 'text');
  assert.equal(detectFormat(Buffer.from('just words\n')), 'text');
  assert.equal(
    detectFormat(Buffer.from('<p>hi</p><div>there</div>')),
    'html',
    'a bare html fragment still sniffs as html',
  );
});

/**
 * The dependency rule: `mammoth`, `unpdf` and `saxes` are each imported lazily,
 * so a Markdown or text run loads none of them. This matters most for `npx`
 * cold start, which is the headline entry point in the README — and it is
 * checked statically because a dynamic import that has been made static again
 * is invisible at runtime until someone measures a slow `npx`.
 */
test('the heavy parsers are behind a dynamic import', async () => {
  const source = await readFile(new URL('../dist/extract.js', import.meta.url), 'utf8');
  const staticImports = [...source.matchAll(/^import .*?from ["']([^"']+)["']/gm)].map((m) => m[1]);

  for (const heavy of ['unpdf', 'saxes', './extract-pdf.js', './extract-pptx.js']) {
    assert.ok(!staticImports.includes(heavy), `${heavy} is imported statically`);
  }
  assert.match(source, /await import\(["']\.\/extract-pdf\.js["']\)/);
  assert.match(source, /await import\(["']\.\/extract-pptx\.js["']\)/);
});

test('SUPPORTED_EXTENSIONS covers every documented input', () => {
  for (const ext of ['.docx', '.pptx', '.pptm', '.potx', '.pdf', '.md', '.markdown',
    '.mdx', '.txt', '.csv', '.json', '.yaml', '.yml', '.html', '.htm', '.rtf']) {
    assert.ok(SUPPORTED_EXTENSIONS.includes(ext), `${ext} should be supported`);
  }
  // The legacy binary containers stay out: they are named refusals, not inputs.
  for (const ext of ['.doc', '.ppt', '.xls', '.xlsx', '.key', '.odp']) {
    assert.ok(!SUPPORTED_EXTENSIONS.includes(ext), `${ext} should not be supported`);
  }
});

// --------------------------------------------------------------------------
// html
// --------------------------------------------------------------------------

test('html: entities, tags, media and code blocks', async () => {
  const doc = await extractFromFile(fixture('sample.html'));

  assert.equal(doc.format, 'html');
  // &nbsp; decodes to U+00A0 and stays one — folding it is clean.ts's job.
  assert.match(doc.text, /^# Quarterly\u00a0Review$/m);
  assert.match(doc.text, /^## Highlights$/m);
  // <strong>/<em> now survive as Markdown emphasis; --aggressive strips them.
  assert.match(doc.text, /^- Revenue up \*\*12%\*\* year on year$/m);
  assert.match(doc.text, /^- Churn down to 1\.8%$/m);

  // Entities: named, numeric decimal, numeric hex, and a double-encode guard.
  assert.ok(doc.text.includes('R&D'), '&amp; decoded');
  assert.ok(doc.text.includes('’'), '&rsquo; decoded');
  assert.ok(doc.text.includes('—'), '&mdash; decoded');
  assert.ok(doc.text.includes('<dana@example.com>'), '&lt;/&gt; decoded');
  assert.ok(!doc.text.includes('&amp;'), 'no raw entity left behind');

  // Script and style bodies are gone, comments too.
  assert.ok(!doc.text.includes('window.analytics'));
  assert.ok(!doc.text.includes('font-family'));
  assert.ok(!doc.text.includes('not a heading'));
  assert.ok(!doc.text.includes('must not survive'));
  assert.ok(!doc.text.includes('Enable JavaScript'));
  assert.ok(!doc.text.includes('<rect'), 'svg contents dropped');

  // Media.
  assert.ok(!doc.text.includes('data:'), 'the inline avatar data URI is gone');
  assert.ok(!/[A-Za-z0-9+/]{200,}/.test(doc.text), 'no base64 blob survives');
  assert.ok(doc.text.includes('[image: Revenue by quarter, 2019 to 2024]'));
  assert.ok(!doc.text.includes('avatar'), 'a trivial alt is dropped, not kept');
  assert.ok(doc.text.includes('Figure 1 — revenue trend'), 'figcaption kept');

  // Links: http(s) become markdown, self-linking and relative ones become text.
  assert.ok(doc.text.includes('[the Q3 report](https://example.com/reports/q3)'));
  assert.ok(
    doc.text.includes('mirrored at https://example.com/mirror'),
    'a link whose text equals its href stays bare',
  );
  assert.ok(doc.text.includes('the internal wiki'));
  assert.ok(!doc.text.includes('](/internal/wiki)'), 'relative href dropped');

  // <pre> becomes a fenced block with its indentation intact.
  assert.match(doc.text, /```\nif \(revenue > target\) \{\n {4}celebrate\(\); {5}\/\//);
  assert.ok(doc.warnings.some((w) => /dropped 2 images/.test(w)));

  assert.ok(!/<[a-z]/i.test(doc.text.replace(/<dana@example\.com>/, '')), 'no tags left');
});

test('html: tables are emitted as GitHub-flavoured Markdown', async () => {
  const doc = await extractFromFile(fixture('sample.html'));

  // The edge bars are what make isTableRow recognise these, which is in turn
  // what stops clean.ts from unwrapping the rows into prose.
  assert.match(doc.text, /^\| Quarter \| Revenue \| Notes \|$/m);
  assert.match(doc.text, /^\| --- \| --- \| --- \|$/m);
  assert.match(doc.text, /^\| Q1 \| 1\.2M \| flat \|$/m);
});

// --------------------------------------------------------------------------
// rtf
// --------------------------------------------------------------------------

test('rtf: escapes, breaks and dropped destination groups', async () => {
  const doc = await extractFromFile(fixture('sample.rtf'));

  assert.equal(doc.format, 'rtf');
  assert.match(doc.text, /^Quarterly Review$/m);

  // \'hh -> cp1252 -> unicode
  assert.ok(doc.text.includes('team’s'), "\\'92 -> right single quote");
  assert.ok(doc.text.includes('“Q3 numbers”'), "\\'93/\\'94 -> curly quotes");
  assert.ok(doc.text.includes('£1.20'), "\\'a3 -> pound sign");
  assert.ok(doc.text.includes('café'), "\\'e9 -> e-acute");
  assert.ok(doc.text.includes('a 4% improvement'), "\\'25 -> percent");

  // \uN escapes, with the replacement char swallowed per \uc1
  assert.ok(doc.text.includes('— em dash'), '\\u8212 -> em dash');
  assert.ok(doc.text.includes('… ellipsis'), '\\u8230 -> ellipsis');
  assert.ok(doc.text.includes('éclair'), '\\u233 consumed its ? placeholder');
  assert.ok(doc.text.includes('π pi'), '\\u960 -> pi');
  assert.ok(!doc.text.includes('?clair'), 'the ? placeholder is not left behind');

  // Literal escapes.
  assert.ok(doc.text.includes('{like this}'));
  assert.ok(doc.text.includes('a literal backslash \\ stay put'));

  // \par / \line / \tab
  assert.match(doc.text, /A tab follows:\tthen more text\.\nA hard line break/);
  assert.match(doc.text, /^Bullet one\nBullet two$/m);

  // Destination groups: the {\pict} hex blob and metadata never appear.
  assert.ok(!/[0-9a-f]{40,}/.test(doc.text), 'the {\\pict} hex blob is dropped');
  assert.ok(!doc.text.includes('Times New Roman'), 'fonttbl dropped');
  assert.ok(!doc.text.includes('Someone Internal'), 'info group dropped');
  assert.ok(!doc.text.includes('Riched20'), '{\\*\\generator} dropped');
  assert.ok(!doc.text.includes('\\pard'), 'no control words leak through');

  assert.ok(doc.warnings.some((w) => /approximate/i.test(w)));
  assert.ok(doc.warnings.some((w) => /dropped 1 embedded picture/.test(w)));
});

/** Extract a literal RTF string through the same path a .rtf file takes. */
const fromRtf = async (rtf) =>
  (await extractFromBuffer(Buffer.from(rtf), { filename: 'snippet.rtf' })).text;

test('rtf: a break inside a cell stays inside the cell', async () => {
  // Word writes a multi-paragraph cell as `\intbl ...\par ...\cell`. Rows used
  // to be split on newlines, which tore everything before the break out of the
  // table and left it above as prose no reader could place.
  const text = await fromRtf(String.raw`{\rtf1 a\line b\cell c\cell\row d\cell e\cell\row}`);

  assert.equal(text, '| a b | c |\n| --- | --- |\n| d | e |');

  const paragraphs = await fromRtf(
    String.raw`{\rtf1\trowd\intbl one\par two\cell B\cell\row\trowd\intbl C\cell D\cell\row}`,
  );
  assert.equal(paragraphs, '| one two | B |\n| --- | --- |\n| C | D |');
});

test('rtf: a blank line separates a table from the prose around it', async () => {
  // A GFM table body runs until a blank line, so prose that follows one without
  // a blank line between them is read as another row of the table.
  const text = await fromRtf(String.raw`{\rtf1 A\cell B\cell\row Prose follows\par}`);

  assert.equal(text, '| A | B |\n| --- | --- |\n\nProse follows');

  const before = await fromRtf(String.raw`{\rtf1 Prose first\par A\cell B\cell\row}`);
  assert.equal(before, 'Prose first\n\n| A | B |\n| --- | --- |');
});

test('rtf: a literal cell sentinel in the document cannot fabricate a table', async () => {
  // U+001F is a legal document character, arriving as \uN, \'hh or a raw byte.
  // Only the marks the scanner emits itself may mean "cell boundary".
  assert.equal(await fromRtf(String.raw`{\rtf1 before\u31 x after}`), 'before after');
  assert.equal(await fromRtf(String.raw`{\rtf1 before\'1f after}`), 'before after');
  assert.equal(await fromRtf('{\\rtf1 before\u001f after}'), 'before after');
});

test('rtf: no cell sentinel survives on any path', async () => {
  const SENTINELS = /[\u001e\u001f]/;
  const cases = [
    // A `\cell` inside a destination group that is dropped whole.
    String.raw`{\rtf1 keep{\*\generator x\cell y\cell\row}tail}`,
    // A row the document never closes with `\row`.
    String.raw`{\rtf1 a\cell b\cell}`,
    // A one-column run, which is not a table and degrades to plain lines.
    String.raw`{\rtf1 solo\cell\row only\cell\row}`,
    // A nested table.
    String.raw`{\rtf1\trowd\intbl A\nestcell B\nestcell\nestrow C\cell\row}`,
    // Sentinels in the source text, next to real cells.
    '{\\rtf1 x\u001fy\\cell\u001e z\\cell\\row}',
  ];

  for (const rtf of cases) {
    assert.doesNotMatch(await fromRtf(rtf), SENTINELS, `sentinel survived: ${rtf}`);
  }

  for (const name of ['sample.rtf', 'tables.rtf']) {
    assert.doesNotMatch((await extractFromFile(fixture(name))).text, SENTINELS, name);
  }
});

// --------------------------------------------------------------------------
// passthrough, encodings, refusals
// --------------------------------------------------------------------------

test('markdown and text pass through untouched apart from line endings', async () => {
  const raw = await readFile(fixture('messy.md'), 'utf8');
  const doc = await extractFromFile(fixture('messy.md'));

  assert.equal(doc.format, 'markdown');
  assert.equal(doc.text, raw, 'markdown is handed to clean.ts verbatim');
  assert.deepEqual(doc.warnings, []);

  const crlf = await extractFromBuffer(Buffer.from('a\r\nb\rc\n'), { filename: 'x.txt' });
  assert.equal(crlf.format, 'text');
  assert.equal(crlf.text, 'a\nb\nc\n');
});

test('extractFromBuffer works without a hint', async () => {
  const doc = await extractFromBuffer(Buffer.from('plain words\n'));
  assert.equal(doc.format, 'text');
  assert.equal(doc.text, 'plain words\n');
  assert.equal(doc.source, '<buffer>');
});

test('BOMs: utf-8 stripped, utf-16 LE and BE decoded', async () => {
  const utf8 = Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from('hello', 'utf8')]);
  assert.equal((await extractFromBuffer(utf8, { filename: 'a.txt' })).text, 'hello');

  const le = Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from('héllo', 'utf16le')]);
  assert.equal((await extractFromBuffer(le, { filename: 'a.txt' })).text, 'héllo');

  const beBody = Buffer.from('héllo', 'utf16le');
  const be = Buffer.concat([Buffer.from([0xfe, 0xff]), Buffer.from(beBody).swap16()]);
  assert.equal((await extractFromBuffer(be, { filename: 'a.txt' })).text, 'héllo');
});

test('a .doc misnamed .docx still gets the legacy-doc hint', async () => {
  const buf = Buffer.concat([
    Buffer.from([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1]),
    Buffer.alloc(64),
  ]);
  assert.equal(detectFormat(buf, 'report.docx'), 'text', 'the extension is not trusted alone');
  await assert.rejects(
    () => extractFromBuffer(buf, { filename: 'report.docx' }),
    (err) => err instanceof UnsupportedFormatError && err.format === 'doc',
  );
});

test('unsupported: legacy .doc throws with a conversion hint', async () => {
  const doc = Buffer.concat([
    Buffer.from([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1]),
    Buffer.alloc(64),
  ]);
  await assert.rejects(
    () => extractFromBuffer(doc, { filename: 'report.doc' }),
    (err) => {
      assert.ok(err instanceof UnsupportedFormatError);
      assert.equal(err.name, 'UnsupportedFormatError');
      assert.equal(err.format, 'doc');
      assert.match(err.message, /legacy \.doc is not supported/);
      assert.match(err.message, /textutil -convert docx report\.doc/);
      return true;
    },
  );
});

/**
 * A PDF whose objects are truncated is not a slimdoc refusal any more — the
 * engine reads what it can. What must not happen is a crash or mojibake.
 */
test('pdf: a malformed pdf is reported rather than emitted as junk', async () => {
  const pdf = Buffer.from('%PDF-1.7\n%\xe2\xe3\xcf\xd3\n1 0 obj\n', 'latin1');
  await assert.rejects(() => extractFromBuffer(pdf, { filename: 'paper.pdf' }));
});

/**
 * The header is only *usually* at byte zero — the specification allows leading
 * junk before `%PDF`, and mail gateways and scanners produce exactly that.
 */
test('detection: a pdf with leading junk is still recognised as a pdf', () => {
  const pdf = Buffer.concat([
    Buffer.alloc(200, 0x20),
    Buffer.from('%PDF-1.7\n1 0 obj\n', 'latin1'),
  ]);
  assert.equal(detectFormat(pdf, 'scan.pdf'), 'pdf');
});

test('unsupported: junk far past the header does not make a text file a pdf', async () => {
  const text = Buffer.concat([Buffer.alloc(4000, 0x20), Buffer.from('%PDF is discussed below.')]);
  const doc = await extractFromBuffer(text, { filename: 'notes.txt' });
  assert.equal(doc.format, 'text');
});

/**
 * A legacy container is refused by what it actually holds. Told only that the
 * bytes are OLE2, slimdoc used to advise re-saving a PowerPoint deck as .docx.
 */
const ole2 = (stream) =>
  Buffer.concat([
    Buffer.from([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1]),
    Buffer.alloc(64),
    Buffer.from(stream, 'utf16le'),
  ]);

test('unsupported: a legacy .ppt is not told to re-save as .docx', async () => {
  await assert.rejects(
    () => extractFromBuffer(ole2('PowerPoint Document'), { filename: 'deck.ppt' }),
    (err) => {
      assert.equal(err.format, 'ppt');
      assert.match(err.message, /legacy \.ppt is not supported/);
      assert.doesNotMatch(err.message, /docx/);
      return true;
    },
  );
});

test('unsupported: a legacy .xls names spreadsheets, not Word', async () => {
  await assert.rejects(
    () => extractFromBuffer(ole2('Workbook'), { filename: 'budget.xls' }),
    (err) => err.format === 'xls' && /spreadsheet/i.test(err.message),
  );
});

test('unsupported: an OLE2 container names its type from the bytes, not the name', async () => {
  await assert.rejects(
    () => extractFromBuffer(ole2('PowerPoint Document'), { filename: 'mislabelled.doc' }),
    (err) => err.format === 'ppt',
  );
});

/** A zip whose entry names say what it is. The names are stored uncompressed. */
const zipNamed = (...parts) =>
  Buffer.concat([Buffer.from([0x50, 0x4b, 0x03, 0x04]), Buffer.from(parts.join(' '), 'latin1')]);

test('unsupported: an .xlsx is refused by name with a route out', async () => {
  await assert.rejects(
    () => extractFromBuffer(zipNamed('xl/workbook.xml'), { filename: 'budget.xlsx' }),
    (err) => {
      assert.equal(err.format, 'xlsx');
      assert.match(err.message, /csv/i);
      return true;
    },
  );
});

test('unsupported: Keynote and OpenDocument are named rather than called binary', async () => {
  await assert.rejects(
    () => extractFromBuffer(zipNamed('Index/Document.iwa'), { filename: 'deck.key' }),
    (err) => err.format === 'key',
  );
  await assert.rejects(
    () => extractFromBuffer(zipNamed('mimetype', 'opendocument.presentation'), { filename: 'a.odp' }),
    (err) => err.format === 'odp',
  );
});

test('unsupported: arbitrary binary throws rather than emitting mojibake', async () => {
  const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0xff, 0xfd, 0xfc]);
  await assert.rejects(
    () => extractFromBuffer(png, { filename: 'shot.png' }),
    (err) => {
      assert.ok(err instanceof UnsupportedFormatError);
      assert.equal(err.format, 'binary');
      return true;
    },
  );
});

test('extraction is pure: the same buffer twice gives the same text', async () => {
  const buf = await readFile(fixture('sample.docx'));
  const a = await extractFromBuffer(buf, { filename: 'sample.docx' });
  const b = await extractFromBuffer(buf, { filename: 'sample.docx' });
  assert.equal(a.text, b.text);
  assert.deepEqual(a.warnings, b.warnings);
});

/**
 * `maxInputBytes` exists so that a hostile file is never held in memory, and it
 * was measured on a buffer the reader had already produced — the one order in
 * which it cannot do that. By the time the limit was consulted, the bytes it
 * was there to refuse were resident.
 *
 * A file larger than Node will hold at all makes the difference visible rather
 * than merely theoretical: `readFile` gives up with a bare `RangeError` about
 * 2 GiB, which says nothing about slimdoc's limits and is not the error the API
 * documents. The file below is sparse, so it costs a directory entry and no
 * disk at all.
 */
test('limits: a file too large to read is refused by size, not by failing to read it', async (t) => {
  const { mkdtemp, rm, truncate, writeFile } = await import('node:fs/promises');
  const { tmpdir } = await import('node:os');

  const directory = await mkdtemp(join(tmpdir(), 'slimdoc-limits-'));
  const path = join(directory, 'enormous.pdf');
  t.after(() => rm(directory, { recursive: true, force: true }));

  await writeFile(path, '');
  await truncate(path, 3_000_000_000);

  await assert.rejects(
    () => extractFromFile(path),
    (err) => {
      assert.ok(err instanceof UnsupportedFormatError, `${err.constructor.name}: ${err.message}`);
      assert.match(err.message, /is 3\.0 GB, over the 100\.0 MB input limit/);
      return true;
    },
  );
});
