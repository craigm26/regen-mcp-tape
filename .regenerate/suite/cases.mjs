// The suite's cases. Each case runs `tape` once:
//   { id, reqs, platform?: 'posix'|'win32', na?: ['reference'],
//     tapeArgs: [...]                 tape options before the command (the runner adds --out <dir> unless noOut)
//     command?: [...]                 default: ['node', FAKE, <config>] + extraArgs
//     extraArgs?: [...], server: {...fake config...}, labelArg?: string,
//     stdin: [{text|b64, delayMs}], keepStdinOpen?: bool, signal?: {name, afterStdout: bytes},
//     expect: { exit, stdout (text|b64), received (text|b64), stderrIncludes, noTrace, notStarted,
//               trace: { label, command, in: [...], out: [...], exitCode }, args, term } }
// Expected trace content is computed with the oracle from the bytes the case sends.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import * as O from './oracle.mjs';

export const FAKE = join(import.meta.dirname, 'servers', 'fake.mjs');
export const CONFIG_NAME = 'srv.json'; // the config file's name; the derived default label is "srv-json"

const j = (o) => JSON.stringify(o);
const req = (id, method, params) => j({ jsonrpc: '2.0', id, method, ...(params === undefined ? {} : { params }) });
const exitReq = req(99, 'test/exit');
const reply = (id, method) => j({ jsonrpc: '2.0', id, result: { method } });
const parseLines = (text) => text.split('\n').map((l) => l.replace(/\r$/, '')).filter((l) => l.trim()).flatMap((l) => {
  try { return [JSON.parse(l)]; } catch { return []; }
});
// Expected logged messages for a byte string sent in one direction (REQ-TR-007/008).
const logged = (text, red = {}) => {
  const out = [];
  for (const line of text.split('\n')) {
    if (/^[ \t\r]*$/.test(line)) continue;
    try { out.push(O.redact(JSON.parse(line), red)); } catch { /* not JSON */ }
  }
  return out;
};

