import { spawn } from 'node:child_process';

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
 */
export async function readStdinBuffer(): Promise<Buffer | null> {
  if (!hasPipedStdin()) return null;
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  return Buffer.concat(chunks);
}

export async function readStdin(): Promise<string | null> {
  const buf = await readStdinBuffer();
  return buf === null ? null : stripBom(buf.toString('utf8'));
}

/**
 * Run `cmd` with `args`, optionally feeding `input` through the child's stdin.
 * User text is never interpolated into a shell string — there is no shell.
 */
function runTool(tool: ClipboardTool, input?: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn(tool.cmd, tool.args, { stdio: ['pipe', 'pipe', 'pipe'] });
    const out: Buffer[] = [];
    const err: Buffer[] = [];
    let settled = false;

    child.stdout.on('data', (d: Buffer) => out.push(d));
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

async function firstWorkingTool(tools: ClipboardTool[], input?: string): Promise<string> {
  for (const tool of tools) {
    try {
      return await runTool(tool, input);
    } catch (e) {
      if (e instanceof ToolMissingError) continue;
      throw e;
    }
  }
  throw missingToolError(tools);
}

export async function readClipboard(): Promise<string> {
  return stripBom(await firstWorkingTool(pasteTools()));
}

export async function writeClipboard(text: string): Promise<void> {
  await firstWorkingTool(copyTools(), text);
}
