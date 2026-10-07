import { test } from 'node:test';
import assert from 'node:assert';
import { makeRedactor } from './redact.ts';
import { deriveLabel, parseArgs } from './cli.ts';

const R = '[REDACTED]';
const d = makeRedactor(true, []);

test('REQ-RD-001 exact keys, any type, nothing examined inside', () => {
  const v = { api_key: 1, token: null, bearer: true, Authorization: { a: 1 }, pwd: [1], keep: 2, n: { secret: 'x' } };
  assert.deepEqual(d.msg(v), { api_key: R, token: R, bearer: R, Authorization: R, pwd: R, keep: 2, n: { secret: R } });
  assert.deepEqual(d.msg(JSON.parse('{"__proto__":{"password":"x"}}')), JSON.parse('{"__proto__":{"password":"[REDACTED]"}}'));
});

test('REQ-RD-002 string patterns', () => {
  const cases: [string, string][] = [
    ['try AKIAIOSFODNN7EXAMPLE today', `try ${R} today`],
    ['Authorization: Bearer abc.def', R],
    ['Authorization: x\r\nnext', `${R}\r\nnext`],
    ['postgres://admin:hunter2@db:5432/x', `postgres://admin:${R}@db:5432/x`],
    ['load /srv/app/.env.local now', `load ${R} now`],
    ['key is ~/.ssh/id_ed25519.pub', `key is ${R}`],
    ['café AKIAIOSFODNN7EXAMPLE', `café ${R}`],
    ['éAKIAIOSFODNN7EXAMPLE', `é${R}`],
    ['a/.env.x+b/.env', R],
    ['my.envy', 'my.envy'],
    ['cfg/.env.', `${R}.`],
    ['.env.env-id_', `${R}-id_`],
    ['sk-' + 'a'.repeat(24), R],
    ['ghs_' + 'b'.repeat(40), R],
    ['eyJhbGci.eyJzdWIi.sig_-x', R],
    ['xoxb-1234567890-abc', R],
    ['sk_live_abcdefgh12', R],
    ['say "x/.env" ok', `say "${R}" ok`],
    ['id_rsa_backup', 'id_rsa_backup'],
  ];
  for (const [i, o] of cases) assert.equal(d.msg(i), o, i);
});

test('REQ-RD-003 key substrings', () => {
  assert.deepEqual(d.msg({ db_password: 'x' }), { db_password: R });
  assert.deepEqual(d.msg({ max_tokens: 100 }), { max_tokens: 100 });
  assert.deepEqual(d.msg({ progressToken: 'abc' }), { progressToken: R });
  assert.deepEqual(d.msg({ tokens: [1, 2] }), { tokens: R });
  assert.deepEqual(d.msg({ myPwd: 'x', 'my-pwd': 'x', pwdx: 'y', Bearer: 'z', xbearer: 'w', 'API-Key': 'k', PrivateKey2: 'p' }),
    { myPwd: 'x', 'my-pwd': R, pwdx: 'y', Bearer: R, xbearer: 'w', 'API-Key': R, PrivateKey2: R });
  assert.deepEqual(d.msg({ secret_flag: false, a: [{ x_secret: {} }] }), { secret_flag: false, a: [{ x_secret: R }] });
});

test('REQ-RD-004 --redact patterns after defaults, in order', () => {
  const r = makeRedactor(true, [/a+/g, /\[REDACTED\]b/g]);
  assert.equal(r.msg('baab'), `b${R}`);
  const only = makeRedactor(false, [/x/g]);
  assert.deepEqual(only.msg({ password: 'xp' }), { password: `${R}p` });
  assert.deepEqual(only.msg('AKIAIOSFODNN7EXAMPLE x'), 'AKIAIOSFODNN7EXAMPLE [REDACTED]');
});

test('REQ-RD-006 linear time on a large word', () => {
  const t0 = Date.now();
  d.msg('A'.repeat(2_000_000));
  d.msg('.env'.repeat(500_000));
  d.msg('a.'.repeat(1_000_000));
  assert.ok(Date.now() - t0 < 5000);
});

test('REQ-RD-005 string rules for command arguments', () => {
  assert.equal(d.str('ghp_' + 'A'.repeat(36)), R);
  assert.equal(makeRedactor(false, []).str('AKIAIOSFODNN7EXAMPLE'), 'AKIAIOSFODNN7EXAMPLE');
});

test('REQ-LB-001 derived labels', () => {
  const l = (s: string[]) => deriveLabel(s.map(d.str));
  assert.equal(l(['node', '/opt/server.js']), 'server-js');
  assert.equal(l(['npx', '-y', 'my-remote']), 'my-remote');
  assert.equal(l(['node', 'srv.js', '--port', '3000']), '3000');
  assert.equal(l(['node', 'C:\\srv\\files.mjs']), 'files-mjs');
  assert.equal(l(['npx', '-y', 'srv', 'https://example.test/mcp', '--header', 'X-Key: abc']), 'mcp');
  assert.equal(l(['node', 'KEY=value']), 'key-value');
  assert.equal(l(['npx', '-y', '--']), 'mcp');
  assert.equal(l(['node', 'srv.js', 'ghp_' + 'A'.repeat(36)]), '-redacted-');
  assert.equal(deriveLabel(['x'.repeat(40)]), 'x'.repeat(32));
});

test('REQ-CLI-002 parseArgs', () => {
  assert.deepEqual(parseArgs(['--label', 'x', 'node', 'srv.js', '--out', 'y']).command, ['node', 'srv.js', '--out', 'y']);
  assert.deepEqual(parseArgs(['--', 'node', '--', '-h']).command, ['node', '--', '-h']);
  assert.equal(parseArgs(['--out', '--', 'x']).out, '--');
  assert.ok(parseArgs(['--nope', 'x']).error);
});
