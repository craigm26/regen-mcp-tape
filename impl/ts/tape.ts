import { spawn } from "node:child_process";
import type { ChildProcess } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { makeRedactor } from "./redact.ts";

const USAGE = `usage: tape [--out DIR] [--label NAME] [--redact REGEX]... [--no-redact-defaults] [--help] [--version] -- <command> [args...]
Transparent stdio proxy that records MCP traffic to a JSONL trace file.
`;

function parseArgs(argv: string[]) {
  const o = { out: "./mcp-traces", label: undefined as string | undefined, redact: [] as string[],
    defaults: true, help: false, version: false, cmd: [] as string[], error: "" };
  for (let i = 0; i < argv.length && !o.error; i++) {
    const a = argv[i];
    if (a === "--") { o.cmd = argv.slice(i + 1); break; }
    if (a === "--out" || a === "--label" || a === "--redact") {
      if (i + 1 >= argv.length) { o.error = `option ${a} needs a value`; break; }
      const v = argv[++i];
      if (a === "--out") o.out = v; else if (a === "--label") o.label = v; else o.redact.push(v);
    } else if (a === "--no-redact-defaults") o.defaults = false;
    else if (a === "--help" || a === "-h") o.help = true;
    else if (a === "--version" || a === "-v") o.version = true;
    else if (a.startsWith("-")) o.error = `unknown option ${a}`;
    else { o.cmd = argv.slice(i); break; }
  }
  return o;
}

function usageError(msg: string): never {
  process.stderr.write(`tape: ${msg}\n${USAGE}`, () => process.exit(2));
  return undefined as never;
}

function deriveLabel(command: string[]): string {
  const skip = new Set(["npx", "-y", "--yes", "node", "bun", "deno", "run", "--"]);
  for (let i = command.length - 1; i >= 0; i--) {
    const a = command[i];
    if (a.startsWith("-") || skip.has(a) || /\s/.test(a)) continue;
    const l = a.slice(Math.max(a.lastIndexOf("/"), a.lastIndexOf("\\")) + 1)
      .replace(/[^A-Za-z0-9-]/g, "-").toLowerCase().slice(0, 32);
    if (l) return l;
  }
  return "mcp";
}

function launch(cmd: string[]): ChildProcess {
  const stdio: ["pipe", "pipe", "inherit"] = ["pipe", "pipe", "inherit"];
  if (process.platform !== "win32") return spawn(cmd[0], cmd.slice(1), { stdio });
  let file = cmd[0];
  if (!/[\\/]/.test(file) && !path.extname(file)) {
    const exts = (process.env.PATHEXT ?? ".COM;.EXE;.BAT;.CMD").split(";").filter(Boolean);
    const dirs = [".", ...(process.env.PATH ?? "").split(";").filter(Boolean)];
    for (const d of dirs) {
      const hit = exts.map((e) => path.join(d, file + e)).find((f) => fs.existsSync(f) && fs.statSync(f).isFile());
      if (hit) { file = hit; break; }
    }
  }
  if (!/\.(cmd|bat)$/i.test(file)) return spawn(file, cmd.slice(1), { stdio });
  const q = (s: string) => (s === "" || /\s/.test(s) ? `"${s.replace(/"/g, '""')}"` : s);
  const line = `"${[file, ...cmd.slice(1)].map(q).join(" ")}"`;
  return spawn(process.env.ComSpec ?? "cmd.exe", ["/d", "/s", "/c", line], { stdio, windowsVerbatimArguments: true });
}

// Splits one direction's bytes at LF and hands each whole line to `handle`.
function splitter(handle: (line: Buffer) => void) {
  let pending: Buffer[] = [];
  return {
    feed(chunk: Buffer) {
      let start = 0;
      for (let i = chunk.indexOf(10, start); i >= 0; i = chunk.indexOf(10, start)) {
        handle(Buffer.concat([...pending, chunk.subarray(start, i)]));
        pending = [];
        start = i + 1;
      }
      if (start < chunk.length) pending.push(chunk.subarray(start));
    },
    flush() {
      if (!pending.length) return;
      const b = Buffer.concat(pending);
      pending = [];
      handle(b);
    },
  };
}

