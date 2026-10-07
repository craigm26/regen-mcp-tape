import { test } from 'node:test';
import assert from 'node:assert';
import { spawn } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { redactString, redactTree } from '../redact.ts';

const ROOT = path.resolve(import.meta.dirname, '..');
const TAPE = path.join(ROOT, 'tape.ts');
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'tape-'));
const posix = process.platform !== 'win32';

const FAKE = path.join(tmp(), 'fake.mjs');
fs.writeFileSync(FAKE, `
const mode = process.argv[2];
if (mode === 'echo') { process.stdin.on('data', (d) => process.stdout.write(d)); process.stdin.on('end', () => process.exit(0)); }
else if (mode === 'eof') { process.stdin.resume(); process.stdin.on('end', () => { process.stdout.write('saw-eof\\n'); process.exit(0); }); }
else if (mode === 'exit') { process.exit(Number(process.argv[3])); }
else if (mode === 'quit-open') { process.stdout.write('bye\\n'); process.stderr.write('err\\n'); setTimeout(() => process.exit(3), 100); process.stdin.resume(); }
else if (mode === 'stderr') { process.stderr.write(Buffer.from([0xff, 0x41, 0x0a])); process.stdout.write('{"a":1}\\n'); }
else if (mode === 'emit') { process.stdout.write(Buffer.from(process.argv[3], 'base64')); }
else if (mode === 'args') { process.stdout.write(JSON.stringify(process.argv.slice(3)) + '\\n'); }
else if (mode === 'term') { process.on('SIGTERM', () => process.exit(0)); process.stdout.write('ready\\n'); setInterval(() => {}, 1000); }
else if (mode === 'sig') { process.stdout.write('ready\\n'); setTimeout(() => process.kill(process.pid, process.argv[3]), 100); setInterval(() => {}, 1000); }
else if (mode === 'cwd') { process.stdout.write(process.cwd() + '|' + process.env.TAPE_TEST_VAR + '\\n'); }
`);

interface Result { stdout: Buffer; stderr: Buffer; code: number | null; out: string; trace: any[]; file: string }

function run(args: string[], opts: { chunks?: (Buffer | string | number)[]; close?: boolean; out?: string; cwd?: string;
  env?: Record<string, string>; after?: (p: ReturnType<typeof spawn>) => void; noOut?: boolean } = {}): Promise<Result> {
  const out = opts.out ?? tmp();
  const full = opts.noOut ? args : ['--out', out, ...args];
  return new Promise((resolve, reject) => {
    const p = spawn(process.execPath, [TAPE, ...full], { cwd: opts.cwd, env: { ...process.env, ...opts.env } });
    const so: Buffer[] = [], se: Buffer[] = [];
    p.stdout.on('data', (d) => so.push(d));
    p.stderr.on('data', (d) => se.push(d));
    p.stdin.on('error', () => {});
    const timer = setTimeout(() => { p.kill('SIGKILL'); reject(new Error('timeout')); }, 15000);
    p.on('close', (code) => {
      clearTimeout(timer);
      let files: string[] = [];
      try { files = fs.readdirSync(out); } catch { /* none */ }
      const file = files[0] ?? '';
      const text = file ? fs.readFileSync(path.join(out, file), 'utf8') : '';
      assert.ok(files.length <= 1);
      const trace = text ? text.split('\n').slice(0, -1).map((l) => JSON.parse(l)) : [];
      resolve({ stdout: Buffer.concat(so), stderr: Buffer.concat(se), code, out, trace, file });
    });
    (async () => {
      for (const c of opts.chunks ?? []) {
        if (typeof c === 'number') await new Promise((r) => setTimeout(r, c));
        else p.stdin.write(c);
      }
      if (opts.after) opts.after(p);
      if (opts.close !== false) p.stdin.end();
    })();
  });
}
const node = (...a: string[]) => ['--', process.execPath, FAKE, ...a];
const msgs = (r: Result) => r.trace.filter((l) => l.dir);

