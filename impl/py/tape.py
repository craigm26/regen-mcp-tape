#!/usr/bin/env python3
"""tape: a transparent stdio proxy for MCP servers that records a redacted JSONL trace."""
import json, math, os, re, shutil, signal, subprocess, sys, threading, time, warnings
from datetime import datetime, timezone, timedelta

warnings.simplefilter("ignore")
VERSION = "tape 1.1.2"
USAGE = """usage: tape [--out DIR] [--label NAME] [--redact REGEX]... [--no-redact-defaults] [--help] [--version] -- <command> [args...]

Runs <command> as a child, forwards stdio unchanged and writes a redacted JSONL trace into DIR (default ./mcp-traces).
"""
R = "[REDACTED]"
# ECMAScript character classes, spelled out for Python's re (used with re.A, so \b and \w are ASCII).
WS = r"\t\n\v\f\r    -     　﻿"
DOT = r"[^\n\r  ]"
WSRX = re.compile("[" + WS + "]")
WORD = re.compile('[^' + WS + '"]+')
ID_RX = re.compile(r"\bid_(?:rsa|ed25519|ecdsa|dsa)\b", re.A)
ENV_ID = re.compile(r"\.env")
IS_WORD = re.compile(r"[A-Za-z0-9_]")
ENV_CLASS = re.compile(r"[A-Za-z0-9._\-]*")
EXACT = {"api_key", "apiKey", "token", "bearer", "secret", "password", "passwd", "pwd", "private_key",
         "privateKey", "access_key", "accessKey", "authorization", "Authorization"}
KEY_RX = re.compile(r"password|passwd|\bpwd\b|secret|token|api[_-]?key|authorization|^bearer\Z|"
                    r"private[_-]?key|access[_-]?key", re.A | re.I)
SKIP_ARGS = {"npx", "-y", "--yes", "node", "bun", "deno", "run", "--"}


def sub_rx(src):
    rx = re.compile(src.replace("{WS}", WS).replace("{DOT}", DOT), re.A)
    return lambda s: rx.sub(R, s)


def _boundary(s, e):
    a = e > 0 and IS_WORD.match(s[e - 1]) is not None
    b = e < len(s) and IS_WORD.match(s[e]) is not None
    return a != b


def _env_end(w, p):
    """End of the longest `\\.env(?:\\.[A-Za-z0-9._\\-]+)?\\b` match starting at p, or -1."""
    q = p + 4
    if q < len(w) and w[q] == ".":
        m = ENV_CLASS.match(w, q + 1).end()
        for e in range(m, q + 1, -1):
            if _boundary(w, e):
                return e
    return q if _boundary(w, q) else -1


def _word_env(w):
    p = w.rfind(".env")
    while p >= 0:
        e = _env_end(w, p)
        if e >= 0:
            return R + w[e:]
        p = w.rfind(".env", 0, p)
    return w


def pat9(s):
    return re.sub(r"(://[^/:@{WS}]{1,128}:)[^/@{WS}]+(?=@)".replace("{WS}", WS), lambda m: m.group(1) + R, s)


def pat10(s):
    return WORD.sub(lambda m: _word_env(m.group()), s) if ".env" in s else s


def pat11(s):
    return WORD.sub(lambda m: R if ID_RX.search(m.group()) else m.group(), s) if "id_" in s else s


P1_4 = [sub_rx(r"\bAKIA[0-9A-Z]{16}\b"), sub_rx(r"\bsk-[A-Za-z0-9_-]{20,}\b"),
        sub_rx(r"\bgh[pousr]_[A-Za-z0-9]{36,}\b"), sub_rx(r"\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\b")]
P5_11 = [sub_rx(r"[Aa]uthorization[{WS}]*:[{WS}]*{DOT}+"), sub_rx(r"[Bb]earer[{WS}]+[A-Za-z0-9._\-+/=]+"),
         sub_rx(r"\b(?:xoxb|xoxa|xoxp|xoxr|xoxs)-[A-Za-z0-9-]{10,}"), sub_rx(r"\b(?:rk_live|sk_live)_[A-Za-z0-9]{8,}\b"),
         pat9, pat10, pat11]


def es2py(p):
    """Translate the ECMAScript subset allowed in --redact patterns to Python syntax."""
    out, i, cls = [], 0, False
    while i < len(p):
        c = p[i]
        if c == "\\" and i + 1 < len(p):
            n = p[i + 1]
            i += 2
            if n == "s":
                out.append(WS if cls else "[" + WS + "]")
            elif n == "S" and not cls:
                out.append("[^" + WS + "]")
            else:
                out.append("\\" + n)
            continue
        if cls:
            out.append("\\[" if c == "[" else c)
            cls = c != "]"
        elif c == "[":
            cls = True
            out.append(c)
            if p.startswith("^", i + 1):
                out.append("^")
                i += 1
        elif c == ".":
            out.append(DOT)
        elif c == "$":
            out.append(r"\Z")
        elif p.startswith("(?<", i) and i + 3 < len(p) and p[i + 3] not in "=!":
            out.append("(?P<")
            i += 3
            continue
        else:
            out.append(c)
        i += 1
    return "".join(out)


