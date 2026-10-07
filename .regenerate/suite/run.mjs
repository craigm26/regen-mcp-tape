#!/usr/bin/env node
// Spec suite runner for tape. Node standard library only.
//   node .regenerate/suite/run.mjs --impl <dir> [--json report.json] [--reference] [--only substr]
// Prints `passed X/Y (advisory A/B, skipped S, n/a N)`; exits 0 only if every non-advisory
// case passed and traceability holds.
import { spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir, constants as osConstants } from 'node:os';
import { basename, extname, isAbsolute, join, resolve } from 'node:path';
import { buildCases, FAKE, CONFIG_NAME } from './cases.mjs';
import * as O from './oracle.mjs';

const SUITE = import.meta.dirname;
const args = process.argv.slice(2);
const opt = (n) => { const i = args.indexOf(n); return i >= 0 ? args[i + 1] : undefined; };
const IMPL = opt('--impl') && resolve(opt('--impl'));
const JSON_OUT = opt('--json');
const AS_REFERENCE = args.includes('--reference');
const ONLY = opt('--only');
const TIMEOUT_MS = 15000;
const WIN = process.platform === 'win32';
if (!IMPL) { console.error('usage: run.mjs --impl <dir> [--json report.json] [--reference]'); process.exit(2); }

// ---------- traceability
const spec = readFileSync(join(SUITE, '..', 'SPEC.md'), 'utf8');
const definedReqs = new Set([...spec.matchAll(/\*\*(REQ-[A-Z]+-\d{3})\.\*\*/g)].map((m) => m[1]));
const allCases = buildCases();
const trace = [];
const ids = new Set();
for (const c of allCases) {
  if (ids.has(c.id)) trace.push(`duplicate case id ${c.id}`);
  ids.add(c.id);
  if (!c.reqs?.length) trace.push(`case ${c.id} cites no REQ`);
  for (const r of c.reqs ?? []) {
    if (r.startsWith('OPEN-')) trace.push(`case ${c.id} cites open item ${r}`);
    else if (!definedReqs.has(r)) trace.push(`case ${c.id} cites unknown ${r}`);
  }
}
for (const r of definedReqs) if (!allCases.some((c) => c.reqs.includes(r))) trace.push(`${r} has no case`);
if (trace.length) { console.error('TRACEABILITY FAILED:\n  ' + trace.join('\n  ')); process.exit(2); }
const cases = allCases.filter((c) => !ONLY || c.id.includes(ONLY));

// ---------- REGEN.json
const pick = (v) => (v == null ? '' : typeof v === 'string' ? v : v[process.platform] ?? v.default ?? '');
let regen = null, regenErr = null;
try { regen = JSON.parse(readFileSync(join(IMPL, 'REGEN.json'), 'utf8')); } catch (e) { regenErr = e.message; }
let buildFailed = null;
if (regen && pick(regen.build).trim()) {
  const b = spawnSync(pick(regen.build), { cwd: IMPL, shell: true, encoding: 'utf8', timeout: 600000 });
  if (b.status !== 0) buildFailed = `build exited ${b.status}: ${((b.stdout ?? '') + (b.stderr ?? '')).slice(-500)}`;
}
// Driver words; relative paths that exist in the implementation folder become absolute (SPEC § 1.1).
const driverWords = () => pick(regen.driver).split(' ').filter(Boolean)
  .map((w, i) => (i > 0 && !isAbsolute(w) && !w.startsWith('-') && existsSync(join(IMPL, w)) ? join(IMPL, w) : w));

// ---------- run one case
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
function killTree(pid) {
  if (WIN) spawnSync('taskkill', ['/PID', String(pid), '/T', '/F'], { stdio: 'ignore' });
  else { try { process.kill(-pid, 'SIGKILL'); } catch { try { process.kill(pid, 'SIGKILL'); } catch {} } }
}
const toBuf = (x) => (x === undefined ? undefined : typeof x === 'string' ? Buffer.from(x, 'utf8') : Buffer.from(x.b64, 'base64'));