// SPEC.md's example tables must agree with the oracle (checked when the suite loads).
export function checkSpecExamples() {
  const spec = readFileSync(join(import.meta.dirname, '..', 'SPEC.md'), 'utf8');
  const bad = [];
  let n = 0;
  const sec = (a, b) => spec.slice(spec.indexOf(a), spec.indexOf(b, spec.indexOf(a)));
  for (const m of sec('| input string | after step 2 |', '### 6.3').matchAll(/^\| `([^`]*)`(?: \+ CR \+ LF \+ `([^`]*)`)? \| `([^`]*)`(?: \+ CR \+ LF \+ `([^`]*)`)?/gm)) {
    const input = m[2] !== undefined ? `${m[1]}\r\n${m[2]}` : m[1];
    const want = m[4] !== undefined ? `${m[3]}\r\n${m[4]}` : m[3];
    n++;
    if (O.redact(input) !== want) bad.push(`redaction example ${JSON.stringify(input)}: spec ${JSON.stringify(want)}, oracle ${JSON.stringify(O.redact(input))}`);
  }
  for (const m of sec('| command | label |', '## 6.').matchAll(/^\| `([^`]*)` \| `([^`]*)` \|/gm)) {
    const args = [...m[1].matchAll(/"([^"]*)"|(\S+)/g)].map((x) => x[1] ?? x[2]);
    n++;
    if (O.deriveLabel(args) !== m[2]) bad.push(`label example ${m[1]}: spec ${m[2]}, oracle ${O.deriveLabel(args)}`);
  }
  for (const m of spec.matchAll(/`(\{"[^`]*\})` ⟶ (unchanged|`(\{[^`]*\})`)/g)) {
    n++;
    const input = JSON.parse(m[1]);
    const want = m[2] === 'unchanged' ? input : JSON.parse(m[3]);
    if (j(O.redact(input)) !== j(want)) bad.push(`key example ${m[1]}: oracle ${j(O.redact(input))}`);
  }
  for (const m of sec('Patterns 10 and 11, in words', '### 6.3').matchAll(/`([^`]+)` becomes `([^`]+)`|`([^`]+)` is unchanged/g)) {
    n++;
    const input = m[1] ?? m[3], want = m[2] ?? m[3];
    if (O.redact(input) !== want) bad.push(`word-rule example ${input}: spec ${want}, oracle ${O.redact(input)}`);
  }
  O.selfTestWordRules(3000);
  if (n < 22) bad.push(`only ${n} examples found; the example patterns no longer match SPEC.md`);
  if (bad.length) throw new Error('SPEC.md examples disagree with the oracle:\n  ' + bad.join('\n  '));
  return n;
}

export function buildCases() {
  checkSpecExamples();
  const cases = [];
  // Cases not about labels pass an explicit --label, so a label difference cannot mask what
  // the case is testing. Label cases set `derive: true` (or pass their own --label).
  const add = (c) => {
    const tapeArgs = c.tapeArgs ?? [];
    const own = c.derive || tapeArgs.includes('--label') || c.command?.length === 0 || c.id.startsWith('cli-') && !c.expect?.trace;
    cases.push({ stdin: [], server: {}, ...c, tapeArgs: own ? tapeArgs : ['--label', 'case', ...tapeArgs] });
  };

  // A standard session: client sends `input` then test/exit; server replies to requests and exits.
  const session = (id, reqs, input, more = {}) => {
    const text = input + exitReq + '\n';
    const outText = (more.server?.stdout ?? []).map((x) => x.text ?? '').join('');
    const replies = parseLines(text).filter((m) => m && typeof m === 'object' && !Array.isArray(m) && 'id' in m && 'method' in m)
      .map((m) => reply(m.id, m.method) + '\n').join('');
    const red = more.red ?? {};
    add({
      id, reqs, stdin: [{ text }],
      server: { respond: true, ...(more.server ?? {}) },
      tapeArgs: more.tapeArgs ?? [],
      ...more.extra,
      expect: {
        exit: more.server?.exitCode ?? 0, received: text, stdout: outText + replies,
        trace: { in: logged(text, red), out: logged(outText + replies, red), exitCode: more.server?.exitCode ?? 0, red },
        ...(more.expect ?? {}),
      },
    });
  };

  // ---------- forwarding and logging basics
  session('fw-basic-session', ['REQ-FW-001', 'REQ-FW-002', 'REQ-TR-002', 'REQ-TR-003', 'REQ-TR-004', 'REQ-TR-005', 'REQ-EX-001'],
    req(1, 'initialize', { protocolVersion: '2025-06-18' }) + '\n' + req(2, 'tools/list') + '\n' + j({ jsonrpc: '2.0', method: 'notifications/initialized' }) + '\n');
  session('fw-non-json-and-blank', ['REQ-FW-001', 'REQ-TR-007'],
    'hello there\n\n  \t\r\n' + req(1, 'ping') + '\n{not json\n');
  session('fw-crlf-in', ['REQ-FW-001', 'REQ-TR-007'], req(1, 'ping') + '\r\n' + req(2, 'ping') + '\r\n');
  session('fw-scalars-and-batch', ['REQ-TR-007'],
    '42\n"just a string"\nnull\ntrue\n[' + req(5, 'a') + ',' + req(6, 'b', { token: 'x' }) + ']\n');
  session('fw-numbers-survive', ['REQ-TR-010'], j({ jsonrpc: '2.0', method: 'n' }).slice(0, -1) + ',"params":{"a":1.0,"b":1e2,"c":-0.5,"d":12345678901234567890,"e":2.5E-3}}\n');
  session('fw-order-within-direction', ['REQ-TR-009'], Array.from({ length: 40 }, (_, i) => req(i + 1, `m${i}`) + '\n').join(''));
  session('fw-server-output-plan', ['REQ-FW-001', 'REQ-TR-007'], req(1, 'ping') + '\n', {
    server: { stdout: [{ text: j({ jsonrpc: '2.0', method: 'notifications/hello' }) + '\r\n' }, { text: 'log: not json\n' }, { text: '\n\n' }, { text: '7\n' }] },
  });
  session('fw-big-message-out', ['REQ-FW-001', 'REQ-TR-007'], req(1, 'ping') + '\n', {
    server: { stdout: [{ bigBytes: 2_000_000 }] },
  });
  {
    const big = j({ jsonrpc: '2.0', id: 1, method: 'big', params: { s: 'y'.repeat(1_000_000) } }) + '\n';
    session('fw-big-message-in', ['REQ-FW-001', 'REQ-TR-007'], big);
  }
  // patch the big-out case: expected stdout/out-log for bigBytes entries
  for (const c of cases.filter((x) => x.id === 'fw-big-message-out')) {
    const head = '{"jsonrpc":"2.0","method":"big","params":{"s":"', tail = '"}}\n';
    const bigLine = head + 'x'.repeat(2_000_000 - head.length - tail.length) + tail;
    c.expect.stdout = bigLine + reply(1, 'ping') + '\n' + reply(99, 'test/exit') + '\n';
    c.expect.trace.out = logged(c.expect.stdout);
  }
  {
    // REQ-RD-006: 2 MB of base64-like text with no white space, in each direction.
    let seed = 7;
    const b64 = Array.from({ length: 1_500_000 }, () => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed & 255; });
    const blob = Buffer.from(b64).toString('base64');
    const inMsg = j({ jsonrpc: '2.0', id: 1, method: 'resources/write', params: { blob } }) + '\n';
    session('rd-large-blob-in', ['REQ-RD-006', 'REQ-FW-001'], inMsg);
    const outMsg = j({ jsonrpc: '2.0', method: 'notifications/resource', params: { blob: blob.split('').reverse().join('') } }) + '\n';
    session('rd-large-blob-out', ['REQ-RD-006', 'REQ-FW-001'], req(1, 'ping') + '\n', { server: { stdout: [{ text: outMsg }] } });
  }
  session('fw-stderr-passthrough', ['REQ-FW-003'], req(1, 'ping') + '\n', {
    server: { stderr: 'SERVER-STDERR-LINE-7f3a\nsecond line\n' },
    expect: { stderrIncludes: 'SERVER-STDERR-LINE-7f3a\nsecond line\n' },
  });
  session('fw-invalid-utf8-forwarded', ['REQ-FW-001'], '', {
    extra: { stdin: [{ b64: Buffer.concat([Buffer.from('raw \xff\xfe bytes\n', 'latin1'), Buffer.from(exitReq + '\n')]).toString('base64') }] },
  });
  for (const c of cases.filter((x) => x.id === 'fw-invalid-utf8-forwarded')) {
    const b = Buffer.from(c.stdin[0].b64, 'base64');
    c.expect.received = { b64: b.toString('base64') };
    c.expect.trace = { ...c.expect.trace, in: [JSON.parse(exitReq)] };
  }

  // ---------- UTF-8 split across writes (REQ-TR-007 step 1)
  {
    const msg = j({ jsonrpc: '2.0', method: 'note', params: { text: 'héllo €uro 😀 done' } }) + '\n';
    const bytes = Buffer.from(msg, 'utf8');
    const cut = bytes.indexOf(Buffer.from('€', 'utf8')) + 1; // inside the 3-byte €
    const cut2 = bytes.indexOf(Buffer.from('😀', 'utf8')) + 2; // inside the 4-byte emoji
    session('utf8-split-out', ['REQ-TR-007', 'REQ-FW-001'], req(1, 'ping') + '\n', {
      server: { stdout: [{ b64: bytes.subarray(0, cut).toString('base64') }, { b64: bytes.subarray(cut, cut2).toString('base64'), delayMs: 150 }, { b64: bytes.subarray(cut2).toString('base64'), delayMs: 150 }] },
    });
    for (const c of cases.filter((x) => x.id === 'utf8-split-out')) {
      c.expect.stdout = msg + reply(1, 'ping') + '\n' + reply(99, 'test/exit') + '\n';
      c.expect.trace.out = logged(c.expect.stdout);
    }
    const text = msg + exitReq + '\n';
    const tb = Buffer.from(text, 'utf8');
    add({
      id: 'utf8-split-in', reqs: ['REQ-TR-007', 'REQ-FW-001'],
      stdin: [{ b64: tb.subarray(0, cut).toString('base64') }, { b64: tb.subarray(cut, cut2).toString('base64'), delayMs: 150 }, { b64: tb.subarray(cut2).toString('base64'), delayMs: 150 }],
      server: { respond: true },
      expect: { exit: 0, received: text, stdout: reply(99, 'test/exit') + '\n', trace: { in: logged(text), out: [JSON.parse(reply(99, 'test/exit'))], exitCode: 0 } },
    });
  }

  // ---------- final line without LF (REQ-TR-008)
  {
    const last = j({ jsonrpc: '2.0', method: 'notifications/last' });
    session('eof-unterminated-out-line', ['REQ-TR-008', 'REQ-FW-001'], '', {
      server: { respond: false, then: 'exit', stdout: [{ text: j({ jsonrpc: '2.0', method: 'first' }) + '\n' + last }] },
    });
    for (const c of cases.filter((x) => x.id === 'eof-unterminated-out-line')) {
      c.stdin = []; c.expect.received = ''; c.expect.stdout = j({ jsonrpc: '2.0', method: 'first' }) + '\n' + last;
      c.expect.trace = { in: [], out: [{ jsonrpc: '2.0', method: 'first' }, JSON.parse(last)], exitCode: 0 };
    }
    const partial = '{"jsonrpc":"2.0","id":1,"res';
    add({
      id: 'eof-partial-line-out', reqs: ['REQ-TR-008', 'REQ-FW-001'], server: { then: 'exit', stdout: [{ text: partial }] },
      expect: { exit: 0, stdout: partial, trace: { in: [], out: [], exitCode: 0 } },
    });
    const text = req(1, 'ping') + '\n' + last;
    add({
      id: 'eof-unterminated-in-line', reqs: ['REQ-TR-008', 'REQ-FW-004'], stdin: [{ text }], server: { respond: true, then: 'eof' },
      expect: { exit: 0, received: text, stdout: reply(1, 'ping') + '\n', trace: { in: [JSON.parse(req(1, 'ping')), JSON.parse(last)], out: [JSON.parse(reply(1, 'ping'))], exitCode: 0 } },
    });
  }

  // ---------- end of input and child exit (REQ-FW-004, REQ-FW-005)
  {
    const text = req(1, 'ping') + '\n' + req(2, 'tools/list') + '\n';
    add({
      id: 'eof-propagates-to-child', reqs: ['REQ-FW-004'], stdin: [{ text }], server: { respond: true, then: 'eof', exitCode: 0 },
      expect: { exit: 0, received: text, stdout: reply(1, 'ping') + '\n' + reply(2, 'tools/list') + '\n', trace: { in: logged(text), out: logged(reply(1, 'ping') + '\n' + reply(2, 'tools/list') + '\n'), exitCode: 0 } },
    });
    add({
      id: 'eof-empty-input', reqs: ['REQ-FW-004', 'REQ-TR-002'], stdin: [], server: { then: 'eof', exitCode: 4 },
      expect: { exit: 4, received: '', stdout: '', trace: { in: [], out: [], exitCode: 4 } },
    });
    const t2 = req(1, 'ping') + '\n' + exitReq + '\n';
    add({
      id: 'child-exit-with-stdin-open', reqs: ['REQ-FW-005', 'REQ-EX-001'], stdin: [{ text: t2 }], keepStdinOpen: true, server: { respond: true, exitCode: 5 },
      expect: { exit: 5, received: t2, stdout: reply(1, 'ping') + '\n' + reply(99, 'test/exit') + '\n', trace: { in: logged(t2), out: logged(reply(1, 'ping') + '\n' + reply(99, 'test/exit') + '\n'), exitCode: 5 } },
    });
    add({
      id: 'child-exits-immediately-stdin-open', reqs: ['REQ-FW-005', 'REQ-EX-001'], keepStdinOpen: true,
      server: { then: 'exit', exitCode: 3, stdout: [{ text: j({ jsonrpc: '2.0', method: 'bye' }) + '\n' }] },
      expect: { exit: 3, stdout: j({ jsonrpc: '2.0', method: 'bye' }) + '\n', trace: { in: [], out: [{ jsonrpc: '2.0', method: 'bye' }], exitCode: 3 } },
    });
  }

  // ---------- exit status (REQ-EX-*)
  for (const code of [0, 1, 42, 255]) {
    session(`exit-code-${code}`, ['REQ-EX-001', 'REQ-TR-005'], req(1, 'ping') + '\n', { server: { exitCode: code } });
  }
  for (const [sig, num] of [['SIGTERM', 15], ['SIGKILL', 9], ['SIGUSR1', 10], ['SIGHUP', 1]]) {
    add({
      id: `exit-child-signal-${sig}`, reqs: ['REQ-EX-002', 'REQ-TR-005'], platform: 'posix', linuxNumbers: true,
      stdin: [{ text: exitReq + '\n' }], server: { respond: true, exitSignal: sig },
      expect: { exit: 128 + num, received: exitReq + '\n', stdout: reply(99, 'test/exit') + '\n', trace: { in: [JSON.parse(exitReq)], out: [JSON.parse(reply(99, 'test/exit'))], exitCode: 128 + num } },
    });
  }
  for (const sig of ['SIGTERM', 'SIGINT']) {
    add({
      id: `signal-forwarded-${sig}`, reqs: ['REQ-EX-003'], platform: 'posix',
      stdin: [], server: { termFile: true, stdout: [{ text: j({ jsonrpc: '2.0', method: 'ready' }) + '\n' }] },
      signal: { name: sig, afterStdout: 1 },
      expect: { exit: 0, term: sig, stdout: j({ jsonrpc: '2.0', method: 'ready' }) + '\n', trace: { in: [], out: [{ jsonrpc: '2.0', method: 'ready' }], exitCode: 0 } },
    });
  }
  add({
    id: 'signal-forwarded-child-dies', reqs: ['REQ-EX-003', 'REQ-EX-002'], platform: 'posix', linuxNumbers: true,
    stdin: [], server: { then: 'hold', stdout: [{ text: j({ jsonrpc: '2.0', method: 'ready' }) + '\n' }] },
    signal: { name: 'SIGTERM', afterStdout: 1 },
    expect: { exit: 143, stdout: j({ jsonrpc: '2.0', method: 'ready' }) + '\n', trace: { in: [], out: [{ jsonrpc: '2.0', method: 'ready' }], exitCode: 143 } },
  });
  add({
    id: 'exit-command-not-found', reqs: ['REQ-EX-004', 'REQ-TR-002'], command: ['no-such-program-7d1f2e'], tapeArgs: ['--label', 'nf'],
    expect: { exit: 127, stdout: '', trace: { label: 'nf', command: ['no-such-program-7d1f2e'], in: [], out: [], exitCode: 127 } },
  });
  add({
    id: 'exit-out-is-a-file', reqs: ['REQ-EX-005'], outIsFile: true, server: { respond: true },
    stdin: [{ text: exitReq + '\n' }], expect: { exit: 1, stdout: '', notStarted: true, noTrace: true },
  });

  // ---------- CLI (REQ-CLI-*)
  for (const [id, args] of [['cli-help', ['--help']], ['cli-help-short', ['-h']], ['cli-version', ['--version']], ['cli-version-short', ['-v']], ['cli-help-wins', ['--version', '--help']]]) {
    add({ id, reqs: ['REQ-CLI-001', 'REQ-CLI-003'], tapeArgs: args, server: { respond: true }, expect: { exit: 0, stdoutNonEmpty: true, notStarted: true, noTrace: true } });
  }
  add({ id: 'cli-help-with-command', reqs: ['REQ-CLI-003'], tapeArgs: ['--help'], server: { respond: true }, stdin: [{ text: exitReq + '\n' }], expect: { exit: 0, stdoutNonEmpty: true, notStarted: true, noTrace: true } });
  for (const [id, args, command] of [
    ['cli-unknown-option', ['--frobulate'], undefined],
    ['cli-missing-value', ['--label'], []],
    ['cli-no-command', [], []],
    ['cli-bad-redact-regex', ['--redact', '(['], undefined],
  ]) {
    add({ id, reqs: ['REQ-CLI-004'], tapeArgs: args, ...(command ? { command } : {}), server: { respond: true }, stdin: [{ text: exitReq + '\n' }],
      expect: { exit: 2, stdout: '', stderrNonEmpty: true, notStarted: true, noTrace: true } });
  }
  {
    const text = req(1, 'ping') + '\n' + exitReq + '\n';
    add({
      id: 'cli-command-without-separator', reqs: ['REQ-CLI-002', 'REQ-CLI-001'], noSeparator: true, tapeArgs: ['--label', 'nosep'], extraArgs: ['--out', 'not-for-tape', '--label', 'x'],
      stdin: [{ text }], server: { respond: true },
      expect: { exit: 0, received: text, args: ['--out', 'not-for-tape', '--label', 'x'], trace: { label: 'nosep', in: logged(text), out: logged(reply(1, 'ping') + '\n' + reply(99, 'test/exit') + '\n'), exitCode: 0 } },
    });
    add({
      id: 'cli-value-looks-like-option', reqs: ['REQ-CLI-001'], tapeArgs: ['--label', '--weird'], stdin: [{ text }], server: { respond: true },
      expect: { exit: 0, trace: { label: '--weird', in: logged(text), out: logged(reply(1, 'ping') + '\n' + reply(99, 'test/exit') + '\n'), exitCode: 0 } },
    });
    add({
      id: 'cli-default-out-dir', reqs: ['REQ-TR-001', 'REQ-CLI-001'], noOut: true, stdin: [{ text }], server: { respond: true },
      expect: { exit: 0, trace: { in: logged(text), out: logged(reply(1, 'ping') + '\n' + reply(99, 'test/exit') + '\n'), exitCode: 0 } },
    });
    add({
      id: 'cli-out-created-with-parents', reqs: ['REQ-TR-001'], outSubdir: 'a/b/c', stdin: [{ text }], server: { respond: true },
      expect: { exit: 0, trace: { in: logged(text), out: logged(reply(1, 'ping') + '\n' + reply(99, 'test/exit') + '\n'), exitCode: 0 } },
    });
  }

  // ---------- labels and file names (REQ-LB-001, REQ-TR-001)
  {
    const text = exitReq + '\n';
    const basic = (id, reqs, opts) => add({
      id, reqs, stdin: [{ text }], server: { respond: true }, derive: id.startsWith('label-derived'), ...opts,
      expect: { exit: 0, ...(opts.expect ?? {}), trace: { in: logged(text), out: [JSON.parse(reply(99, 'test/exit'))], exitCode: 0, ...(opts.expect?.trace ?? {}) } },
    });
    basic('label-derived-config-name', ['REQ-LB-001'], { expect: { trace: { label: 'srv-json' } } });
    basic('label-derived-last-arg', ['REQ-LB-001'], { extraArgs: ['--port', '3000'], expect: { trace: { label: '3000' } } });
    basic('label-derived-backslash', ['REQ-LB-001'], { extraArgs: ['C:\\srv\\Files.MJS'], expect: { trace: { label: 'files-mjs' } } });
    basic('label-derived-skips-whitespace', ['REQ-LB-001', 'REQ-PL-002'], { extraArgs: ['https://example.test/svc', '--header', 'X-Key: abc'], expect: { trace: { label: 'svc' } } });
    basic('label-derived-truncated', ['REQ-LB-001'], { extraArgs: ['Q'.repeat(50)], expect: { trace: { label: 'q'.repeat(32) } } });
    basic('label-derived-redacted-secret', ['REQ-LB-001', 'REQ-RD-005'], { extraArgs: ['ghp_' + 'A'.repeat(36)], expect: { trace: { label: '-redacted-' } } });
    basic('label-given-verbatim', ['REQ-LB-001', 'REQ-TR-001', 'REQ-TR-003'], { tapeArgs: ['--label', 'my server/v2'], expect: { trace: { label: 'my server/v2' } } });
    basic('label-given-long', ['REQ-TR-001'], { tapeArgs: ['--label', 'L'.repeat(100)], expect: { trace: { label: 'L'.repeat(100) } } });
    basic('label-given-empty-name', ['REQ-TR-001'], { tapeArgs: ['--label', ''], expect: { trace: { label: '' } } });
    basic('command-redacted-in-meta', ['REQ-RD-005', 'REQ-TR-003'], { tapeArgs: ['--label', 'cm'], extraArgs: ['--key=sk-' + 'b'.repeat(24), 'postgres://u:pw@h/db'], expect: { trace: { label: 'cm' } } });
    basic('command-not-redacted-without-defaults', ['REQ-RD-005'], { tapeArgs: ['--label', 'cm2', '--no-redact-defaults', '--redact', 'pw'], extraArgs: ['--key=sk-' + 'b'.repeat(24), 'postgres://u:pw@h/db'], expect: { trace: { label: 'cm2' } } });
  }

  // ---------- redaction (REQ-RD-*)
  {
    const r = (id, reqs, msgs, opts = {}) => {
      const tapeArgs = opts.tapeArgs ?? [];
      const red = { defaults: !tapeArgs.includes('--no-redact-defaults'), user: tapeArgs.flatMap((a, i) => (tapeArgs[i - 1] === '--redact' ? [a] : [])) };
      session(id, reqs, msgs.map((m) => j(m) + '\n').join(''), { tapeArgs, red, server: opts.server });
    };
    r('rd-exact-keys-any-type', ['REQ-RD-001'], [
      { jsonrpc: '2.0', id: 1, method: 'x', params: { password: 42, token: { a: 1 }, secret: null, apiKey: true, pwd: [1, 2], Authorization: 'Basic abc', nested: [{ private_key: 'k' }] } },
    ]);
    r('rd-exact-keys-case-sensitive', ['REQ-RD-001', 'REQ-RD-003'], [{ jsonrpc: '2.0', id: 1, method: 'x', params: { TOKEN: 7, Secret: 8, APIKEY: 9 } }]);
    r('rd-string-patterns', ['REQ-RD-002'], [{
      jsonrpc: '2.0', id: 1, method: 'tools/call', params: { arguments: {
        a: 'try AKIAIOSFODNN7EXAMPLE today', b: 'k=sk-' + 'Z'.repeat(30) + ' end', c: 'gh token gho_' + '9'.repeat(40),
        d: 'jwt eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxIn0.c2ln here', e: 'Authorization: Basic Zm9vOmJhcg== trailing',
        f: 'use Bearer abc.DEF-ghi/+= now', g: 'slack xoxb-1234567890-abc', h: 'stripe rk_live_ABCDEFGH12', i: 'postgres://admin:hunter2@db:5432/x and https://u:p@h',
        k: 'load /home/u/.env.local now', l: 'key ~/.ssh/id_ed25519.pub here', m: ['nested AKIAIOSFODNN7EXAMPLE'], n: 123,
      } },
    }]);
    r('rd-string-pattern-meanings', ['REQ-RD-002'], [{
      jsonrpc: '2.0', id: 1, method: 'x', params: {
        crlf: 'Authorization: x\r\nnext', ls: 'Authorization: y\u2028next', nbsp: 'Bearer\u00a0tok123 after', uni: 'éAKIAIOSFODNN7EXAMPLE', uni2: 'xAKIAIOSFODNN7EXAMPLE',
        url: 'svc://' + 'u'.repeat(128) + ':pw@h and svc://' + 'u'.repeat(129) + ':pw@h',
      },
    }]);
    r('rd-keys-not-touched', ['REQ-RD-002'], [{ jsonrpc: '2.0', id: 1, method: 'x', params: { AKIAIOSFODNN7EXAMPLE: 'v', 'Bearer abc': 1 } }]);
    r('rd-key-substrings', ['REQ-RD-003'], [{
      jsonrpc: '2.0', id: 1, method: 'x', params: { db_password: 'x', max_tokens: 100, progressToken: 'abc', tokens: [1, 2], client_secret: { a: 1 },
        user_pwd: 'kept', 'my-pwd': 'gone', bearer: 'b', bearerish: 'kept', X_API_KEY: false, accessKey: 'gone', ok: { inner_token: 'gone', fine: 'AKIAIOSFODNN7EXAMPLE' } },
    }]);
    r('rd-in-and-out', ['REQ-RD-001', 'REQ-RD-002'], [{ jsonrpc: '2.0', id: 1, method: 'x', params: { token: 'in-secret' } }], {
      server: { stdout: [{ text: j({ jsonrpc: '2.0', method: 'notify', params: { password: 'out-secret', note: 'AKIAIOSFODNN7EXAMPLE' } }) + '\n' }] },
    });
    r('rd-user-patterns', ['REQ-RD-004', 'REQ-CLI-001'], [{ jsonrpc: '2.0', id: 1, method: 'x', params: { a: 'MYCO-1234 and MYCO-99', b: 'abcabc' } }], { tapeArgs: ['--redact', 'MYCO-[0-9]+', '--redact', '(abc){2}'] });
    r('rd-no-defaults', ['REQ-RD-004', 'REQ-CLI-001'], [{ jsonrpc: '2.0', id: 1, method: 'x', params: { password: 'p', a: 'AKIAIOSFODNN7EXAMPLE', b: 'CUSTOM-1' } }], { tapeArgs: ['--no-redact-defaults', '--redact', 'CUSTOM-[0-9]+'] });
    r('rd-forwarded-unchanged', ['REQ-FW-001', 'REQ-RD-001'], [{ jsonrpc: '2.0', id: 1, method: 'x', params: { password: 'hunter2', s: 'AKIAIOSFODNN7EXAMPLE' } }]);
  }

  // ---------- platforms (REQ-PL-*)
  {
    const text = exitReq + '\n';
    add({
      id: 'pl-args-exact', reqs: ['REQ-PL-002', 'REQ-FW-006'], tapeArgs: ['--label', 'args'], extraArgs: ['a b', 'q"x', '', 'tab\there', 'back\\slash\\', '%PATH%', '$HOME'],
      stdin: [{ text }], server: { respond: true },
      expect: { exit: 0, args: ['a b', 'q"x', '', 'tab\there', 'back\\slash\\', '%PATH%', '$HOME'], trace: { label: 'args', in: logged(text), out: [JSON.parse(reply(99, 'test/exit'))], exitCode: 0 } },
    });
    add({
      id: 'pl-windows-cmd-shim', reqs: ['REQ-PL-001'], platform: 'win32', cmdShim: true, tapeArgs: ['--label', 'shim'],
      stdin: [{ text }], server: { respond: true },
      expect: { exit: 0, received: text, stdout: reply(99, 'test/exit') + '\n', trace: { label: 'shim', in: logged(text), out: [JSON.parse(reply(99, 'test/exit'))], exitCode: 0 } },
    });
  }

  // ---------- static checks over the implementation folder (n/a for the reference)
  for (const [id, reqs, test] of [['st-regen-json', ['REQ-IF-001'], 'regen'], ['st-runtime', ['REQ-BU-001'], 'runtime'], ['st-no-deps', ['REQ-BU-002'], 'deps'], ['st-line-budget', ['REQ-BU-003'], 'loc']]) {
    cases.push({ id, reqs, static: test, na: ['reference'] });
  }
  return cases;
}
