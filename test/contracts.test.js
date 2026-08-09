/**
 * The table and code output contracts, asserted through the full
 * `extract -> clean` pipeline rather than at the extraction boundary.
 *
 * Three of the defects these cover are invisible in the extractor's own output
 * and only appear once clean.ts has run — the RTF table in particular is
 * destroyed by `tabsToSpaces` long after extraction has done its job.
 */

import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import test from 'node:test';

import { extractFromBuffer, extractFromFile } from '../dist/extract.js';
import { clean } from '../dist/clean.js';

const FIXTURES = join(dirname(fileURLToPath(import.meta.url)), 'fixtures');
const fixture = (name) => join(FIXTURES, name);

const PRESETS = ['safe', 'balanced', 'aggressive'];

async function extractAndClean(name, preset) {
  const doc = await extractFromFile(fixture(name));
  return clean(doc.text, { preset });
}

/**
 * A fragment run through the same route a pasted .html file takes. Fixtures
 * cover the common shapes; the nesting and adjacency cases below are sharper
 * written inline, where the exact input sits next to the assertion.
 */
async function extractHtml(html) {
  return extractFromBuffer(Buffer.from(html, 'utf8'), { filename: 'inline.html' });
}

async function cleanHtml(html, preset = 'balanced') {
  return clean((await extractHtml(html)).text, { preset });
}

/** Every contiguous run of pipe-table lines in `text`. */
function tableBlocks(text) {
  const blocks = [];
  let current = [];
  for (const line of text.split('\n')) {
    if (line.trim().startsWith('|')) {
      current.push(line.trim());
    } else if (current.length > 0) {
      blocks.push(current);
      current = [];
    }
  }
  if (current.length > 0) blocks.push(current);
  return blocks;
}

// --------------------------------------------------------------------------
// table contract
// --------------------------------------------------------------------------

for (const preset of PRESETS) {
  test(`table contract: html survives the ${preset} preset`, async () => {
    const text = await extractAndClean('tables.html', preset);

    assert.match(text, /^\| Ship \| Class \| Status \|$/m);
    assert.match(text, /^\| --- \| --- \| --- \|$/m);
    assert.match(text, /^\| Enterprise \| Constitution \| active \|$/m);
  });
}

test('table contract: every emitted row has both edge bars', async () => {
  const text = await extractAndClean('tables.html', 'balanced');

  for (const block of tableBlocks(text)) {
    for (const row of block) {
      assert.ok(row.endsWith('|'), `row is missing its trailing bar: ${row}`);
    }
  }
});

test('table contract: no blank line ever splits a table', async () => {
  const text = await extractAndClean('tables.html', 'balanced');

  for (const block of tableBlocks(text)) {
    assert.ok(block.length >= 2, `a table block should not be orphaned: ${block}`);
  }
});

test('table contract: a header is always followed by a separator row', async () => {
  const text = await extractAndClean('tables.html', 'balanced');

  for (const block of tableBlocks(text)) {
    assert.match(block[1], /^\|(?: -+ \|)+$/, `expected a separator, got ${block[1]}`);
  }
});

test('table contract: a pipe inside a cell is escaped, not a column break', async () => {
  const text = await extractAndClean('tables.html', 'balanced');

  assert.match(text, /\| Voyager \| Intrepid \| lost \\\| presumed found \|$/m);
});

test('table contract: a newline inside a cell collapses to a space', async () => {
  const text = await extractAndClean('tables.html', 'balanced');

  assert.match(text, /^\| Defiant \| Escort \| refit pending \|$/m);
});

test('table contract: merged cells are flattened across the span', async () => {
  const doc = await extractFromFile(fixture('tables.html'));
  const text = clean(doc.text, { preset: 'balanced' });

  // colspan=2 repeats the value across both spanned columns.
  assert.match(text, /^\| Deployment \| Deployment \| Crew \|$/m);
  // rowspan=2 repeats the value down the spanned rows.
  assert.match(text, /^\| Alpha Quadrant \| Sector 001 \| 430 \|$/m);
  assert.match(text, /^\| Alpha Quadrant \| Sector 097 \| 141 \|$/m);

  assert.ok(
    doc.warnings.some((w) => /merged cells flattened/.test(w)),
    `expected a merged-cell warning, got ${JSON.stringify(doc.warnings)}`,
  );
});

