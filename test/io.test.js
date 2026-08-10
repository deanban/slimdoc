/**
 * stdin and clipboard reading. Both are streams, so neither has a size to `stat`
 * before it is read — which is why `maxInputBytes` has to be enforced against a
 * running total as the chunks arrive. It was not: both paths buffered the whole
 * input and the size was checked afterwards, by which point the bytes the limit
 * exists to refuse were already in memory. `extractFromFile` gets this right and
 * says so in a comment; these two contradicted it.
 */

import assert from 'node:assert/strict';
import test from 'node:test';

import { readStdinBuffer } from '../dist/io.js';

/** Stand in for `process.stdin`: async-iterable, and not a TTY. */
function fakeStdin(chunks) {
  return {
    isTTY: undefined,
    async *[Symbol.asyncIterator]() {
      for (const chunk of chunks) yield Buffer.from(chunk);
    },
  };
}

async function withStdin(chunks, fn) {
  const real = Object.getOwnPropertyDescriptor(process, 'stdin');
  Object.defineProperty(process, 'stdin', { value: fakeStdin(chunks), configurable: true });
  try {
    return await fn();
  } finally {
    if (real) Object.defineProperty(process, 'stdin', real);
  }
}

test('io: piped input under the limit is read whole', async () => {
  const buf = await withStdin(['hello ', 'world'], () => readStdinBuffer(100));
  assert.equal(buf.toString('utf8'), 'hello world');
});

test('io: piped input is refused as soon as it passes the limit', async () => {
  await assert.rejects(
    () => withStdin(['x'.repeat(40), 'y'.repeat(40)], () => readStdinBuffer(50)),
    /over the .* input limit/,
  );
});

/**
 * The point of checking per chunk rather than at the end: the refusal happens
 * before the rest of the stream is accumulated. A generator that would yield far
 * more than the limit must stop being consumed once it is passed.
 */
test('io: the whole stream is not buffered before the limit is applied', async () => {
  let yielded = 0;
  const stream = {
    isTTY: undefined,
    async *[Symbol.asyncIterator]() {
      for (let i = 0; i < 1000; i++) {
        yielded += 1;
        yield Buffer.alloc(1000, 0x61);
      }
    },
  };

  const real = Object.getOwnPropertyDescriptor(process, 'stdin');
  Object.defineProperty(process, 'stdin', { value: stream, configurable: true });
  try {
    await assert.rejects(() => readStdinBuffer(2500), /input limit/);
  } finally {
    if (real) Object.defineProperty(process, 'stdin', real);
  }

  assert.ok(yielded <= 4, `consumed ${yielded} chunks of 1000 before refusing`);
});

test('io: an interactive terminal reads as no input at all', async () => {
  const real = Object.getOwnPropertyDescriptor(process, 'stdin');
  Object.defineProperty(process, 'stdin', { value: { isTTY: true }, configurable: true });
  try {
    assert.equal(await readStdinBuffer(10), null);
  } finally {
    if (real) Object.defineProperty(process, 'stdin', real);
  }
});
