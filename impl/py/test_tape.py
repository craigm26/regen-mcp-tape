import glob, json, os, signal, subprocess, sys, tempfile, threading, time, unittest

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
import tape

ECHO = r'''
import sys
while True:
    b = sys.stdin.buffer.read1(65536)
    if not b: break
    sys.stdout.buffer.write(b); sys.stdout.buffer.flush()
sys.stderr.buffer.write(b"bye\n")
'''
PY = sys.executable
TAPE = os.path.join(HERE, "tape.py")


def run(args, data=b"", child=ECHO, close=True, timeout=15):
    tmp = tempfile.mkdtemp()
    cp = os.path.join(tmp, "srv.py")
    open(cp, "w").write(child)
    out = os.path.join(tmp, "o")
    cmd = [PY, TAPE, "--out", out] + args + ["--", PY, cp]
    p = subprocess.Popen(cmd, stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.PIPE, cwd=tmp)

    def feed():
        try:
            for c in (data if isinstance(data, list) else [data]):
                p.stdin.write(c); p.stdin.flush(); time.sleep(0.05)
            if close:
                p.stdin.close()
        except OSError:
            pass
    threading.Thread(target=feed, daemon=True).start()
    o, e = p.stdout.read(), p.stderr.read()
    p.wait(timeout=timeout)
    files = glob.glob(os.path.join(out, "*.jsonl"))
    lines = [json.loads(l) for f in files for l in open(f, encoding="utf-8")]
    return p.returncode, o, e, lines, files


Rd = tape.Redactor(True, [])