test('table contract: a single-column table degrades to plain lines', async () => {
  // Plain lines, not a bogus one-column pipe table. `unwrap` is then free to
  // join them in the presets that reflow prose, which is the cost of refusing
  // to assert a structure that was never really there.
  const raw = (await extractFromFile(fixture('tables.html'))).text;
  assert.match(raw, /^Single column\nSecond row$/m);

  const text = await extractAndClean('tables.html', 'balanced');
  assert.match(text, /Single column/);
  assert.doesNotMatch(text, /\| Single column/);
});

test('table contract: a table with no <th> promotes its first row', async () => {
  // GFM has no headerless table, and Word never emits <th>, so an empty header
  // row would cost tokens on every docx table while hiding the real one.
  const text = await extractAndClean('tables.html', 'balanced');
  const block = tableBlocks(text).find((b) => b.some((r) => r.includes('Warp')));

  assert.ok(block, 'the headerless table should still be a table');
  assert.equal(block[0], '| Warp | 9.975 |');
  assert.match(block[1], /^\|(?: -+ \|)+$/);
  assert.equal(block[2], '| Impulse | 0.25c |');
});

test('table contract: unwrap cannot glue a table into the prose above it', async () => {
  const text = await extractAndClean('tables.html', 'balanced');

  assert.doesNotMatch(text, /no blank line between them\. \|/);
  assert.match(text, /^\| Ship \| Class \| Status \|$/m);
});

test('table contract: a table nested in a cell keeps its content', async () => {
  // Outlook and Teams wrap the real table in a layout table, so this is the
  // extractor's primary input rather than an edge case. Parking resolves
  // innermost-first, which leaves a marker sitting inside a parked value; a
  // single non-recursive restore left it there, clean.ts stripped the sentinels
  // around it, and the whole inner table arrived as the literal '0'.
  const text = await cleanHtml(
    '<table><tr><td><table><tr><td>Hello</td><td>World</td></tr></table></td></tr></table>',
  );

  assert.match(text, /^\| Hello \| World \|$/m);
  assert.match(text, /^\| --- \| --- \|$/m);
  assert.doesNotMatch(text, /^0$/m);
});

test('table contract: a table nested in a real row is flattened to its words', async () => {
  // The layout case above degrades to plain lines, so the inner table keeps its
  // Markdown. Here the outer grid is a real table, and a cell has no Markdown
  // form available to it: pipes are escaped on the way in, so restoring the
  // rendered inner table spelt the cell `\| Enterprise \| NCC-1701 \| \| --- \|`
  // — every byte of the grid and none of its meaning.
  const text = await cleanHtml(
    '<table><tr><td>Ship</td><td>' +
      '<table><tr><td>Enterprise</td><td>NCC-1701</td></tr></table>' +
      '</td></tr></table>',
  );

  assert.match(text, /^\| Ship \| Enterprise NCC-1701 \|$/m);
  assert.doesNotMatch(text, /\\\|/, 'the inner grid was restored as escaped pipes');
  assert.doesNotMatch(text, /---.*---.*---/, 'an inner separator row leaked into a cell');
});

test('table contract: a block restored into a cell cannot break the row', async () => {
  // A <pre> is parked before the <td> that holds it, so the cell holds a
  // marker. Restoring it after the row was rendered spliced newlines into a
  // finished pipe row; restoring it before rendering lets escapeCell flatten
  // it, which costs the block its line breaks and keeps the table standing.
  const text = await cleanHtml(
    '<table><tr><td>desc</td><td><pre><code>a\nb</code></pre></td></tr>' +
      '<tr><td>x</td><td>y</td></tr></table>',
  );

  assert.match(text, /^\| desc \| .*a b.* \|$/m);
  assert.match(text, /^\| x \| y \|$/m);
  for (const block of tableBlocks(text)) {
    for (const row of block) {
      assert.ok(row.endsWith('|'), `a restored block broke the row: ${row}`);
    }
  }
});

