import { test } from 'node:test';
import assert from 'node:assert';
import { spawn } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const TAPE = path.join(here, 'tape.ts');
const FAKE = path.join(here, 'tests', 'fake.mjs');
const posix = process.platform !== 'win32';

interface Result { code: number | null; stdout: Buffer; stderr: Buffer; dir: string; files: string[]; lines: any[] }
interface RunOpts { chunks?: (Buffer | string)[]; pause?: number; keepOpen?: boolean; env?: Record<string, string>; cwd?: string; noOut?: boolean; onStdout?: (p: any) => void }

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function start(args: string[], opt: RunOpts = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tape-'));
  const out = path.join(dir, 'traces');
  const full = [TAPE, ...(opt.noOut ? [] : ['--out', out]), ...args];
  const p = spawn(process.execPath, full, { cwd: opt.cwd ?? dir, env: { ...process.env, ...opt.env } });
  const so: Buffer[] = [];
  const se: Buffer[] = [];
  p.stdout.on('data', (c) => { so.push(c); opt.onStdout?.(p); });
  p.stderr.on('data', (c) => se.push(c));
  p.stdin.on('error', () => {});
  const done = new Promise<Result>((resolve) => {
    p.on('close', (code) => {
      const files = fs.existsSync(out) ? fs.readdirSync(out) : [];
      const lines = files.length ? fs.readFileSync(path.join(out, files[0]!), 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)) : [];
      resolve({ code, stdout: Buffer.concat(so), stderr: Buffer.concat(se), dir, files, lines });
    });
  });
  return { p, done, dir, out };
}

async function run(args: string[], opt: RunOpts = {}): Promise<Result> {
  const { p, done } = start(args, opt);
  for (const c of opt.chunks ?? []) {
    p.stdin.write(c);
    if (opt.pause) await sleep(opt.pause);
  }
  if (!opt.keepOpen) p.stdin.end();
  const timer = setTimeout(() => p.kill('SIGKILL'), 15000);
  const r = await done;
  clearTimeout(timer);
  return r;
}

const echo = (...extra: string[]) => ['--', process.execPath, FAKE, 'echo', ...extra];
const msgs = (r: Result, dir: string) => r.lines.filter((l) => l.dir === dir).map((l) => l.raw);

test('REQ-IF-001 REGEN.json', () => {
  const j = JSON.parse(fs.readFileSync(path.join(here, 'REGEN.json'), 'utf8'));
  assert.ok(['ts', 'py'].includes(j.lang));
  for (const k of ['build', 'test', 'driver']) assert.ok(k in j);
  assert.ok(!/[|&"'<>]/.test(j.driver));
});

test('REQ-CLI-003 help and version', async () => {
  for (const a of [['--help'], ['-h'], ['-v'], ['--version'], ['--version', '--help'], ['--help', '--bogus']]) {
    const r = await run(a);
    assert.equal(r.code, 0);
    assert.ok(r.stdout.length > 0);
    assert.equal(r.files.length, 0);
  }
  const both = await run(['--version', '--help']);
  assert.match(both.stdout.toString(), /usage/);
});

test('REQ-CLI-004 usage errors', async () => {
  const cases = [['--bogus', '--', 'x'], ['--out'], ['--label'], [], ['--'], ['--redact', '(', '--', 'x'], ['--redact', '[', 'node']];
  for (const a of cases) {
    const r = await run(a);
    assert.equal(r.code, 2, JSON.stringify(a));
    assert.equal(r.stdout.length, 0);
    assert.ok(r.stderr.length > 0);
    assert.equal(r.files.length, 0);
    assert.ok(!fs.existsSync(path.join(r.dir, 'traces')));
  }
});

test('REQ-CLI-001 REQ-CLI-002 command boundaries and option values', async () => {
  const r = await run(['--label', 'x', process.execPath, FAKE, 'info', '--out', 'y', '--label']);
  assert.deepEqual(JSON.parse(r.stdout.toString()).args, ['--out', 'y', '--label']);
  assert.ok(r.files[0]!.endsWith('-x.jsonl'));
  const r2 = await run(['--label', '--help', '--', process.execPath, FAKE, 'info']);
  assert.equal(r2.code, 0);
  assert.ok(r2.files[0]!.endsWith('---help.jsonl'));
  assert.equal(r2.lines[0].label, '--help');
});

test('REQ-FW-001 REQ-FW-002 bytes are forwarded unchanged', async () => {
  const bytes = Buffer.concat([
    Buffer.from('{"a":1}\r\n\n\n  \nnot json\n'), Buffer.from([0xff, 0xfe, 0x80, 0x0a]),
    Buffer.from('{"password":"hunter2","k":"AKIAIOSFODNN7EXAMPLE"}\n'), Buffer.from('{"last":true}'),
  ]);
  const r = await run(echo(), { chunks: [bytes.subarray(0, 10), bytes.subarray(10)], pause: 30 });
  assert.ok(r.stdout.equals(bytes));
  assert.equal(r.code, 0);
});

test('REQ-FW-001 large line', async () => {
  const big = Buffer.from(JSON.stringify({ id: 1, data: 'A'.repeat(5_000_000) }) + '\n');
  const r = await run(echo(), { chunks: [big] });
  assert.ok(r.stdout.equals(big));
});

test('REQ-FW-003 child stderr and REQ-EX-001 exit status', async () => {
  const r = await run(['--', process.execPath, FAKE, 'exit', '7']);
  assert.equal(r.stderr.toString(), 'err\n');
  assert.equal(r.stdout.toString(), 'bye\n');
  assert.equal(r.code, 7);
  assert.equal(r.lines.at(-1).exitCode, 7);
});

test('REQ-FW-004 end of input closes the child stdin', async () => {
  const r = await run(echo('4'), { chunks: ['{"x":1}\n'] });
  assert.equal(r.code, 4);
  assert.equal(r.stdout.toString(), '{"x":1}\n');
});

test('REQ-FW-005 exits when child exits with stdin still open', async () => {
  const { p, done } = start(['--', process.execPath, FAKE, 'exit', '3']);
  const timer = setTimeout(() => p.kill('SIGKILL'), 10000);
  const r = await done;
  clearTimeout(timer);
  assert.equal(r.code, 3);
  assert.equal(r.stdout.toString(), 'bye\n');
  assert.equal(r.lines.at(-1).type, 'end');
});

test('REQ-FW-006 environment and working directory', async () => {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'tape-cwd-'));
  const r = await run(['--', process.execPath, FAKE, 'info'], { env: { TAPE_T: 'v1' }, cwd });
  const j = JSON.parse(r.stdout.toString());
  assert.equal(j.env, 'v1');
  assert.equal(fs.realpathSync(j.cwd), fs.realpathSync(cwd));
});

