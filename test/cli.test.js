import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const CLI_URL = new URL('../dist/cli.js', import.meta.url).href;

/**
 * Importing dist/cli.js and calling `run()` inside a child process. A child is used
 * rather than an in-process stdout stub because node:test's own reporter writes to
 * this process's stdout: a stub that swallows the CLI's output swallows TAP lines
 * with it, and whole tests vanish from the run. The child still exercises `run()`
 * itself — including the fact that importing the module does not execute the CLI.
 */
const BOOT = `
const { run } = await import(process.env.SLIMDOC_CLI);
process.exitCode = await run(JSON.parse(process.env.SLIMDOC_ARGV));
`;

function cli(argv, options = {}) {
  return new Promise((resolve, reject) => {
    const child = execFile(
      process.execPath,
      ['--input-type=module', '-e', BOOT],
      {
        encoding: 'utf8',
        maxBuffer: 32 * 1024 * 1024,
        env: {
          ...process.env,
          NO_COLOR: '1',
          SLIMDOC_CLI: CLI_URL,
          SLIMDOC_ARGV: JSON.stringify(argv),
        },
      },
      (error, stdout, stderr) => {
        if (error && typeof error.code !== 'number') {
          reject(error);
          return;
        }
        resolve({ code: error ? error.code : 0, stdout, stderr });
      },
    );
    child.stdin.end(options.stdin ?? '');
  });
}

/** In-process `run()`, with only stderr stubbed — safe because these cases print no stdout. */
async function runInProcess(argv) {
  const { run } = await import('../dist/cli.js');
  const chunks = [];
  const real = process.stderr.write;
  process.stderr.write = (chunk) => {
    chunks.push(typeof chunk === 'string' ? chunk : Buffer.from(chunk).toString('utf8'));
    return true;
  };
  try {
    const code = await run(argv);
    return { code, stderr: chunks.join('') };
  } finally {
    process.stderr.write = real;
  }
}

let dir;

before(async () => {
  dir = await mkdtemp(join(tmpdir(), 'slimdoc-cli-'));
});

after(async () => {
  await rm(dir, { recursive: true, force: true });
});

async function fixture(name, contents) {
  const path = join(dir, name);
  await writeFile(path, contents, 'utf8');
  return path;
}

const MESSY = 'Hello   world\ttoday.\n\n\n\nSecond  paragraph here.\n';

test('--help prints usage to stdout and exits 0', async () => {
  const { code, stdout, stderr } = await cli(['--help']);
  assert.equal(code, 0);
  assert.match(stdout, /slimdoc \[file\.\.\.\] \[options\]/);
  assert.match(stdout, /--transcript/);
  assert.match(stdout, /--unescape-markdown/);
  assert.equal(stderr, '');
});

test('--version prints a version and exits 0', async () => {
  for (const flag of ['--version', '-V']) {
    const { code, stdout } = await cli([flag]);
    assert.equal(code, 0);
    assert.match(stdout.trim(), /^\d+\.\d+\.\d+/, `for ${flag}`);
  }
});

test('an unknown flag exits 2 with a usage message on stderr', async () => {
  const { code, stdout, stderr } = await cli(['--definitely-not-a-flag']);
  assert.equal(code, 2);
  assert.equal(stdout, '');
  assert.match(stderr, /slimdoc:/);
  assert.match(stderr, /usage:/);
});

test('run() is importable and returns codes without exiting the process', async () => {
  const before = process.exitCode;
  const bad = await runInProcess(['--definitely-not-a-flag']);
  assert.equal(bad.code, 2);
  assert.match(bad.stderr, /usage:/);

  const conflict = await runInProcess(['-w', '-o', join(dir, 'x.md'), 'a.md']);
  assert.equal(conflict.code, 2);

  assert.equal(process.exitCode, before, 'run() must not touch process.exitCode');
});

test('--out with more than one input is rejected', async () => {
  const a = await fixture('a.md', 'one\n');
  const b = await fixture('b.md', 'two\n');
  const { code, stderr } = await cli(['-o', join(dir, 'out.md'), a, b]);
  assert.equal(code, 2);
  assert.match(stderr, /--out/);
});

test('--write with stdin input is rejected', async () => {
  const { code, stderr } = await cli(['--write'], { stdin: MESSY });
  assert.equal(code, 2);
  assert.match(stderr, /--write/);
});

test('--write and --out together are rejected', async () => {
  const a = await fixture('c.md', 'one\n');
  const { code } = await cli(['-w', '-o', join(dir, 'x.md'), a]);
  assert.equal(code, 2);
});