test('table contract: no parking sentinel ever reaches the output', async () => {
  // The sentinels are C0 controls that clean.ts strips, so an unrestored marker
  // is invisible in the cleaned text and takes its content with it. This is
  // asserted on the extractor's own output, where it is still visible.
  const { text } = await extractHtml(
    '<table><tr><td><table><tr><td><pre>a\nb</pre></td><td>x</td></tr></table></td>' +
      '<td>outer</td></tr></table>',
  );

  assert.doesNotMatch(text, /[\u0002\u0003]/, 'a parking marker survived restoration');
  assert.doesNotMatch(text, /[\u0000-\u0008\u000b-\u001f]/);
  assert.match(text, /outer/);
});

test('table contract: two adjacent tables do not weld together', async () => {
  // Nothing separated the two markers, so the first table's separator row and
  // the second table's header used to be restored onto the same line.
  const text = await cleanHtml(
    '<table><tr><td>A</td><td>B</td></tr></table><table><tr><td>C</td><td>D</td></tr></table>',
  );

  assert.deepEqual(tableBlocks(text), [
    ['| A | B |', '| --- | --- |'],
    ['| C | D |', '| --- | --- |'],
  ]);
});

test('table contract: a table is separated from the block on either side', async () => {
  // Same defect, other neighbour: a parked code block carries no break of its
  // own either, so a fence used to be glued onto the separator row.
  const after = await cleanHtml(
    '<table><tr><td>A</td><td>B</td></tr></table><pre>warp core</pre>',
  );
  assert.match(after, /^\| --- \| --- \|\n\n```$/m);

  const before = await cleanHtml(
    '<pre>warp core</pre><table><tr><td>A</td><td>B</td></tr></table>',
  );
  assert.match(before, /^```\n\n\| A \| B \|$/m);

  // And the blank line a <p> already supplied is not doubled up.
  const between = await cleanHtml(
    '<p>before</p><table><tr><td>A</td><td>B</td></tr></table><p>after</p>',
  );
  assert.match(between, /^before\n\n\| A \| B \|\n\| --- \| --- \|\n\nafter$/m);
});

test('table contract: a document with more than 100 tables is not truncated', async () => {
  // A threaded email chain or a long Word report clears 100 tables easily. The
  // old fixed cap did not degrade, it corrupted: table 101 kept its markup, and
  // the generic tag-stripper then glued its cells into `EnterpriseNCC-1701`.
  const html = Array.from(
    { length: 120 },
    (_, i) => `<table><tr><td>Ship${i}</td><td>NCC-${i}</td></tr></table>`,
  ).join('');
  const text = await cleanHtml(html);

  assert.equal(tableBlocks(text).length, 120);
  assert.match(text, /^\| Ship119 \| NCC-119 \|$/m);
  assert.doesNotMatch(text, /Ship\d+NCC/, 'a table past the cap had its cells glued');
});

test('table contract: an absurd colspan cannot expand into a token bomb', async () => {
  // A span is expanded by repetition because Markdown has no colspan, which
  // makes `colspan="999"` 999 real columns holding the same word.
  const text = await cleanHtml('<table><tr><td colspan="999">X</td><td>y</td></tr></table>');
  const columns = tableBlocks(text)[0][0].split('|').length - 1;

  assert.ok(columns <= 66, `a single cell expanded into ${columns} columns`);
  assert.match(text, /\| y \|$/m);
});

// --------------------------------------------------------------------------
// entities, decoded exactly once
// --------------------------------------------------------------------------

test('html contract: an entity in inline code is decoded once, not twice', async () => {
  // markInlineCode decoded its text and then left it in the stream, where
  // normaliseWhitespace decoded it a second time. `&amp;lt;br&amp;gt;` is
  // someone writing about a tag, and it used to arrive as the tag itself.
  const text = await cleanHtml('<p>use <code>&amp;lt;br&amp;gt;</code> here</p>');

  assert.match(text, /use `&lt;br&gt;` here/);
});

