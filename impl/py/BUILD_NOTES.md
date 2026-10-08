# Build notes

- Build: nothing to build (`build` is empty in REGEN.json). Python 3.11+, standard library only.
- Test: `python3 -m unittest discover` (Windows: `py -3 -m unittest discover`). The tests start real
  `tape.py` processes with a small fake server written to a temp folder. POSIX signal tests skip on Windows.
- Run: `python3 tape.py [--out DIR] [--label NAME] [--redact REGEX]... [--no-redact-defaults] -- <command> [args...]`.
- Layout: `tape.py` (about 350 non-blank lines, budget 450), `test_tape.py`, `REGEN.json`, `CHOICES.md`.

Design: one thread per stream (client→child, child→client, child stderr) using raw file descriptors, so
bytes are forwarded before they are looked at. Each direction splits lines, decodes them whole, parses JSON,
redacts a copy and appends it to the trace. The main thread waits for the child, lets the output pumps
drain, writes the end line and leaves through `os._exit` (the stdin reader thread may be blocked in a read).

Surprises:
- Python's `re` has no variable-length lookbehind, so pattern 9 uses a captured prefix; patterns 10 and 11
  follow the spec's word-based wording, which keeps a 2 MB base64 string fast (the whole suite takes ~5 s).
- ECMAScript `$` and Python `$` differ (final LF), as do `\s`, `\b` and `.`; the translation is in `es2py`.
- I could not run anything on Windows; the Windows paths (PATHEXT lookup, `.cmd` start) are untested.
