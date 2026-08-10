/**
 * Real documents, resolved by logical name.
 *
 * These are other people's files: they live in the gitignored
 * `test/fixtures/local/` and are never committed. A clone that has none of them
 * still runs a green suite — the tests that need one skip with a notice naming
 * the fixture and what it was there to prove.
 *
 * The hash in the manifest identifies the copy the expectations were measured
 * against. A different document of the same shape is a legitimate substitute,
 * so a mismatch is a notice rather than a failure; only absence skips.
 */

import { existsSync, readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const MANIFEST = join(HERE, '..', 'fixtures', 'local-manifest.json');
const LOCAL = join(HERE, '..', 'fixtures', 'local');

const { fixtures } = JSON.parse(readFileSync(MANIFEST, 'utf8'));
const byName = new Map(fixtures.map((f) => [f.name, f]));

/** Names the manifest knows, for a test that wants to assert the set is complete. */
export const LOCAL_FIXTURES = fixtures;

/**
 * The path to a real fixture, or `null` when it is not on this machine.
 *
 * Pass the test's `t` to get the skip recorded against it:
 *
 *   test('...', (t) => {
 *     const file = localFixture('deck-mixed', t);
 *     if (file === null) return;
 *     ...
 *   });
 */
export function localFixture(name, t) {
  const entry = byName.get(name);
  if (entry === undefined) {
    throw new Error(`no fixture named "${name}" in test/fixtures/local-manifest.json`);
  }

  const path = join(LOCAL, entry.file);
  if (!existsSync(path)) {
    t?.skip(
      `needs test/fixtures/local/${entry.file} — ${entry.description} ` +
        `See test/fixtures/local-manifest.json.`,
    );
    return null;
  }

  const actual = createHash('sha256').update(readFileSync(path)).digest('hex');
  if (actual !== entry.sha256) {
    t?.diagnostic(
      `test/fixtures/local/${entry.file} is not the copy these expectations were ` +
        `measured against (${actual.slice(0, 12)}… vs ${entry.sha256.slice(0, 12)}…). ` +
        `A substitute of the same shape is fine; a failure below may just mean it differs.`,
    );
  }
  return path;
}
