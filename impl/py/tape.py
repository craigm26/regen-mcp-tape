"""tape: a transparent stdio proxy for MCP servers that writes a redacted JSONL trace."""
import json
import math
import os
import queue
import re
import shutil
import signal
import subprocess
import sys
import threading
import warnings
from datetime import datetime, timezone

VERSION = "1.1.0"
USAGE = ("usage: tape [--out DIR] [--label NAME] [--redact REGEX]... [--no-redact-defaults] "
         "[--help] [--version] -- <command> [args...]")
R = "[REDACTED]"
WS = " \t\n\v\f\r   -     　﻿"
S = "[" + WS + "]"
DOT = "[^\n\r  ]"
WORD = re.compile('[^' + WS + '"]+')
SSH = re.compile(r"\bid_(?:rsa|ed25519|ecdsa|dsa)\b", re.A)
SUFFIX = frozenset("ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789._-")
EXACT = {"api_key", "apiKey", "token", "bearer", "secret", "password", "passwd", "pwd",
         "private_key", "privateKey", "access_key", "accessKey", "authorization", "Authorization"}
KEYRE = re.compile(r"password|passwd|\bpwd\b|secret|token|api[_-]?key|authorization|^bearer\Z|"
                   r"private[_-]?key|access[_-]?key", re.A | re.I)
warnings.simplefilter("ignore")


def sub(rx, repl=R):
    c = re.compile(rx, re.A)
    return lambda s: c.sub(repl, s)


def isw(ch):
    return ch.isascii() and (ch.isalnum() or ch == "_")


def env_end(w, i):
    """End of the longest match of \\.env(?:\\.[A-Za-z0-9._\\-]+)?\\b starting at i, or -1."""
    n, j = len(w), i + 4

    def b(k):
        return (k > 0 and isw(w[k - 1])) != (k < n and isw(w[k]))
    if j + 1 < n and w[j] == ".":
        k = j + 1
        while k < n and w[k] in SUFFIX:
            k += 1
        for e in range(k, j + 1, -1):
            if b(e):
                return e
    return j if b(j) else -1


def p10(s):
    if ".env" not in s:
        return s

    def word(m):
        w = m.group()
        i = w.rfind(".env")
        while i >= 0:
            e = env_end(w, i)
            if e >= 0:
                return R + w[e:]
            i = w.rfind(".env", 0, i + 3)
        return w
    return WORD.sub(word, s)


def p11(s):
    if "id_" not in s:
        return s
    return WORD.sub(lambda m: R if SSH.search(m.group()) else m.group(), s)


P1_4 = [sub(r"\bAKIA[0-9A-Z]{16}\b"), sub(r"\bsk-[A-Za-z0-9_-]{20,}\b"),
        sub(r"\bgh[pousr]_[A-Za-z0-9]{36,}\b"),
        sub(r"\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\b")]
P5_11 = [sub("[Aa]uthorization" + S + "*:" + S + "*" + DOT + "+"),
         sub("[Bb]earer" + S + r"+[A-Za-z0-9._\-+/=]+"),
         sub(r"\b(?:xoxb|xoxa|xoxp|xoxr|xoxs)-[A-Za-z0-9-]{10,}"),
         sub(r"\b(?:rk_live|sk_live)_[A-Za-z0-9]{8,}\b"),
         sub("(://[^/:@" + WS + "]{1,128}:)[^/@" + WS + "]+(?=@)", r"\1" + R),
         p10, p11]


def js_regex(p):
    """Translate an ECMAScript pattern into Python syntax with ECMAScript meanings."""
    out, i, cls = [], 0, False
    while i < len(p):
        c = p[i]
        if c == "\\" and i + 1 < len(p):
            n = p[i + 1]
            if n == "s":
                out.append(WS if cls else S)
            elif n == "S" and not cls:
                out.append("[^" + WS + "]")
            else:
                out.append(c + n)
            i += 2
            continue
        if cls:
            cls = c != "]"
            out.append(c)
        elif c == "[":
            cls = True
            out.append(c)
        else:
            out.append(DOT if c == "." else r"\Z" if c == "$" else c)
        i += 1
    return re.compile("".join(out), re.A)