test('REQ-IF-001 REGEN.json', () => {
  const j = JSON.parse(fs.readFileSync(path.join(ROOT, 'REGEN.json'), 'utf8'));
  assert.ok(['ts', 'py'].includes(j.lang));
  for (const k of ['build', 'test', 'driver']) assert.ok(k in j);
  assert.ok(!/[|&<>"']/.test(String(j.driver)));
});

test('REQ-CLI-003 help and version', async () => {
  for (const a of [['--help'], ['-v'], ['--version', '--help']]) {
    const r = await run(a, { noOut: true, cwd: tmp() });
    assert.equal(r.code, 0);
    assert.ok(r.stdout.length > 0);
    assert.equal(r.file, '');
  }
  const h = await run(['--version', '--help'], { noOut: true });
  assert.match(h.stdout.toString(), /usage/);
});

test('REQ-CLI-004 usage errors', async () => {
  const out = tmp();
  for (const a of [['--bogus', 'x'], ['--out'], [], ['--redact', '(', ...node('echo')], ['--label', 'x']]) {
    const r = await run(a, { out: path.join(out, 'sub') });
    assert.equal(r.code, 2, JSON.stringify(a));
    assert.equal(r.stdout.length, 0);
    assert.ok(r.stderr.length > 0);
    assert.ok(!fs.existsSync(path.join(out, 'sub')));
  }
});

test('REQ-CLI-001/002 command without --, option-looking args and values', async () => {
  const r = await run(['--label', '--out', process.execPath, FAKE, 'args', '--out', 'y'], {});
  assert.equal(r.stdout.toString(), '["--out","y"]\n');
  assert.equal(r.trace[0].label, '--out');
  assert.match(r.file, /Z---out\.jsonl$/);
});

test('REQ-CLI-001 default --out is ./mcp-traces', async () => {
  const cwd = tmp();
  await run([...node('exit', '0')], { noOut: true, cwd });
  assert.equal(fs.readdirSync(path.join(cwd, 'mcp-traces')).length, 1);
});

test('REQ-FW-001/002/004 forwarding of odd bytes, chunked, and EOF', async () => {
  const big = Buffer.from('{"x":"' + 'a'.repeat(3_000_000) + '"}\n');
  const input = Buffer.concat([Buffer.from('{"a":1}\r\n\n  \n'), Buffer.from([0xff, 0xfe, 0x0a]), big,
    Buffer.from('é'.repeat(3)), Buffer.from('no-lf')]);
  const r = await run(['--', process.execPath, FAKE, 'echo'], { chunks: [input.subarray(0, 20), 50, input.subarray(20)] });
  assert.ok(r.stdout.equals(input));
  assert.equal(r.code, 0);
  const r2 = await run(node('eof'), { chunks: ['x\n'] });
  assert.equal(r2.stdout.toString(), 'saw-eof\n');
});

test('REQ-FW-003 stderr bytes', async () => {
  const r = await run(node('stderr'));
  assert.ok(r.stderr.includes(Buffer.from([0xff, 0x41, 0x0a])));
});

test('REQ-FW-005 exits when child exits with stdin open', async () => {
  const r = await run(node('quit-open'), { close: false });
  assert.equal(r.code, 3);
  assert.equal(r.stdout.toString(), 'bye\n');
  assert.ok(r.stderr.toString().includes('err\n'));
  assert.equal(r.trace.at(-1).exitCode, 3);
});

test('REQ-FW-006 env and cwd', async () => {
  const cwd = tmp();
  const r = await run(node('cwd'), { cwd, env: { TAPE_TEST_VAR: 'zz' } });
  assert.equal(fs.realpathSync(r.stdout.toString().split('|')[0]), fs.realpathSync(cwd));
  assert.equal(r.stdout.toString().split('|')[1], 'zz\n');
});

test('REQ-EX-001 exit status', async () => {
  assert.equal((await run(node('exit', '42'))).code, 42);
  assert.equal((await run(node('exit', '0'))).code, 0);
});

test('REQ-EX-002 signal status', { skip: !posix }, async () => {
  const r = await run(node('sig', 'SIGUSR1'), { close: false });
  assert.equal(r.code, 128 + os.constants.signals.SIGUSR1);
  assert.equal(r.trace.at(-1).exitCode, r.code);
});

test('REQ-EX-003 SIGTERM forwarded', { skip: !posix }, async () => {
  const r = await run(node('term'), { close: false, after: (p) => { setTimeout(() => p.kill('SIGTERM'), 600); } });
  assert.equal(r.code, 0);
  const r2 = await run(node('sig', 'SIGKILL'), { close: false });
  assert.equal(r2.code, 137);
});

test('REQ-EX-004 command cannot start', async () => {
  const r = await run(['--', 'definitely-not-a-program-xyz']);
  assert.equal(r.code, 127);
  assert.ok(r.stderr.length > 0);
  assert.equal(r.trace[0].type, 'meta');
  assert.equal(r.trace.at(-1).exitCode, 127);
});

test('REQ-EX-005 trace file cannot be created', async () => {
  const f = path.join(tmp(), 'file');
  fs.writeFileSync(f, 'x');
  const r = await run(node('echo'), { out: f });
  assert.equal(r.code, 1);
  assert.ok(r.stderr.length > 0);
  assert.equal(r.stdout.length, 0);
});

test('REQ-TR-001..005 file name and line shapes', async () => {
  const out = path.join(tmp(), 'a', 'b');
  const r = await run(['--label', 'my server/v2', ...node('echo')], { out, chunks: ['{"id":1}\n'] });
  assert.match(r.file, /^\d{4}-\d\d-\d\dT\d\d-\d\d-\d\d-\d{3}Z-my-server-v2\.jsonl$/);
  const [meta, m] = r.trace; const end = r.trace.at(-1);
  assert.equal(meta.v, 1); assert.equal(meta.type, 'meta'); assert.equal(meta.label, 'my server/v2');
  assert.match(meta.startedAt, /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/);
  assert.deepEqual(meta.command, [process.execPath, FAKE, 'echo']);
  assert.deepEqual(m.raw, { id: 1 });
  assert.equal(r.trace.length, 4);
  assert.deepEqual(r.trace.slice(1, 3).map((x) => x.dir).sort(), ['in', 'out']);
  assert.equal(end.type, 'end'); assert.equal(end.exitCode, 0);
  assert.ok(Number.isInteger(end.durationMs) && end.durationMs >= 0);
  const long = await run(['--label', 'é' + 'x'.repeat(100), ...node('exit', '0')]);
  assert.match(long.file, /Z-[-x]{64}\.jsonl$/);
  const empty = await run(['--label', '', ...node('exit', '0')]);
  assert.match(empty.file, /Z-mcp\.jsonl$/);
});

test('REQ-TR-007..010 which lines are logged', async () => {
  const input = Buffer.concat([Buffer.from('{"a":1}\n \t\r\nnot json\n[1,2]\r\n"s"\n'), Buffer.from('{"u":"é'),
    Buffer.from([0xc3]), Buffer.from([0xa9, 0x22, 0x7d, 0x0a]), Buffer.from('{"n":1.0,"b":12345678901234567890}\n'),
    Buffer.from('null\n42\n{"last":true}')]);
  const r = await run(node('echo'), { chunks: [input.subarray(0, 40), 50, input.subarray(40, 52), 50, input.subarray(52)] });
  const ins = msgs(r).filter((l) => l.dir === 'in').map((l) => l.raw);
  assert.deepEqual(ins, [{ a: 1 }, [1, 2], 's', { u: 'ééé'.slice(0, 1) + 'é' }, { n: 1, b: 12345678901234567890 }, null, 42, { last: true }]);
  const outs = msgs(r).filter((l) => l.dir === 'out').map((l) => l.raw);
  assert.deepEqual(outs, ins);
});

test('REQ-TR-008 final line without LF from child', async () => {
  const r = await run(node('emit', Buffer.from('{"z":1}').toString('base64')));
  assert.deepEqual(msgs(r).map((l) => [l.dir, l.raw]), [['out', { z: 1 }]]);
});

test('REQ-LB-001 derived labels', async () => {
  const cases: [string[], string][] = [
    [['node', '/opt/server.js'], 'server-js'], [['npx', '-y', 'my-remote'], 'my-remote'],
    [['node', 'srv.js', '--port', '3000'], '3000'], [['node', 'C:\\srv\\files.mjs'], 'files-mjs'],
    [['npx', '-y', 'srv', 'https://example.test/mcp', '--header', 'X-Key: abc'], 'mcp'],
    [['node', 'KEY=value'], 'key-value'], [['npx', '-y', '--'], 'mcp'],
  ];
  for (const [cmd, label] of cases) {
    const r = await run(['--', 'definitely-not-a-program-xyz', ...cmd.slice(0)]);
    // the last-segment rule is applied to the whole command; compare via a command ending in the case
    assert.equal(r.trace[0].command.length, cmd.length + 1);
  }
  for (const [cmd, label] of cases) {
    const r = await run(['--', ...cmd]);
    assert.equal(r.trace[0].label, label, cmd.join(' '));
  }
});

test('REQ-RD-005 label and command are redacted', async () => {
  const r = await run(['--', 'nope-xyz', 'AKIAIOSFODNN7EXAMPLE']);
  assert.equal(r.trace[0].label, '-redacted-');
  assert.deepEqual(r.trace[0].command, ['nope-xyz', '[REDACTED]']);
  assert.ok(!r.file.includes('AKIA'));
  const r2 = await run(['--no-redact-defaults', '--redact', 'zzz+', '--', 'nope-xyz', 'AKIAIOSFODNN7EXAMPLE', 'azzzb']);
  assert.deepEqual(r2.trace[0].command, ['nope-xyz', 'AKIAIOSFODNN7EXAMPLE', 'a[REDACTED]b']);
});

const D = { defaults: true, extra: [] as RegExp[] };
const s2 = (s: string) => redactString(s, D);
const CRLF = '\r\n';

test('REQ-RD-001 exact keys any type, nothing inside examined', () => {
  assert.deepEqual(redactTree({ token: 5, a: { password: null, k: { x: 1 } }, secret: { y: [1] }, pwd: true, Authorization: [1] }, D),
    { token: '[REDACTED]', a: { password: '[REDACTED]', k: { x: 1 } }, secret: '[REDACTED]', pwd: '[REDACTED]', Authorization: '[REDACTED]' });
  assert.deepEqual(redactTree({ Token: 5 }, D), { Token: 5 });
});

test('REQ-RD-002 string patterns', () => {
  const cases: [string, string][] = [
    ['try AKIAIOSFODNN7EXAMPLE today', 'try [REDACTED] today'],
    ['Authorization: Bearer abc.def', '[REDACTED]'],
    ['Authorization: x' + CRLF + 'next', '[REDACTED]' + CRLF + 'next'],
    ['postgres://admin:hunter2@db:5432/x', 'postgres://admin:[REDACTED]@db:5432/x'],
    ['load /srv/app/.env.local now', 'load [REDACTED] now'],
    ['key is ~/.ssh/id_ed25519.pub', 'key is [REDACTED]'],
    ['café AKIAIOSFODNN7EXAMPLE', 'café [REDACTED]'],
    ['éAKIAIOSFODNN7EXAMPLE', 'é[REDACTED]'],
    ['a/.env.x+b/.env', '[REDACTED]'], ['my.envy', 'my.envy'], ['cfg/.env.', '[REDACTED].'],
    ['.env.env-id_', '[REDACTED]-id_'],
    ['sk-' + 'a'.repeat(20), '[REDACTED]'], ['ghp_' + 'a'.repeat(36), '[REDACTED]'],
    ['eyJhbGci.eyJzdWIi.sig_-x', '[REDACTED]'], ['bearer abc123', '[REDACTED]'],
    ['xoxb-1234567890-abc', '[REDACTED]'], ['sk_live_abcdefgh1', '[REDACTED]'],
  ];
  for (const [i, o] of cases) assert.equal(s2(i), o, i);
});

test('REQ-RD-003 key substrings', () => {
  assert.deepEqual(redactTree({ db_password: 'x', max_tokens: 100, progressToken: 'abc', tokens: [1, 2], 'pwd-x': 'k', myPwd: 'k', bearer: 'b', xbearer: 's', flag: { api_key2: true } }, D),
    { db_password: '[REDACTED]', max_tokens: 100, progressToken: '[REDACTED]', tokens: '[REDACTED]', 'pwd-x': '[REDACTED]', myPwd: 'k', bearer: '[REDACTED]', xbearer: 's', flag: { api_key2: true } });
  assert.deepEqual(redactTree({ PrivateKey: { a: 1 }, ACCESS_KEY: 's', Passwd: null }, D),
    { PrivateKey: '[REDACTED]', ACCESS_KEY: '[REDACTED]', Passwd: null });
});

test('REQ-RD-004 --redact and --no-redact-defaults, in order', () => {
  const c = { defaults: true, extra: [/foo+/g, /\[REDACTED\] x/g] };
  assert.deepEqual(redactTree({ a: 'foooo AKIAIOSFODNN7EXAMPLE x' }, c), { a: '[REDACTED] [REDACTED]' });
  const n = { defaults: false, extra: [/b+/g] };
  assert.deepEqual(redactTree({ token: 'abbc', k: 'AKIAIOSFODNN7EXAMPLE' }, n), { token: 'a[REDACTED]c', k: 'AKIAIOSFODNN7EXAMPLE' });
});

test('REQ-RD-004 in a run: traced redacted, forwarded untouched', async () => {
  const line = '{"token":"abc","m":"AKIAIOSFODNN7EXAMPLE zed"}\n';
  const r = await run(['--redact', 'zed', ...node('echo')], { chunks: [line] });
  assert.equal(r.stdout.toString(), line);
  assert.deepEqual(msgs(r)[0].raw, { token: '[REDACTED]', m: '[REDACTED] [REDACTED]' });
});

test('REQ-RD-006 2 MB blob is fast', async () => {
  const blob = 'QUJD'.repeat(500_000);
  const line = JSON.stringify({ data: blob }) + '\n';
  const t = Date.now();
  const r = await run(node('echo'), { chunks: [line, '{"after":1}\n'] });
  assert.ok(Date.now() - t < 10000);
  assert.equal(r.stdout.toString(), line + '{"after":1}\n');
  assert.equal(msgs(r).filter((l) => l.dir === 'in').length, 2);
  const t0 = Date.now();
  s2('.env' + 'a.'.repeat(1_000_000) + ' id_ ' + 'b'.repeat(1_000_000));
  assert.ok(Date.now() - t0 < 5000);
});

test('REQ-PL-002 arguments with spaces and quotes reach the child exactly', async () => {
  const args = ['a b', 'say "hi"', '', 'x\\y', '--out'];
  const r = await run(['--', process.execPath, FAKE, 'args', ...args]);
  assert.deepEqual(JSON.parse(r.stdout.toString()), args);
});

test('REQ-PL-001 bare command name found on PATH', async () => {
  const dir = tmp();
  const r = await run(['--', 'node', FAKE, 'exit', '7'], { env: { PATH: path.dirname(process.execPath) + path.delimiter + (process.env.PATH ?? '') } });
  assert.equal(r.code, 7);
  void dir;
});

test('REQ-PL-001 .cmd files run', { skip: posix }, async () => {
  const dir = tmp();
  fs.writeFileSync(path.join(dir, 'shim.cmd'), '@echo off\r\necho shim-%1\r\n');
  const r = await run(['--', 'shim', 'one'], { env: { PATH: dir + path.delimiter + process.env.PATH } });
  assert.equal(r.stdout.toString().trim(), 'shim-one');
});
