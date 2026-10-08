import glob, json, os, signal, subprocess, sys, tempfile, time, unittest

HERE = os.path.dirname(os.path.abspath(__file__))
TAPE = os.path.join(HERE, "tape.py")
sys.path.insert(0, HERE)
import tape as T

CHILD = r'''
import os, sys, time, signal, json
mode = sys.argv[1]
out, err = sys.stdout.buffer, sys.stderr.buffer
if mode == "cat":
    while True:
        d = os.read(0, 65536)
        if not d: break
        os.write(1, d)
elif mode == "exit":
    sys.exit(int(sys.argv[2]))
elif mode == "kill":
    os.kill(os.getpid(), int(sys.argv[2])); time.sleep(5)
elif mode == "term":
    signal.signal(signal.SIGTERM, lambda *a: sys.exit(0))
    out.write(b"ready\n"); out.flush(); time.sleep(10)
elif mode == "eof":
    while os.read(0, 100): pass
    out.write(b"bye\n"); out.flush(); sys.exit(3)
elif mode == "sleep":
    out.write(b'{"a":1}\n'); out.flush(); time.sleep(0.5); sys.exit(4)
elif mode == "info":
    out.write(json.dumps([os.getcwd(), os.environ.get("TAPE_T"), sys.argv[2:]]).encode() + b"\n")
elif mode == "err":
    err.write(b"e1\xff"); err.flush(); time.sleep(0.1); err.write(b"e2"); err.flush()
elif mode == "pieces":
    for p in json.loads(sys.argv[2]):
        out.write(p.encode("latin-1")); out.flush(); time.sleep(0.15)
'''


