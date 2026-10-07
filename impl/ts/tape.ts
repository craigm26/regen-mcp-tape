// tape: transparent stdio proxy for MCP servers that writes a redacted JSONL trace.
import { spawn } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { redactString, redactTree } from './redact.ts';

const VERSION = '1.0.1';
const USAGE = `usage: tape [--out DIR] [--label NAME] [--redact REGEX]... [--no-redact-defaults] [--help] [--version] -- <command> [args...]
`;

function parseArgs(argv: string[]) {
  const o = { out: './mcp-traces', label: undefined as string | undefined, redact: [] as string[],
    defaults: true, help: false, version: false, err: '', command: [] as string[] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--') { o.command = argv.slice(i + 1); break; }
    if (a === '--out' || a === '--label' || a === '--redact') {
      if (i + 1 >= argv.length) { o.err ||= `option ${a} needs a value`; break; }
      const v = argv[++i];
      if (a === '--out') o.out = v; else if (a === '--label') o.label = v; else o.redact.push(v);
    } else if (a === '--no-redact-defaults') o.defaults = false;
    else if (a === '--help' || a === '-h') o.help = true;
    else if (a === '--version' || a === '-v') o.version = true;
    else if (a.startsWith('-')) o.err ||= `unknown option ${a}`;
    else { o.command = argv.slice(i); break; }
  }
  return o;
}

function deriveLabel(cmd: string[]): string {
  const skip = new Set(['npx', '-y', '--yes', 'node', 'bun', 'deno', 'run', '--']);
  for (let i = cmd.length - 1; i >= 0; i--) {
    const a = cmd[i];
    if (a.startsWith('-') || skip.has(a) || /\s/.test(a)) continue;
    const label = a.split(/[/\\]/).pop()!.replace(/[^A-Za-z0-9-]/g, '-').toLowerCase().slice(0, 32);
    if (label) return label;
  }
  return 'mcp';
}