def walk_str(v, f):
    if isinstance(v, str):
        return f(v)
    if isinstance(v, list):
        return [walk_str(x, f) for x in v]
    if isinstance(v, dict):
        return {k: walk_str(x, f) for k, x in v.items()}
    return v


def step1(v):
    if isinstance(v, list):
        return [step1(x) for x in v]
    if isinstance(v, dict):
        return {k: R if k in EXACT else step1(x) for k, x in v.items()}
    return v


def step3(v):
    if isinstance(v, list):
        return [step3(x) for x in v]
    if isinstance(v, dict):
        return {k: R if isinstance(x, (str, dict, list)) and KEY_RX.search(k) else step3(x) for k, x in v.items()}
    return v


class Redactor:
    def __init__(self, defaults, user):
        self.defaults, self.user = defaults, user
        self.s2 = (P1_4 + P5_11) if defaults else []
        self.s4 = (P1_4 if defaults else []) + user

    @staticmethod
    def _apply(fns, s):
        for f in fns:
            s = f(s)
        return s

    def string(self, s):
        return self._apply(self.s4, self._apply(self.s2, s))

    def message(self, v):
        if self.defaults:
            v = walk_str(step3(walk_str(step1(v), lambda s: self._apply(self.s2, s))), lambda s: self._apply(self.s4, s))
        elif self.user:
            v = walk_str(v, lambda s: self._apply(self.user, s))
        return v


def derive_label(command):
    for a in reversed(command):
        if a.startswith("-") or a in SKIP_ARGS or WSRX.search(a):
            continue
        x = re.sub(r"[^A-Za-z0-9-]", "-", re.split(r"[/\\]", a)[-1]).lower()[:32]
        if x:
            return x
    return "mcp"


def ms(dt):
    return (dt - datetime(1970, 1, 1, tzinfo=timezone.utc)) // timedelta(milliseconds=1)


