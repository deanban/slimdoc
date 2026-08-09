import assert from 'node:assert/strict';
import test from 'node:test';

import { fenceDelimiter, fencedBlock } from '../dist/utils/fence.js';
import { escapeCell, renderTable } from '../dist/utils/markdown-table.js';

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
