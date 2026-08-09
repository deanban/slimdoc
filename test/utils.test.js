import assert from 'node:assert/strict';
import test from 'node:test';

import { fenceDelimiter, fencedBlock } from '../dist/utils/fence.js';
import { escapeCell, renderTable } from '../dist/utils/markdown-table.js';
import { parseRanges, selectPages } from '../dist/utils/ranges.js';
import { sanitizeText, stripInvisible } from '../dist/utils/text.js';

// --------------------------------------------------------------------------
// fenceDelimiter
// --------------------------------------------------------------------------

test('fence: plain code gets the standard three backticks', () => {
  assert.equal(fenceDelimiter('const x = 1;'), '```');
  assert.equal(fenceDelimiter(''), '```');
});

test('fence: a run of three backticks inside forces four', () => {
  const code = 'Example:\n```\nnested\n```\n';
  assert.equal(fenceDelimiter(code), '````');
});

test('fence: the longest interior run wins, not the first', () => {
  const code = '``` then later ````` here';
  assert.equal(fenceDelimiter(code), '``````');
});

test('fence: one or two backticks still only need three', () => {
  assert.equal(fenceDelimiter('use `x` and ``y``'), '```');
});

// --------------------------------------------------------------------------
// fencedBlock
// --------------------------------------------------------------------------

test('fence: a block round-trips with matching delimiters', () => {
  assert.equal(fencedBlock('hi'), '```\nhi\n```');
});

test('fence: a language identifier is emitted on the opening fence only', () => {
  assert.equal(fencedBlock('hi', 'js'), '```js\nhi\n```');
});

test('fence: a nested fence is not broken by the wrapper', () => {
  const code = '```\ninner\n```';
  const out = fencedBlock(code, 'md');

  assert.equal(out, '````md\n```\ninner\n```\n````');
  // The closing fence must be the last line and must not be mistaken for the
  // inner one: a reader scanning for the opener's delimiter finds only the end.
  assert.equal(out.split('\n').at(-1), '````');
});

test('fence: trailing newlines in the code do not double up', () => {
  assert.equal(fencedBlock('hi\n'), '```\nhi\n```');
  assert.equal(fencedBlock('hi\n\n\n'), '```\nhi\n```');
});

test('fence: an empty block is still well formed', () => {
  assert.equal(fencedBlock(''), '```\n\n```');
});

// --------------------------------------------------------------------------
// escapeCell
// --------------------------------------------------------------------------

test('table: a pipe inside a cell is escaped, not dropped', () => {
  assert.equal(escapeCell('a|b'), 'a\\|b');
});

test('table: a newline inside a cell collapses to a space', () => {
  assert.equal(escapeCell('two\nlines'), 'two lines');
  assert.equal(escapeCell('crlf\r\nhere'), 'crlf here');
});

test('table: cell whitespace is collapsed and trimmed', () => {
  assert.equal(escapeCell('  padded   out  '), 'padded out');
  assert.equal(escapeCell('\ttabbed'), 'tabbed');
});

// --------------------------------------------------------------------------
// renderTable
// --------------------------------------------------------------------------

const GRID = [
  ['Quarter', 'Revenue', 'Notes'],
  ['Q1', '1.2M', 'flat'],
  ['Q2', '1.4M', 'the big deal landed'],
];

test('table: a header grid renders as GitHub-flavoured Markdown', () => {
  assert.equal(
    renderTable(GRID),
    [
      '| Quarter | Revenue | Notes |',
      '| --- | --- | --- |',
      '| Q1 | 1.2M | flat |',
      '| Q2 | 1.4M | the big deal landed |',
    ].join('\n'),
  );
});

test('table: every row carries leading and trailing bars', () => {
  // This is what makes a table survive clean.ts: isTableRow requires both.
  for (const line of renderTable(GRID).split('\n')) {
    assert.ok(line.startsWith('|'), `missing leading bar: ${line}`);
    assert.ok(line.endsWith('|'), `missing trailing bar: ${line}`);
  }
});

test('table: no blank line ever separates two rows', () => {
  assert.doesNotMatch(renderTable(GRID), /\n\s*\n/);
});