def stamp(dt, sep=":"):
    return dt.strftime("%Y-%m-%dT%H{0}%M{0}%S".format(sep)) + ("." if sep == ":" else "-") + "%03dZ" % (dt.microsecond // 1000)


class Trace:
    def __init__(self, out, label, command, start):
        name = re.sub(r"[^A-Za-z0-9_-]", "-", label)[:64] or "mcp"
        os.makedirs(out, exist_ok=True)
        self.f = open(os.path.join(out, "%s-%s.jsonl" % (stamp(start, "-"), name)), "wb")
        self.start, self.lock = start, threading.Lock()
        self.write({"v": 1, "type": "meta", "startedAt": stamp(start), "label": label, "command": command})

    def write(self, obj):
        line = json.dumps(obj, separators=(",", ":")).encode("ascii") + b"\n"
        with self.lock:
            self.f.write(line)
            self.f.flush()

    def message(self, d, raw):
        self.write({"t": stamp(datetime.now(timezone.utc)), "dir": d, "raw": raw})

    def end(self, code):
        now = datetime.now(timezone.utc)
        self.write({"t": stamp(now), "type": "end", "exitCode": code, "durationMs": max(0, ms(now) - ms(self.start))})
        self.f.close()


def _no_const(name):
    raise ValueError(name)


def _float(s):
    f = float(s)
    return f if math.isfinite(f) else None


class Lines:
    """Splits one direction's bytes at LF and logs each line that is a JSON message."""

    def __init__(self, direction, trace, redactor):
        self.d, self.trace, self.red, self.buf = direction, trace, redactor, bytearray()

    def feed(self, data):
        start, pos = len(self.buf), 0
        self.buf += data
        while True:
            i = self.buf.find(b"\n", max(pos, start))
            if i < 0:
                break
            self.handle(bytes(self.buf[pos:i]))
            pos = i + 1
        del self.buf[:pos]

    def finish(self):
        if self.buf:
            self.handle(bytes(self.buf))
            self.buf.clear()

    def handle(self, line):
        try:
            text = line.decode("utf-8")
            if not text.strip(" \t\r"):
                return
            raw = json.loads(text, parse_float=_float, parse_constant=_no_const)
            self.trace.message(self.d, self.red.message(raw))
        except Exception:
            return


def write_all(fd, data):
    view = memoryview(data)
    while view:
        view = view[os.write(fd, view):]


def pump(src, dst, lines, activity, close_dst=None):
    """Copy src fd to dst fd (dst None: stdin of nothing), then log the lines seen."""
    ok = True
    while True:
        try:
            data = os.read(src, 65536)
        except OSError:
            data = b""
        if not data:
            break
        if ok:
            try:
                write_all(dst, data)
            except OSError:
                ok = False
                if close_dst:
                    break
        if lines:
            lines.feed(data)
        activity[0] = time.monotonic()
    if lines:
        lines.finish()
    if close_dst:
        try:
            close_dst()
        except OSError:
            pass


def parse_args(argv):
    o = {"out": "./mcp-traces", "label": None, "redact": [], "defaults": True, "help": False, "version": False,
         "command": [], "error": None}
    i = 0
    while i < len(argv):
        a = argv[i]
        if a == "--":
            o["command"] = argv[i + 1:]
            break
        if a in ("--out", "--label", "--redact"):
            if i + 1 >= len(argv):
                o["error"] = "option %s needs a value" % a
                break
            v = argv[i + 1]
            if a == "--redact":
                o["redact"].append(v)
            else:
                o[a[2:]] = v
            i += 2
            continue
        if a == "--no-redact-defaults":
            o["defaults"] = False
        elif a in ("--help", "-h"):
            o["help"] = True
        elif a in ("--version", "-v"):
            o["version"] = True
        elif a.startswith("-"):
            o["error"] = o["error"] or "unknown option %s" % a
        else:
            o["command"] = argv[i:]
            break
        i += 1
    return o


def usage_error(msg):
    sys.stderr.write("tape: %s\n%s" % (msg, USAGE))
    sys.stderr.flush()
    return 2


def resolve(command):
    if os.name == "nt" and not any(c in command[0] for c in "/\\") and not os.path.splitext(command[0])[1]:
        found = shutil.which(command[0])
        if found:
            return [found] + command[1:]
    return command


def main(argv):
    o = parse_args(argv)
    if o["help"]:
        sys.stdout.write(USAGE)
        return 0
    if o["version"]:
        sys.stdout.write(VERSION + "\n")
        return 0
    if o["error"] is None and not o["command"]:
        o["error"] = "no command given"
    user = []
    if o["error"] is None:
        for p in o["redact"]:
            try:
                user.append(sub_rx_user(p))
            except (re.error, OverflowError, RecursionError) as e:
                o["error"] = "invalid --redact pattern %r: %s" % (p, e)
                break
    if o["error"]:
        return usage_error(o["error"])

    start = datetime.now(timezone.utc)
    red = Redactor(o["defaults"], user)
    command = o["command"]
    shown = [red.string(a) for a in command]
    label = o["label"] if o["label"] is not None else derive_label(shown)
    try:
        trace = Trace(o["out"], label, shown, start)
    except OSError as e:
        sys.stderr.write("tape: cannot create trace file: %s\n" % e)
        return 1

    state = {"child": None, "pending": []}

    def on_signal(sig, frame):
        state["pending"].append(sig)
        if state["child"] is not None:
            state["child"].send_signal(sig)

    if os.name == "posix":
        signal.signal(signal.SIGINT, on_signal)
        signal.signal(signal.SIGTERM, on_signal)
    try:
        child = subprocess.Popen(resolve(command), stdin=subprocess.PIPE, stdout=subprocess.PIPE,
                                 stderr=subprocess.PIPE, bufsize=0)
    except (OSError, ValueError) as e:
        sys.stderr.write("tape: cannot start %s: %s\n" % (command[0], e))
        trace.end(127)
        return 127
    state["child"] = child
    for sig in state["pending"]:
        child.send_signal(sig)

    activity = [time.monotonic()]
    cin, cout, cerr = child.stdin.fileno(), child.stdout.fileno(), child.stderr.fileno()
    threads = [
        threading.Thread(target=pump, args=(0, cin, Lines("in", trace, red), activity, child.stdin.close), daemon=True),
        threading.Thread(target=pump, args=(cout, 1, Lines("out", trace, red), activity), daemon=True),
        threading.Thread(target=pump, args=(cerr, 2, None, activity), daemon=True),
    ]
    for t in threads:
        t.start()
    rc = child.wait()
    activity[0] = time.monotonic()
    for t in threads[1:]:
        while t.is_alive():
            t.join(0.1)
            if time.monotonic() - activity[0] > 3:
                break
    code = 128 - rc if rc < 0 else rc
    trace.end(code)
    return code


def sub_rx_user(p):
    rx = re.compile(es2py(p), re.A)
    return lambda s: rx.sub(R, s)


if __name__ == "__main__":
    status = main(sys.argv[1:])
    sys.stdout.flush()
    sys.stderr.flush()
    os._exit(status)
