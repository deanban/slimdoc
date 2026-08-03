import test from 'node:test';
import assert from 'node:assert/strict';
import { clean, cleanWithStats } from '../dist/clean.js';

const PRESETS = ['safe', 'balanced', 'aggressive'];

const MESSY = [
  '#  Quarterly   Report  ',
  '',
  '',
  '',
  'The team—which grew by 12—shipped “three” releases… and',
  'everybody was pleased with the outcome of the work.',
  '',
  '• first bullet',
  '• second bullet',
  '',
  '| Name        |  Role       |',
  '| ----------- | ----------- |',
  '| Dean        |  Engineering|',
  '',
  '```js',
  'const  x   =  1;\t// keep   this   exactly',
  '```',
  '',
  'A paragraph with `inline  code` in the middle of it, plus a',
  '[link](https://example.com/x) and **bold** text.',
  '',
  '> a quoted line',
  '',
  '1. numbered one',
  '2. numbered two',
  '',
].join('\n');

test('idempotent for every preset', () => {
  for (const preset of PRESETS) {
    const once = clean(MESSY, { preset });
    assert.equal(clean(once, { preset }), once, `preset ${preset} is not idempotent`);
  }
});

test('idempotent for every preset with transcript and emoji enabled', () => {
  const input = `${MESSY}\nDone \u{1F389}\u{1F3FD} here.\n`;
  for (const preset of PRESETS) {
    for (const extra of [{ stripEmoji: true }, { transcript: true }, { unwrap: true, maxBlankLines: 0 }]) {
      const opts = { preset, ...extra };
      const once = clean(input, opts);
      assert.equal(clean(once, opts), once, `${preset} + ${JSON.stringify(extra)} is not idempotent`);
    }
  }
});

test('output always ends with exactly one newline and no leading blank lines', () => {
  for (const preset of PRESETS) {
    const out = clean(`\n\n\n${MESSY}\n\n\n`, { preset });
    assert.ok(out.endsWith('\n'));
    assert.ok(!out.endsWith('\n\n'));
    assert.ok(!out.startsWith('\n'));
  }
  assert.equal(clean(''), '');
  assert.equal(clean('   \n\n  \n'), '');
});

test('fenced code survives byte-identical', () => {
  const fence = '```python\ndef  f( a ):\n\treturn   a  *  2\n\n\n    # trailing   comment\n```';
  const input = `Intro   text.\n\n${fence}\n\nOutro   text.\n`;
  for (const preset of PRESETS) {
    const out = clean(input, { preset });
    assert.ok(out.includes(fence), `preset ${preset} mangled the fence:\n${out}`);
  }
});

test('tilde fences, long fences and unclosed fences are protected', () => {
  const body = '~~~~\nkeep    ~~~ this\n~~~~';
  assert.ok(clean(`a\n\n${body}\n\nb\n`, { preset: 'aggressive' }).includes(body));
  const unclosed = '```\nnever    closed\n  still  code';
  assert.ok(clean(`a\n\n${unclosed}\n`, { preset: 'aggressive' }).includes(unclosed));
});

test('indented code blocks survive', () => {
  const input = 'Intro paragraph.\n\n    code   line   one\n    code   line   two\n\nAfter.\n';
  const out = clean(input, { preset: 'aggressive' });
  assert.ok(out.includes('    code   line   one\n    code   line   two'));
});

test('inline code spans survive byte-identical', () => {
  const input = 'Run `npm  install   x` then ``a ` b`` and — done.\n';
  for (const preset of PRESETS) {
    const out = clean(input, { preset });
    assert.ok(out.includes('`npm  install   x`'), preset);
    assert.ok(out.includes('``a ` b``'), preset);
  }
  // Protected spans are exempt from punctuation folding too.
  assert.ok(clean('x `a — b` y\n', { preset: 'aggressive' }).includes('`a — b`'));
});