def tree(v, fn):
    if isinstance(v, dict):
        return {k: fn(k, x) for k, x in v.items()}
    if isinstance(v, list):
        return [tree(x, fn) for x in v]
    return v


def key_pass(v, rule):
    def fn(k, x):
        return R if rule(k, x) else key_pass(x, rule)
    return tree(v, fn)


def str_pass(v, fs):
    if isinstance(v, str):
        for f in fs:
            v = f(v)
        return v
    if isinstance(v, dict):
        return {k: str_pass(x, fs) for k, x in v.items()}
    if isinstance(v, list):
        return [str_pass(x, fs) for x in v]
    return v


class Redactor:
    def __init__(self, defaults, user):
        self.defaults = defaults
        self.user = [(lambda s, c=c: c.sub(R, s)) for c in user]
        self.str_rules = (P1_4 + P5_11 + P1_4 + self.user) if defaults else self.user

    def string(self, s):
        return str_pass(s, self.str_rules)

    def message(self, v):
        if not self.defaults:
            return str_pass(v, self.user)
        v = key_pass(v, lambda k, x: k in EXACT)
        v = str_pass(v, P1_4 + P5_11)
        v = key_pass(v, lambda k, x: isinstance(x, (str, dict, list)) and KEYRE.search(k))
        return str_pass(v, P1_4 + self.user)


def derive_label(command):
    skip = {"npx", "-y", "--yes", "node", "bun", "deno", "run", "--"}
    for a in reversed(command):
        if a.startswith("-") or a in skip or re.search(S, a):
            continue
        part = re.split(r"[/\\]", a)[-1]
        part = re.sub(r"[^A-Za-z0-9-]", "-", part).lower()[:32]
        if part:
            return part
    return "mcp"


def parse_args(argv):
    """Return (opts, error). opts has help, version, out, label, redact, defaults, command."""
    o = {"help": False, "version": False, "out": "./mcp-traces", "label": None,
         "redact": [], "defaults": True, "command": []}
    err = None
    i = 0
    while i < len(argv):
        a = argv[i]
        if a == "--":
            o["command"] = argv[i + 1:]
            break
        if a in ("--help", "-h"):
            o["help"] = True
        elif a in ("--version", "-v"):
            o["version"] = True
        elif a == "--no-redact-defaults":
            o["defaults"] = False
        elif a in ("--out", "--label", "--redact"):
            if i + 1 >= len(argv):
                err = err or "option %s needs a value" % a
                break
            i += 1
            if a == "--redact":
                try:
                    o["redact"].append(js_regex(argv[i]))
                except (re.error, RecursionError, OverflowError) as e:
                    err = err or "invalid --redact pattern %r: %s" % (argv[i], e)
            else:
                o[a[2:]] = argv[i]
        elif a.startswith("-"):
            err = err or "unknown option %s" % a
        else:
            o["command"] = argv[i:]
            break
        i += 1
    if not err and not o["command"]:
        err = "no command given"
    return o, err


