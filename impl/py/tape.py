#!/usr/bin/env python3
"""tape: a transparent stdio proxy for MCP servers that records a redacted JSONL trace."""
import json
import os
import re
import shutil
import signal
import subprocess
import sys
import threading
import time
import warnings
from datetime import datetime, timezone

warnings.simplefilter("ignore")
VERSION = "1.1.1"
R = "[REDACTED]"
WS = " \t\v\f\r\n   -     　﻿"
HAS_WS = re.compile("[" + WS + "]")
USAGE = """usage: tape [--out DIR] [--label NAME] [--redact REGEX]... [--no-redact-defaults] [--help] [--version] -- <command> [args...]

Transparent stdio proxy for MCP servers; writes a redacted JSONL trace of all messages.
"""


# ---------------------------------------------------------------- regex helpers
def es(p):
    """Translate the ECMAScript regex subset used here into a Python pattern."""
    out, i, incls = [], 0, False
    while i < len(p):
        c = p[i]
        if c == "\\" and i + 1 < len(p):
            d = p[i + 1]
            i += 2
            if d == "s":
                out.append(WS if incls else "[" + WS + "]")
            elif d == "S" and not incls:
                out.append("[^" + WS + "]")
            else:
                out.append(c + d)
            continue
        i += 1
        if incls:
            incls = c != "]"
        elif c == "[":
            incls = True
            if p[i:i + 1] == "^":
                out.append("[^")
                i += 1
                continue
        elif c == ".":
            c = "[^\n\r  ]"
        elif c == "$":
            c = "\\Z"
        out.append(c)
    return "".join(out)


def rx(p):
    return re.compile(es(p), re.ASCII)


PATTERNS_A = [rx(p) for p in (
    r"\bAKIA[0-9A-Z]{16}\b",
    r"\bsk-[A-Za-z0-9_-]{20,}\b",
    r"\bgh[pousr]_[A-Za-z0-9]{36,}\b",
    r"\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\b")]
PATTERNS_B = [rx(p) for p in (
    r"[Aa]uthorization\s*:\s*.+",
    r"[Bb]earer\s+[A-Za-z0-9._\-+/=]+",
    r"\b(?:xoxb|xoxa|xoxp|xoxr|xoxs)-[A-Za-z0-9-]{10,}",
    r"\b(?:rk_live|sk_live)_[A-Za-z0-9]{8,}\b")]
CONN = rx(r"://([^/\s:@]{1,128}):([^/\s@]+)(?=@)")
WORD = rx(r'[^\s"]+')
ENVTAIL = rx(r"[A-Za-z0-9._\-]+")
SSHKEY = rx(r"\bid_(?:rsa|ed25519|ecdsa|dsa)\b")
EXACT_KEYS = frozenset("api_key apiKey token bearer secret password passwd pwd private_key "
                       "privateKey access_key accessKey authorization Authorization".split())
KEY_SUBSTR = re.compile(r"password|passwd|\bpwd\b|secret|token|api[_-]?key|authorization|^bearer\Z|"
                        r"private[_-]?key|access[_-]?key", re.ASCII | re.IGNORECASE)


def _wordch(c):
    return c.isascii() and (c.isalnum() or c == "_")


def _bound(w, p):
    return (p > 0 and _wordch(w[p - 1])) != (p < len(w) and _wordch(w[p]))


def _env_end(w):
    """End of the match of pattern 10 for the last `.env` that matches in word w, or -1."""
    i = len(w)
    while True:
        i = w.rfind(".env", 0, i)
        if i < 0:
            return -1
        e = i + 4
        m = ENVTAIL.match(w, e + 1) if w[e:e + 1] == "." else None
        if m:
            j = m.end()
            while j >= e + 2 and not _bound(w, j):
                j -= 1
            if j >= e + 2:
                return j
        if _bound(w, e):
            return e


def _env_word(m):
    w = m.group(0)
    end = _env_end(w)
    return R + w[end:] if end >= 0 else w


def string_defaults(s):
    """Step 2: the eleven string patterns, in order."""
    for p in PATTERNS_A + PATTERNS_B[:4]:
        s = p.sub(R, s)
    s = CONN.sub(lambda m: m.group(0)[:m.start(2) - m.start(0)] + R, s)
    if ".env" in s:
        s = WORD.sub(_env_word, s)
    if "id_" in s:
        s = WORD.sub(lambda m: R if SSHKEY.search(m.group(0)) else m.group(0), s)
    return s