class T(unittest.TestCase):
    def test_forward_bytes(self):  # FW-001, FW-002, FW-003, FW-004, TR-008
        data = b'{"a":1}\r\n\n\xff\xfe junk\n' + b"x" * 3000000 + b"\n" + b'{"last":true}'
        rc, o, e, lines, _ = run([], data)
        self.assertEqual(o, data)
        self.assertEqual(e, b"bye\n")
        self.assertEqual(rc, 0)
        raws = [l["raw"] for l in lines if "raw" in l]
        self.assertEqual(raws.count({"a": 1}), 2)
        self.assertEqual(raws.count({"last": True}), 2)

    def test_format(self):  # TR-001..005, 007, 009, 010
        rc, o, e, lines, files = run(["--label", "my server/v2"], b'[1,2]\n   \r\n"s"\n 1.0 \nnull\nnot json\n')
        self.assertRegex(os.path.basename(files[0]), r"^\d{4}-\d\d-\d\dT\d\d-\d\d-\d\d-\d{3}Z-my-server-v2\.jsonl$")
        meta, end = lines[0], lines[-1]
        self.assertEqual((meta["v"], meta["type"], meta["label"]), (1, "meta", "my server/v2"))
        self.assertRegex(meta["startedAt"], r"^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$")
        self.assertEqual(end["type"], "end"); self.assertEqual(end["exitCode"], 0)
        self.assertGreaterEqual(end["durationMs"], 0)
        ins = [l["raw"] for l in lines[1:-1] if l["dir"] == "in"]
        self.assertEqual(ins, [[1, 2], "s", 1, None])

    def test_split_utf8(self):  # TR-007 step 1
        msg = '{"k":"é€"}\n'.encode()
        rc, o, e, lines, _ = run([], [msg[:7], msg[7:]])
        self.assertEqual(o, msg)
        self.assertIn({"k": "é€"}, [l.get("raw") for l in lines])

    def test_exit_codes(self):  # EX-001, EX-002
        self.assertEqual(run([], b"", child="import sys; sys.exit(7)")[0], 7)
        self.assertEqual(run([], b"", child="import os,signal; os.kill(os.getpid(), signal.SIGUSR1)")[0], 138)

    def test_child_exit_stdin_open(self):  # FW-005
        t = time.time()
        rc, o, e, lines, _ = run([], b"", child="print('hi')", close=False)
        self.assertEqual(o, b"hi\n"); self.assertLess(time.time() - t, 10)
        self.assertEqual(lines[-1]["type"], "end")

    def test_signal_forward(self):  # EX-003
        child = "import signal,sys,time\nsignal.signal(signal.SIGTERM, lambda *a: sys.exit(0))\nprint('r',flush=True)\ntime.sleep(30)"
        tmp = tempfile.mkdtemp(); cp = os.path.join(tmp, "s.py"); open(cp, "w").write(child)
        p = subprocess.Popen([PY, TAPE, "--out", tmp, "--", PY, cp], stdin=subprocess.PIPE, stdout=subprocess.PIPE)
        self.assertEqual(p.stdout.readline(), b"r\n")
        p.send_signal(signal.SIGTERM)
        self.assertEqual(p.wait(timeout=10), 0)

    def test_cannot_start(self):  # EX-004
        tmp = tempfile.mkdtemp()
        p = subprocess.run([PY, TAPE, "--out", tmp, "--", "/no/such/prog"], capture_output=True, input=b"")
        self.assertEqual(p.returncode, 127); self.assertTrue(p.stderr); self.assertEqual(p.stdout, b"")
        f = glob.glob(os.path.join(tmp, "*.jsonl"))
        self.assertEqual([json.loads(l) for l in open(f[0])][-1]["exitCode"], 127)

    def test_trace_uncreatable(self):  # EX-005
        tmp = tempfile.mkdtemp(); f = os.path.join(tmp, "file"); open(f, "w").close()
        p = subprocess.run([PY, TAPE, "--out", f, "--", PY, "-c", "open(%r,'w')" % (f + "x")], capture_output=True)
        self.assertEqual(p.returncode, 1); self.assertTrue(p.stderr)
        self.assertFalse(os.path.exists(f + "x"))

    def test_cli(self):  # CLI-001..004
        def r(*a): return subprocess.run([PY, TAPE, *a], capture_output=True, cwd=tempfile.mkdtemp())
        for a in (["--help"], ["-v"], ["--version", "--help"]):
            p = r(*a); self.assertEqual(p.returncode, 0); self.assertTrue(p.stdout)
        for a in (["--bogus", "x"], ["--out"], [], ["--redact", "("], ["--"], ["--label", "x"]):
            p = r(*a); self.assertEqual(p.returncode, 2, a); self.assertEqual(p.stdout, b""); self.assertTrue(p.stderr)
        d = tempfile.mkdtemp()
        p = subprocess.run([PY, TAPE, "--out", d, "--label", "x", PY, "-c", "import sys; print(sys.argv[1:])",
                            "--out", "y", "a b", '"q"'], capture_output=True)
        self.assertEqual(p.stdout.decode().strip(), "['--out', 'y', 'a b', '\"q\"']")
        self.assertEqual(len(glob.glob(d + "/*-x.jsonl")), 1)

    def test_default_out(self):  # CLI-001 default dir
        d = tempfile.mkdtemp()
        subprocess.run([PY, TAPE, "--", PY, "-c", "pass"], cwd=d)
        self.assertEqual(len(glob.glob(d + "/mcp-traces/*.jsonl")), 1)

    def test_labels(self):  # LB-001
        cases = [(["node", "/opt/server.js"], "server-js"), (["npx", "-y", "my-remote"], "my-remote"),
                 (["node", "srv.js", "--port", "3000"], "3000"), (["node", "C:\\srv\\files.mjs"], "files-mjs"),
                 (["npx", "-y", "srv", "https://example.test/mcp", "--header", "X-Key: abc"], "mcp"),
                 (["node", "KEY=value"], "key-value"), (["npx", "-y", "--"], "mcp"),
                 (["node", "srv.js", "ghp_" + "A" * 36], "-redacted-")]
        for c, want in cases:
            self.assertEqual(tape.derive_label([Rd.string(a) for a in c]), want)

    def test_redaction_meta(self):  # RD-005
        d = tempfile.mkdtemp()
        subprocess.run([PY, TAPE, "--out", d, "--redact", "zzz", "--", PY, "-c", "pass", "ghp_" + "A" * 36, "zzz"])
        f = glob.glob(d + "/*.jsonl")[0]
        self.assertIn("redacted", f)
        self.assertEqual(json.loads(open(f).readline())["command"][-2:], ["[REDACTED]", "[REDACTED]"])

    def test_redaction_not_forwarded(self):  # FW-001 with redaction
        msg = b'{"password":"hunter2","x":"AKIAIOSFODNN7EXAMPLE"}\n'
        rc, o, e, lines, _ = run([], msg)
        self.assertEqual(o, msg)
        self.assertEqual(lines[1]["raw"], {"password": "[REDACTED]", "x": "[REDACTED]"})

    def test_big_blob(self):  # RD-006
        msg = b'{"d":"' + b"QUJD" * 500000 + b'"}\n'
        t = time.time()
        rc, o, e, lines, _ = run([], [msg, b'{"after":1}\n'])
        self.assertLess(time.time() - t, 12)
        self.assertEqual(o, msg + b'{"after":1}\n')
        self.assertEqual(sum(1 for l in lines if "raw" in l and "d" in l["raw"]), 2)

    def test_no_redact_defaults(self):  # RD-004 via CLI
        rc, o, e, lines, _ = run(["--no-redact-defaults", "--redact", "^id", "--redact", "end$"],
                                 b'{"password":"p","a":"id 7","b":"my id","c":"the end","d":"the end\\n"}\n')
        self.assertEqual(lines[1]["raw"], {"password": "p", "a": "[REDACTED] 7", "b": "my id",
                                           "c": "the [REDACTED]", "d": "the end\n"})