async function runCase(c) {
  const tmp = mkdtempSync(join(tmpdir(), 'tape-case-'));
  const out = c.outSubdir ? join(tmp, 'out', ...c.outSubdir.split('/')) : join(tmp, 'out');
  const traceDir = c.noOut ? join(tmp, 'mcp-traces') : out;
  if (c.outIsFile) writeFileSync(out, 'not a directory\n');
  const cfgPath = join(tmp, CONFIG_NAME);
  const files = { record: join(tmp, 'received.bin'), argsFile: join(tmp, 'args.json'), termFile: join(tmp, 'term.txt') };
  const server = { ...c.server, record: files.record, argsFile: files.argsFile, ...(c.server.termFile ? { termFile: files.termFile } : {}) };
  writeFileSync(cfgPath, JSON.stringify(server));
  let command = c.command ?? ['node', FAKE, cfgPath, ...(c.extraArgs ?? [])];
  const env = { ...process.env };
  if (c.cmdShim) {
    const shimDir = join(tmp, 'shim');
    mkdirSync(shimDir);
    writeFileSync(join(shimDir, 'fakesrv.cmd'), `@node "${FAKE}" %*\r\n`);
    const pathKey = Object.keys(env).find((k) => k.toUpperCase() === 'PATH') ?? 'PATH';
    env[pathKey] = shimDir + ';' + env[pathKey];
    command = ['fakesrv', cfgPath, ...(c.extraArgs ?? [])];
  }
  const tapeArgs = [...(c.noOut ? [] : ['--out', out]), ...c.tapeArgs];
  const argv = c.command && c.command.length === 0 ? tapeArgs : [...tapeArgs, ...(c.noSeparator ? [] : ['--']), ...command];
  const words = driverWords();
  const started = Date.now();
  const child = spawn(words[0], [...words.slice(1), ...argv], { cwd: tmp, env, stdio: ['pipe', 'pipe', 'pipe'], detached: !WIN, windowsHide: true });
  const so = [], se = [];
  let soLen = 0, timedOut = false, spawnError = null;
  child.stdout.on('data', (d) => { so.push(d); soLen += d.length; });
  child.stderr.on('data', (d) => se.push(d));
  child.stdin.on('error', () => {});
  const done = new Promise((res) => {
    child.on('error', (e) => { spawnError = e; res(null); });
    child.on('close', (code, signal) => res({ code, signal }));
  });
  const timer = setTimeout(() => { timedOut = true; killTree(child.pid); }, TIMEOUT_MS);
  (async () => {
    for (const s of c.stdin) {
      if (s.delayMs) await sleep(s.delayMs);
      if (child.exitCode !== null) break;
      await new Promise((r) => child.stdin.write(toBuf(s.text ?? s), () => r()));
    }
    if (c.signal) {
      while (soLen < c.signal.afterStdout && child.exitCode === null && !timedOut) await sleep(20);
      await sleep(200);
      if (!c.keepStdinOpen) child.stdin.end();
      try { process.kill(child.pid, c.signal.name); } catch {}
      return;
    }
    if (!c.keepStdinOpen) child.stdin.end();
  })();
  const status = await done;
  clearTimeout(timer);
  const elapsed = Date.now() - started;
  if (c.keepStdinOpen) { try { child.stdin.destroy(); } catch {} }
  const result = { tmp, traceDir, out, files, command, started, elapsed, timedOut, spawnError,
    code: status?.code ?? null, signal: status?.signal ?? null, stdout: Buffer.concat(so), stderr: Buffer.concat(se) };
  return result;
}

// ---------- checks
const ISO = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;
const sameJson = (a, b) => {
  if (a === null || b === null || typeof a !== 'object' || typeof b !== 'object') return Object.is(a, b) || a === b;
  if (Array.isArray(a) !== Array.isArray(b)) return false;
  const ka = Object.keys(a).sort(), kb = Object.keys(b).sort();
  return ka.join('\0') === kb.join('\0') && ka.every((k) => sameJson(a[k], b[k]));
};
const short = (v) => { const s = typeof v === 'string' ? v : JSON.stringify(v); return s.length > 300 ? s.slice(0, 300) + `…(${s.length})` : s; };
const showBytes = (b) => short(b.toString('utf8'));

