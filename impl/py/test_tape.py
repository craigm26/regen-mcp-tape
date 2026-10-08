import base64
import glob
import json
import os
import re
import signal
import subprocess
import sys
import tempfile
import threading
import time
import unittest
import warnings

HERE = os.path.dirname(os.path.abspath(__file__))
TAPE = os.path.join(HERE, "tape.py")
PY = sys.executable
sys.path.insert(0, HERE)
import tape  # noqa: E402

warnings.simplefilter('ignore')
ECHO = ("import sys\nfor d in iter(lambda: sys.stdin.buffer.read1(65536), b''):\n"
        " sys.stdout.buffer.write(d); sys.stdout.buffer.flush()\n")
POSIX = os.name == "posix"
STAMP = re.compile(r"^\d{4}-\d\d-\d\dT\d\d-\d\d-\d\d-\d{3}Z-")
TIME = re.compile(r"^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$")


def py(code):
    return [PY, "-c", code]


class Result:
    pass


def run(args, chunks=(b"",), close=True, cwd=None, env=None, timeout=15, out=None):
    outdir = out or tempfile.mkdtemp()
    errf = tempfile.TemporaryFile()
    full = [PY, TAPE] + (["--out", outdir] if out != "" else []) + list(args)
    p = subprocess.Popen(full, stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=errf, cwd=cwd, env=env)

    def feed():
        try:
            for c in chunks:
                p.stdin.write(c)
                p.stdin.flush()
                if len(chunks) > 1:
                    time.sleep(0.1)
            if close:
                p.stdin.close()
        except OSError:
            pass
    th = threading.Thread(target=feed, daemon=True)
    th.start()
    r = Result()
    r.stdout = p.stdout.read()
    r.rc = p.wait(timeout=timeout)
    errf.seek(0)
    r.stderr = errf.read()
    r.proc, r.outdir = p, outdir
    p.stdout.close()
    errf.close()
    r.files = sorted(glob.glob(os.path.join(outdir, "*.jsonl")))
    r.trace = []
    if r.files:
        with open(r.files[0], "rb") as f:
            r.trace = [json.loads(line) for line in f.read().decode("utf-8").split("\n") if line]
    r.msgs = [t for t in r.trace if "dir" in t]
    return r


def echo_run(chunks, extra=(), **kw):
    return run(list(extra) + ["--label", "t", "--"] + py(ECHO), chunks, **kw)


class Interface(unittest.TestCase):
    def test_regen_json(self):  # REQ-IF-001
        with open(os.path.join(HERE, "REGEN.json")) as f:
            d = json.load(f)
        self.assertEqual(d["lang"], "py")
        for k in ("build", "test", "driver"):
            self.assertIn(k, d)
        drv = d["driver"]
        self.assertIn("default", drv)
        for v in drv.values():
            self.assertFalse(re.search(r"[\"'|&<>]", v))
        self.assertEqual(os.path.exists(os.path.join(HERE, drv["default"].split()[1])), True)


class Cli(unittest.TestCase):
    def test_options(self):  # REQ-CLI-001
        r = run(["--label", "my server/v2", "--redact", "foo", "--redact", "bar", "--no-redact-defaults",
                 "--"] + py("print('foo bar baz sk-aaaaaaaaaaaaaaaaaaaaaaaa')"))
        self.assertEqual(r.rc, 0)
        self.assertEqual(r.trace[0]["label"], "my server/v2")
        self.assertTrue(r.files[0].endswith("-my-server-v2.jsonl"))
        r = run(["--redact", "x", "--out", os.path.join(tempfile.mkdtemp(), "a", "b"), "--",
                 sys.executable, "-c", "pass"], out="")
        self.assertEqual(r.rc, 0)

    def test_default_out(self):  # REQ-CLI-001
        cwd = tempfile.mkdtemp()
        r = subprocess.run([PY, TAPE, "--", PY, "-c", "pass"], cwd=cwd, timeout=15)
        self.assertEqual(r.returncode, 0)
        self.assertEqual(len(glob.glob(os.path.join(cwd, "mcp-traces", "*.jsonl"))), 1)

    def test_option_value_is_next_arg(self):  # REQ-CLI-001
        r = run(["--label", "--out", "--"] + py("pass"))
        self.assertEqual(r.trace[0]["label"], "--out")

    def test_command_without_dashes(self):  # REQ-CLI-002
        code = "import sys;print(sys.argv[1:])"
        r = run(["--label", "x", PY, "-c", code, "--out", "y"])
        self.assertEqual(r.stdout.strip(), b"['--out', 'y']")
        r = run(["--", PY, "-c", code, "--label", "z"])
        self.assertEqual(r.stdout.strip(), b"['--label', 'z']")

    def test_help_version(self):  # REQ-CLI-003
        for a in (["--help"], ["-h"], ["--version"], ["-v"], ["--version", "--help"]):
            r = run(a)
            self.assertEqual(r.rc, 0)
            self.assertTrue(r.stdout)
            self.assertEqual(r.files, [])
        self.assertEqual(run(["--version", "--help"]).stdout, run(["--help"]).stdout)
        r = run(["--help", "--"] + py("print('child')"))
        self.assertNotIn(b"child", r.stdout)

    def test_usage_errors(self):  # REQ-CLI-004
        for a in (["--bogus", "--", "x"], ["--out"], [], ["--label", "x"], ["--redact", "(", "--", "x"],
                  ["--"]):
            r = run(a)
            self.assertEqual(r.rc, 2, a)
            self.assertEqual(r.stdout, b"")
            self.assertTrue(r.stderr)
            self.assertEqual(r.files, [])