test('html contract: an entity in a link is decoded once, not twice', async () => {
  const text = await cleanHtml('<p><a href="https://x.com">A &amp;amp; B</a></p>');

  assert.match(text, /\[A &amp; B\]\(https:\/\/x\.com\)/);
});

test('html contract: prose and table cells still decode exactly once', async () => {
  // The other half of the invariant: these two were already right, and the fix
  // for the two above must not turn a single decode into none.
  assert.match(await cleanHtml('<p>A &amp;amp; B</p>'), /A &amp; B/);
  assert.match(
    await cleanHtml('<table><tr><td>A &amp;amp; B</td><td>x</td></tr></table>'),
    /^\| A &amp; B \| x \|$/m,
  );
  assert.match(await cleanHtml('<p>A &amp; B</p>'), /A & B/);
});

// --------------------------------------------------------------------------
// docx, which now shares the HTML path
// --------------------------------------------------------------------------

for (const preset of PRESETS) {
  test(`table contract: docx survives the ${preset} preset`, async () => {
    // mammoth's Markdown writer had no table support at all: this table used
    // to arrive as twelve orphan paragraphs.
    const text = await extractAndClean('sample.docx', preset);

    assert.match(text, /^\| Quarter \| Revenue \| Notes \|$/m);
    assert.match(text, /^\| --- \| --- \| --- \|$/m);
    assert.match(text, /^\| Q1 \| 1\.2M \| flat \|$/m);
  });
}

test('docx: a nested bullet stays attached to its parent list', async () => {
  const text = await extractAndClean('sample.docx', 'balanced');

  assert.match(text, /^- Two enterprise logos signed .* multi.year\n {2}- Support backlog cleared$/m);
});

test('docx: no base64 survives the html route', async () => {
  const text = await extractAndClean('sample.docx', 'balanced');

  assert.doesNotMatch(text, /data:/);
  assert.doesNotMatch(text, /[A-Za-z0-9+/]{200,}/);
});

test('one table, three formats, one output', async () => {
  // The whole point of the shared emitter: docx, html and rtf must not each
  // invent their own answer to escaping, headers and separators.
  const shape = (text) =>
    text
      .split('\n')
      .filter((l) => l.startsWith('|'))
      .map((l) => l.replace(/[^|\\ -]+/g, 'X'))
      .slice(0, 2)
      .join('\n');

  const docx = shape(await extractAndClean('sample.docx', 'balanced'));
  const html = shape(await extractAndClean('tables.html', 'balanced'));
  const rtf = shape(await extractAndClean('tables.rtf', 'balanced'));

  assert.equal(docx, '| X | X | X |\n| --- | --- | --- |');
  assert.equal(html, docx);
  assert.equal(rtf, docx);
});

// --------------------------------------------------------------------------
// code contract
// --------------------------------------------------------------------------

test('code contract: a fence is longer than any backtick run inside it', async () => {
  const text = await extractAndClean('code.html', 'balanced');
  const opener = text.split('\n').find((l) => /^`{4,}$/.test(l));

  assert.ok(opener, `expected a widened fence, got:\n${text}`);
  assert.match(text, /^````\nExample:\n```\ninner block\n```\ndone\n````$/m);
});

test('code contract: a language identifier survives when the source supplies one', async () => {
  const text = await extractAndClean('code.html', 'balanced');

  assert.match(text, /^```python$/m);
});

test('code contract: indentation inside a code block is never collapsed', async () => {
  for (const preset of PRESETS) {
    const text = await extractAndClean('code.html', preset);
    assert.match(text, /^ {4}return "nominal"$/m, `indent lost under ${preset}`);
  }
});

test('code contract: indentation outside <pre> is protected too', async () => {
  const text = await extractAndClean('code.html', 'balanced');

  assert.match(text, /^def broken\(x\):\n {4}return x \+ 1$/m);
});

