/**
 * Measure what slimdoc actually saves, per format, against a stated baseline.
 *
 *   npm install --no-save gpt-tokenizer   # for the real-tokenizer column
 *   node scripts/scorecard.mjs [--json path]
 *
 * Two things this is built to avoid, both of which made the previous scorecard
 * read better than the tool deserved:
 *
 * 1. **A self-referential baseline.** PPTX was measured against slimdoc's own
 *    pre-clean extraction, which measures the cleaner and calls it the product.
 *    Here every binary format is measured against a *neutral* extraction — what a
 *    naive tool gets out of the same file — and that baseline is named in the
 *    output so nobody has to guess.
 *
 * 2. **A whitespace-blind estimator.** `estimateTokens` used to price runs of
 *    spaces at zero, so the PDF path's character-grid padding was free and PDF
 *    scored a 3% saving while cl100k said it *added* tokens. Both columns are
 *    reported: the estimator, because it is what `--stats` prints, and the real
 *    tokenizer, because it is what the model charges.
 *
 * A saving is `(before - after) / before` on the real tokenizer where it is
 * available. Negative means slimdoc's output costs more than the baseline, which
 * is a fact worth printing rather than hiding.
 */

import { readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { extractFromFile } from '../dist/extract.js';
import { cleanDocument } from '../dist/sections.js';
import { estimateTokens } from '../dist/tokens.js';
import { readZipEntries } from '../dist/zip.js';
import { DEFAULT_LIMITS } from '../dist/types.js';
import { htmlToText, meaningfulAlt } from '../dist/extract-html.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, '..');
const CORPUS = join(ROOT, 'test', 'fixtures', 'corpus');
const LOCAL = join(ROOT, 'test', 'fixtures', 'local');
const FIXTURES = join(ROOT, 'test', 'fixtures');

let realTokens;
try {
  const { encode } = await import('gpt-tokenizer/encoding/cl100k_base');
  realTokens = (text) => encode(text).length;
} catch {
  console.error('note: gpt-tokenizer not installed — the real-tokenizer column is omitted.');
  console.error('      npm install --no-save gpt-tokenizer\n');
}

// --------------------------------------------------------------------------
// neutral baselines: what a naive reader gets from the same bytes
// --------------------------------------------------------------------------

/** unpdf's own extracted text, which is what any pdf.js-based tool hands you. */
async function pdfBaseline(file) {
  const { extractText, getDocumentProxy } = await import('unpdf');
  const pdf = await getDocumentProxy(new Uint8Array(await readFile(file)), { verbosity: 0 });
  const { text } = await extractText(pdf, { mergePages: true });
  return text;
}

/**
 * Every `<a:t>` in every slide part, in archive order.
 *
 * Deliberately naive — no reading order, no layout/master exclusion, no hidden
 * slide filtering — because that is exactly what a fifteen-line script gets, and
 * it is the thing slimdoc has to beat. It is also why this baseline is *not*
 * slimdoc's own extraction: comparing a tool to itself measures nothing.
 */
async function pptxBaseline(file) {
  const entries = readZipEntries(await readFile(file), DEFAULT_LIMITS);
  const parts = [...entries.keys()].filter((n) => /^ppt\/slides\/slide\d+\.xml$/.test(n)).sort();
  const out = [];
  for (const part of parts) {
    const xml = entries.get(part)().toString('utf8');
    for (const m of xml.matchAll(/<a:t>([\s\S]*?)<\/a:t>/g)) out.push(m[1]);
  }
  return out.join('\n');
}

/**
 * mammoth's Markdown, with image bytes left out.
 *
 * The old DOCX figure compared against mammoth's *default* converter, which
 * base64-encodes every embedded image into the output — on an image-heavy file
 * that is ~99% of the characters, so "97.8% saved" was mostly measuring that
 * slimdoc does not print JPEGs. Nobody's real alternative is to paste base64, so
 * the honest baseline suppresses images the same way slimdoc does.
 */
async function docxBaseline(file) {
  const mammoth = await import('mammoth');
  const convertImage = mammoth.images.imgElement(async (image) => ({
    src: '',
    alt: meaningfulAlt(image.altText) ?? '',
  }));
  const result = await mammoth.convertToHtml({ buffer: await readFile(file) }, { convertImage });
  return htmlToText(result.value).text;
}

const rawBaseline = (file) => readFile(file, 'utf8');

// --------------------------------------------------------------------------
// the corpus
// --------------------------------------------------------------------------

async function exists(file) {
  try {
    await readFile(file);
    return true;
  } catch {
    return false;
  }
}

const GROUPS = [
  {
    input: 'PDF',
    baseline: "unpdf's extracted text (what any pdf.js-based tool gives you)",
    read: pdfBaseline,
    files: [join(CORPUS, 'kitchen-sink.pdf'), ...['paper-single', 'paper-figures', 'paper-ocr-columns', 'form-rotated'].map((n) => join(LOCAL, `${n}.pdf`))],
  },
  {
    input: 'PPTX',
    baseline: 'every <a:t> in every slide part, in archive order',
    read: pptxBaseline,
    files: [join(CORPUS, 'kitchen-sink.pptx'), ...['deck-mixed', 'deck-textboxes', 'deck-hidden'].map((n) => join(LOCAL, `${n}.pptx`))],
  },
  {
    input: 'DOCX',
    baseline: "mammoth's Markdown with image bytes suppressed",
    read: docxBaseline,
    files: [join(CORPUS, 'kitchen-sink.docx'), join(FIXTURES, 'sample.docx')],
  },
  {
    input: 'DOCX transcript',
    baseline: "mammoth's Markdown with image bytes suppressed",
    read: docxBaseline,
    transcript: true,
    files: [join(LOCAL, 'sample_transcript.docx')],
  },
  {
    input: 'HTML',
    baseline: 'raw HTML source',
    read: rawBaseline,
    files: [join(CORPUS, 'kitchen-sink.html'), join(FIXTURES, 'sample.html'), join(FIXTURES, 'tables.html'), join(FIXTURES, 'code.html')],
  },
  {
    input: 'RTF',
    baseline: 'raw RTF source',
    read: rawBaseline,
    files: [join(FIXTURES, 'sample.rtf'), join(FIXTURES, 'tables.rtf')],
  },
  {
    input: 'Markdown',
    baseline: 'raw Markdown source',
    read: rawBaseline,
    files: [join(FIXTURES, 'messy.md')],
  },
  {
    input: 'Transcript text',
    baseline: 'raw transcript source',
    read: rawBaseline,
    transcript: true,
    files: ['transcript-zoom.txt', 'transcript-teams.md', 'transcript-webvtt.vtt', 'transcript-srt.srt'].map((n) => join(FIXTURES, n)),
  },
];

// --------------------------------------------------------------------------
// measure
// --------------------------------------------------------------------------

const pct = (before, after) => (before === 0 ? 0 : ((before - after) / before) * 100);
const round1 = (n) => Math.round(n * 10) / 10;

async function measureFile(group, file) {
  const before = await group.read(file);
  const cleanOpts = group.transcript ? { preset: 'balanced', transcript: true } : { preset: 'balanced' };
  const doc = await extractFromFile(file);
  const after = cleanDocument(doc, cleanOpts, {}).text;

  return {
    file: file.replace(`${ROOT}/`, ''),
    before: { est: estimateTokens(before), real: realTokens?.(before) },
    after: { est: estimateTokens(after), real: realTokens?.(after) },
  };
}

/**
 * The 0.3.0 review's rubric, kept verbatim so the two scorecards are comparable.
 *
 * It scores *reduction only*. A format can lose real content and score well, or add
 * tokens deliberately to keep information a cheaper tool discards and score badly —
 * which is exactly what PPTX does. Nothing here is a fidelity measure.
 */
const RUBRIC = [
  [90, 10], [80, 9], [70, 8], [60, 7], [40, 6], [25, 5], [15, 4], [8, 3], [3, 2], [0, 1],
];

function scoreOf(saved) {
  if (saved === undefined) return null;
  return RUBRIC.find(([floor]) => saved >= floor)?.[1] ?? 1;
}

/**
 * How much the number deserves to be trusted, from the corpus behind it rather than
 * from an opinion.
 *
 * Sample size is most of it, and whether any of the samples is a document nobody here
 * wrote is the rest: every fixture in `test/fixtures/` encodes the same assumptions the
 * extractor does, so a row measured only on those agrees with itself. The four real
 * PDFs and three real decks in `test/fixtures/local/` are what earn a Medium — and
 * nothing here earns a High, because no row has more than five samples.
 */
function confidenceOf(measured) {
  if (measured.length === 0) return 'None';
  const real = measured.filter((m) => m.file.includes('fixtures/local/')).length;
  if (measured.length >= 3 && real > 0) return 'Medium';
  return 'Low';
}

const results = [];
for (const group of GROUPS) {
  const measured = [];
  for (const file of group.files) {
    if (!(await exists(file))) continue;
    try {
      measured.push(await measureFile(group, file));
    } catch (e) {
      console.error(`  skipped ${file}: ${e.message}`);
    }
  }
  if (measured.length === 0) continue;

  const sum = (pick) => measured.reduce((n, m) => n + (pick(m) ?? 0), 0);
  const savedEst = pct(sum((m) => m.before.est), sum((m) => m.after.est));
  const savedReal = realTokens ? pct(sum((m) => m.before.real), sum((m) => m.after.real)) : undefined;
  const perFile = measured.map((m) =>
    realTokens ? pct(m.before.real, m.after.real) : pct(m.before.est, m.after.est),
  );

  results.push({
    input: group.input,
    baseline: group.baseline,
    sample_n: measured.length,
    before_tokens: { est: sum((m) => m.before.est), ...(realTokens && { real: sum((m) => m.before.real) }) },
    after_tokens: { est: sum((m) => m.after.est), ...(realTokens && { real: sum((m) => m.after.real) }) },
    saved_pct: { est: round1(savedEst), ...(realTokens && { real: round1(savedReal) }) },
    score: scoreOf(realTokens ? round1(savedReal) : round1(savedEst)),
    confidence: confidenceOf(measured),
    range_pct: `${round1(Math.min(...perFile))} to ${round1(Math.max(...perFile))}`,
    files: measured.map((m) => m.file),
  });
}

/**
 * Formats with no corpus at all. Carried through to the output rather than omitted:
 * a missing row reads as an oversight, an `Unmeasured` one states that the tool has
 * nothing to say. Plain text's savings depend entirely on how much stray whitespace
 * the input happens to carry, and no fixture here represents that.
 */
const UNMEASURED = [{ input: 'Plain UTF-8 text', reason: 'no representative corpus' }];

// --------------------------------------------------------------------------
// report
// --------------------------------------------------------------------------

const col = (n) => (n === undefined ? '—' : String(n));
/** One decimal always, so the column compares down the page without ragged precision. */
const signed = (n) => (n === undefined ? '—' : `${n.toFixed(1)}%`);

const ranked = [...results].sort(
  (a, b) => (b.saved_pct.real ?? b.saved_pct.est) - (a.saved_pct.real ?? a.saved_pct.est),
);

// --------------------------------------------------------------------------
// the scorecard
// --------------------------------------------------------------------------

const WIDTHS = [18, 12, 10, 12];
/** Input and Confidence read as labels; Saved and Score are figures to compare down. */
const ALIGN = ['left', 'right', 'right', 'left'];
const rule = (ch) => WIDTHS.map((w) => ch.repeat(w)).join('  ');
const row = (cells) =>
  cells
    .map((cell, i) => (ALIGN[i] === 'left' ? ` ${cell}`.padEnd(WIDTHS[i]) : cell.padStart(WIDTHS[i])))
    .join('  ')
    .trimEnd();

function scorecard() {
  const lines = [
    '### Token-saving scorecard',
    '',
    'Scores measure reduction only—not extraction fidelity.',
    '',
    row(['Input', 'Saved', 'Score', 'Confidence']),
    rule('━'),
  ];

  const body = [
    ...ranked.map((r) => [
      r.input,
      signed(r.saved_pct.real ?? r.saved_pct.est),
      `${r.score}/10`,
      r.confidence,
    ]),
    ...UNMEASURED.map((u) => [u.input, 'Unmeasured', 'Unscored', 'None']),
  ];

  body.forEach((cells, i) => {
    lines.push(row(cells));
    if (i < body.length - 1) lines.push(rule('─'));
  });
  return lines.join('\n');
}

console.log(`\n${scorecard()}\n`);

if (process.argv.includes('--detail')) {
  console.log(`| Input | n | Baseline | Before | After | Saved (real) | Saved (est) | Range (real) |`);
  console.log(`|---|---|---|---|---|---|---|---|`);
  for (const r of ranked) {
    console.log(
      `| ${r.input} | ${r.sample_n} | ${r.baseline} | ${col(r.before_tokens.real ?? r.before_tokens.est)} | ` +
        `${col(r.after_tokens.real ?? r.after_tokens.est)} | ${signed(r.saved_pct.real)} | ${signed(r.saved_pct.est)} | ${r.range_pct} |`,
    );
  }
  console.log();
}

const jsonAt = process.argv.indexOf('--json');
if (jsonAt !== -1 && process.argv[jsonAt + 1]) {
  const { writeFile } = await import('node:fs/promises');
  await writeFile(
    process.argv[jsonAt + 1],
    `${JSON.stringify(
      {
        estimator: 'slimdoc estimateTokens heuristic',
        real_tokenizer: realTokens ? 'cl100k_base via gpt-tokenizer' : null,
        note:
          'Savings are measured against a neutral baseline per format — what a naive reader ' +
          'gets from the same bytes — never against slimdoc\'s own output.',
        scores: results,
      },
      null,
      2,
    )}\n`,
  );
  console.log(`\nwrote ${process.argv[jsonAt + 1]}`);
}