test('REQ-EX-002 signal exit status', { skip: !posix }, async () => {
  assert.equal((await run(['--', process.execPath, FAKE, 'sig', 'SIGTERM'])).code, 143);
  assert.equal((await run(['--', process.execPath, FAKE, 'sig', 'SIGKILL'])).code, 137);
  const r = await run(['--', process.execPath, FAKE, 'sig', 'SIGUSR1']);
  assert.equal(r.code, 128 + os.constants.signals.SIGUSR1);
  assert.equal(r.lines.at(-1).exitCode, r.code);
});

test('REQ-EX-003 signals are forwarded', { skip: !posix }, async () => {
  for (const sig of ['SIGTERM', 'SIGINT'] as const) {
    const { p, done } = start(['--', process.execPath, FAKE, 'term']);
    await new Promise<void>((res) => p.stdout.once('data', () => res()));
    p.kill(sig);
    const r = await done;
    if (sig === 'SIGTERM') assert.equal(r.code, 0);
    else assert.equal(r.code, 130);
  }
});

test('REQ-EX-004 command cannot be started', async () => {
  const r = await run(['--', 'no-such-program-xyz', 'a']);
  assert.equal(r.code, 127);
  assert.ok(r.stderr.length > 0);
  assert.equal(r.lines[0].type, 'meta');
  assert.equal(r.lines.at(-1).exitCode, 127);
});

test('REQ-EX-005 trace file cannot be created', async () => {
  const f = path.join(os.tmpdir(), `tape-file-${process.pid}`);
  fs.writeFileSync(f, 'x');
  const r = await run(['--out', f, ...echo()], { noOut: true });
  assert.equal(r.code, 1);
  assert.ok(r.stderr.length > 0);
  assert.equal(r.stdout.length, 0);
});

test('REQ-TR-001..005 trace layout', async () => {
  const before = Date.now();
  const r = await run(['--label', 'my server/v2', ...echo()], { chunks: ['{"a":1}\n'] });
  assert.equal(r.files.length, 1);
  assert.match(r.files[0]!, /^\d{4}-\d\d-\d\dT\d\d-\d\d-\d\d-\d{3}Z-my-server-v2\.jsonl$/);
  const [meta, ...rest] = r.lines;
  const end = rest.pop();
  assert.equal(meta.v, 1);
  assert.equal(meta.type, 'meta');
  assert.match(meta.startedAt, /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/);
  assert.ok(Date.parse(meta.startedAt) >= before - 1000);
  assert.equal(meta.label, 'my server/v2');
  assert.deepEqual(meta.command, [process.execPath, FAKE, 'echo']);
  assert.equal(rest.length, 2);
  for (const l of rest) { assert.match(l.t, /^\d{4}-.*Z$/); assert.deepEqual(l.raw, { a: 1 }); }
  assert.deepEqual(rest.map((l) => l.dir).sort(), ['in', 'out']);
  assert.equal(end.type, 'end');
  assert.equal(end.exitCode, 0);
  assert.ok(Number.isInteger(end.durationMs) && end.durationMs >= 0);
  const long = await run(['--label', 'é'.repeat(80), ...echo()]);
  assert.equal(long.files[0]!.replace(/^.*Z-/, '').replace('.jsonl', ''), '-'.repeat(64));
  const empty = await run(['--label', '', ...echo()]);
  assert.ok(empty.files[0]!.endsWith('Z-mcp.jsonl'));
});

