/**
 * Measurement harness for the kitchen-sink corpus.
 *
 * This measures; it does not assert. It is deliberately NOT part of
 * `npm test` — it exists to quantify what a change buys (or costs) across a
 * deliberately hostile corpus, and to be the baseline the PDF and PPTX phases
 * are judged against.
 *
 *   node test/bench.js [--preset balanced] [path...]
 */

import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, join, basename } from 'node:path';

import { extractFromFile } from '../dist/extract.js';
import { cleanDocument } from '../dist/sections.js';
import { formatBytes } from '../dist/tokens.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const CORPUS = join(HERE, 'fixtures', 'corpus');
const PRESETS = ['safe', 'balanced', 'aggressive'];

const DEFAULT_FILES = [
  'kitchen-sink.html',
  'kitchen-sink.docx',
  'kitchen-sink.pptx',
  'kitchen-sink.pdf',
].map((name) => join(CORPUS, name));

/** Extract once, clean at every preset, and time the whole path. */
async function measure(path) {
  const bytes = (await readFile(path)).length;
  const started = process.hrtime.bigint();

  let doc;
  try {
    doc = await extractFromFile(path);
  } catch (err) {
    return { path, bytes, unsupported: err.message };
  }

  // cleanDocument, not clean: a paged document is cleaned section by section,
  // and measuring the other path would measure something slimdoc never runs.
  const rows = PRESETS.map((preset) => {
    const at = process.hrtime.bigint();
    const { stats } = cleanDocument(doc, { preset });
    return { preset, stats, ms: Number(process.hrtime.bigint() - at) / 1e6 };
  });

  const totalMs = Number(process.hrtime.bigint() - started) / 1e6;
  return { path, bytes, extracted: doc.text.length, warnings: doc.warnings, rows, totalMs };
}

function reportOne(result) {
  const name = basename(result.path);
  if (result.unsupported) {
    console.log(`\n${name}  (${formatBytes(result.bytes)})`);
    console.log(`  pending — ${result.unsupported}`);
    return;
  }

  console.log(
    `\n${name}  ${formatBytes(result.bytes)} on disk -> ` +
      `${formatBytes(result.extracted)} extracted  (${result.totalMs.toFixed(1)} ms)`,
  );
  for (const w of result.warnings) console.log(`  ! ${w}`);
  console.log('  preset       chars     tokens    saved');
  for (const { preset, stats, ms } of result.rows) {
    console.log(
      `  ${preset.padEnd(11)}` +
        `${String(stats.chars.after).padStart(6)}` +
        `${String(stats.tokens.after).padStart(11)}` +
        `${(`${stats.savedPct}%`).padStart(9)}` +
        `   ${ms.toFixed(1)} ms`,
    );
  }
}

const files = process.argv.slice(2).filter((a) => !a.startsWith('--'));
const targets = files.length > 0 ? files : DEFAULT_FILES;

console.log('slimdoc corpus benchmark');
console.log('saved% is cleaning only; extraction has already dropped image payloads.');

// Sampled between documents, not during one: this is the resident set the process
// settles at, not the high-water mark of any single extraction. Naming it "peak"
// claimed a measurement that was not being taken.
let resident = 0;
for (const path of targets) {
  reportOne(await measure(path));
  resident = Math.max(resident, process.memoryUsage().rss);
}
console.log(`\nRSS between documents, highest ${formatBytes(resident)}`);
