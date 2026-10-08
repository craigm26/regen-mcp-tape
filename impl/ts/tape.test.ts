import { test } from "node:test";
import assert from "node:assert";
import { spawn } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

const here = import.meta.dirname;
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "tape-test-"));
const fake = path.join(tmp, "fake.mjs");
fs.writeFileSync(fake, `
const [mode, a] = process.argv.slice(2);
if (mode === "echo") { process.stdin.pipe(process.stdout); }
else if (mode === "exit") process.exit(Number(a));
else if (mode === "signal") process.kill(process.pid, a);
else if (mode === "stderr") { process.stderr.write(Buffer.from(a, "hex")); }
else if (mode === "emit") { process.stdout.write(Buffer.from(a, "hex")); }
else if (mode === "eof") { process.stdin.resume(); process.stdin.on("end", () => { process.stdout.write("EOF\\n"); process.exit(3); }); }
else if (mode === "term") { process.on("SIGTERM", () => process.exit(0)); process.stdout.write("ready\\n"); setInterval(() => {}, 1000); }
else if (mode === "args") { process.stdout.write(JSON.stringify(process.argv.slice(3)) + "\\n"); }
else if (mode === "cwdenv") { process.stdout.write(JSON.stringify([process.cwd(), process.env.TAPE_X]) + "\\n"); }
`);

interface Res { code: number | null; out: Buffer; err: Buffer; trace: any[]; files: string[]; dir: string }
interface Opts { chunks?: (Buffer | string | number)[]; keepOpen?: boolean; env?: Record<string, string>; cwd?: string }

async function run(args: string[], o: Opts = {}): Promise<Res> {
  const dir = fs.mkdtempSync(path.join(tmp, "o-"));
  const full = args.map((a) => (a === "OUT" ? dir : a));
  const p = spawn(process.execPath, [path.join(here, "tape.ts"), ...full], { cwd: o.cwd ?? tmp, env: { ...process.env, ...o.env } });
  const out: Buffer[] = [], err: Buffer[] = [];
  p.stdout.on("data", (d) => out.push(d));
  p.stderr.on("data", (d) => err.push(d));
  p.stdin.on("error", () => {});
  const closed = new Promise<number | null>((r) => p.on("close", (c, s) => r(c ?? (s ? -1 : null))));
  for (const c of o.chunks ?? []) {
    if (typeof c === "number") await new Promise((r) => setTimeout(r, c));
    else p.stdin.write(c);
  }
  if (!o.keepOpen) p.stdin.end();
  const timer = setTimeout(() => p.kill("SIGKILL"), 15000);
  const code = await closed;
  clearTimeout(timer);
  p.stdin.destroy();
  return { code, out: Buffer.concat(out), err: Buffer.concat(err), ...readTrace(dir), dir };
}

