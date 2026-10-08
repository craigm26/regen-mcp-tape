# Build notes

- Build: nothing (`build` is empty in REGEN.json). Python 3.11+, standard library only.
- Test: `python3 -m unittest discover -p "test_*.py"` (Windows: `py -3 -m unittest discover -p "test_*.py"`).
  The tests start real `tape` processes with small Python child programs given via `-c`.
  POSIX-only tests (signals) and the Windows-only lookup test skip on the other platform.
- Run: `python3 tape.py [--out DIR] [--label NAME] [--redact REGEX]... [--no-redact-defaults] -- <command> [args...]`.
- Layout: `tape.py` (the whole program, about 330 non-blank lines of the 450 allowed), `test_tape.py`.

Design: two daemon threads copy bytes (client stdin to child, child stdout to client). Each chunk
goes through a per-direction line splitter that writes trace lines, then is forwarded. The child's
stderr is inherited, so it reaches the client's stderr directly. Patterns 10 and 11 use the
word-based algorithm from the spec, so a 2 MB base64 string is redacted in well under a second.

Things that surprised me:
- Python's `re` has no ECMAScript `\s`, `.` or `$` meanings; a small translator was needed (C-4).
- Patterns 4 and 9 still run on Python's backtracking `re`; contrived inputs may be slow (OPEN-RD-003).
- Windows behavior (PATHEXT lookup, `.cmd` files) is written but could not be run here.
