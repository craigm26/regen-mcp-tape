#!/usr/bin/env node
// The suite's fake MCP server. Usage: node fake.mjs <config.json> [extra args...]
// Config (all optional):
//   record:   file that receives every stdin byte, appended as read
//   argsFile: file that receives JSON of the extra args
//   termFile: file that receives "SIGTERM" / "SIGINT" if that signal arrives (then exit 0)
//   stdout:   [{b64 | text | bigBytes, delayMs}]  written in order at start, before any reply
//   stderr:   text written to stderr at start
//   respond:  reply to each JSON request line ({"id","method"}) with {"jsonrpc":"2.0","id":..,"result":{"method":..}}
//   then:     what to do after the stdout plan: "eof" (exit at stdin EOF), "hold" (wait), "exit" (exit now)
//   exitCode: status for every exit (default 0)
//   exitSignal: instead of exiting with a code, kill self with this signal (POSIX)
// A request with method "test/exit" is answered (when respond) and then the server exits.
import { appendFileSync, readFileSync, writeFileSync } from 'node:fs';

const cfg = JSON.parse(readFileSync(process.argv[2], 'utf8'));
if (cfg.argsFile) writeFileSync(cfg.argsFile, JSON.stringify(process.argv.slice(3)));

const write = (buf) => new Promise((res) => process.stdout.write(buf, () => res()));
const sleep = (ms) => new Promise((res) => setTimeout(res, ms));
async function finish() {
  await write(Buffer.alloc(0));
  if (cfg.exitSignal) process.kill(process.pid, cfg.exitSignal);
  else process.exit(cfg.exitCode ?? 0);
}

if (cfg.termFile) {
  for (const sig of ['SIGTERM', 'SIGINT']) {
    process.on(sig, () => { appendFileSync(cfg.termFile, sig + '\n'); process.exit(0); });
  }
}
if (cfg.stderr) process.stderr.write(cfg.stderr);

let planDone = false;
let pending = Buffer.alloc(0);
let exiting = false;
async function handleLines() {
  if (!planDone) return;
  let i;
  while (!exiting && (i = pending.indexOf(0x0a)) >= 0) {
    const line = pending.subarray(0, i).toString('utf8');
    pending = pending.subarray(i + 1);
    let msg;
    try { msg = JSON.parse(line); } catch { continue; }
    if (msg === null || typeof msg !== 'object' || Array.isArray(msg) || !('method' in msg)) continue;
    if (cfg.respond && 'id' in msg) {
      await write(JSON.stringify({ jsonrpc: '2.0', id: msg.id, result: { method: msg.method } }) + '\n');
    }
    if (msg.method === 'test/exit') { exiting = true; await finish(); }
  }
}

process.stdin.on('data', (chunk) => {
  if (cfg.record) appendFileSync(cfg.record, chunk);
  pending = Buffer.concat([pending, chunk]);
  handleLines();
});
process.stdin.on('end', async () => {
  if (cfg.record) appendFileSync(cfg.record, Buffer.alloc(0));
  while (!planDone) await sleep(10);
  await handleLines();
  if (cfg.then === 'eof' && !exiting) { exiting = true; await finish(); }
});

for (const item of cfg.stdout ?? []) {
  if (item.delayMs) await sleep(item.delayMs);
  if (item.bigBytes) {
    const head = '{"jsonrpc":"2.0","method":"big","params":{"s":"';
    const tail = '"}}\n';
    await write(head + 'x'.repeat(item.bigBytes - head.length - tail.length) + tail);
  } else {
    await write(item.b64 !== undefined ? Buffer.from(item.b64, 'base64') : Buffer.from(item.text, 'utf8'));
  }
}
planDone = true;
await handleLines();
if (cfg.then === 'exit' && !exiting) { exiting = true; await finish(); }
if (cfg.then === 'hold' || cfg.termFile) setInterval(() => {}, 1 << 30);
