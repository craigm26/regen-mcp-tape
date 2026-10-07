import { spawn } from 'node:child_process';
import type { ChildProcess } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { deriveLabel, parseArgs } from './cli.ts';
import { makeRedactor } from './redact.ts';

const VERSION = '1.0.2';
const USAGE = `usage: tape [--out DIR] [--label NAME] [--redact REGEX]... [--no-redact-defaults] [--help] [--version] -- <command> [args...]
Transparent stdio proxy for MCP servers; writes a JSONL trace of all messages.
`;

function quit(code: number, text?: string, stream: NodeJS.WriteStream = process.stderr): never {
  process.exitCode = code;
  if (text) stream.write(text);
  stream.on('error', () => {});
  stream.write('', () => process.exit(code));
  setTimeout(() => process.exit(code), 3000).unref();
  return undefined as never;
}

function resolveWin(prog: string): string {
  if (/[\\/]/.test(prog) || path.extname(prog) !== '') return prog;
  const exts = (process.env.PATHEXT ?? '.COM;.EXE;.BAT;.CMD').split(';').filter(Boolean);
  const dirs = [process.cwd(), ...(process.env.PATH ?? '').split(';').map((d) => d.replace(/"/g, '')).filter(Boolean)];
  for (const d of dirs) {
    for (const e of exts) {
      const f = path.join(d, prog + e);
      try { if (fs.statSync(f).isFile()) return f; } catch { /* keep looking */ }
    }
  }
  return prog;
}

function launch(cmd: string[]): ChildProcess {
  const [prog, ...args] = cmd as [string, ...string[]];
  if (process.platform !== 'win32') return spawn(prog, args, { stdio: 'pipe' });
  const file = resolveWin(prog);
  if (!/\.(cmd|bat)$/i.test(file)) return spawn(file, args, { stdio: 'pipe' });
  const q = (a: string) => (/^[^\s"&|<>^%()]+$/.test(a) ? a : `"${a.replace(/"/g, '""')}"`);
  return spawn(process.env.ComSpec ?? 'cmd.exe', ['/d', '/s', '/c', `"${[file, ...args].map(q).join(' ')}"`],
    { stdio: 'pipe', windowsVerbatimArguments: true });
}

function main(): void {
  const o = parseArgs(process.argv.slice(2));
  if (o.help) return quit(0, USAGE, process.stdout);
  if (o.version) return quit(0, `tape ${VERSION}\n`, process.stdout);
  if (o.error) return quit(2, `tape: ${o.error}\n${USAGE}`);

  const user: RegExp[] = [];
  for (const p of o.redact) {
    let re: RegExp;
    try { re = new RegExp(p, 'g'); } catch (e) { return quit(2, `tape: invalid --redact pattern ${p}: ${(e as Error).message}\n`); }
    if (new RegExp(re.source, 'g').test('')) {
      process.stderr.write(`tape: --redact pattern ${p} matches the empty string and is ignored\n`);
      continue;
    }
    user.push(re);
  }
  const red = makeRedactor(o.defaults, user);
  const command = o.command.map(red.str);
  const label = o.label ?? deriveLabel(command);
  const started = new Date();
  const startedAt = started.toISOString();
  const name = label.replace(/[^A-Za-z0-9_-]/g, '-').slice(0, 64) || 'mcp';
  let fd = -1;
  try {
    fs.mkdirSync(o.out, { recursive: true });
    fd = fs.openSync(path.join(o.out, `${startedAt.replace(/[:.]/g, '-')}-${name}.jsonl`), 'wx');
  } catch (e) {
    return quit(1, `tape: cannot create trace file in ${o.out}: ${(e as Error).message}\n`);
  }
  const emit = (x: object) => fs.writeFileSync(fd, JSON.stringify(x) + '\n');
  emit({ v: 1, type: 'meta', startedAt, label, command });

  function tracker(dir: 'in' | 'out') {
    let pend: Buffer[] = [];
    const dec = new TextDecoder('utf-8', { ignoreBOM: true });
    const line = (b: Buffer) => {
      let raw: unknown;
      try { raw = red.msg(JSON.parse(dec.decode(b))); } catch { return; }
      emit({ t: new Date().toISOString(), dir, raw });
    };
    const flush = () => { if (pend.length) { const b = Buffer.concat(pend); pend = []; line(b); } };
    return {
      push(chunk: Buffer) {
        let s = 0;
        for (let i = chunk.indexOf(10, s); i >= 0; i = chunk.indexOf(10, s)) {
          pend.push(chunk.subarray(s, i));
          s = i + 1;
          const b = Buffer.concat(pend);
          pend = [];
          line(b);
        }
        if (s < chunk.length) pend.push(chunk.subarray(s));
      },
      end: flush,
    };
  }

  const tIn = tracker('in');
  const tOut = tracker('out');
  const child = launch(o.command);
  let done = false;
  function finish(code: number) {
    if (done) return;
    done = true;
    emit({ t: new Date().toISOString(), type: 'end', exitCode: code, durationMs: Math.max(0, Date.now() - started.getTime()) });
    fs.closeSync(fd);
    process.stdout.on('error', () => {});
    process.stdout.write('', () => quit(code));
  }

  child.stdin!.on('error', () => {});
  child.stdout!.pipe(process.stdout, { end: false });
  child.stderr!.pipe(process.stderr, { end: false });
  process.stdin.pipe(child.stdin!);
  process.stdin.on('data', (c: Buffer) => tIn.push(c));
  process.stdin.on('end', () => tIn.end());
  process.stdin.on('error', () => {});
  child.stdout!.on('data', (c: Buffer) => tOut.push(c));
  child.stdout!.on('end', () => tOut.end());
  process.stdout.on('error', () => {});
  process.stderr.on('error', () => {});
  for (const sig of ['SIGINT', 'SIGTERM'] as const) process.on(sig, () => { child.kill(sig); });

  child.on('error', (e) => {
    if (child.pid !== undefined) return;
    process.stderr.write(`tape: cannot start ${o.command[0]}: ${e.message}\n`);
    finish(127);
  });
  child.on('close', (code, sig) => finish(code ?? (sig ? 128 + (os.constants.signals[sig] ?? 0) : 1)));
}
main();