test('REQ-TR-007 REQ-TR-008 REQ-TR-009 REQ-TR-010 which lines are logged', async () => {
  const snow = Buffer.from('{"s":"é☃𝄞"}\n');
  const input = Buffer.concat([
    Buffer.from('\n \t\r\nnot json\n{"n":1.0,"big":0.1,"e":1e300}\r\n[1,2]\n"str"\n42\ntrue\nnull\n{"m":1}\n{"m":2}\n'),
    snow, Buffer.from('{"tail":1}'),
  ]);
  const cut = input.length - 10 - 8;
  const r = await run(echo(), { chunks: [input.subarray(0, cut), input.subarray(cut)], pause: 50 });
  const expected = [{ n: 1, big: 0.1, e: 1e300 }, [1, 2], 'str', 42, true, null, { m: 1 }, { m: 2 }, { s: 'é☃𝄞' }, { tail: 1 }];
  assert.deepEqual(msgs(r, 'in'), expected);
  assert.deepEqual(msgs(r, 'out'), expected);
});

test('REQ-TR-007 multibyte character split across writes', async () => {
  const b = Buffer.from('{"s":"☃"}\n');
  const r = await run(echo(), { chunks: [b.subarray(0, 7), b.subarray(7)], pause: 100 });
  assert.deepEqual(msgs(r, 'in'), [{ s: '☃' }]);
  assert.deepEqual(msgs(r, 'out'), [{ s: '☃' }]);
});

test('REQ-RD-005 REQ-LB-001 command redaction and label', async () => {
  const tok = 'ghp_' + 'A'.repeat(36);
  const r = await run(['--', process.execPath, FAKE, 'info', tok]);
  assert.ok(r.files[0]!.endsWith('Z--redacted-.jsonl'));
  assert.equal(r.lines[0].label, '-redacted-');
  assert.equal(r.lines[0].command.at(-1), '[REDACTED]');
  assert.ok(r.stdout.toString().includes(tok));
  const r2 = await run(['--no-redact-defaults', '--redact', 'ABC+', '--', process.execPath, FAKE, 'info', tok, 'xABCCy']);
  assert.equal(r2.lines[0].command.at(-2), tok);
  assert.equal(r2.lines[0].command.at(-1), 'x[REDACTED]y');
});

test('REQ-RD redaction in the trace, never in forwarded bytes', async () => {
  const line = '{"password":"p","max_tokens":100,"x":"AKIAIOSFODNN7EXAMPLE","y":"mine"}\n';
  const r = await run(['--redact', 'mine', ...echo()], { chunks: [line] });
  assert.equal(r.stdout.toString(), line);
  const want = { password: '[REDACTED]', max_tokens: 100, x: '[REDACTED]', y: '[REDACTED]' };
  assert.deepEqual(msgs(r, 'in'), [want]);
  const r2 = await run(['--no-redact-defaults', ...echo()], { chunks: [line] });
  assert.deepEqual(msgs(r2, 'in'), [JSON.parse(line)]);
});

test('REQ-RD-006 2 MB word is logged and later traffic forwarded', async () => {
  const blob = Buffer.from('A'.repeat(2_000_000), 'latin1').toString();
  const input = JSON.stringify({ r: blob }) + '\n' + JSON.stringify({ r: blob.replace(/A/g, '.env') }) + '\n{"after":1}\n';
  const t0 = Date.now();
  const r = await run(echo(), { chunks: [input] });
  assert.ok(Date.now() - t0 < 14000);
  assert.equal(r.stdout.toString(), input);
  assert.deepEqual(msgs(r, 'in').at(-1), { after: 1 });
  assert.equal(msgs(r, 'in').length, 3);
});

test('REQ-PL-002 arguments arrive intact', async () => {
  const args = ['a b', 'say "hi"', '', 'x\\', '--out=1'];
  const r = await run(['--', process.execPath, FAKE, 'info', ...args]);
  assert.deepEqual(JSON.parse(r.stdout.toString()).args, args);
});

test('REQ-PL-001 .cmd shims run (Windows)', { skip: posix }, async () => {
  const r = await run(['--', 'npx', '--version']);
  assert.equal(r.code, 0);
  assert.match(r.stdout.toString(), /\d+\.\d+/);
});