test('a wrapped list continuation is not frozen as indented code', () => {
  // The indent is structure and survives, but the line must still be cleaned.
  const input = '- item one\n\n    still   part of “the”   item\n\nAfter.\n';
  const out = clean(input, { preset: 'balanced' });
  assert.ok(out.includes('    still part of "the" item'), out);
});

test('smart quotes, dashes and ellipses fold to ASCII', () => {
  const input = '“He said’ it—a fact…” – and a → b, x ≤ y, 3 × 4.\n';
  const out = clean(input, { preset: 'balanced' });
  assert.equal(out, '"He said\' it-a fact..." - and a -> b, x <= y, 3 x 4.\n');
});

test('an em-dash does not gain or lose surrounding spaces', () => {
  assert.equal(clean('a—b\n', { preset: 'balanced' }), 'a-b\n');
  assert.equal(clean('a — b\n', { preset: 'balanced' }), 'a - b\n');
});

test('line-leading unicode bullets become list markers', () => {
  const out = clean('• one\n● two\n  ◦ three\n', { preset: 'balanced' });
  assert.equal(out, '- one\n- two\n  - three\n');
});

test('safe preset leaves typography alone but still strips media', () => {
  const out = clean('A — B\n\n![](data:image/png;base64,QUJD)\n\nC\n', { preset: 'safe' });
  assert.ok(out.includes('A — B'));
  assert.ok(!out.includes('data:'));
});

test('non-breaking and zero-width junk disappears', () => {
  const out = clean('a b​c﻿d­e\n', { preset: 'balanced' });
  assert.equal(out, 'a bcde\n');
});

test('blank line runs collapse to the preset limit', () => {
  const input = 'one\n\n\n\n\ntwo\n';
  assert.equal(clean(input, { preset: 'safe' }), 'one\n\n\ntwo\n');
  assert.equal(clean(input, { preset: 'balanced' }), 'one\n\ntwo\n');
  assert.equal(clean(input, { preset: 'aggressive' }), 'one\ntwo\n');
});

test('paragraphs are never glued together, even at maxBlankLines 0', () => {
  const input = 'First paragraph here.\n\n\nSecond paragraph here.\n\n\nThird one.\n';
  for (const preset of PRESETS) {
    const out = clean(input, { preset, maxBlankLines: 0 });
    const nonBlank = out.split('\n').filter((l) => l !== '');
    assert.equal(nonBlank.length, 3, `${preset}: ${JSON.stringify(out)}`);
    assert.ok(!out.includes('here. Second'));
    assert.ok(!out.includes('here.Second'));
  }
});

test('unwrap joins wrapped prose', () => {
  const input = 'This sentence was hard\nwrapped across three\nsource lines.\n\nNext paragraph.\n';
  const out = clean(input, { preset: 'balanced' });
  assert.equal(out, 'This sentence was hard wrapped across three source lines.\n\nNext paragraph.\n');
});

test('unwrap does not swallow structural lines', () => {
  const input = [
    'Intro line that could absorb things',
    '# A heading',
    'Text under the heading',
    '- a list item',
    '- another list item',
    '1. an ordered item',
    '2) another ordered item',
    '> a blockquote',
    '| a | b |',
    '| --- | --- |',
    '| c | d |',
    '<div>html</div>',
    'Tail line',
    '',
    'Second paragraph.',
    '',
  ].join('\n');
  const out = clean(input, { preset: 'balanced' });
  assert.ok(out.includes('Intro line that could absorb things\n# A heading'), out);
  assert.ok(out.includes('# A heading\nText under the heading'), out);
  assert.ok(out.includes('Text under the heading\n- a list item'), out);
  assert.ok(out.includes('- a list item\n- another list item'), out);
  assert.ok(out.includes('- another list item\n1. an ordered item'), out);
  assert.ok(out.includes('1. an ordered item\n2) another ordered item'), out);
  assert.ok(out.includes('2) another ordered item\n> a blockquote'), out);
  assert.ok(out.includes('> a blockquote\n| a | b |'), out);
  assert.ok(out.includes('| c | d |\n<div>html</div>'), out);
});