def smap(v, f):
    if isinstance(v, str):
        return f(v)
    if isinstance(v, list):
        return [smap(x, f) for x in v]
    if isinstance(v, dict):
        return {k: smap(x, f) for k, x in v.items()}
    return v


class Redactor:
    def __init__(self, user=(), defaults=True):
        self.defaults = defaults
        self.user = [rx(p) for p in user]

    def step1(self, v):
        if isinstance(v, list):
            return [self.step1(x) for x in v]
        if isinstance(v, dict):
            return {k: R if k in EXACT_KEYS else self.step1(x) for k, x in v.items()}
        return v

    def step3(self, v):
        if isinstance(v, list):
            return [self.step3(x) for x in v]
        if isinstance(v, dict):
            return {k: R if KEY_SUBSTR.search(k) and isinstance(x, (str, dict, list)) else self.step3(x)
                    for k, x in v.items()}
        return v

    def step4(self, s):
        if self.defaults:
            for p in PATTERNS_A:
                s = p.sub(R, s)
        for p in self.user:
            s = p.sub(R, s)
        return s

    def string(self, s):
        return self.step4(string_defaults(s) if self.defaults else s)

    def value(self, v):
        if self.defaults:
            v = smap(self.step1(v), string_defaults)
            v = self.step3(v)
        return smap(v, self.step4)


# ---------------------------------------------------------------- label
def derive_label(command):
    skip = {"npx", "-y", "--yes", "node", "bun", "deno", "run", "--"}
    for a in reversed(command):
        if a.startswith("-") or a in skip or HAS_WS.search(a):
            continue
        part = re.split(r"[/\\]", a)[-1]
        part = "".join(c if c.isascii() and (c.isalnum() or c == "-") else "-" for c in part)
        if part:
            return part.lower()[:32]
    return "mcp"


def file_name_part(label):
    name = "".join(c if c.isascii() and (c.isalnum() or c in "_-") else "-" for c in label)[:64]
    return name or "mcp"