test('table: ragged rows are padded to the widest row', () => {
  const out = renderTable([['a', 'b', 'c'], ['d']]);
  assert.equal(out.split('\n')[2], '| d |  |  |');
});

test('table: cell contents are escaped on the way in', () => {
  const out = renderTable([['h1', 'h2'], ['a|b', 'two\nlines']]);
  assert.match(out, /\| a\\\|b \| two lines \|/);
});

test('table: a single-column grid is not a table', () => {
  assert.equal(renderTable([['only'], ['one']]), null);
});

test('table: an empty grid is not a table', () => {
  assert.equal(renderTable([]), null);
  assert.equal(renderTable([[]]), null);
});

// --------------------------------------------------------------------------
// stripInvisible / sanitizeText
// --------------------------------------------------------------------------

test('text: zero-width and soft-hyphen characters go, the letters stay', () => {
  assert.equal(stripInvisible('zero​width'), 'zerowidth');
  assert.equal(stripInvisible('soft­hyphen'), 'softhyphen');
  assert.equal(stripInvisible('﻿bom'), 'bom');
});

test('text: newlines and tabs survive the control strip', () => {
  assert.equal(stripInvisible('a\nb\tc'), 'a\nb\tc');
  assert.equal(stripInvisible('bellhere'), 'bellhere');
});

test('text: sanitize folds ligatures the way NFKC does', () => {
  assert.equal(sanitizeText('ﬁrst'), 'first');
  assert.equal(sanitizeText('ﬂag'), 'flag');
});

test('text: sanitize does both jobs in one pass', () => {
  assert.equal(sanitizeText('ﬁrst​ line'), 'first line');
});

/**
 * The reason this helper exists: fenced content bypasses clean.ts entirely, so
 * a PDF table preserved as preformatted text would otherwise keep every
 * ligature and soft hyphen the cleaner exists to remove.
 */
test('text: sanitize leaves ordinary prose byte-identical', () => {
  const prose = 'Ordinary prose, with punctuation - and digits 42.';
  assert.equal(sanitizeText(prose), prose);
});

// --------------------------------------------------------------------------
// parseRanges
// --------------------------------------------------------------------------

test('ranges: a single page is a range of one', () => {
  assert.deepEqual(parseRanges('4'), [[4, 4]]);
});

test('ranges: the spec example parses to two ranges', () => {
  assert.deepEqual(parseRanges('3-7,12'), [[3, 7], [12, 12]]);
});

test('ranges: surrounding and interior spaces are tolerated', () => {
  assert.deepEqual(parseRanges(' 1 - 2 , 5 '), [[1, 2], [5, 5]]);
});

test('ranges: junk is refused by name rather than silently ignored', () => {
  for (const bad of ['', 'x', '0', '-3', '3-', '5-2', '1,,2', '1.5']) {
    assert.throws(() => parseRanges(bad), RangeError, `accepted "${bad}"`);
  }
});

// --------------------------------------------------------------------------
// selectPages
// --------------------------------------------------------------------------

test('pages: no ranges means every page', () => {
  assert.deepEqual(selectPages(3, [], 10), { pages: [1, 2, 3], dropped: 0 });
});

test('pages: ranges are expanded, sorted and deduplicated', () => {
  assert.deepEqual(selectPages(9, [[5, 6], [1, 2], [2, 2]], 10).pages, [1, 2, 5, 6]);
});

test('pages: a range running past the end is clamped, not an error', () => {
  assert.deepEqual(selectPages(3, [[2, 900]], 10).pages, [2, 3]);
});

test('pages: a selection entirely past the end comes back empty', () => {
  assert.deepEqual(selectPages(3, [[40, 50]], 10).pages, []);
});

/**
 * The cap applies to SELECTED pages, so `--pages 1-3` of a 2,000-page document
 * reads three pages. `dropped` is what stops the cap from being silent: the
 * caller warns with it.
 */
test('pages: the cap counts selected pages and reports what it dropped', () => {
  assert.deepEqual(selectPages(2000, [[1, 3]], 5), { pages: [1, 2, 3], dropped: 0 });
  assert.deepEqual(selectPages(2000, [], 3), { pages: [1, 2, 3], dropped: 1997 });
});