class Base(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.d = self.tmp.name
        self.out = os.path.join(self.d, "traces")
        self.child = os.path.join(self.d, "child.py")
        with open(self.child, "w") as f:
            f.write(CHILD)

    def tape(self, opts, cmd, data=b"", timeout=30, cwd=None, env=None, out=True):
        args = [sys.executable, TAPE] + (["--out", self.out] if out else []) + opts
        if cmd is not None:
            args += ["--"] + cmd
        e = dict(os.environ, **(env or {}))
        p = subprocess.run(args, input=data, capture_output=True, timeout=timeout, cwd=cwd or self.d, env=e)
        return p

    def cc(self, *a):
        return [sys.executable, self.child] + list(a)

    def trace(self):
        files = glob.glob(os.path.join(self.out, "*.jsonl"))
        self.assertEqual(len(files), 1, files)
        with open(files[0], "rb") as f:
            data = f.read()
        self.assertTrue(data.endswith(b"\n"))
        return os.path.basename(files[0]), [json.loads(l) for l in data.decode("utf-8").split("\n")[:-1]]

    def msgs(self, trace=None, d=None):
        lines = (trace or self.trace()[1])[1:-1]
        return [l["raw"] for l in lines if d is None or l["dir"] == d]


class TestCli(Base):
    def test_help_version(self):
        for a in (["--help"], ["-h"], ["--version"], ["-v"], ["--version", "--help"]):
            p = self.tape(a, None, out=False)
            self.assertEqual(p.returncode, 0)
            self.assertTrue(p.stdout.strip())
        h = self.tape(["--version", "--help"], None).stdout
        self.assertEqual(h, self.tape(["--help"], None).stdout)
        self.assertFalse(os.path.exists(self.out))

    def test_usage_errors(self):
        marker = os.path.join(self.d, "started")
        for a, cmd in ((["--bogus"], self.cc("exit", "0")), (["--label"], None), (["--out"], None), ([], None),
                       (["--redact", "("], self.cc("exit", "0")), (["--redact", "[a"], self.cc("exit", "0"))):
            p = self.tape(a, cmd)
            self.assertEqual(p.returncode, 2, a)
            self.assertTrue(p.stderr)
            self.assertEqual(p.stdout, b"")
            self.assertFalse(os.path.exists(self.out))
        self.assertFalse(os.path.exists(marker))

    def test_command_start(self):
        p = subprocess.run([sys.executable, TAPE, "--out", self.out, "--label", "x", sys.executable, self.child,
                            "info", "--out", "y", "--label"], capture_output=True, cwd=self.d)
        self.assertEqual(json.loads(p.stdout)[2], ["--out", "y", "--label"])
        p = self.tape([], self.cc("info", "--help", "-v"), out=True)
        self.assertEqual(json.loads(p.stdout)[2], ["--help", "-v"])

    def test_option_value_is_next_arg(self):
        p = self.tape(["--label", "--redact"], self.cc("exit", "0"))
        self.assertEqual(p.returncode, 0)
        self.assertEqual(self.trace()[1][0]["label"], "--redact")

    def test_default_out_dir(self):
        subprocess.run([sys.executable, TAPE, "--", sys.executable, self.child, "exit", "0"], cwd=self.d)
        self.assertEqual(len(glob.glob(os.path.join(self.d, "mcp-traces", "*.jsonl"))), 1)

    def test_args_exact(self):
        args = ["a b", 'say "hi"', "", "x\\y", "ü"]
        p = self.tape([], self.cc("info", *args))
        self.assertEqual(json.loads(p.stdout)[2], args)


class TestForward(Base):
    def test_bytes_unchanged(self):
        data = b'{"a":1}\r\n\n\n\xff\xfe not json\n{"b":"\xc3\xa9"}\r\nlast no lf'
        p = self.tape([], self.cc("cat"), data)
        self.assertEqual(p.stdout, data)
        self.assertEqual(p.returncode, 0)

    def test_big_line(self):
        data = b'{"x":"' + b"A" * 3000000 + b'"}\n{"y":1}\n'
        p = self.tape([], self.cc("cat"), data)
        self.assertEqual(p.stdout, data)

    def test_stdout_only_child_bytes_and_stderr(self):
        p = self.tape([], self.cc("err"))
        self.assertEqual(p.stdout, b"")
        self.assertEqual(p.stderr, b"e1\xffe2")

    def test_stdin_eof_reaches_child(self):
        p = self.tape([], self.cc("eof"), b"hello\n")
        self.assertEqual(p.stdout, b"bye\n")
        self.assertEqual(p.returncode, 3)

    def test_child_exit_with_stdin_open(self):
        p = subprocess.Popen([sys.executable, TAPE, "--out", self.out, "--"] + self.cc("sleep"),
                             stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.PIPE)
        try:
            out, _ = p.communicate(timeout=10) if False else (p.stdout.read(), None)
            self.assertEqual(p.wait(timeout=10), 4)
        finally:
            p.stdin.close()
            p.stdout.close()
            p.stderr.close()
        self.assertEqual(out, b'{"a":1}\n')

    def test_env_and_cwd(self):
        sub = os.path.join(self.d, "sub")
        os.mkdir(sub)
        p = self.tape([], self.cc("info"), cwd=sub, env={"TAPE_T": "yes"})
        cwd, env, _ = json.loads(p.stdout)
        self.assertEqual(os.path.realpath(cwd), os.path.realpath(sub))
        self.assertEqual(env, "yes")


class TestExit(Base):
    def test_exit_codes(self):
        for n in (0, 1, 7, 255):
            self.assertEqual(self.tape([], self.cc("exit", str(n))).returncode, n)

    @unittest.skipIf(os.name == "nt", "POSIX signals")
    def test_signal_exit(self):
        for s in (signal.SIGTERM, signal.SIGKILL, signal.SIGUSR1):
            p = self.tape([], self.cc("kill", str(int(s))))
            self.assertEqual(p.returncode, 128 + int(s))

    @unittest.skipIf(os.name == "nt", "POSIX signals")
    def test_signal_forwarded(self):
        for sig in (signal.SIGTERM, signal.SIGINT):
            p = subprocess.Popen([sys.executable, TAPE, "--out", self.out, "--"] + self.cc("term"),
                                 stdin=subprocess.PIPE, stdout=subprocess.PIPE)
            self.assertEqual(p.stdout.readline(), b"ready\n")
            p.send_signal(sig)
            if sig == signal.SIGTERM:
                self.assertEqual(p.wait(timeout=10), 0)
            else:
                # the child dies of SIGINT (KeyboardInterrupt), so tape exits 128 + 2
                self.assertEqual(p.wait(timeout=10), 130)
            p.stdin.close()
            p.stdout.close()

    def test_cannot_start(self):
        p = self.tape([], ["/nonexistent/prog-xyz"])
        self.assertEqual(p.returncode, 127)
        self.assertTrue(p.stderr)
        t = self.trace()[1]
        self.assertEqual(t[-1]["exitCode"], 127)
        self.assertEqual(t[0]["type"], "meta")

    def test_trace_file_cannot_be_created(self):
        blocker = os.path.join(self.d, "file")
        open(blocker, "w").close()
        marker = os.path.join(self.d, "started")
        p = subprocess.run([sys.executable, TAPE, "--out", blocker, "--", sys.executable, "-c",
                            "open(%r,'w')" % marker], capture_output=True)
        self.assertEqual(p.returncode, 1)
        self.assertTrue(p.stderr)
        self.assertFalse(os.path.exists(marker))


class TestTrace(Base):
    def test_file_name_meta_end(self):
        self.tape(["--label", "my server/v2"], self.cc("exit", "3"))
        name, t = self.trace()
        self.assertRegex(name, r"^\d{4}-\d\d-\d\dT\d\d-\d\d-\d\d-\d{3}Z-my-server-v2\.jsonl$")
        meta, end = t[0], t[-1]
        self.assertEqual((meta["v"], meta["type"], meta["label"]), (1, "meta", "my server/v2"))
        self.assertEqual(meta["command"], self.cc("exit", "3"))
        self.assertRegex(meta["startedAt"], r"^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$")
        self.assertEqual((end["type"], end["exitCode"]), ("end", 3))
        self.assertIsInstance(end["durationMs"], int)
        self.assertGreaterEqual(end["durationMs"], 0)
        self.assertEqual(len(t), 2)

    def test_name_cut_and_empty(self):
        self.tape(["--label", "é" + "a" * 100], self.cc("exit", "0"))
        self.assertEqual(self.trace()[0].split("Z-", 1)[1], "-" + "a" * 63 + ".jsonl")
        self.tape(["--label", ""], self.cc("exit", "0"))
        self.assertTrue(glob.glob(os.path.join(self.out, "*Z-mcp.jsonl")))

    def test_out_creates_parents(self):
        self.out = os.path.join(self.d, "a", "b", "c")
        self.tape([], self.cc("exit", "0"))
        self.trace()

    def test_labels(self):
        L = T.derive_label
        cases = [(["node", "/opt/server.js"], "server-js"), (["npx", "-y", "my-remote"], "my-remote"),
                 (["node", "srv.js", "--port", "3000"], "3000"), (["node", "C:\\srv\\files.mjs"], "files-mjs"),
                 (["npx", "-y", "srv", "https://example.test/mcp", "--header", "X-Key: abc"], "mcp"),
                 (["node", "KEY=value"], "key-value"), (["npx", "-y", "--"], "mcp"), ([], "mcp"),
                 (["x" * 50], "x" * 32)]
        for cmd, want in cases:
            self.assertEqual(L(cmd), want)
        self.tape([], ["node", "srv.js", "ghp_" + "A" * 36])
        self.assertTrue(self.trace()[0].endswith("Z--redacted-.jsonl"))

    def test_messages_logged(self):
        data = (b'{"id":1,"method":"x"}\n   \t\r\nnot json\n[1,2]\n"str"\n12\ntrue\nnull\n'
                b'{"id":2}\r\n\xff\xfe\n{"last":1}')
        self.tape([], self.cc("cat"), data)
        t = self.trace()[1]
        self.assertEqual(self.msgs(t, "in"), [{"id": 1, "method": "x"}, [1, 2], "str", 12, True, None, {"id": 2},
                                              {"last": 1}])
        self.assertEqual(self.msgs(t, "out"), self.msgs(t, "in"))
        for l in t[1:-1]:
            self.assertRegex(l["t"], r"^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$")

    def test_split_multibyte_and_final_line(self):
        pieces = ['{"s":"\xc3', '\xa9\xe2\x82', '\xac"}\n{"b":', '2}']
        self.tape([], self.cc("pieces", json.dumps(pieces)))
        self.assertEqual(self.msgs(d="out"), [{"s": "\u00e9\u20ac"}, {"b": 2}])

    def test_numbers_and_order(self):
        lines = [b'{"n":%d}' % i for i in range(200)]
        self.tape([], self.cc("cat"), b"\n".join(lines) + b'\n{"f":1.5e300,"i":9007199254740993,"z":1.0}\n')
        m = self.msgs(d="in")
        self.assertEqual([x["n"] for x in m[:200]], list(range(200)))
        self.assertEqual(m[200]["f"], 1.5e300)
        self.assertEqual(float(m[200]["z"]), 1.0)

    def test_proto_member(self):
        self.tape([], self.cc("cat"), b'{"__proto__":{"a":1},"constructor":2}\n')
        self.assertEqual(self.msgs(d="in"), [{"__proto__": {"a": 1}, "constructor": 2}])


class TestRedaction(Base):
    def rs(self, s, defaults=True, user=()):
        return T.Redactor(defaults, [T.sub_rx_user(p) for p in user]).string(s)

    def test_string_examples(self):
        cases = {
            "try AKIAIOSFODNN7EXAMPLE today": "try [REDACTED] today",
            "Authorization: Bearer abc.def": "[REDACTED]",
            "Authorization: x\r\nnext": "[REDACTED]\r\nnext",
            "postgres://admin:hunter2@db:5432/x": "postgres://admin:[REDACTED]@db:5432/x",
            "load /srv/app/.env.local now": "load [REDACTED] now",
            "key is ~/.ssh/id_ed25519.pub": "key is [REDACTED]",
            "caf\u00e9 AKIAIOSFODNN7EXAMPLE": "caf\u00e9 [REDACTED]",
            "\u00e9AKIAIOSFODNN7EXAMPLE": "\u00e9[REDACTED]",
            "a/.env.x+b/.env": "[REDACTED]", "my.envy": "my.envy", "cfg/.env.": "[REDACTED].",
            ".env.env-id_": "[REDACTED]-id_",
            "sk-" + "a" * 24: "[REDACTED]", "ghp_" + "A" * 36: "[REDACTED]",
            "eyJabc.def.ghi": "[REDACTED]", "xoxb-1234567890-abc": "[REDACTED]", "sk_live_abcdefgh12": "[REDACTED]",
            "send bearer abc123": "send [REDACTED]", "plain text": "plain text",
        }
        for a, b in cases.items():
            self.assertEqual(self.rs(a), b, a)

    def test_user_patterns(self):
        u = ["^id", "end$"]
        self.assertEqual(self.rs("id 7", user=u), "[REDACTED] 7")
        self.assertEqual(self.rs("my id", user=u), "my id")
        self.assertEqual(self.rs("the end", user=u), "the [REDACTED]")
        self.assertEqual(self.rs("the end\n", user=u), "the end\n")
        self.assertEqual(self.rs("a\nid", user=["^id"]), "a\nid")
        self.assertEqual(self.rs("ab12 ab", user=["ab[0-9]{1,2}", "(x|ab)$"]), "[REDACTED] [REDACTED]")
        self.assertEqual(self.rs("a.b", user=["a.b"], defaults=False), "[REDACTED]")
        self.assertEqual(self.rs("a\rb", user=["a.b"]), "a\rb")

    def test_keys(self):
        m = T.Redactor(True, []).message
        self.assertEqual(m({"db_password": "x"}), {"db_password": R})
        self.assertEqual(m({"max_tokens": 100}), {"max_tokens": 100})
        self.assertEqual(m({"progressToken": "abc"}), {"progressToken": R})
        self.assertEqual(m({"tokens": [1, 2]}), {"tokens": R})
        self.assertEqual(m({"token": 5, "password": None, "secret": {"a": 1}, "x": {"apiKey": True}}),
                         {"token": R, "password": R, "secret": R, "x": {"apiKey": R}})
        self.assertEqual(m({"n": [{"pwd": "a", "bearer": "b", "Bearer": "c", "Bearer2": "d", "a-pwd-b": "e"}]}),
                         {"n": [{"pwd": R, "bearer": R, "Bearer": R, "Bearer2": "d", "a-pwd-b": R}]})
        self.assertEqual(m({"private-key": "a", "accessKey2": 1, "access_key2": "x", "API_KEY": "k"}),
                         {"private-key": R, "accessKey2": 1, "access_key2": R, "API_KEY": R})
        self.assertEqual(m({"Authorization": 1, "a": ["sk-" + "x" * 30, {"k": "AKIAIOSFODNN7EXAMPLE"}]}),
                         {"Authorization": R, "a": [R, {"k": R}]})

    def test_no_defaults(self):
        m = T.Redactor(False, [T.sub_rx_user("foo")]).message
        self.assertEqual(m({"password": "foo bar", "k": "sk-" + "x" * 30}), {"password": "[REDACTED] bar", "k": "sk-" + "x" * 30})

    def test_trace_redacted_forwarded_not(self):
        data = b'{"params":{"token":"abc","text":"AKIAIOSFODNN7EXAMPLE zz"}}\n'
        p = self.tape(["--redact", "zz"], self.cc("cat"), data)
        self.assertEqual(p.stdout, data)
        self.assertEqual(self.msgs(d="in"), [{"params": {"token": R, "text": "[REDACTED] [REDACTED]"}}])

    def test_no_redact_defaults_cli(self):
        data = b'{"token":"abc"}\n'
        self.tape(["--no-redact-defaults"], self.cc("cat"), data)
        self.assertEqual(self.msgs(d="in"), [{"token": "abc"}])

    def test_command_redacted_in_meta(self):
        self.tape(["--redact", "zzz"], self.cc("exit", "0", "ghp_" + "A" * 36, "zzz"))
        meta = self.trace()[1][0]
        self.assertEqual(meta["command"][-2:], [R, R])
        self.assertTrue(self.trace()[0].endswith("Z--redacted-.jsonl"))

    def test_large_blob(self):
        blob = ("QUJD" * 600000)[:2000000]
        data = b'{"d":"' + blob.encode() + b'"}\n{"after":1}\n'
        t0 = time.time()
        p = self.tape([], self.cc("cat"), data)
        self.assertLess(time.time() - t0, 12)
        self.assertEqual(p.stdout, data)
        m = self.msgs(d="out")
        self.assertEqual(m[0], {"d": blob})
        self.assertEqual(m[1], {"after": 1})


R = "[REDACTED]"

if __name__ == "__main__":
    unittest.main()