# ---------------------------------------------------------------- trace
def ts(ms):
    return datetime.fromtimestamp(ms // 1000, timezone.utc).strftime("%Y-%m-%dT%H:%M:%S.") + "%03dZ" % (ms % 1000)


def now_ms():
    return time.time_ns() // 1_000_000


def dumps(obj):
    return json.dumps(obj, separators=(",", ":"), allow_nan=False).encode("ascii") + b"\n"


def _bad_constant(name):
    raise ValueError(name)


def _float(s):
    f = float(s)
    return None if f in (float("inf"), float("-inf")) else f


class Trace:
    def __init__(self, f, start_ms):
        self.f, self.start, self.lock, self.closed = f, start_ms, threading.Lock(), False

    def put(self, obj):
        with self.lock:
            if not self.closed:
                self.f.write(dumps(obj))
                self.f.flush()

    def end(self, code):
        t = now_ms()
        self.put({"t": ts(t), "type": "end", "exitCode": code, "durationMs": max(0, t - self.start)})
        with self.lock:
            self.closed = True
            self.f.close()


class Lines:
    """Splits one direction into lines and logs those that are JSON."""

    def __init__(self, direction, trace, red):
        self.dir, self.trace, self.red, self.pending = direction, trace, red, []

    def feed(self, data):
        pieces = data.split(b"\n")
        for p in pieces[:-1]:
            self.pending.append(p)
            line = b"".join(self.pending)
            self.pending = []
            self.handle(line)
        self.pending.append(pieces[-1])

    def flush(self):
        line = b"".join(self.pending)
        self.pending = []
        self.handle(line)

    def handle(self, line):
        try:
            if not line.strip(b" \t\r"):
                return
            value = json.loads(line.decode("utf-8"), parse_constant=_bad_constant, parse_float=_float)
            raw = self.red.value(value)
            self.trace.put({"t": ts(now_ms()), "dir": self.dir, "raw": raw})
        except Exception:
            return


# ---------------------------------------------------------------- proxy
def write_all(fd, data):
    view = memoryview(data)
    while view:
        view = view[os.write(fd, view):]


def pump(rfd, wfd, lines, close, progress):
    alive = True
    while True:
        try:
            data = os.read(rfd, 65536)
        except OSError:
            data = b""
        if not data:
            break
        lines.feed(data)
        progress[0] += 1
        if alive:
            try:
                write_all(wfd, data)
            except OSError:
                alive = False
    lines.flush()
    if close:
        try:
            close()
        except OSError:
            pass


def parse_args(args):
    o = {"out": "./mcp-traces", "label": None, "redact": [], "defaults": True,
         "help": False, "version": False, "error": None, "command": []}
    i = 0
    while i < len(args):
        a = args[i]
        if a == "--":
            o["command"] = args[i + 1:]
            break
        if a in ("--out", "--label", "--redact"):
            if i + 1 >= len(args):
                o["error"] = "option %s needs a value" % a
                break
            v = args[i + 1]
            i += 2
            if a == "--redact":
                o["redact"].append(v)
            else:
                o[a[2:]] = v
            continue
        if a == "--no-redact-defaults":
            o["defaults"] = False
        elif a in ("--help", "-h"):
            o["help"] = True
        elif a in ("--version", "-v"):
            o["version"] = True
        elif a.startswith("--"):
            o["error"] = o["error"] or "unknown option %s" % a
        elif not a.startswith("-"):
            o["command"] = args[i:]
            break
        i += 1
    return o


def fail(msg, code):
    sys.stderr.write("tape: %s\n" % msg)
    sys.stderr.flush()
    return code


def main(argv):
    o = parse_args(argv)
    if o["help"]:
        sys.stdout.write(USAGE)
        return 0
    if o["version"]:
        sys.stdout.write("tape %s\n" % VERSION)
        return 0
    if o["error"] or not o["command"]:
        return fail(o["error"] or "no command given\n" + USAGE, 2)
    try:
        red = Redactor(o["redact"], o["defaults"])
    except re.error as e:
        return fail("invalid --redact pattern: %s" % e, 2)

    start = now_ms()
    command = o["command"]
    shown = [red.string(a) for a in command]
    label = o["label"] if o["label"] is not None else derive_label(shown)
    path = os.path.join(o["out"], ts(start).replace(":", "-").replace(".", "-") + "-" + file_name_part(label) + ".jsonl")
    try:
        os.makedirs(o["out"], exist_ok=True)
        f = open(path, "xb")
    except OSError as e:
        return fail("cannot create trace file: %s" % e, 1)
    trace = Trace(f, start)
    trace.put({"v": 1, "type": "meta", "startedAt": ts(start), "label": label, "command": shown})

    holder, pending = [None], []
    if os.name == "posix":
        def forward(sig, frame):
            if holder[0] is None:
                pending.append(sig)
            else:
                try:
                    holder[0].send_signal(sig)
                except OSError:
                    pass
        signal.signal(signal.SIGINT, forward)
        signal.signal(signal.SIGTERM, forward)

    argv0 = list(command)
    if os.name == "nt" and not os.path.splitext(argv0[0])[1] and not re.search(r"[/\\]", argv0[0]):
        argv0[0] = shutil.which(argv0[0]) or argv0[0]
    try:
        child = subprocess.Popen(argv0, stdin=subprocess.PIPE, stdout=subprocess.PIPE, bufsize=0)
    except (OSError, ValueError) as e:
        sys.stderr.write("tape: cannot start %s: %s\n" % (command[0], e))
        trace.end(127)
        return 127
    holder[0] = child
    for sig in pending:
        child.send_signal(sig)

    progress = [0]
    t_in = threading.Thread(target=pump, daemon=True, args=(
        0, child.stdin.fileno(), Lines("in", trace, red), child.stdin.close, [0]))
    t_out = threading.Thread(target=pump, daemon=True, args=(
        child.stdout.fileno(), 1, Lines("out", trace, red), None, progress))
    t_in.start()
    t_out.start()

    rc = child.wait()
    last, idle = -1, time.time()
    while t_out.is_alive():
        t_out.join(0.2)
        if progress[0] != last:
            last, idle = progress[0], time.time()
        elif time.time() - idle > 3:
            break
    code = 128 - rc if rc < 0 else rc
    trace.end(code)
    return code


if __name__ == "__main__":
    status = main(sys.argv[1:])
    try:
        sys.stdout.flush()
        sys.stderr.flush()
    except OSError:
        pass
    os._exit(status & 0xFFFFFFFF if os.name == "nt" else status & 0xFF)