test('unwrap does not absorb a code fence or its contents', () => {
  const input = 'A line of prose\n```\nfenced  code\n```\nmore prose\n\nend.\n';
  const out = clean(input, { preset: 'balanced' });
  assert.ok(out.includes('A line of prose\n```\nfenced  code\n```\nmore prose'), out);
});

test('unwrap respects an escaped hard break', () => {
  const out = clean('line one\\\nline two\n\nnext.\n', { preset: 'balanced' });
  assert.ok(out.includes('line one\\\nline two'), out);
});

test('table padding is compacted and separators shrink', () => {
  const input = '| Name    |  Role        | N |\n| :------ | -----------: | - |\n| Dean    |  Engineering | 1 |\n';
  const out = clean(input, { preset: 'balanced' });
  assert.equal(out, '| Name | Role | N |\n| :--- | ---: | --- |\n| Dean | Engineering | 1 |\n');
});

test('escaped pipes inside a table cell survive compaction', () => {
  const out = clean('| a \\| b |  c  |\n| --- | --- |\n', { preset: 'balanced' });
  assert.equal(out, '| a \\| b | c |\n| --- | --- |\n');
});

test('stripMarkdown keeps the words and the list structure', () => {
  const input = [
    '# Heading',
    '',
    'Some **bold**, some *italic*, some __also bold__, some _also italic_,',
    'some ~~struck~~ text and a [link](https://example.com) plus <https://bare.example>.',
    '',
    '<!-- a comment -->',
    '',
    'Setext heading',
    '==============',
    '',
    '---',
    '',
    '- kept list marker',
    '1. kept ordered marker',
    '',
    '> quoted',
    '',
  ].join('\n');
  const out = clean(input, { preset: 'aggressive' });
  assert.ok(!out.includes('**'));
  assert.ok(!out.includes('~~'));
  assert.ok(!out.includes('](' ));
  assert.ok(!out.includes('<!--'));
  assert.ok(!out.includes('=========='));
  assert.ok(out.includes('Heading'));
  assert.ok(out.includes('bold'));
  assert.ok(out.includes('italic'));
  assert.ok(out.includes('struck'));
  assert.ok(out.includes('link'));
  assert.ok(out.includes('https://bare.example'));
  assert.ok(out.includes('Setext heading'));
  assert.ok(out.includes('- kept list marker'));
  assert.ok(out.includes('1. kept ordered marker'));
  assert.ok(out.includes('quoted'));
  assert.ok(!/^>/m.test(out));
});

test('snake_case and maths asterisks are not read as emphasis', () => {
  const out = clean('call some_function_name(a) when 2 * 3 * 4 is fine.\n', { preset: 'aggressive' });
  assert.ok(out.includes('some_function_name'), out);
  assert.ok(out.includes('2 * 3 * 4'), out);
});

