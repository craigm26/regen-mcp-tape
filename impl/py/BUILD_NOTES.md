# Build notes

- Build: nothing to build (`build` is empty in REGEN.json). Python 3.11+, standard library only.
- Test: `python3 -m unittest discover -s . -p "test_*.py"` (Windows: `py -3 -m unittest ...`). 19 tests pass on Linux in about 2 seconds. They start real child processes (small Python scripts).
- Run: `python3 tape.py [--out DIR] [--label NAME] [--redact REGEX]... [--no-redact-defaults] -- <command> [args...]`.
- Size: `tape.py` has 343 non-blank lines, against the budget of 450.

Design: three daemon pump threads copy raw bytes with `os.read`/`os.write` (stdin to child, child stdout to stdout, child stderr to stderr). The two data pumps also split lines and queue them. A worker thread decodes, parses, redacts and writes the trace, so a slow redaction never stalls forwarding. The main thread waits for the child, joins the output pumps, drains the queue, writes the end line and exits with `os._exit`.

Surprises:
- Patterns 10 and 11 can't be run as regexes on a 2 MB blob. They are implemented per word with `str.rfind`, as the spec describes.
- Python's `re` differs from ECMAScript in `$`, `.`, `\s`, `\b` and `\d`. I used `re.ASCII` plus explicit character classes, and a small translator for `--redact` patterns (see CHOICES.md C-8).
- Pattern 9 (the variable-length lookbehind) is done with a capture group of the prefix, which gives the same result.
- A test helper that writes megabytes to the proxy must read its output at the same time, or it deadlocks. That was a bug in my own test, not in `tape`.
- Windows behaviour was not run here.