class Forwarding(unittest.TestCase):
    def test_bytes_unchanged(self):  # REQ-FW-001, REQ-FW-002
        data = b'{"a":1}\r\n\r\n\xff\xfe bad\n   \n[1,2]\n{"unterminated": '
        r = echo_run([data])
        self.assertEqual(r.stdout, data)
        big = b'{"x":"' + base64.b64encode(os.urandom(2_000_000)) + b'"}\n'
        r = echo_run([big, b'{"after":1}\n'])
        self.assertEqual(r.stdout, big + b'{"after":1}\n')
        self.assertEqual(len(r.msgs), 4)

    def test_secrets_forwarded(self):  # REQ-FW-001
        data = b'{"password":"hunter2"}\n'
        r = echo_run([data])
        self.assertEqual(r.stdout, data)
        self.assertEqual(r.msgs[0]["raw"], {"password": "[REDACTED]"})

    def test_stderr(self):  # REQ-FW-003
        code = "import sys;sys.stderr.buffer.write(b'e1\\xff\\n');sys.stderr.buffer.flush();sys.stderr.buffer.write(b'e2')"
        r = run(["--"] + py(code))
        self.assertIn(b"e1\xff\ne2", r.stderr)

    def test_eof_closes_child_stdin(self):  # REQ-FW-004
        r = echo_run([b"a\n", b"b\n"])
        self.assertEqual(r.rc, 0)
        self.assertEqual(r.stdout, b"a\nb\n")

    def test_child_exit_with_stdin_open(self):  # REQ-FW-005
        t0 = time.time()
        r = run(["--"] + py("import sys;sys.stdout.write('bye\\n')"), [b"x\n"], close=False)
        self.assertEqual(r.stdout, b"bye\n")
        self.assertLess(time.time() - t0, 10)
        self.assertEqual(r.trace[-1]["type"], "end")
        r.proc.stdin.close()

    def test_env_cwd(self):  # REQ-FW-006
        d = tempfile.mkdtemp()
        env = dict(os.environ, TAPE_X="42")
        r = run(["--", PY, "-c", "import os;print(os.environ['TAPE_X'], os.getcwd())"], cwd=d, env=env)
        self.assertEqual(r.stdout.split()[0], b"42")
        self.assertEqual(os.path.realpath(r.stdout.split(None, 1)[1].decode().strip()), os.path.realpath(d))