const WORDS = /[\p{L}\p{N}][\p{L}\p{N}'’-]*/gu;
const wordCount = (s) => (s.match(WORDS) ?? []).length;

test('no word is ever lost', () => {
  const prose = [
    '# Heading One',
    '',
    'The quick brown fox jumps over the lazy dog while',
    'the second line continues the very same sentence.',
    '',
    '- alpha beta',
    '- gamma delta',
    '',
    '| one | two |',
    '| --- | --- |',
    '| three | four |',
    '',
    '> quoted words here',
    '',
    'Trailing paragraph with **emphasis** and a [labelled link](https://example.com).',
    '',
  ].join('\n');
  const before = wordCount(prose);
  for (const preset of PRESETS) {
    const out = clean(prose, { preset, stripMarkdown: false });
    assert.equal(wordCount(out), before, `preset ${preset} changed the word count`);
  }
});

test('stripMedia removes a multi-KB base64 avatar and leaves no blank line behind', () => {
  const payload = 'iVBORw0KGgoAAAANSUhEUg' + 'A'.repeat(8000) + '=';
  const input = `Before.\n\n![](data:image/jpeg;base64,${payload})\n\nAfter.\n`;
  const out = clean(input, { preset: 'balanced' });
  assert.equal(out, 'Before.\n\nAfter.\n');
  assert.ok(out.length < 40);
});

test('stripMedia handles the Teams per-utterance block', () => {
  const avatar = `![](data:image/jpeg;base64,${'/9j/4AAQ'.repeat(700)})`;
  const input = [
    avatar, '', '__Rivera, Sam__', '', '0 minutes 43 seconds0:43', '',
    'Morning all, shall we get started\\.', '',
  ].join('\n');
  const out = clean(input, { preset: 'balanced' });
  assert.ok(!out.includes('data:'));
  assert.ok(!out.includes('9j/4AAQ'));
  assert.ok(out.includes('__Rivera, Sam__'));
  assert.ok(out.includes('Morning all, shall we get started?'));
  assert.ok(!/\n\n\n/.test(out), JSON.stringify(out));
});

test('an inline image never leaves a double space', () => {
  const out = clean('A sentence ![](data:image/png;base64,QUJD) with an image.\n', { preset: 'balanced' });
  assert.equal(out, 'A sentence with an image.\n');
  const tight = clean('word![](img.png)word\n', { preset: 'balanced' });
  assert.equal(tight, 'wordword\n');
});

test('a meaningful alt is kept as a caption, a generic one is not', () => {
  assert.equal(
    clean('![Revenue by quarter](chart.png)\n', { preset: 'balanced' }),
    '[image: Revenue by quarter]\n',
  );
  for (const alt of ['', 'avatar', 'Logo', 'photo.jpg', 'cid:image001.png@01D9']) {
    const out = clean(`x\n\n![${alt}](chart.png)\n\ny\n`, { preset: 'balanced' });
    assert.equal(out, 'x\n\ny\n', `alt ${JSON.stringify(alt)} should have been dropped`);
  }
});

test('orphan base64 blobs and image reference definitions are dropped', () => {
  const blob = 'QUJD'.repeat(80);
  const input = `Before.\n\n${blob}\n\n[a]: data:image/png;base64,QUJD\n[b]: pics/avatar.png\n[c]: https://example.com/page\n\nAfter.\n`;
  const out = clean(input, { preset: 'balanced' });
  assert.ok(!out.includes(blob));
  assert.ok(!out.includes('[a]:'));
  assert.ok(!out.includes('[b]:'));
  assert.ok(out.includes('[c]: https://example.com/page'));
  assert.ok(out.includes('Before.'));
  assert.ok(out.includes('After.'));
});

test('HTML media and data URIs anywhere are removed', () => {
  const input = [
    'Text <img src="data:image/png;base64,QUJD" alt="avatar"> more text.',
    '',
    '<svg width="10"><circle r="3"/></svg>',
    '',
    '<picture><source srcset="a.webp"><img src="a.png"></picture>',
    '',
    '<figure><img src="x.png" alt="ignored"><figcaption>Figure 1: growth</figcaption></figure>',
    '',
    'A stray data:application/octet-stream;base64,QUJDREVG in prose.',
    '',
  ].join('\n');
  const out = clean(input, { preset: 'balanced' });
  assert.ok(!out.includes('data:'), out);
  assert.ok(!out.includes('<svg'), out);
  assert.ok(!out.includes('<img'), out);
  assert.ok(!out.includes('<picture'), out);
  assert.ok(out.includes('Text more text.'), out);
  assert.ok(out.includes('Figure 1: growth'), out);
  assert.ok(out.includes('A stray in prose.'), out);
});

test('media inside a code fence is left alone', () => {
  const fence = '```md\n![](data:image/png;base64,QUJD)\n```';
  assert.ok(clean(`a\n\n${fence}\n\nb\n`, { preset: 'aggressive' }).includes(fence));
});

test('--no-strip-media keeps the image', () => {
  const out = clean('![](data:image/png;base64,QUJD)\n', { preset: 'balanced', stripMedia: false });
  assert.ok(out.includes('data:image/png;base64,QUJD'));
});

test('unescapeMarkdown drops mammoth backslashes but keeps escaped backslashes', () => {
  assert.equal(clean('AI\\-generated content may be incorrect\n', { preset: 'balanced' }),
    'AI-generated content may be incorrect\n');
  assert.equal(clean('good afternoon\\.\\.\\.\n', { preset: 'balanced' }), 'good afternoon...\n');
  assert.equal(clean('a \\\\ b\n', { preset: 'balanced' }), 'a \\ b\n');
  // Off in the safe preset.
  assert.equal(clean('AI\\-generated\n', { preset: 'safe' }), 'AI\\-generated\n');
  // Never inside code.
  assert.ok(clean('`AI\\-generated`\n', { preset: 'balanced' }).includes('`AI\\-generated`'));
});

test('tabs become single spaces outside code', () => {
  assert.equal(clean('a\tb\t\tc\n', { preset: 'balanced' }), 'a b c\n');
  assert.equal(clean('a\tb\n', { preset: 'balanced', tabsToSpaces: false }), 'a\tb\n');
});

test('indentation is preserved while interior space runs collapse', () => {
  assert.equal(clean('  - nested   item   here\n', { preset: 'safe' }), '  - nested item here\n');
});

test('stripEmoji removes pictographs and tidies the gap', () => {
  const out = clean('Great work \u{1F389}\u{1F3FD} team \u{1F1EC}\u{1F1E7}!\n', { preset: 'aggressive' });
  assert.equal(out, 'Great work team !\n');
  const only = clean('before\n\n\u{1F389}\n\nafter\n', { preset: 'aggressive' });
  assert.equal(only, 'before\nafter\n');
});

test('CRLF, CR and unicode line separators all normalise', () => {
  assert.equal(clean('a\r\nb\rc d e\n', { preset: 'safe', unwrap: false }), 'a\nb\nc\nd\ne\n');
});

test('cleanWithStats returns the cleaned text plus a stats block', () => {
  const { text, stats } = cleanWithStats(MESSY, { preset: 'balanced' });
  assert.equal(text, clean(MESSY, { preset: 'balanced' }));
  assert.equal(stats.chars.before, MESSY.length);
  assert.equal(stats.chars.after, text.length);
  assert.ok(stats.tokens.after <= stats.tokens.before);
  assert.ok(stats.savedPct >= 0 && stats.savedPct <= 100);
});

test('options merge over the selected preset', () => {
  assert.ok(clean('a—b\n', { preset: 'safe', asciiPunctuation: true }).includes('a-b'));
  assert.ok(clean('a—b\n', { preset: 'balanced', asciiPunctuation: false }).includes('a—b'));
  assert.equal(clean('x\n\n\n\n\ny\n', { maxBlankLines: 3 }), 'x\n\n\n\ny\n');
});

test('a 5 MB document is cleaned in well under five seconds', () => {
  const block = [
    'Some prose line with “smart quotes” and an em—dash in it.',
    'A second   line   with   padding and a wrapped continuation',
    'that keeps going for a while.',
    '',
    `![](data:image/jpeg;base64,${'/9j/4AAQSkZJRg'.repeat(120)})`,
    '',
    '| a   |  b  |',
    '| --- | --- |',
    '',
    '```',
    'code  block  content',
    '```',
    '',
    'AI\\-generated content may be incorrect\\.',
    '',
    `${'QUJD'.repeat(90)}`,
    '',
  ].join('\n');
  let input = '';
  while (input.length < 5 * 1024 * 1024) input += block;
  const started = process.hrtime.bigint();
  const out = clean(input, { preset: 'aggressive' });
  const elapsedMs = Number(process.hrtime.bigint() - started) / 1e6;
  assert.ok(!out.includes('data:'));
  assert.ok(out.length < input.length / 2);
  assert.ok(elapsedMs < 5000, `took ${elapsedMs.toFixed(0)}ms`);
});