function main() {
  const o = parseArgs(process.argv.slice(2));
  if (o.help) { process.stdout.write(USAGE, () => process.exit(0)); return; }
  if (o.version) { process.stdout.write("tape 1.0.0\n", () => process.exit(0)); return; }
  if (!o.error && !o.cmd.length) o.error = "no command given";
  const user: RegExp[] = [];
  if (!o.error) {
    for (const p of o.redact) {
      try { user.push(new RegExp(p, "g")); } catch { o.error = `invalid --redact pattern: ${p}`; break; }
    }
  }
  if (o.error) return usageError(o.error);

  const start = Date.now();
  const startedAt = new Date(start).toISOString();
  const rd = makeRedactor(o.defaults, user);
  const command = o.cmd.map(rd.str);
  const label = o.label ?? deriveLabel(command);
  const name = label.replace(/[^A-Za-z0-9_-]/g, "-").slice(0, 64) || "mcp";
  let fd: number;
  try {
    fs.mkdirSync(o.out, { recursive: true });
    fd = fs.openSync(path.join(o.out, `${startedAt.replace(/[:.]/g, "-")}-${name}.jsonl`), "w");
    fs.writeFileSync(fd, JSON.stringify({ v: 1, type: "meta", startedAt, label, command }) + "\n");
  } catch (e) {
    process.stderr.write(`tape: cannot create trace file: ${(e as Error).message}\n`, () => process.exit(1));
    return;
  }

  let done = false;
  const log = (dir: "in" | "out") => (line: Buffer) => {
    if (done) return;
    const text = new TextDecoder("utf-8", { ignoreBOM: true }).decode(line);
    if (/^[ \t\r]*$/.test(text)) return;
    try {
      const raw = rd.msg(JSON.parse(text));
      fs.writeFileSync(fd, JSON.stringify({ t: new Date().toISOString(), dir, raw }) + "\n");
    } catch { /* not JSON, or too deep to redact: not logged */ }
  };
  const sin = splitter(log("in"));
  const sout = splitter(log("out"));

  const finish = (code: number) => {
    if (done) return;
    sin.flush();
    sout.flush();
    done = true;
    const now = Date.now();
    fs.writeFileSync(fd, JSON.stringify({ t: new Date(now).toISOString(), type: "end", exitCode: code,
      durationMs: Math.max(0, now - start) }) + "\n");
    fs.closeSync(fd);
    process.stdout.write("", () => process.exit(code));
  };

  const child = launch(o.cmd);
  child.on("error", (e) => {
    if (child.pid !== undefined) return;
    process.stderr.write(`tape: cannot start ${o.cmd[0]}: ${e.message}\n`, () => finish(127));
  });
  child.stdin!.on("error", () => {});
  process.stdout.on("error", () => {});

  process.stdin.on("data", (chunk: Buffer) => {
    if (!child.stdin!.write(chunk)) {
      process.stdin.pause();
      child.stdin!.once("drain", () => process.stdin.resume());
    }
    sin.feed(chunk);
  });
  process.stdin.on("end", () => { sin.flush(); child.stdin!.end(); });
  child.stdout!.on("data", (chunk: Buffer) => {
    if (!process.stdout.write(chunk)) {
      child.stdout!.pause();
      process.stdout.once("drain", () => child.stdout!.resume());
    }
    sout.feed(chunk);
  });
  child.on("close", (code, signal) => {
    if (child.pid === undefined) return;
    finish(code ?? (signal ? 128 + (os.constants.signals[signal] ?? 0) : 1));
  });
  if (process.platform !== "win32") {
    for (const s of ["SIGINT", "SIGTERM"] as const) process.on(s, () => child.kill(s));
  }
}

main();
