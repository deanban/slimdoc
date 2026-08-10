/**
 * The fixture tiers themselves.
 *
 * The suite's blind spot was never a missing assertion — it was that every fixture
 * was hand-written, so it agreed with the code wherever the code guessed. These
 * tests keep the two tiers that fix that honest: the generated fixtures have to
 * still be present and readable, and the real-document manifest has to stay
 * truthful about what it can and cannot prove on this machine.
 */

import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

import { LOCAL_FIXTURES, localFixture } from './helpers/local.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const GENERATED = join(HERE, 'fixtures', 'generated');

const GENERATED_FILES = [
  'justified-prose.pdf',
  'two-column-table.pdf',
  'inherited-bullets.pptx',
];

test('fixtures: the third-party generated tier is committed', () => {
  for (const name of GENERATED_FILES) {
    assert.ok(
      existsSync(join(GENERATED, name)),
      `${name} is missing — regenerate with test/fixtures/generated/make-*.py`,
    );
  }
});

test('fixtures: every real-document entry says what it proves', () => {
  assert.ok(LOCAL_FIXTURES.length > 0);
  for (const entry of LOCAL_FIXTURES) {
    assert.match(entry.name, /^[a-z0-9-]+$/, `${entry.name} is not a logical name`);
    assert.match(entry.sha256, /^[0-9a-f]{64}$/, `${entry.name} has no usable hash`);
    // The description tells a reader how to substitute their own document; the
    // `proves` line is why the entry is worth substituting at all.
    assert.ok(entry.description.length > 40, `${entry.name} needs a real description`);
    assert.ok(entry.proves.length > 40, `${entry.name} does not say what it proves`);
  }
});

test('fixtures: an unknown logical name is a mistake, not a skip', () => {
  assert.throws(() => localFixture('no-such-fixture'), /no fixture named/);
});

test('fixtures: a real document is used when present and skipped when not', (t) => {
  // Whichever way this runs it must not fail: that is the property the whole
  // tier depends on, since these files are never committed.
  const path = localFixture('deck-mixed', t);
  if (path === null) return;
  assert.ok(existsSync(path));
});