test('code contract: inline <code> keeps its backticks', async () => {
  const text = await extractAndClean('code.html', 'balanced');

  assert.match(text, /`slimdoc --stats`/);
});

test('code contract: an escaped script sample survives while a real one does not', async () => {
  for (const preset of PRESETS) {
    const text = await extractAndClean('code.html', preset);

    assert.match(text, /<script>alert\('this is a sample'\)<\/script>/, `sample lost under ${preset}`);
    assert.doesNotMatch(text, /window\.tracking/, `tracking script survived ${preset}`);
    assert.doesNotMatch(text, /color: red/, `stylesheet survived ${preset}`);
  }
});

test('code contract: a code embed leaves a trace instead of a dangling lead-in', async () => {
  const text = await extractAndClean('code.html', 'balanced');

  assert.match(text, /\[embedded: https:\/\/gist\.github\.com\/picard\/1234abcd\]/);
  // A non-code embed is still dropped outright.
  assert.doesNotMatch(text, /youtube/i);
});

// --------------------------------------------------------------------------
// the kitchen-sink corpus — every category of noise at once
// --------------------------------------------------------------------------

const CORPUS = join(FIXTURES, 'corpus', 'kitchen-sink.html');

for (const preset of PRESETS) {
  test(`corpus: html holds its contract under ${preset}`, async () => {
    const doc = await extractFromFile(CORPUS);
    const text = clean(doc.text, { preset });

    // An escaped sample is text and survives; the page's own script does not.
    assert.match(text, /alert\(1\)/, 'the escaped code sample was lost');
    assert.doesNotMatch(text, /pixel\./, 'a real script survived');
    // No prose in the fixture contains the word, so this is a safe search.
    assert.doesNotMatch(text, /base64/, 'encoded image data reached the output');
    assert.doesNotMatch(text, /&[a-zA-Z][a-zA-Z0-9]{1,31};/, 'an entity was left undecoded');
    // No markup assertion here: the escaped <script> sample is *supposed* to
    // start a line with what looks exactly like a tag.
    // Indentation that carries meaning is never collapsed.
    assert.match(text, /^ {4}\S/m, 'code indentation was collapsed');
  });
}

test('corpus: 43 kB of hostile html carries about 5 kB of meaning', async () => {
  const doc = await extractFromFile(CORPUS);

  assert.ok(doc.text.length < 8000, `expected < 8 kB extracted, got ${doc.text.length}`);
  assert.ok(doc.warnings.some((w) => /merged cells flattened/.test(w)));
});

// --------------------------------------------------------------------------
// rtf tables
// --------------------------------------------------------------------------

for (const preset of PRESETS) {
  test(`table contract: rtf columns survive the ${preset} preset`, async () => {
    // The sharpest illustration of why this is asserted after cleaning: the
    // extractor used to emit tabs, and tabsToSpaces plus collapseSpaces then
    // erased the columns entirely.
    const text = await extractAndClean('tables.rtf', preset);

    assert.match(text, /^\| Ship \| Class \| Status \|$/m);
    assert.match(text, /^\| --- \| --- \| --- \|$/m);
    assert.match(text, /^\| Enterprise \| Constitution \| active \|$/m);
  });
}

test('table contract: a pipe in an rtf cell is escaped', async () => {
  const text = await extractAndClean('tables.rtf', 'balanced');

  assert.match(text, /^\| Voyager \| Intrepid \| lost \\\| presumed found \|$/m);
});

test('table contract: rtf prose around the table is untouched', async () => {
  const text = await extractAndClean('tables.rtf', 'balanced');

  assert.match(text, /^Fleet Report$/m);
  assert.match(text, /After the table, ordinary prose resumes\./m);
});

test('table contract: no cell sentinel ever reaches the output', async () => {
  const raw = (await extractFromFile(fixture('tables.rtf'))).text;

  assert.doesNotMatch(raw, /[\u0000-\u0008\u000b-\u001f]/);
});
