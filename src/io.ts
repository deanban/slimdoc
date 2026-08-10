import { spawn } from 'node:child_process';

import { UnsupportedFormatError } from './errors.js';
import { formatBytes } from './tokens.js';

/**
 * The same refusal `extract.ts` raises for an oversized file, worded the same way
 * and carrying the same `oversized` tag, so the CLI reports a pipe and a path
 * identically. The size is not quoted because a stream that is still arriving has
 * no size yet — only the fact that it has passed the limit.
 */
function oversized(limit: number): UnsupportedFormatError {
  return new UnsupportedFormatError(`is over the ${formatBytes(limit)} input limit`, 'oversized');
}

interface ClipboardTool {
  cmd: string;
  args: string[];
}

/** Thrown internally when a candidate clipboard binary is not installed. */
class ToolMissingError extends Error {}

function stripBom(text: string): string {
  return text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
}

export function hasPipedStdin(): boolean {
  // `isTTY` is `undefined` (not `false`) on a pipe or a redirected file.
  return process.stdin.isTTY !== true;
}

/**
 * Read all of stdin as bytes, or `null` when stdin is an interactive terminal.
 * Bytes rather than text so a piped `.docx` still reaches the format detector intact.
 *
 * `limit` is checked as the chunks arrive, not after. `extractFromFile` takes the
 * size from `stat` before the read and its comment explains why — "by then the
 * bytes it was meant to refuse are already in memory" — and this path did exactly
 * that, buffering the whole of stdin and validating it afterwards. A pipe has no
 * size to stat, so the running total is the only place the check can go.
 */
export async function readStdinBuffer(limit = Infinity): Promise<Buffer | null> {
  if (!hasPipedStdin()) return null;
  const chunks: Buffer[] = [];
  let read = 0;

  for await (const chunk of process.stdin) {
    const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    read += buf.length;
    if (read > limit) throw oversized(limit);
    chunks.push(buf);
  }
  return Buffer.concat(chunks);
}

export async function readStdin(limit = Infinity): Promise<string | null> {
  const buf = await readStdinBuffer(limit);
  return buf === null ? null : stripBom(buf.toString('utf8'));
}

/**
 * Run `cmd` with `args`, optionally feeding `input` through the child's stdin.
 * User text is never interpolated into a shell string — there is no shell.
 */
function runTool(tool: ClipboardTool, input?: string, limit = Infinity): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn(tool.cmd, tool.args, { stdio: ['pipe', 'pipe', 'pipe'] });
    const out: Buffer[] = [];
    const err: Buffer[] = [];
    let settled = false;
    let read = 0;

    child.stdout.on('data', (d: Buffer) => {
      // Bounded as it arrives, for the same reason stdin is: a clipboard holding
      // a pasted spreadsheet is not small, and buffering all of it to measure it
      // afterwards is the one order in which the limit cannot do its job. The
      // child is killed rather than drained — there is nothing left to read.
      read += d.length;
      if (read > limit) {
        if (settled) return;
        settled = true;
        child.kill();
        reject(oversized(limit));
        return;
      }
      out.push(d);
    });
    child.stderr.on('data', (d: Buffer) => err.push(d));

    child.on('error', (e: NodeJS.ErrnoException) => {
      if (settled) return;
      settled = true;
      reject(e.code === 'ENOENT' ? new ToolMissingError(tool.cmd) : e);
    });

    child.on('close', (code) => {
      if (settled) return;
      settled = true;
      if (code === 0) {
        resolve(Buffer.concat(out).toString('utf8'));
      } else {
        const detail = Buffer.concat(err).toString('utf8').trim();
        reject(new Error(`${tool.cmd} exited with code ${code}${detail ? `: ${detail}` : ''}`));
      }
    });

    if (input !== undefined) {
      // EPIPE if the tool exits before draining; the close handler already reports it.
      child.stdin.on('error', () => {});
      child.stdin.end(input, 'utf8');
    } else {
      child.stdin.end();
    }
  });
}

const WL_PASTE: ClipboardTool = { cmd: 'wl-paste', args: ['--no-newline'] };
const WL_COPY: ClipboardTool = { cmd: 'wl-copy', args: [] };

function unixTools(wayland: ClipboardTool, x11: ClipboardTool[]): ClipboardTool[] {
  // Prefer the compositor we are actually running under, but still try the other.
  return process.env['WAYLAND_DISPLAY'] ? [wayland, ...x11] : [...x11, wayland];
}

function pasteTools(): ClipboardTool[] {
  if (process.platform === 'darwin') return [{ cmd: 'pbpaste', args: [] }];
  if (process.platform === 'win32') {
    return [
      { cmd: 'powershell.exe', args: ['-NoProfile', '-NonInteractive', '-Command', 'Get-Clipboard'] },
      { cmd: 'powershell', args: ['-NoProfile', '-NonInteractive', '-Command', 'Get-Clipboard'] },
    ];
  }
  return unixTools(WL_PASTE, [
    { cmd: 'xclip', args: ['-selection', 'clipboard', '-o'] },
    { cmd: 'xsel', args: ['--clipboard', '--output'] },
  ]);
}

function copyTools(): ClipboardTool[] {
  if (process.platform === 'darwin') return [{ cmd: 'pbcopy', args: [] }];
  if (process.platform === 'win32') {
    return [
      { cmd: 'clip.exe', args: [] },
      { cmd: 'clip', args: [] },
    ];
  }
  return unixTools(WL_COPY, [
    { cmd: 'xclip', args: ['-selection', 'clipboard'] },
    { cmd: 'xsel', args: ['--clipboard', '--input'] },
  ]);
}

function missingToolError(tools: ClipboardTool[]): Error {
  const names = [...new Set(tools.map((t) => t.cmd))].join(', ');
  const hint =
    process.platform === 'linux'
      ? ' — install wl-clipboard (Wayland) or xclip/xsel (X11)'
      : '';
  return new Error(`no clipboard tool available (tried: ${names})${hint}`);
}

async function firstWorkingTool(
  tools: ClipboardTool[],
  input?: string,
  limit = Infinity,
): Promise<string> {
  for (const tool of tools) {
    try {
      return await runTool(tool, input, limit);
    } catch (e) {
      if (e instanceof ToolMissingError) continue;
      throw e;
    }
  }
  throw missingToolError(tools);
}

export async function readClipboard(limit = Infinity): Promise<string> {
  return stripBom(await firstWorkingTool(pasteTools(), undefined, limit));
}

export async function writeClipboard(text: string): Promise<void> {
  await firstWorkingTool(copyTools(), text);
}
