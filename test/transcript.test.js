import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

import { looksLikeTranscript, tidyTranscript } from '../dist/transcript.js';

const here = dirname(fileURLToPath(import.meta.url));
const fixture = (name) => readFileSync(join(here, 'fixtures', name), 'utf8');

const TEAMS = fixture('transcript-teams.md');
const VTT = fixture('transcript-webvtt.vtt');
const ZOOM = fixture('transcript-zoom.txt');
const SRT = fixture('transcript-srt.srt');

// --- the Microsoft Teams "export to Word" shape -----------------------------

test('teams: collapses the five-line Word block into one turn', () => {
  const out = tidyTranscript(TEAMS);
  assert.equal(
    out,
    [
      'Kathryn [0:43]: Hey, everyone, good afternoon.',
      'William [0:47]: Afternoon.',
      'Kathryn [1:05]: Let\'s start with the release checklist. I put the draft in the shared folder yesterday.',
      'Geordi [1:02:03]: We still owe the localisation team a build. I can cut one tomorrow morning if nobody objects.',
      'William [1:03:30]:\nThat works for me, and while we are on it I would like to walk through the rollback plan one more time, because the last two releases both needed a manual step that nobody had written down anywhere, and I would rather not repeat that.',
    ].join('\n\n'),
  );
});

test('teams: the spec target shape, with full names', () => {
  const block = [
    '[IMG]',
    '',
    '__Torres, Miral__',
    '',
    '0 minutes 43 seconds0:43',
    '',
    'Torres, Miral 0 minutes 43 seconds',
    '',
    'Hey, everyone, good afternoon\\.',
  ].join('\n');
  assert.equal(
    tidyTranscript(block, { shortenNames: false }),
    'Torres, Miral [0:43]: Hey, everyone, good afternoon.',
  );
});

test('teams: singular units, plural units and an hours component', () => {
  const out = tidyTranscript(
    [
      'Dax, Jadzia 1 minute 5 seconds1:05',
      'Dax, Jadzia 1 minute 5 seconds',
      'One.',
      '',
      'Dax, Jadzia 2 minutes 0 seconds',
      'Two.',
      '',
      'Dax, Jadzia 1 hour 0 minutes 7 seconds',
      'Three.',
      '',
      'Dax, Jadzia 2 hours 15 minutes 42 seconds',
      'Four.',
    ].join('\n'),
    { mergeConsecutive: false },
  );
  assert.deepEqual(out.split('\n\n'), [
    'Jadzia [1:05]: One.',
    'Jadzia [2:00]: Two.',
    'Jadzia [1:00:07]: Three.',
    'Jadzia [2:15:42]: Four.',
  ]);
});