class Redact(unittest.TestCase):
    def s(self, x): return Rd.string(x)
    def m(self, v): return Rd.message(v)

    def test_step1(self):  # RD-001
        self.assertEqual(self.m({"a": {"token": {"x": 1}, "apiKey": 5, "n": [{"pwd": None}]}}),
                         {"a": {"token": "[REDACTED]", "apiKey": "[REDACTED]", "n": [{"pwd": "[REDACTED]"}]}})

    def test_step2_examples(self):  # RD-002
        W = "\r\n"
        for a, b in [("try AKIAIOSFODNN7EXAMPLE today", "try [REDACTED] today"),
                     ("Authorization: Bearer abc.def", "[REDACTED]"),
                     ("Authorization: x" + W + "next", "[REDACTED]" + W + "next"),
                     ("postgres://admin:hunter2@db:5432/x", "postgres://admin:[REDACTED]@db:5432/x"),
                     ("load /srv/app/.env.local now", "load [REDACTED] now"),
                     ("key is ~/.ssh/id_ed25519.pub", "key is [REDACTED]"),
                     ("café AKIAIOSFODNN7EXAMPLE", "café [REDACTED]"),
                     ("éAKIAIOSFODNN7EXAMPLE", "é[REDACTED]"),
                     ("a/.env.x+b/.env", "[REDACTED]"), ("my.envy", "my.envy"),
                     ("cfg/.env.", "[REDACTED]."), (".env.env-id_", "[REDACTED]-id_"),
                     ("sk-" + "a" * 20, "[REDACTED]"), ("ghs_" + "A" * 36, "[REDACTED]"),
                     ("eyJabc.def.ghi", "[REDACTED]"), ("xoxb-1234567890", "[REDACTED]"),
                     ("sk_live_12345678", "[REDACTED]"), ("bearer  abc/+=", "[REDACTED]")]:
            self.assertEqual(self.s(a), b, a)

    def test_step3(self):  # RD-003
        self.assertEqual(self.m({"db_password": "x", "max_tokens": 100, "progressToken": "abc", "tokens": [1, 2],
                                 "flag_secret": True, "bearer": 1, "xbearer": "k", "PWD": "z", "a-pwd-b": "q",
                                 "apipkey": "ok", "Api-Key": "k"}),
                         {"db_password": "[REDACTED]", "max_tokens": 100, "progressToken": "[REDACTED]",
                          "tokens": "[REDACTED]", "flag_secret": True, "bearer": "[REDACTED]", "xbearer": "k",
                          "PWD": "[REDACTED]", "a-pwd-b": "[REDACTED]", "apipkey": "ok", "Api-Key": "[REDACTED]"})

    def test_step4(self):  # RD-004
        r = tape.Redactor(True, [tape.js_regex("^id"), tape.js_regex("end$"), tape.js_regex(r"a.\sb")])
        self.assertEqual(r.string("id 7"), "[REDACTED] 7")
        self.assertEqual(r.string("my id"), "my id")
        self.assertEqual(r.string("the end"), "the [REDACTED]")
        self.assertEqual(r.string("the end\n"), "the end\n")
        self.assertEqual(r.string("ax b"), "[REDACTED]")
        self.assertEqual(r.string("a\r b"), "a\r b")


if __name__ == "__main__":
    unittest.main()