test('--max-blank-lines needs a number', async () => {
  const { code, stderr } = await cli(['--max-blank-lines', 'lots'], { stdin: 'hi\n' });
  assert.equal(code, 2);
  assert.match(stderr, /max-blank-lines/);
});

test('a file is cleaned to stdout', async () => {
  const path = await fixture('doc.md', MESSY);
  const { code, stdout } = await cli([path]);
  assert.equal(code, 0);
  assert.ok(stdout.includes('Hello world'), stdout);
  assert.ok(!stdout.includes('\t'));
  assert.ok(!/\n{3}/.test(stdout));
  assert.ok(stdout.endsWith('\n'));
});

test('stdin is read when no files are given', async () => {
  const { code, stdout } = await cli([], { stdin: MESSY });
  assert.equal(code, 0);
  assert.ok(stdout.includes('Hello world'), stdout);
});

test('a missing file reports on stderr and exits 1', async () => {
  const { code, stderr } = await cli([join(dir, 'nope.md')]);
  assert.equal(code, 1);
  assert.match(stderr, /slimdoc: .*nope\.md: /);
});

test('one bad input does not stop the good ones', async () => {
  const good = await fixture('good.md', 'kept text\n');
  const { code, stdout, stderr } = await cli([join(dir, 'missing.md'), good]);
  assert.equal(code, 1);
  assert.ok(stdout.includes('kept text'));
  assert.match(stderr, /missing\.md/);
});

test('a directory argument is reported, not thrown', async () => {
  const sub = join(dir, 'adir');
  await mkdir(sub, { recursive: true });
  const { code, stderr } = await cli([sub]);
  assert.equal(code, 1);
  assert.match(stderr, /adir/);
});

test('multiple inputs are separated by a labelled rule', async () => {
  const a = await fixture('first.md', 'alpha\n');
  const b = await fixture('second.md', 'beta\n');
  const { code, stdout } = await cli([a, b]);
  assert.equal(code, 0);
  assert.ok(stdout.includes('\n\n--- second.md ---\n\n'), JSON.stringify(stdout));
  assert.ok(stdout.indexOf('alpha') < stdout.indexOf('beta'));
});

test('--json emits an object for a single input', async () => {
  const path = await fixture('json.md', MESSY);
  const { code, stdout } = await cli(['--json', path]);
  assert.equal(code, 0);
  const payload = JSON.parse(stdout);
  assert.ok(!Array.isArray(payload));
  assert.deepEqual(
    Object.keys(payload).sort(),
    ['format', 'source', 'stats', 'text', 'warnings'].sort(),
  );
  assert.equal(payload.source, path);
  assert.equal(payload.format, 'markdown');
  assert.ok(Array.isArray(payload.warnings));
  assert.equal(typeof payload.stats.tokens.after, 'number');
  assert.equal(typeof payload.stats.savedPct, 'number');
  assert.ok(payload.text.includes('Hello world'));
});

test('--json emits an array for several inputs', async () => {
  const a = await fixture('j1.md', 'alpha\n');
  const b = await fixture('j2.md', 'beta\n');
  const { code, stdout } = await cli(['-j', a, b]);
  assert.equal(code, 0);
  const payload = JSON.parse(stdout);
  assert.ok(Array.isArray(payload));
  assert.equal(payload.length, 2);
});

test('--stats writes the report to stderr, never stdout', async () => {
  const path = await fixture('stats.md', MESSY);
  const { code, stdout, stderr } = await cli(['--stats', path]);
  assert.equal(code, 0);
  assert.match(stderr, /chars ->/);
  assert.match(stderr, /tokens/);
  assert.doesNotMatch(stdout, /chars ->/);
  assert.ok(stdout.includes('Hello world'));
});

test('--stats on several inputs adds a per-file line and a total', async () => {
  const a = await fixture('s1.md', MESSY);
  const b = await fixture('s2.md', MESSY);
  const { stderr } = await cli(['-s', a, b]);
  assert.match(stderr, /s1\.md: .*chars ->/);
  assert.match(stderr, /s2\.md: .*chars ->/);
  assert.match(stderr, /total: .*chars ->/);
});