class ExitStatus(unittest.TestCase):
    def test_exit_code(self):  # REQ-EX-001
        for n in (0, 1, 3, 200):
            r = run(["--"] + py("import sys;sys.exit(%d)" % n))
            self.assertEqual(r.rc, n)
            self.assertEqual(r.trace[-1]["exitCode"], n)

    @unittest.skipUnless(POSIX, "POSIX only")
    def test_signal_exit(self):  # REQ-EX-002
        for sig in (signal.SIGTERM, signal.SIGKILL, signal.SIGUSR1):
            r = run(["--"] + py("import os,signal;os.kill(os.getpid(), %d)" % sig))
            self.assertEqual(r.rc, 128 + sig)
            self.assertEqual(r.trace[-1]["exitCode"], 128 + sig)

    @unittest.skipUnless(POSIX, "POSIX only")
    def test_signal_forward(self):  # REQ-EX-003
        code = ("import signal,sys,time\nsignal.signal(signal.SIGTERM, lambda *a: sys.exit(0))\n"
                "print('ready', flush=True)\ntime.sleep(30)")
        for sig, expect in ((signal.SIGTERM, 0), (signal.SIGINT, 130)):
            body = code if sig == signal.SIGTERM else (
                "import signal,time\nsignal.signal(signal.SIGINT, signal.SIG_DFL)\nprint('ready', flush=True)\ntime.sleep(30)")
            p = subprocess.Popen([PY, TAPE, "--out", tempfile.mkdtemp(), "--"] + py(body),
                                 stdin=subprocess.PIPE, stdout=subprocess.PIPE)
            self.assertEqual(p.stdout.readline(), b"ready\n")
            p.send_signal(sig)
            self.assertEqual(p.wait(timeout=15), expect)

    def test_cannot_start(self):  # REQ-EX-004
        r = run(["--label", "n", "--", "/no/such/program-xyz"])
        self.assertEqual(r.rc, 127)
        self.assertTrue(r.stderr)
        self.assertEqual(r.trace[0]["type"], "meta")
        self.assertEqual(r.trace[-1]["exitCode"], 127)

    def test_cannot_create_trace(self):  # REQ-EX-005
        f = os.path.join(tempfile.mkdtemp(), "file")
        open(f, "w").close()
        marker = os.path.join(tempfile.mkdtemp(), "ran")
        r = run(["--out", f, "--"] + py("open(%r,'w')" % marker), out="")
        self.assertEqual(r.rc, 1)
        self.assertTrue(r.stderr)
        self.assertFalse(os.path.exists(marker))


class TraceFile(unittest.TestCase):
    def test_name_and_structure(self):  # REQ-TR-001..005
        r = echo_run([b'{"jsonrpc":"2.0","id":1,"method":"ping"}\n'], extra=["--label", "a b!"])
        self.assertEqual(len(r.files), 1)
        base = os.path.basename(r.files[0])
        self.assertTrue(STAMP.match(base) and base.endswith("-t.jsonl"), base)
        with open(r.files[0], "rb") as fh:
            raw = fh.read()
        self.assertTrue(raw.endswith(b"\n"))
        meta, *_, end = r.trace
        self.assertEqual((meta["v"], meta["type"]), (1, "meta"))
        self.assertTrue(TIME.match(meta["startedAt"]))
        self.assertEqual(meta["command"][0], PY)
        self.assertEqual(sum(1 for t in r.trace if t.get("type") == "meta"), 1)
        self.assertEqual(sum(1 for t in r.trace if t.get("type") == "end"), 1)
        for m in r.msgs:
            self.assertTrue(TIME.match(m["t"]))
            self.assertIn(m["dir"], ("in", "out"))
        self.assertEqual(sorted(m["dir"] for m in r.msgs), ["in", "out"])
        self.assertTrue(TIME.match(end["t"]))
        self.assertIsInstance(end["durationMs"], int)
        self.assertGreaterEqual(end["durationMs"], 0)
        self.assertEqual(end["exitCode"], 0)

    def test_name_rules(self):  # REQ-TR-001
        self.assertEqual(tape.file_name_part("my server/v2"), "my-server-v2")
        self.assertEqual(tape.file_name_part(""), "mcp")
        self.assertEqual(tape.file_name_part("a" * 100), "a" * 64)
        self.assertEqual(tape.file_name_part("a_b-C9é"), "a_b-C9-")

    def test_which_lines(self):  # REQ-TR-007
        data = (b'{"a":1}\n \t\r\n\nnot json\n"str"\n42\nnull\ntrue\n[{"b":2}]\n{"c":3}\r\n'
                b'{"u":"\xc3\xa9\xe2\x82\xac"}\n')
        r = echo_run([data])
        ins = [m["raw"] for m in r.msgs if m["dir"] == "in"]
        self.assertEqual(ins, [{"a": 1}, "str", 42, None, True, [{"b": 2}], {"c": 3}, {"u": "é€"}])

    def test_split_multibyte(self):  # REQ-TR-007
        line = '{"u":"é€😀"}\n'.encode()
        chunks = [line[:7], line[7:9], line[9:12], line[12:]]
        r = echo_run(chunks)
        self.assertEqual([m["raw"] for m in r.msgs if m["dir"] == "in"], [{"u": "é€😀"}])
        self.assertEqual([m["raw"] for m in r.msgs if m["dir"] == "out"], [{"u": "é€😀"}])

    def test_final_line(self):  # REQ-TR-008
        r = echo_run([b'{"a":1}\n{"b":2}'])
        self.assertEqual([m["raw"] for m in r.msgs if m["dir"] == "in"], [{"a": 1}, {"b": 2}])

    def test_order(self):  # REQ-TR-009
        data = b"".join(b'{"n":%d}\n' % i for i in range(200))
        r = echo_run([data])
        for d in ("in", "out"):
            self.assertEqual([m["raw"]["n"] for m in r.msgs if m["dir"] == d], list(range(200)))

    def test_numbers(self):  # REQ-TR-010
        r = echo_run([b'{"a":1.0,"b":0.1,"c":1e300,"d":-2.5e-7,"e":9007199254740991}\n'])
        raw = r.msgs[0]["raw"]
        self.assertEqual((raw["a"], raw["b"], raw["c"], raw["d"], raw["e"]),
                         (1.0, 0.1, 1e300, -2.5e-7, 9007199254740991))

    def test_proto_member(self):
        r = echo_run([b'{"__proto__":{"x":1},"constructor":2}\n'])
        self.assertEqual(r.msgs[0]["raw"], {"__proto__": {"x": 1}, "constructor": 2})