def tstr(d):
    return d.strftime("%Y-%m-%dT%H:%M:%S.") + "%03dZ" % (d.microsecond // 1000)


def now():
    return datetime.now(timezone.utc)


def write_all(fd, data):
    try:
        while data:
            data = data[os.write(fd, data):]
        return True
    except OSError:
        return False


class Lines:
    """Splits one direction's bytes at LF and hands each line to submit."""

    def __init__(self, direction, submit):
        self.buf, self.d, self.submit = bytearray(), direction, submit

    def feed(self, data):
        start = len(self.buf)
        self.buf += data
        while True:
            k = self.buf.find(b"\n", start)
            if k < 0:
                return
            line = bytes(self.buf[:k])
            del self.buf[:k + 1]
            start = 0
            self.submit(self.d, line)

    def end(self):
        if self.buf:
            self.submit(self.d, bytes(self.buf))
            self.buf.clear()


def bad_constant(name):
    raise ValueError(name)


def finite(s):
    f = float(s)
    return f if math.isfinite(f) else None


def trace_line(direction, t, data, red):
    s = data.decode("utf-8")
    if not s.strip(" \t\r"):
        return None
    v = json.loads(s, parse_float=finite, parse_constant=bad_constant)
    return json.dumps({"t": t, "dir": direction, "raw": red.message(v)},
                      separators=(",", ":"), allow_nan=False)


def resolve(cmd):
    if sys.platform == "win32" and cmd and not re.search(r"[/\\]", cmd[0]) and not os.path.splitext(cmd[0])[1]:
        found = shutil.which(cmd[0])
        if found:
            return [found] + cmd[1:]
    return cmd


def main(argv):
    sys.setrecursionlimit(3000)
    sys.set_int_max_str_digits(0)
    o, err = parse_args(argv)
    if o["help"]:
        print(USAGE)
        return 0
    if o["version"]:
        print("tape " + VERSION)
        return 0
    if err:
        sys.stderr.write("tape: %s\n%s\n" % (err, USAGE))
        return 2
    red = Redactor(o["defaults"], o["redact"])
    command = o["command"]
    rcmd = [red.string(a) for a in command]
    label = o["label"] if o["label"] is not None else derive_label(rcmd)
    start = now()
    name = re.sub(r"[^A-Za-z0-9_-]", "-", label)[:64] or "mcp"
    try:
        os.makedirs(o["out"], exist_ok=True)
        path = os.path.join(o["out"], start.strftime("%Y-%m-%dT%H-%M-%S-") + "%03dZ-%s.jsonl"
                            % (start.microsecond // 1000, name))
        tf = open(path, "wb")
    except OSError as e:
        sys.stderr.write("tape: cannot create trace file: %s\n" % e)
        return 1

    def emit(obj):
        tf.write(json.dumps(obj, separators=(",", ":")).encode() + b"\n")
        tf.flush()
    emit({"v": 1, "type": "meta", "startedAt": tstr(start), "label": label, "command": rcmd})

    def finish(code):
        end = now()
        emit({"t": tstr(end), "type": "end", "exitCode": code,
              "durationMs": max(0, int((end - start).total_seconds() * 1000))})
        tf.close()
        return code

    child = []

    def forward_signal(signum, frame):
        if child:
            try:
                child[0].send_signal(signum)
            except OSError:
                pass
    if sys.platform != "win32":
        signal.signal(signal.SIGINT, forward_signal)
        signal.signal(signal.SIGTERM, forward_signal)
    try:
        proc = subprocess.Popen(resolve(command), stdin=subprocess.PIPE, stdout=subprocess.PIPE,
                                stderr=subprocess.PIPE, bufsize=0)
    except (OSError, ValueError) as e:
        sys.stderr.write("tape: cannot start %r: %s\n" % (command[0], e))
        return finish(127)
    child.append(proc)

    q, lock, closed = queue.Queue(), threading.Lock(), []

    def submit(d, data):
        with lock:
            if not closed:
                q.put((d, tstr(now()), data))

    def worker():
        while True:
            item = q.get()
            if item is None:
                return
            try:
                line = trace_line(*item, red)
                if line:
                    tf.write(line.encode() + b"\n")
                    tf.flush()
            except Exception:
                pass

    def pump(rfd, wfd, lines, after=None):
        ok = True
        while True:
            try:
                data = os.read(rfd, 65536)
            except OSError:
                break
            if not data:
                break
            if ok:
                ok = write_all(wfd, data)
            if lines:
                lines.feed(data)
        if lines:
            lines.end()
        if after:
            after()

    def close_child_stdin():
        try:
            proc.stdin.close()
        except OSError:
            pass
    wt = threading.Thread(target=worker)
    wt.start()
    t_in = threading.Thread(target=pump, args=(0, proc.stdin.fileno(), Lines("in", submit),
                                               close_child_stdin), daemon=True)
    t_out = threading.Thread(target=pump, args=(proc.stdout.fileno(), 1, Lines("out", submit)),
                             daemon=True)
    t_err = threading.Thread(target=pump, args=(proc.stderr.fileno(), 2, None), daemon=True)
    for t in (t_in, t_out, t_err):
        t.start()
    rc = proc.wait()
    t_out.join(5)
    t_err.join(5)
    with lock:
        closed.append(1)
    q.put(None)
    wt.join()
    code = rc if rc >= 0 else 128 - rc
    return finish(code)


if __name__ == "__main__":
    status = main(sys.argv[1:])
    sys.stdout.flush()
    sys.stderr.flush()
    os._exit(status)