function check(c, r) {
  const e = c.expect;
  const fails = [];
  if (r.spawnError) return [`driver did not start: ${r.spawnError.message}`];
  if (r.timedOut) fails.push(`timed out after ${TIMEOUT_MS} ms (tape did not exit)`);
  let expectedExit = e.exit;
  if (c.server.exitSignal && !WIN) expectedExit = 128 + osConstants.signals[c.server.exitSignal];
  if (c.id === 'signal-forwarded-child-dies' && !WIN) expectedExit = 128 + osConstants.signals.SIGTERM;
  if (!r.timedOut && expectedExit !== undefined && r.code !== expectedExit) fails.push(`exit ${r.code}${r.signal ? ` (signal ${r.signal})` : ''}, want ${expectedExit}`);
  if (e.stdout !== undefined && !r.stdout.equals(toBuf(e.stdout))) fails.push(`stdout ${showBytes(r.stdout)} want ${showBytes(toBuf(e.stdout))}`);
  if (e.stdoutNonEmpty && r.stdout.length === 0) fails.push('stdout empty, want text');
  if (e.stderrNonEmpty && r.stderr.length === 0) fails.push('stderr empty, want a message');
  if (e.stderrIncludes !== undefined && !r.stderr.includes(Buffer.from(e.stderrIncludes))) fails.push(`stderr lacks ${JSON.stringify(e.stderrIncludes)}: ${showBytes(r.stderr)}`);
  if (e.received !== undefined) {
    const got = existsSync(r.files.record) ? readFileSync(r.files.record) : Buffer.alloc(0);
    if (!got.equals(toBuf(e.received))) fails.push(`server received ${showBytes(got)} want ${showBytes(toBuf(e.received))}`);
  }
  if (e.notStarted && existsSync(r.files.argsFile)) fails.push('child was started');
  if (e.args !== undefined) {
    const got = existsSync(r.files.argsFile) ? JSON.parse(readFileSync(r.files.argsFile, 'utf8')) : null;
    if (!sameJson(got, e.args)) fails.push(`child args ${short(got)} want ${short(e.args)}`);
  }
  if (e.term && !(existsSync(r.files.termFile) && readFileSync(r.files.termFile, 'utf8').includes(e.term))) fails.push(`child did not receive ${e.term}`);
  const traceFiles = existsSync(r.traceDir) && statSync(r.traceDir).isDirectory() ? readdirSync(r.traceDir) : [];
  if (e.noTrace) {
    if (c.outIsFile) { if (readFileSync(r.out, 'utf8') !== 'not a directory\n') fails.push('--out file was modified'); }
    else if (traceFiles.length) fails.push(`trace files created: ${traceFiles.join(', ')}`);
  }
  if (e.trace) fails.push(...checkTrace(c, r, e.trace, traceFiles));
  return fails;
}

function checkTrace(c, r, t, traceFiles) {
  const fails = [];
  if (traceFiles.length !== 1) return [`want exactly one trace file in ${r.traceDir}, found ${traceFiles.length}: ${traceFiles.join(', ')}`];
  const red = t.red ?? (() => {
    const a = c.tapeArgs;
    return { defaults: !a.includes('--no-redact-defaults'), user: a.flatMap((x, i) => (a[i - 1] === '--redact' ? [x] : [])) };
  })();
  const command = t.command ?? r.command.map((x) => O.redactArg(x, red));
  const labelGiven = c.tapeArgs.indexOf('--label');
  const label = t.label ?? (labelGiven >= 0 ? c.tapeArgs[labelGiven + 1] : O.deriveLabel(command));
  const name = traceFiles[0];
  const m = /^(\d{4})-(\d{2})-(\d{2})T(\d{2})-(\d{2})-(\d{2})-(\d{3})Z-(.*)\.jsonl$/.exec(name);
  if (!m) fails.push(`file name ${name} does not match <stamp>-<name>.jsonl`);
  else {
    const stamp = Date.parse(`${m[1]}-${m[2]}-${m[3]}T${m[4]}:${m[5]}:${m[6]}.${m[7]}Z`);
    if (!(stamp >= r.started - 2000 && stamp <= r.started + r.elapsed + 2000)) fails.push(`file stamp ${name} is not the start time`);
    if (m[8] !== O.fileName(label)) fails.push(`file name part ${JSON.stringify(m[8])} want ${JSON.stringify(O.fileName(label))}`);
  }
  const bytes = readFileSync(join(r.traceDir, name));
  let text;
  try { text = new TextDecoder('utf-8', { fatal: true }).decode(bytes); } catch { return [...fails, 'trace is not valid UTF-8']; }
  if (!text.endsWith('\n')) fails.push('trace does not end with LF');
  const lines = text.split('\n'); if (lines[lines.length - 1] === '') lines.pop();
  const objs = [];
  for (const [i, l] of lines.entries()) {
    try { const o = JSON.parse(l); if (o === null || typeof o !== 'object' || Array.isArray(o)) throw 0; objs.push(o); }
    catch { return [...fails, `trace line ${i + 1} is not a JSON object: ${short(l)}`]; }
  }
  if (objs.length < 2) return [...fails, `trace has ${objs.length} lines`];
  const meta = objs[0], end = objs[objs.length - 1], msgs = objs.slice(1, -1);
  if (meta.v !== 1 || meta.type !== 'meta') fails.push(`first line is not meta: ${short(meta)}`);
  if (!ISO.test(meta.startedAt ?? '')) fails.push(`meta.startedAt ${meta.startedAt}`);
  if (meta.label !== label) fails.push(`meta.label ${JSON.stringify(meta.label)} want ${JSON.stringify(label)}`);
  if (!sameJson(meta.command, command)) fails.push(`meta.command ${short(meta.command)} want ${short(command)}`);
  if (end.type !== 'end') fails.push(`last line is not end: ${short(end)}`);
  else {
    if (!ISO.test(end.t ?? '')) fails.push(`end.t ${end.t}`);
    let wantCode = t.exitCode;
    if (c.server.exitSignal && !WIN) wantCode = 128 + osConstants.signals[c.server.exitSignal];
    if (c.id === 'signal-forwarded-child-dies' && !WIN) wantCode = 128 + osConstants.signals.SIGTERM;
    if (end.exitCode !== wantCode) fails.push(`end.exitCode ${end.exitCode} want ${wantCode}`);
    if (!Number.isInteger(end.durationMs) || end.durationMs < 0) fails.push(`end.durationMs ${end.durationMs}`);
    else if (Math.abs(end.durationMs - (Date.parse(end.t) - Date.parse(meta.startedAt))) > 5) fails.push(`end.durationMs ${end.durationMs} is not end.t - startedAt`);
  }
  if (objs.filter((o) => o.type === 'meta').length !== 1 || objs.filter((o) => o.type === 'end').length !== 1) fails.push('want exactly one meta and one end line');
  const got = { in: [], out: [] };
  for (const mline of msgs) {
    if (!ISO.test(mline.t ?? '') || !['in', 'out'].includes(mline.dir) || !('raw' in mline)) { fails.push(`bad message line ${short(mline)}`); continue; }
    got[mline.dir].push(mline.raw);
  }
  for (const d of ['in', 'out']) {
    if (t[d] === undefined) continue;
    if (got[d].length !== t[d].length) { fails.push(`${d}: ${got[d].length} messages logged, want ${t[d].length}: got ${short(got[d])}`); continue; }
    for (let i = 0; i < t[d].length; i++) {
      if (!sameJson(got[d][i], t[d][i])) { fails.push(`${d}[${i}] raw ${short(got[d][i])}\n        want ${short(t[d][i])}`); break; }
    }
  }
  return fails;
}