test('teams: a continuation turn without avatar or bold line still merges', () => {
  const out = tidyTranscript(TEAMS);
  assert.match(out, /Kathryn \[1:05\]: Let's start with the release checklist\. I put the draft/);
  assert.equal(out.match(/Kathryn \[/g).length, 2);
});

test('teams: the AI-generated banner is dropped, escaped or not', () => {
  assert.ok(!tidyTranscript(TEAMS).includes('AI-generated'));
  const plain = 'AI-generated content may be incorrect\n\nBashir, Julian 0 minutes 3 seconds\n\nHello.';
  assert.equal(tidyTranscript(plain), 'Julian [0:03]: Hello.');
});

test('teams: unescaped input gives the identical result', () => {
  const unescaped = TEAMS.replace(/\\([!-/:-@[-`{-~])/g, '$1');
  assert.equal(tidyTranscript(unescaped), tidyTranscript(TEAMS));
});

test('avatar leftovers, icon glyphs and initials lines are dropped', () => {
  const out = tidyTranscript(
    ['', '[IMG]', '![](avatar.png)', 'DB', 'Kira, Nerys 0 minutes 5 seconds', 'Hello.'].join('\n'),
  );
  assert.equal(out, 'Nerys [0:05]: Hello.');
});

// --- other transcript flavours ---------------------------------------------

test('webvtt: voice spans, cue indices, NOTE blocks and duplicate cues', () => {
  assert.equal(
    tidyTranscript(VTT),
    [
      'Kathryn [0:01]: Morning all, thanks for joining.',
      'Nyota [0:04]: Can everyone see the board?',
      'Kathryn [1:12]: Yes, looks fine here.',
    ].join('\n\n'),
  );
});

test('srt: numeric cue indices and comma timings', () => {
  assert.equal(
    tidyTranscript(SRT),
    [
      "Kathryn [0:02]: Let's pick this up where we left off.",
      'Nyota [0:05]: Agreed, I have the notes open. The first item is the migration window.',
    ].join('\n\n'),
  );
});

test('zoom / meet / otter line shapes', () => {
  assert.equal(
    tidyTranscript(ZOOM),
    [
      'Kathryn [0:12]: Morning all, thanks for joining.',
      'Nyota [12:04:31]: Can everyone see the board?',
      'Kathryn [12:44]: Yes, looks fine here.',
      'Hikaru [13:02]: I lost audio for a second there, but I am back now.',
    ].join('\n\n'),
  );
});

test('duplicate consecutive captions and incremental prefixes collapse', () => {
  const out = tidyTranscript(ZOOM);
  assert.equal(out.match(/Morning all/g).length, 1);
  assert.equal(out.match(/I lost audio/g).length, 1);
  assert.ok(!out.includes('I lost audio for a second\n'));
});

test('a short line that merely starts like the next one is kept', () => {
  const out = tidyTranscript('Picard, Jean-Luc 0 minutes 5 seconds\nSo.\n\nPicard, Jean-Luc 0 minutes 9 seconds\nSo we should ship it.');
  assert.equal(out, 'Jean-Luc [0:05]: So. So we should ship it.');
});

// --- system noise -----------------------------------------------------------

test('system lines are dropped as whole lines only', () => {
  const input = [
    'Recording started',
    'Kim, Harry joined the meeting',
    'Transcription started by Kim, Harry',
    'Kim, Harry is presenting',
    'Muted',
    'This transcript was generated automatically and may contain errors.',
    '',
    'Kim, Harry 0 minutes 8 seconds',
    'I see some news has joined the discussion, so let us wait a moment.',
    '',
    'Meeting ended',
  ].join('\n');
  assert.equal(
    tidyTranscript(input),
    'Harry [0:08]: I see some news has joined the discussion, so let us wait a moment.',
  );
});

test('dropSystemLines: false keeps them', () => {
  const out = tidyTranscript(TEAMS, { dropSystemLines: false });
  assert.ok(out.includes('AI-generated content may be incorrect'));
  assert.ok(out.includes('Recording stopped'));
});

// --- names ------------------------------------------------------------------

test('shortenNames handles "Last, First", accents and double surnames', () => {
  assert.ok(tidyTranscript(TEAMS).includes('Geordi [1:02:03]:'));
});

test('shortenNames bails out to full names when first names collide', () => {
  const out = tidyTranscript(
    'Riker, Thomas 0 minutes 5 seconds\nHello.\n\nParis, Thomas 0 minutes 9 seconds\nHi there.',
  );
  assert.equal(out, 'Riker, Thomas [0:05]: Hello.\n\nParis, Thomas [0:09]: Hi there.');
});

test('shortenNames: false keeps every full name', () => {
  const out = tidyTranscript(TEAMS, { shortenNames: false });
  assert.ok(out.startsWith('Janeway, Kathryn [0:43]:'));
  assert.ok(out.includes('La Forge, Geordi [1:02:03]:'));
});

test('"First Last" shortens to the first name', () => {
  assert.ok(tidyTranscript(ZOOM).startsWith('Kathryn [0:12]:'));
});

// --- options ----------------------------------------------------------------

test('keepFirstTimestamp: false removes every timestamp', () => {
  const out = tidyTranscript(TEAMS, { keepFirstTimestamp: false });
  assert.ok(out.startsWith('Kathryn: Hey, everyone, good afternoon.'));
  assert.ok(!/\[\d/.test(out));
});

test('dropTimestamps: false keeps a stamp per utterance', () => {
  const out = tidyTranscript(TEAMS, { dropTimestamps: false });
  assert.ok(out.includes('Kathryn: [1:05] Let\'s start with the release checklist. [1:20] I put the draft'));
});

test('mergeConsecutive: false leaves one block per utterance', () => {
  const merged = tidyTranscript(TEAMS).split('\n\n').length;
  const split = tidyTranscript(TEAMS, { mergeConsecutive: false }).split('\n\n').length;
  assert.equal(merged, 5);
  assert.equal(split, 7);
});

test('a block over 200 chars puts its text on its own line', () => {
  const long = 'x'.repeat(240);
  const short = 'y'.repeat(120);
  assert.equal(tidyTranscript(`Troi, Deanna 0 minutes 1 second\n${short}`), `Deanna [0:01]: ${short}`);
  assert.equal(tidyTranscript(`Troi, Deanna 0 minutes 1 second\n${long}`), `Deanna [0:01]:\n${long}`);
});

// --- invariants -------------------------------------------------------------

test('tidyTranscript is idempotent and pure', () => {
  for (const input of [TEAMS, VTT, ZOOM, SRT]) {
    const once = tidyTranscript(input);
    assert.equal(tidyTranscript(once), once);
    assert.equal(tidyTranscript(input), once);
  }
});

test('nothing is reordered and no word of an utterance is lost', () => {
  const out = tidyTranscript(TEAMS);
  const order = ['good afternoon', 'Afternoon.', 'release checklist', 'shared folder', 'localisation team', 'rollback plan'];
  let cursor = -1;
  for (const marker of order) {
    const at = out.indexOf(marker);
    assert.ok(at > cursor, `${marker} out of order`);
    cursor = at;
  }
  for (const word of 'walk through the rollback plan one more time'.split(' ')) {
    assert.ok(out.includes(word));
  }
});

test('empty and whitespace-only input yield an empty string', () => {
  assert.equal(tidyTranscript(''), '');
  assert.equal(tidyTranscript('\n\n   \n'), '');
});

// --- detection --------------------------------------------------------------

test('looksLikeTranscript accepts the real-world shapes', () => {
  for (const input of [TEAMS, VTT, ZOOM, SRT]) {
    assert.equal(looksLikeTranscript(input), true);
  }
});

test('looksLikeTranscript rejects ordinary prose', () => {
  const prose = [
    'The meeting industry has changed a great deal in the last five years.',
    'Most teams now record everything by default, which is convenient.',
    'It also produces an enormous amount of text that nobody ever reads.',
    'The automatic summaries are usually wrong in small but annoying ways.',
    'We should think harder about what is actually worth keeping.',
  ].join('\n');
  assert.equal(looksLikeTranscript(prose), false);
});

test('looksLikeTranscript rejects a code file', () => {
  const code = [
    'export function parseSchedule(input) {',
    '  const slots = [];',
    '  for (const line of input.split("\\n")) {',
    '    if (!line) continue;',
    '    slots.push({ start: "09:00", end: "17:30", label: line });',
    '  }',
    '  return slots;',
    '}',
  ].join('\n');
  assert.equal(looksLikeTranscript(code), false);
});

test('looksLikeTranscript rejects a chat log', () => {
  const chat = [
    'alice: does anyone know why the build fails?',
    'bob: yeah, node 20 is required now',
    'alice: ah, thanks',
    'carol: i will bump the CI image today',
    'bob: nice, ping me when it lands',
    'alice: will do',
  ].join('\n');
  assert.equal(looksLikeTranscript(chat), false);
});

test('looksLikeTranscript rejects a markdown doc with a table of times', () => {
  const doc = [
    '# Conference schedule',
    '',
    'The rooms open half an hour before the first session.',
    '',
    '| Time | Session | Room |',
    '| --- | --- | --- |',
    '| 09:00 | Welcome | Main hall |',
    '| 10:30 | Coffee break | Foyer |',
    '| 11:00 | Workshop | Room 2 |',
    '| 12:30 | Lunch | Foyer |',
    '| 14:00 | Closing remarks | Main hall |',
  ].join('\n');
  assert.equal(looksLikeTranscript(doc), false);
});

test('looksLikeTranscript scans at most the first 400 lines', () => {
  const padding = Array.from({ length: 400 }, (_, i) => `Paragraph ${i} of ordinary prose.`).join('\n');
  assert.equal(looksLikeTranscript(`${padding}\n${TEAMS}`), false);
  assert.equal(looksLikeTranscript(TEAMS), true);
});