class Label(unittest.TestCase):
    def test_examples(self):  # REQ-LB-001
        cases = [("node /opt/server.js", "server-js"), ("npx -y my-remote", "my-remote"),
                 ("node srv.js --port 3000", "3000"), ("node C:\\srv\\files.mjs", "files-mjs"),
                 ("node KEY=value", "key-value"), ("npx -y --", "mcp")]
        for cmd, label in cases:
            self.assertEqual(tape.derive_label(cmd.split()), label)
        self.assertEqual(tape.derive_label(["npx", "-y", "srv", "https://example.test/mcp", "--header", "X-Key: abc"]),
                         "mcp")
        self.assertEqual(tape.derive_label(["a" * 50]), "a" * 32)

    def test_end_to_end_redacted(self):  # REQ-LB-001, REQ-RD-005
        r = run(["--", PY, "-c", "pass", "ghp_" + "A" * 36])
        self.assertEqual(r.trace[0]["label"], "-redacted-")
        self.assertTrue(r.files[0].endswith("--redacted-.jsonl"))
        self.assertEqual(r.trace[0]["command"][-1], "[REDACTED]")
        self.assertNotIn("ghp_", r.files[0])

    def test_explicit_label_exact(self):
        r = run(["--label", "Hello World", "--", PY, "-c", "pass"])
        self.assertEqual(r.trace[0]["label"], "Hello World")


def R(v, user=(), defaults=True):
    return tape.Redactor(user, defaults).value(v)