function staticCheck(test) {
  if (!regen) return `REGEN.json unreadable: ${regenErr}`;
  const words = pick(regen.driver).split(' ');
  if (test === 'regen') {
    for (const k of ['lang', 'build', 'test', 'driver']) if (!(k in regen)) return `REGEN.json lacks ${k}`;
    if (!['ts', 'py'].includes(regen.lang)) return `lang ${regen.lang}`;
    for (const k of ['build', 'test', 'driver']) {
      const v = regen[k];
      if (typeof v !== 'string' && !(v && typeof v === 'object' && typeof v.default === 'string')) return `${k} must be a string or an object with "default"`;
    }
    for (const v of [regen.driver, ...(typeof regen.driver === 'object' ? Object.values(regen.driver) : [])])
      if (typeof v === 'string' && /["'|<>&;]|\.cmd\b|\bnpx\b/.test(v)) return `driver is not plain words: ${v}`;
    return null;
  }
  if (test === 'runtime') {
    if (regen.lang === 'ts') return pick(regen.build).trim() ? 'ts must run by type stripping (no build step)' : words[0] === 'node' ? null : `ts driver starts with ${words[0]}`;
    return ['py', 'python', 'python3'].includes(words[0]) ? null : `py driver starts with ${words[0]}`;
  }
  const files = [];
  const walk = (d, rel = '') => {
    for (const n of readdirSync(d)) {
      if (['node_modules', '.git', 'bin', '__pycache__', 'mcp-traces'].includes(n)) continue;
      const p = join(d, n), r = rel ? `${rel}/${n}` : n;
      if (statSync(p).isDirectory()) walk(p, r); else files.push(r);
    }
  };
  walk(IMPL);
  const exts = regen.lang === 'ts' ? ['.ts', '.mts', '.mjs', '.js'] : ['.py'];
  const isTest = (r) => /(^|\/)(test|tests)\//.test(r) || /\.test\./.test(basename(r)) || /_test\./.test(basename(r)) || /^test_.*\.py$/.test(basename(r));
  const src = files.filter((r) => exts.includes(extname(r)) && !isTest(r));
  if (test === 'loc') {
    const n = src.reduce((s, r) => s + readFileSync(join(IMPL, r), 'utf8').split(/\r?\n/).filter((l) => l.trim()).length, 0);
    return n <= 450 ? null : `${n} non-blank source lines > 450`;
  }
  if (test === 'deps') {
    if (existsSync(join(IMPL, 'node_modules'))) return 'node_modules present';
    if (existsSync(join(IMPL, 'package.json'))) {
      const p = JSON.parse(readFileSync(join(IMPL, 'package.json'), 'utf8'));
      for (const k of ['dependencies', 'devDependencies', 'optionalDependencies', 'peerDependencies']) if (p[k] && Object.keys(p[k]).length) return `package.json has ${k}`;
    }
    if (regen.lang === 'ts') {
      for (const r of files.filter((f) => exts.includes(extname(f)))) {
        const t = readFileSync(join(IMPL, r), 'utf8');
        for (const m of t.matchAll(/(?:from\s+|import\s*\(\s*|require\s*\(\s*)['"]([^'"]+)['"]/g)) if (!/^(\.|node:)/.test(m[1])) return `${r} imports ${m[1]}`;
      }
      return null;
    }
    const py = `import ast,sys,os\nloc={os.path.splitext(f)[0] for r,_,fs in os.walk('.') for f in fs if f.endswith('.py')}|{d for d in os.listdir('.') if os.path.isdir(d)}\nbad=set()\nfor r,_,fs in os.walk('.'):\n  for f in fs:\n    if f.endswith('.py'):\n      t=ast.parse(open(os.path.join(r,f),encoding='utf-8').read())\n      for n in ast.walk(t):\n        ms=[a.name for a in n.names] if isinstance(n,ast.Import) else ([n.module] if isinstance(n,ast.ImportFrom) and n.module and n.level==0 else [])\n        for m in ms:\n          top=m.split('.')[0]\n          if top not in sys.stdlib_module_names and top not in loc: bad.add(top)\nprint(','.join(sorted(bad)))`;
    const r = spawnSync(words[0], [...words.slice(1, -1), '-c', py], { cwd: IMPL, encoding: 'utf8' });
    if (r.status !== 0) return `import scan failed: ${(r.stderr ?? '').slice(-200)}`;
    return r.stdout.trim() ? `non-stdlib imports: ${r.stdout.trim()}` : null;
  }
  return `unknown static test ${test}`;
}

// ---------- main
const results = [];
const queue = [];
for (const c of cases) {
  if (AS_REFERENCE && c.na?.includes('reference')) { results.push({ id: c.id, reqs: c.reqs, status: 'n/a' }); continue; }
  if ((c.platform === 'posix' && WIN) || (c.platform === 'win32' && !WIN)) { results.push({ id: c.id, reqs: c.reqs, status: 'skipped', why: `${c.platform} only` }); continue; }
  if (c.static) { const why = staticCheck(c.static); results.push({ id: c.id, reqs: c.reqs, status: why ? 'fail' : 'pass', why: why ?? undefined }); continue; }
  queue.push(c);
}
async function worker() {
  while (queue.length) {
    const c = queue.shift();
    let why;
    if (!regen) why = [`REGEN.json unreadable: ${regenErr}`];
    else if (buildFailed) why = [buildFailed];
    else {
      const r = await runCase(c);
      why = check(c, r);
      if (!why.length) rmSync(r.tmp, { recursive: true, force: true });
      else why.push(`(case dir ${r.tmp}; stderr: ${showBytes(r.stderr)})`);
    }
    results.push({ id: c.id, reqs: c.reqs, status: why.length ? 'fail' : 'pass', why: why.length ? why.join('\n      ') : undefined });
  }
}
await Promise.all(Array.from({ length: 4 }, worker));
results.sort((a, b) => cases.findIndex((c) => c.id === a.id) - cases.findIndex((c) => c.id === b.id));

const counted = results.filter((r) => r.status === 'pass' || r.status === 'fail');
const passed = counted.filter((r) => r.status === 'pass').length;
const skipped = results.filter((r) => r.status === 'skipped').length;
const na = results.filter((r) => r.status === 'n/a').length;
const failing = counted.filter((r) => r.status === 'fail');
console.log(`passed ${passed}/${counted.length} (advisory 0/0, skipped ${skipped}, n/a ${na})`);
for (const f of failing) console.log(`  FAIL ${f.id} [${f.reqs.join(', ')}]\n      ${f.why}`);
if (JSON_OUT) writeFileSync(JSON_OUT, JSON.stringify({ passed, total: counted.length, advisory: '0/0', skipped, na,
  failing: failing.map((f) => ({ case: f.id, reqs: f.reqs, why: f.why })), results }, null, 1));
process.exit(failing.length ? 1 : 0);