// Finds the program like a Windows command prompt does; .cmd/.bat files run through cmd.exe.
function resolveCommand(cmd: string[]) {
  const [name, ...rest] = cmd;
  const plain = { file: name, args: rest, verbatim: false };
  if (process.platform !== 'win32') return plain;
  const exts = (process.env.PATHEXT || '.COM;.EXE;.BAT;.CMD').split(';').filter(Boolean);
  const names = path.extname(name) ? [name] : exts.map((e) => name + e);
  const dirs = /[\\/]/.test(name) ? [''] : ['.', ...(process.env.PATH || '').split(';').filter(Boolean)];
  for (const d of dirs) {
    for (const n of names) {
      const f = path.resolve(d, n);
      if (!fs.existsSync(f) || !fs.statSync(f).isFile()) continue;
      if (!/\.(cmd|bat)$/i.test(f)) return { ...plain, file: f };
      const q = (a: string) => (a === '' || /[\s"&|<>^%()]/.test(a) ? `"${a.replace(/"/g, '""')}"` : a);
      return { file: process.env.ComSpec || 'cmd.exe', verbatim: true,
        args: ['/d', '/s', '/c', `"${[f, ...rest].map(q).join(' ')}"`] };
    }
  }
  return plain;
}

function main() {
  const o = parseArgs(process.argv.slice(2));
  process.stdout.on('error', () => {});
  process.stderr.on('error', () => {});
  const quit = (code: number) => {
    setTimeout(() => process.exit(code), 3000);
    process.stdout.write('', () => process.exit(code));
  };
  if (o.help) { process.stdout.write(USAGE); return quit(0); }
  if (o.version) { process.stdout.write(`tape ${VERSION}\n`); return quit(0); }
  const extra: RegExp[] = [];
  try {
    for (const p of o.redact) extra.push(new RegExp(p, 'g'));
  } catch (e) { o.err ||= `invalid --redact pattern: ${(e as Error).message}`; }
  if (!o.err && o.command.length === 0) o.err = 'no command given';
  if (o.err) { process.stderr.write(`tape: ${o.err}\n${USAGE}`); return quit(2); }
  const cfg = { defaults: o.defaults, extra };

  const start = new Date();
  const command = o.command.map((a) => redactString(a, cfg));
  const label = o.label ?? deriveLabel(command);
  const name = Array.from(label).map((c) => (/[A-Za-z0-9_-]/.test(c) ? c : '-')).slice(0, 64).join('') || 'mcp';
  let fd: number;
  try {
    fs.mkdirSync(o.out, { recursive: true });
    fd = fs.openSync(path.join(o.out, `${start.toISOString().replace(/[:.]/g, '-')}-${name}.jsonl`), 'w');
  } catch (e) {
    process.stderr.write(`tape: cannot create trace file: ${(e as Error).message}\n`);
    return quit(1);
  }
  const emit = (obj: object) => fs.writeFileSync(fd, JSON.stringify(obj) + '\n');
  emit({ v: 1, type: 'meta', startedAt: start.toISOString(), label, command });

  const decoder = new TextDecoder('utf-8', { ignoreBOM: true });
  const tracer = (dir: 'in' | 'out') => {
    let parts: Buffer[] = [];
    const line = (buf: Buffer) => {
      try {
        const text = decoder.decode(buf);
        if (/^[ \t\r]*$/.test(text)) return;
        emit({ t: new Date().toISOString(), dir, raw: redactTree(JSON.parse(text), cfg) });
      } catch { /* not JSON: not logged */ }
    };
    return {
      push(chunk: Buffer) {
        let s = 0;
        for (let i = chunk.indexOf(10, s); i >= 0; i = chunk.indexOf(10, s)) {
          parts.push(chunk.subarray(s, i));
          const b = Buffer.concat(parts);
          parts = [];
          line(b);
          s = i + 1;
        }
        if (s < chunk.length) parts.push(chunk.subarray(s));
      },
      flush() {
        if (parts.length) { const b = Buffer.concat(parts); parts = []; line(b); }
      },
    };
  };
  const tin = tracer('in');
  const tout = tracer('out');

  let finished = false;
  const finish = (code: number) => {
    if (finished) return;
    finished = true;
    tout.flush();
    const now = Date.now();
    emit({ t: new Date(now).toISOString(), type: 'end', exitCode: code, durationMs: Math.max(0, now - start.getTime()) });
    fs.closeSync(fd);
    process.stdin.destroy();
    quit(code);
  };

  const r = resolveCommand(o.command);
  const child = spawn(r.file, r.args, { stdio: ['pipe', 'pipe', 'pipe'], windowsVerbatimArguments: r.verbatim });
  child.stdin.on('error', () => {});
  child.on('error', (e) => {
    if (child.pid !== undefined) return;
    process.stderr.write(`tape: cannot start ${o.command[0]}: ${e.message}\n`);
    finish(127);
  });
  const codeOf = (code: number | null, sig: NodeJS.Signals | null) =>
    code !== null ? code : 128 + (os.constants.signals[sig as NodeJS.Signals] ?? 0);

  process.stdin.on('error', () => {});
  process.stdin.pipe(child.stdin);
  process.stdin.on('data', (c: Buffer) => tin.push(c));
  process.stdin.on('end', () => tin.flush());
  child.stdout.pipe(process.stdout, { end: false });
  child.stdout.on('data', (c: Buffer) => tout.push(c));
  child.stdout.on('end', () => tout.flush());
  child.stderr.pipe(process.stderr, { end: false });

  if (process.platform !== 'win32') {
    for (const sig of ['SIGINT', 'SIGTERM'] as const) process.on(sig, () => child.kill(sig));
  }
  // 'close' waits for the pipes; the timer covers a grandchild that keeps them open.
  child.on('exit', (code, sig) => setTimeout(() => finish(codeOf(code, sig)), 2000).unref());
  child.on('close', (code, sig) => { if (child.pid !== undefined) finish(codeOf(code, sig)); });
}

main();