class Redaction(unittest.TestCase):
    def test_exact_keys(self):  # REQ-RD-001
        for k in ("api_key", "apiKey", "token", "bearer", "secret", "password", "passwd", "pwd", "private_key",
                  "privateKey", "access_key", "accessKey", "authorization", "Authorization"):
            for v in ("x", 1, True, None, {"a": 1}, [1]):
                self.assertEqual(R({"o": {k: v}}), {"o": {k: "[REDACTED]"}}, k)
        self.assertEqual(R({"Token": 5}), {"Token": 5})

    def test_string_patterns(self):  # REQ-RD-002
        S = lambda s: tape.Redactor().string(s)
        cases = [
            ("try AKIAIOSFODNN7EXAMPLE today", "try [REDACTED] today"),
            ("Authorization: Bearer abc.def", "[REDACTED]"),
            ("Authorization: x\r\nnext", "[REDACTED]\r\nnext"),
            ("postgres://admin:hunter2@db:5432/x", "postgres://admin:[REDACTED]@db:5432/x"),
            ("load /srv/app/.env.local now", "load [REDACTED] now"),
            ("key is ~/.ssh/id_ed25519.pub", "key is [REDACTED]"),
            ("café AKIAIOSFODNN7EXAMPLE", "café [REDACTED]"),
            ("éAKIAIOSFODNN7EXAMPLE", "é[REDACTED]"),
            ("a/.env.x+b/.env", "[REDACTED]"),
            ("my.envy", "my.envy"),
            ("cfg/.env.", "[REDACTED]."),
            (".env.env-id_", "[REDACTED]-id_"),
            ("sk-" + "a" * 20, "[REDACTED]"),
            ("ghp_" + "A" * 36, "[REDACTED]"),
            ("eyJhbGc.eyJzdWI.sig_-x", "[REDACTED]"),
            ("xoxb-1234567890-abc", "[REDACTED]"),
            ("sk_live_abcdefgh1", "[REDACTED]"),
            ("bearer  abc/def=", "[REDACTED]"),
            ('"quoted/.env" and x', '"[REDACTED]" and x'),
        ]
        for a, b in cases:
            self.assertEqual(S(a), b, a)

    def test_key_substrings(self):  # REQ-RD-003
        self.assertEqual(R({"db_password": "x"}), {"db_password": "[REDACTED]"})
        self.assertEqual(R({"max_tokens": 100}), {"max_tokens": 100})
        self.assertEqual(R({"progressToken": "abc"}), {"progressToken": "[REDACTED]"})
        self.assertEqual(R({"tokens": [1, 2]}), {"tokens": "[REDACTED]"})
        self.assertEqual(R({"my-pwd": "x", "pwdx": "y", "BEARER": "z", "xbearer": "w", "Api-Key2": {"a": 1}}),
                         {"my-pwd": "[REDACTED]", "pwdx": "y", "BEARER": "[REDACTED]", "xbearer": "w",
                          "Api-Key2": "[REDACTED]"})
        self.assertEqual(R({"secretFlag": True, "n": {"secret_x": None, "k": "v"}}),
                         {"secretFlag": True, "n": {"secret_x": None, "k": "v"}})

    def test_user_patterns(self):  # REQ-RD-004
        u = ["^id", "end$"]
        S = lambda s, d=True: R(s, u, d)
        self.assertEqual(S("id 7"), "[REDACTED] 7")
        self.assertEqual(S("my id"), "my id")
        self.assertEqual(S("the end"), "the [REDACTED]")
        self.assertEqual(S("the end\n"), "the end\n")
        self.assertEqual(S("a\nid"), "a\nid")
        self.assertEqual(R("x.y\rz", ["x.y"]), "x.y\rz".replace("x.y", "[REDACTED]"))
        self.assertEqual(R("a\rb", ["a.b"]), "a\rb")
        self.assertEqual(R("ID", ["id"]), "ID")
        self.assertEqual(R("a\u00a0b", [r"a\sb"]), "[REDACTED]")
        self.assertEqual(R({"password": "x", "k": "AKIAIOSFODNN7EXAMPLE foo"}, ["foo"], False),
                         {"password": "x", "k": "AKIAIOSFODNN7EXAMPLE [REDACTED]"})

    def test_command_redaction(self):  # REQ-RD-005
        r = run(["--redact", "zzz", "--", PY, "-c", "pass", "azzzb", "AKIAIOSFODNN7EXAMPLE"])
        self.assertEqual(r.trace[0]["command"][-2:], ["a[REDACTED]b", "[REDACTED]"])
        r = run(["--no-redact-defaults", "--redact", "zzz", "--", PY, "-c", "pass", "azzzb", "AKIAIOSFODNN7EXAMPLE"])
        self.assertEqual(r.trace[0]["command"][-2:], ["a[REDACTED]b", "AKIAIOSFODNN7EXAMPLE"])

    def test_large_blob(self):  # REQ-RD-006
        blob = base64.b64encode(os.urandom(1_600_000)).decode()
        self.assertGreater(len(blob), 2_000_000)
        t0 = time.time()
        r = echo_run([json.dumps({"p": blob}).encode() + b'\n{"next":1}\n'])
        self.assertLess(time.time() - t0, 12)
        self.assertEqual(r.msgs[0]["raw"]["p"], blob)
        self.assertEqual(len(r.msgs), 4)
        t0 = time.time()
        tape.Redactor().string("." * 2_000_000 + "env/" * 1000)
        tape.Redactor().string(".env." * 400_000)
        self.assertLess(time.time() - t0, 10)

    def test_end_to_end_default_redaction(self):
        r = echo_run([b'{"params":{"authorization":"x","note":"AKIAIOSFODNN7EXAMPLE"}}\n'])
        self.assertEqual(r.msgs[0]["raw"], {"params": {"authorization": "[REDACTED]", "note": "[REDACTED]"}})


class Platform(unittest.TestCase):
    @unittest.skipUnless(os.name == "nt", "Windows only")
    def test_path_lookup(self):  # REQ-PL-001
        r = run(["--", "python", "-c", "print(1)"])
        self.assertEqual(r.rc, 0)

    def test_arguments_exact(self):  # REQ-PL-002
        args = ["a b", 'say "hi"', "", "plain", "c:\\dir\\", "x y\\\"z"]
        r = run(["--", PY, "-c", "import sys,json;print(json.dumps(sys.argv[1:]))"] + args)
        self.assertEqual(json.loads(r.stdout), args)


class Budgets(unittest.TestCase):
    def test_size(self):  # REQ-BU-003
        n = 0
        for root, dirs, files in os.walk(HERE):
            if os.path.basename(root) in ("test", "tests"):
                continue
            for f in files:
                if f.endswith(".py") and not (f.startswith("test_") or f.endswith("_test.py") or ".test." in f):
                    with open(os.path.join(root, f), encoding="utf-8") as fh:
                        n += sum(1 for line in fh if line.strip())
        self.assertLessEqual(n, 450)


if __name__ == "__main__":
    unittest.main()