function readTrace(dir: string) {
  const files = fs.existsSync(dir) && fs.statSync(dir).isDirectory() ? fs.readdirSync(dir) : [];
  const trace = files.length === 1
    ? fs.readFileSync(path.join(dir, files[0]), "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l)) : [];
  return { trace, files };
}
const msgs = (r: Res) => r.trace.filter((l) => l.dir);
const echo = ["--", "node", fake, "echo"];

test("REQ-IF-001 REGEN.json", () => {
  const j = JSON.parse(fs.readFileSync(path.join(here, "REGEN.json"), "utf8"));
  assert.strictEqual(j.lang, "ts");
  for (const k of ["build", "test", "driver"]) assert.ok(k in j);
  assert.match(j.driver, /^[\w. -]+$/);
});

test("REQ-CLI-001/003 help and version", async () => {
  for (const f of ["--help", "-h", "--version", "-v"]) {
    const r = await run([f, "--out", "OUT", ...echo]);
    assert.strictEqual(r.code, 0);
    assert.ok(r.out.length > 0);
    assert.deepStrictEqual(r.files, []);
  }
  const both = await run(["--version", "--help"]);
  assert.match(both.out.toString(), /usage/);
});

test("REQ-CLI-002 command start", async () => {
  const r = await run(["--out", "OUT", "--label", "x", "node", fake, "args", "--out", "y"]);
  assert.deepStrictEqual(JSON.parse(r.out.toString()), ["--out", "y"]);
  assert.match(r.files[0], /-x\.jsonl$/);
  const r2 = await run(["--out", "OUT", "--", "node", fake, "args", "--", "-h"]);
  assert.deepStrictEqual(JSON.parse(r2.out.toString()), ["--", "-h"]);
  const r3 = await run(["--label", "--out", "--out", "OUT", "--", "node", fake, "exit", "0"]);
  assert.match(r3.files[0], /----out\.jsonl$|--out\.jsonl$/);
});

test("REQ-CLI-004 usage errors", async () => {
  const cases = [["--bogus", "--", "x"], ["--out"], ["--out", "OUT"], ["--redact", "(", "--out", "OUT", "--", "node"], ["--out", "OUT", "--redact"]];
  for (const c of cases) {
    const r = await run(c);
    assert.strictEqual(r.code, 2, c.join(" "));
    assert.strictEqual(r.out.length, 0);
    assert.ok(r.err.length > 0);
    assert.deepStrictEqual(r.files, []);
  }
});

test("REQ-FW-001/002 forwarding is byte exact", async () => {
  const bad = Buffer.from([0x7b, 0xff, 0xfe, 0x0a, 0x0d, 0x0a, 0x0a]);
  const input = Buffer.concat([Buffer.from('{"a":1}\r\n\n\n'), bad, Buffer.from("not json\n"), Buffer.from('{"token":"abc"}')]);
  const r = await run(["--out", "OUT", ...echo], { chunks: [input.subarray(0, 5), 50, input.subarray(5)] });
  assert.ok(r.out.equals(input));
  assert.strictEqual(r.code, 0);
});

test("REQ-FW-001 large line", async () => {
  const big = Buffer.from('{"d":"' + "A".repeat(4_000_000) + '"}\n');
  const r = await run(["--out", "OUT", ...echo], { chunks: [big] });
  assert.ok(r.out.equals(big));
  assert.strictEqual(msgs(r).length, 2);
});

test("REQ-FW-003 child stderr", async () => {
  const r = await run(["--out", "OUT", "--", "node", fake, "stderr", "00ff0a41"]);
  assert.ok(r.err.equals(Buffer.from([0, 255, 10, 65])));
});

test("REQ-FW-004 end of input reaches child", async () => {
  const r = await run(["--out", "OUT", "--", "node", fake, "eof"], { chunks: ["x\n"] });
  assert.strictEqual(r.out.toString(), "EOF\n");
  assert.strictEqual(r.code, 3);
});

test("REQ-FW-005 exits when child exits with stdin open", async () => {
  const r = await run(["--out", "OUT", "--", "node", fake, "emit", Buffer.from('{"x":1}\n').toString("hex")], { keepOpen: true });
  assert.strictEqual(r.code, 0);
  assert.strictEqual(r.out.toString(), '{"x":1}\n');
  assert.strictEqual(r.trace.at(-1).type, "end");
});

test("REQ-FW-006 env and cwd", async () => {
  const r = await run(["--out", "OUT", "--", "node", fake, "cwdenv"], { env: { TAPE_X: "hello" }, cwd: here });
  assert.deepStrictEqual(JSON.parse(r.out.toString()), [fs.realpathSync(here), "hello"]);
});

test("REQ-EX-001 exit status", async () => {
  for (const n of [0, 1, 42]) assert.strictEqual((await run(["--out", "OUT", "--", "node", fake, "exit", String(n)])).code, n);
  const r = await run(["--out", "OUT", "--", "node", fake, "exit", "7"]);
  assert.strictEqual(r.trace.at(-1).exitCode, 7);
});

test("REQ-EX-002 signal exit", { skip: process.platform === "win32" }, async () => {
  const sigs: [string, number][] = [["SIGTERM", 15], ["SIGKILL", 9], ["SIGUSR2", os.constants.signals.SIGUSR2]];
  for (const [s, n] of sigs) {
    const r = await run(["--out", "OUT", "--", "node", fake, "signal", s]);
    assert.strictEqual(r.code, 128 + n, s);
    assert.strictEqual(r.trace.at(-1).exitCode, 128 + n);
  }
});

test("REQ-EX-003 signal forwarding", { skip: process.platform === "win32" }, async () => {
  const dir = fs.mkdtempSync(path.join(tmp, "o-"));
  const p = spawn("node", [path.join(here, "tape.ts"), "--out", dir, "--", "node", fake, "term"], { cwd: tmp });
  await new Promise((r) => p.stdout.once("data", r));
  const closed = new Promise((r) => p.on("close", (c) => r(c)));
  p.kill("SIGTERM");
  assert.strictEqual(await closed, 0);
});

test("REQ-EX-004 command cannot start", async () => {
  const r = await run(["--out", "OUT", "--", "/nonexistent/prog", "a"]);
  assert.strictEqual(r.code, 127);
  assert.ok(r.err.length > 0);
  assert.strictEqual(r.out.length, 0);
  assert.strictEqual(r.trace[0].type, "meta");
  assert.strictEqual(r.trace.at(-1).exitCode, 127);
});

test("REQ-EX-005 trace file cannot be created", async () => {
  const file = path.join(tmp, "plain-file");
  fs.writeFileSync(file, "x");
  const r = await run(["--out", file, ...echo], { chunks: ["{}\n"] });
  assert.strictEqual(r.code, 1);
  assert.ok(r.err.length > 0);
  assert.strictEqual(r.out.length, 0);
});

test("REQ-TR-001..005 file name and line shapes", async () => {
  const r = await run(["--out", path.join("OUT", "a", "b"), "--label", "my server/v2", ...echo], {});
  // OUT replaced only for exact arg; build nested dir manually
  assert.deepStrictEqual(r.files, []);
  const dir = path.join(tmp, "nested", "x");
  const p = await new Promise<number | null>((res) => {
    const c = spawn("node", [path.join(here, "tape.ts"), "--out", dir, "--label", "my server/v2", ...echo]);
    c.stdin.end('{"id":1.0,"m":"é"}\n');
    c.stdout.resume();
    c.on("close", res);
  });
  assert.strictEqual(p, 0);
  const files = fs.readdirSync(dir);
  assert.strictEqual(files.length, 1);
  assert.match(files[0], /^\d{4}-\d\d-\d\dT\d\d-\d\d-\d\d-\d{3}Z-my-server-v2\.jsonl$/);
  const text = fs.readFileSync(path.join(dir, files[0]), "utf8");
  assert.ok(text.endsWith("\n"));
  const lines = text.split("\n").slice(0, -1).map((l) => JSON.parse(l));
  assert.strictEqual(lines.length, 4);
  const [meta, m1, m2, end] = lines;
  assert.strictEqual(meta.v, 1);
  assert.strictEqual(meta.type, "meta");
  assert.match(meta.startedAt, /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/);
  assert.strictEqual(meta.label, "my server/v2");
  assert.deepStrictEqual(meta.command, ["node", fake, "echo"]);
  assert.deepStrictEqual([m1.dir, m2.dir].sort(), ["in", "out"]);
  assert.deepStrictEqual(m1.raw, { id: 1, m: "é" });
  assert.match(m1.t, /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/);
  assert.strictEqual(end.type, "end");
  assert.strictEqual(end.exitCode, 0);
  assert.ok(Number.isInteger(end.durationMs) && end.durationMs >= 0);
});

test("REQ-TR-001 empty name and truncation", async () => {
  const r = await run(["--out", "OUT", "--label", "", ...echo]);
  assert.match(r.files[0], /Z-mcp\.jsonl$/);
  const r2 = await run(["--out", "OUT", "--label", "a".repeat(100), ...echo]);
  assert.match(r2.files[0], new RegExp(`Z-a{64}\\.jsonl$`));
  assert.strictEqual(r2.trace[0].label, "a".repeat(100));
});

test("REQ-TR-007/008/009 which lines are logged", async () => {
  const input = '  \t\r\n[1,2]\r\n"s"\n12\nnull\ntrue\nnot json\n{"a":1}\n\u00a0\n{"last":true}';
  const r = await run(["--out", "OUT", ...echo], { chunks: [input] });
  const inn = msgs(r).filter((m) => m.dir === "in").map((m) => m.raw);
  assert.deepStrictEqual(inn, [[1, 2], "s", 12, null, true, { a: 1 }, { last: true }]);
  const out = msgs(r).filter((m) => m.dir === "out").map((m) => m.raw);
  assert.deepStrictEqual(out, inn);
});

test("REQ-TR-007 split multibyte character", async () => {
  const b = Buffer.from('{"m":"日本語"}\n');
  const r = await run(["--out", "OUT", ...echo], { chunks: [b.subarray(0, 7), 80, b.subarray(7, 8), 80, b.subarray(8)] });
  assert.ok(msgs(r).every((m) => m.raw.m === "日本語"));
  assert.strictEqual(msgs(r).length, 2);
});

test("REQ-TR-010 numbers", async () => {
  const r = await run(["--out", "OUT", ...echo], { chunks: ['{"a":1.0,"b":0.1,"c":1e21,"d":9007199254740993}\n'] });
  assert.deepStrictEqual(msgs(r)[0].raw, { a: 1, b: 0.1, c: 1e21, d: 9007199254740992 });
});

test("REQ-LB-001 derived labels", async () => {
  const cases: [string[], string][] = [
    [["node", "/opt/server.js"], "server-js"],
    [["npx", "-y", "my-remote"], "my-remote"],
    [["node", "srv.js", "--port", "3000"], "3000"],
    [["node", "C:\\srv\\files.mjs"], "files-mjs"],
    [["node", "KEY=value"], "key-value"],
    [["npx", "-y", "--"], "mcp"],
    [["node", "srv.js", "ghp_" + "A".repeat(36)], "-redacted-"],
    [["npx", "-y", "srv", "https://example.test/mcp", "--header", "X-Key: abc"], "mcp"],
  ];
  for (const [cmd, label] of cases) {
    const r = await run(["--out", "OUT", "--", ...cmd], { env: { PATH: "/nonexistent" } });
    assert.strictEqual(r.trace[0].label, label, cmd.join(" "));
  }
  const long = await run(["--out", "OUT", "--", "/nonexistent/x", "A".repeat(50)]);
  assert.strictEqual(long.trace[0].label, "a".repeat(32));
});

async function red(value: unknown, extra: string[] = []) {
  const r = await run(["--out", "OUT", ...extra, ...echo], { chunks: [JSON.stringify(value) + "\n"] });
  return msgs(r).find((m) => m.dir === "in").raw;
}

test("REQ-RD-001 exact keys", async () => {
  const keys = ["api_key", "apiKey", "token", "bearer", "secret", "password", "passwd", "pwd", "private_key", "privateKey",
    "access_key", "accessKey", "authorization", "Authorization"];
  const v: Record<string, unknown> = {};
  keys.forEach((k, i) => { v[k] = [1, true, null, { a: "b" }, 5, "s"][i % 6]; });
  const got: any = await red({ x: [v] });
  for (const k of keys) assert.strictEqual(got.x[0][k], "[REDACTED]", k);
});

test("REQ-RD-002 string patterns", async () => {
  const cases: [string, string][] = [
    ["try AKIAIOSFODNN7EXAMPLE today", "try [REDACTED] today"],
    ["key sk-" + "a1_".repeat(8) + " x", "key [REDACTED] x"],
    ["t ghp_" + "A".repeat(36), "t [REDACTED]"],
    ["jwt eyJhbGci.eyJzdWIi.sig_-x end", "jwt [REDACTED] end"],
    ["Authorization: Bearer abc.def", "[REDACTED]"],
    ["Authorization: x\r\nnext", "[REDACTED]\r\nnext"],
    ["use Bearer abc123+/= now", "use [REDACTED] now"],
    ["slack xoxb-1234567890-abc ok", "slack [REDACTED] ok"],
    ["stripe sk_live_abcdefgh12 ok", "stripe [REDACTED] ok"],
    ["postgres://admin:hunter2@db:5432/x", "postgres://admin:[REDACTED]@db:5432/x"],
    ["load /srv/app/.env.local now", "load [REDACTED] now"],
    ["a/.env.x+b/.env", "[REDACTED]"],
    ["my.envy", "my.envy"],
    ["cfg/.env.", "[REDACTED]."],
    [".env.env-id_", "[REDACTED]-id_"],
    ["key is ~/.ssh/id_ed25519.pub", "key is [REDACTED]"],
    ["café AKIAIOSFODNN7EXAMPLE", "café [REDACTED]"],
    ["éAKIAIOSFODNN7EXAMPLE", "é[REDACTED]"],
    ["x \"/a/.env\" y", "x \"[REDACTED]\" y"],
  ];
  for (const [i, o] of cases) assert.strictEqual(await red({ text: i, list: [i] }).then((x: any) => x.text), o, i);
});

test("REQ-RD-003 key substrings", async () => {
  const got: any = await red({ db_password: "x", max_tokens: 100, progressToken: "abc", tokens: [1, 2], "my-pwd": "p", pwdx: "keep",
    API_KEY2: { a: 1 }, ok: { bearer_x: "keep", bearer: "gone" }, secretFlag: true, n: null, Secret: null, apiKey: 3 });
  assert.deepStrictEqual(got, { db_password: "[REDACTED]", max_tokens: 100, progressToken: "[REDACTED]", tokens: "[REDACTED]",
    "my-pwd": "[REDACTED]", pwdx: "keep", API_KEY2: "[REDACTED]", ok: { bearer_x: "keep", bearer: "[REDACTED]" },
    secretFlag: true, n: null, Secret: null, apiKey: "[REDACTED]" });
});

test("REQ-RD-004 user patterns", async () => {
  const x = ["--redact", "^id", "--redact", "end$"];
  assert.strictEqual(await red("id 7", x), "[REDACTED] 7");
  assert.strictEqual(await red("my id", x), "my id");
  assert.strictEqual(await red("the end", x), "the [REDACTED]");
  assert.strictEqual(await red("the end\n", x), "the end\n");
  assert.strictEqual(await red("a.b", ["--redact", "a.b"]), "[REDACTED]");
  assert.strictEqual(await red("x\ry", ["--redact", "x.y"]), "x\ry");
  assert.strictEqual(await red("foo123 bar", ["--redact", "foo\\d{2,3}", "--redact", "(bar|baz)"]), "[REDACTED] [REDACTED]");
  assert.strictEqual(await red("Foo", ["--redact", "foo"]), "Foo");
  assert.strictEqual(await red("AKIAIOSFODNN7EXAMPLE", ["--no-redact-defaults", "--redact", "zzz"]), "AKIAIOSFODNN7EXAMPLE");
});

test("REQ-RD-001/003 --no-redact-defaults", async () => {
  assert.deepStrictEqual(await red({ token: "abc", p: "Bearer abcdef" }, ["--no-redact-defaults"]), { token: "abc", p: "Bearer abcdef" });
});

test("REQ-RD-005 command is redacted", async () => {
  const r = await run(["--out", "OUT", "--redact", "zzz", "--", "/nonexistent/x", "AKIAIOSFODNN7EXAMPLE", "azzzb"]);
  assert.deepStrictEqual(r.trace[0].command, ["/nonexistent/x", "[REDACTED]", "a[REDACTED]b"]);
  const r2 = await run(["--out", "OUT", "--no-redact-defaults", "--redact", "zzz", "--", "/nonexistent/x", "AKIAIOSFODNN7EXAMPLE", "azzzb"]);
  assert.deepStrictEqual(r2.trace[0].command, ["/nonexistent/x", "AKIAIOSFODNN7EXAMPLE", "a[REDACTED]b"]);
});

test("REQ-RD-006 large base64 blob", async () => {
  const blob = Buffer.from(Array.from({ length: 1_500_000 }, (_, i) => String.fromCharCode(65 + (i * 7) % 26)).join("")).toString("base64").slice(0, 2_000_000);
  const line = JSON.stringify({ data: blob + "==" }) + "\n";
  const t = Date.now();
  const r = await run(["--out", "OUT", ...echo], { chunks: [line, '{"after":1}\n'] });
  assert.ok(Date.now() - t < 14000);
  assert.ok(r.out.toString().endsWith('{"after":1}\n'));
  assert.strictEqual(msgs(r).filter((m) => m.dir === "out").length, 2);
});

test("REQ-PL-002 arguments arrive exactly", async () => {
  const args = ["a b", 'q"uote', "", "--out", "x'y"];
  const r = await run(["--out", "OUT", "--", "node", fake, "args", ...args]);
  assert.deepStrictEqual(JSON.parse(r.out.toString()), args);
});