test('--stats never emits colour when stderr is not a TTY', async () => {
  const path = await fixture('colour.md', MESSY);
  const { stderr } = await cli(['--stats', path]);
  assert.doesNotMatch(stderr, /\[/);
});

test('--quiet suppresses the stats banner', async () => {
  const path = await fixture('quiet.md', MESSY);
  const { code, stderr } = await cli(['--stats', '--quiet', path]);
  assert.equal(code, 0);
  assert.equal(stderr, '');
});

test('--out writes to a file and keeps stdout empty', async () => {
  const path = await fixture('outsrc.md', MESSY);
  const target = join(dir, 'written.md');
  const { code, stdout } = await cli(['--out', target, path]);
  assert.equal(code, 0);
  assert.equal(stdout, '');
  assert.ok((await readFile(target, 'utf8')).includes('Hello world'));
});

test('--out-dir writes one file per input, creating the directory', async () => {
  const a = await fixture('d1.md', 'alpha\n');
  const b = await fixture('d2.md', 'beta\n');
  const target = join(dir, 'nested', 'outdir');
  const { code, stdout } = await cli(['--out-dir', target, a, b]);
  assert.equal(code, 0);
  assert.equal(stdout, '');
  assert.ok((await readFile(join(target, 'd1.md'), 'utf8')).includes('alpha'));
  assert.ok((await readFile(join(target, 'd2.md'), 'utf8')).includes('beta'));
});

test('--write rewrites a text input in place', async () => {
  const path = await fixture('inplace.md', MESSY);
  const { code, stdout } = await cli(['--write', path]);
  assert.equal(code, 0);
  assert.equal(stdout, '');
  const written = await readFile(path, 'utf8');
  assert.ok(written.includes('Hello world'));
  assert.ok(!/\n{3}/.test(written));
});

test('an explicit flag beats the preset whichever side it is on', async () => {
  const path = await fixture('bold.md', 'Some **bold** words.\n');
  const stripped = await cli(['--aggressive', path]);
  assert.ok(!stripped.stdout.includes('**bold**'), stripped.stdout);

  const flagAfter = await cli(['--aggressive', '--no-strip-markdown', path]);
  const flagBefore = await cli(['--no-strip-markdown', '--aggressive', path]);
  assert.ok(flagAfter.stdout.includes('**bold**'), flagAfter.stdout);
  assert.equal(flagAfter.stdout, flagBefore.stdout);
});

test('the last of two conflicting flags wins', async () => {
  const path = await fixture('conflict.md', 'Some **bold** words.\n');
  const off = await cli(['--strip-markdown', '--no-strip-markdown', path]);
  const on = await cli(['--no-strip-markdown', '--strip-markdown', path]);
  assert.ok(off.stdout.includes('**bold**'), off.stdout);
  assert.ok(!on.stdout.includes('**bold**'), on.stdout);
});

test('--max-blank-lines is honoured', async () => {
  const path = await fixture('blanks.md', 'one\n\n\n\ntwo\n');
  const zero = await cli(['--max-blank-lines', '0', path]);
  const two = await cli(['--max-blank-lines', '2', path]);
  assert.ok(!/\n\n/.test(zero.stdout), JSON.stringify(zero.stdout));
  assert.ok(/\n\n\n/.test(two.stdout), JSON.stringify(two.stdout));
});

test('--keep-tabs is the counterpart of --no-tabs-to-spaces', async () => {
  const path = await fixture('tabs.md', 'a\tb\n');
  const kept = await cli(['--keep-tabs', path]);
  const also = await cli(['--no-tabs-to-spaces', path]);
  const converted = await cli([path]);
  assert.ok(kept.stdout.includes('\t'), JSON.stringify(kept.stdout));
  assert.equal(kept.stdout, also.stdout);
  assert.ok(!converted.stdout.includes('\t'));
});

test('--clipboard cannot be mixed with file arguments', async () => {
  const path = await fixture('clip.md', 'alpha\n');
  const { code } = await cli(['--clipboard', path]);
  assert.equal(code, 2);
});

test('--json cannot be mixed with --write', async () => {
  const path = await fixture('jw.md', 'alpha\n');
  const { code } = await cli(['--json', '--write', path]);
  assert.equal(code, 2);
});

test('a large input is processed without blowing up', async () => {
  const big = `${'The quick brown fox jumps over the lazy dog.   '.repeat(20000)}\n`;
  const { code, stdout } = await cli([], { stdin: big });
  assert.equal(code, 0);
  assert.ok(stdout.length > 0);
  assert.ok(stdout.length < big.length, 'collapsing spaces should shrink the input');
});

test('--out refuses a .docx target because the output is Markdown text', async () => {
  const target = join(dir, 'cleaned.docx');
  const { code, stderr } = await runInProcess(['-o', target]);
  assert.equal(code, 2);
  assert.match(stderr, /would not open/);
  assert.match(stderr, /cleaned\.md/);
  await assert.rejects(readFile(target), { code: 'ENOENT' });
});
