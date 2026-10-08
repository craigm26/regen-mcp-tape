## C-1: Trace file already exists
- Spec reference: OPEN-TR-005
- Situation: missing
- What I chose: open the file exclusively; if it exists, treat it as "cannot create trace file" (stderr message, no child, exit 1).
- Alternatives: truncate, append, or add a numeric suffix.
- Should the spec pin this? no, rare (same millisecond, same label, same directory).

## C-2: Single-dash unknown options
- Spec reference: OPEN-CLI-002, REQ-CLI-002
- Situation: missing
- What I chose: an unknown argument beginning with a single `-` before the command is ignored (not a usage error, not the start of the command).
- Alternatives: usage error; treat as the start of the command.
- Should the spec pin this? no.

## C-3: --help or --version together with a usage error
- Spec reference: OPEN-CLI-003
- Situation: ambiguous
- What I chose: help wins, then version, over any usage error (except a bad `--redact` regex, which is only compiled after help/version are handled).
- Alternatives: usage error wins.
- Should the spec pin this? no.

## C-4: ECMAScript regex translated to Python's `re`
- Spec reference: REQ-RD-002, REQ-RD-004, D-008
- Situation: missing (how to get ECMAScript meanings in Python)
- What I chose: a small translator rewrites `\s` (ECMAScript white-space set), `.` (not LF CR U+2028 U+2029) and `$` (`\Z`), and compiles with `re.ASCII` (ASCII `\b`, `\w`, `\d`, ASCII-only case folding). No multiline flag. Other ECMAScript syntax is passed through to Python unchanged, so a few things that are invalid in ECMAScript (e.g. possessive quantifiers, `(?i)`) are accepted rather than rejected as usage errors. `\S` inside a character class is not translated.
- Alternatives: write a full regex engine (over the line budget).
- Should the spec pin this? no; the spec's tested subset is covered.

## C-5: Redaction of already-replaced text
- Spec reference: OPEN-RD-002
- Situation: ambiguous
- What I chose: step 4 runs over every string, including `[REDACTED]` text from earlier steps (so `--redact RED` yields `[[REDACTED]ACTED]`).
- Alternatives: skip replaced values.
- Should the spec pin this? no, as it says.

## C-6: Numbers and odd JSON in raw
- Spec reference: REQ-TR-010, OPEN-TR-003
- Situation: ambiguous
- What I chose: Python `json` semantics. Integers stay exact integers (even beyond 2^53), floats are written with `repr`; `1e999` becomes `null`; `NaN`/`Infinity`/`-Infinity` are not JSON so such lines are not logged; duplicate keys keep the last; `raw` is written with ASCII-only escapes (`\uXXXX`) so any string is valid UTF-8 in the file.
- Alternatives: keep raw text; write non-ASCII directly.
- Should the spec pin this? no.

## C-7: Lines that cannot be decoded or processed
- Spec reference: OPEN-TR-004
- Situation: missing
- What I chose: invalid UTF-8, a leading BOM, integers over Python's 4300-digit limit, or nesting that overflows the recursion limit make the line "not JSON": forwarded, not logged. Lines of only U+00A0 etc. are not blank (only space, tab, CR are) and fail to parse, so are not logged.
- Alternatives: log with replacement characters; raise recursion limit.
- Should the spec pin this? no.

## C-8: Timestamp `t` of message lines
- Spec reference: OPEN-TR-002
- Situation: ambiguous
- What I chose: `t` is the time the complete line was seen (read), just before it is forwarded. The trace line is written (and flushed) *before* the chunk containing it is forwarded, so an "in" message is always in the file before the child's reaction to it, and no message can arrive after the end line.
- Alternatives: forward first, log after (lower latency, but the end line can race the last log line).
- Should the spec pin this? no.

## C-9: Waiting for output after child exit
- Spec reference: REQ-FW-005, OPEN-FW-002
- Situation: ambiguous
- What I chose: after the child exits, wait for its stdout pipe to reach EOF, but give up after 3 seconds without any new data (a grandchild holding the pipe).
- Alternatives: wait forever; give up immediately.
- Should the spec pin this? no (it is OPEN).

## C-10: Broken pipes
- Spec reference: OPEN-FW-002
- Situation: missing
- What I chose: if writing to the client's stdout fails, or to the child's stdin fails (child gone), tape stops writing in that direction but keeps reading and logging (discarding) so the other side is not blocked.
- Alternatives: exit at once.
- Should the spec pin this? no.

## C-11: Signals before the child exists
- Spec reference: OPEN-EX-002, REQ-EX-003
- Situation: missing
- What I chose: handlers are installed before the child is started; a signal received earlier is delivered to the child right after it starts. A signal-ended child gets 128 + the positive signal number (negative `returncode`); on Windows the return code is used as is.
- Alternatives: default handling before start.
- Should the spec pin this? no.

## C-12: Message when the command cannot start
- Spec reference: REQ-EX-004
- Situation: ambiguous (what counts as "cannot start")
- What I chose: any `OSError`/`ValueError` from `subprocess.Popen` (missing, not executable, a directory, empty name) gives 127 with a complete trace. The meta line is written before the start attempt, so the trace has meta and end only.
- Alternatives: 126 for "not executable" like shells.
- Should the spec pin this? no; the spec says 127 for both.

## C-13: Windows lookup and .cmd files
- Spec reference: REQ-PL-001, OPEN-PL-002
- Situation: ambiguous
- What I chose: for a name with no directory part and no extension, `shutil.which` (current directory, PATH, PATHEXT) resolves it; the resolved path is given to `subprocess.Popen`, which runs `.cmd`/`.bat` through the command interpreter. Other names go to Popen as given. This path could not be tested on Linux; the Windows-only test is skipped here.
- Alternatives: run everything through `cmd /c`.
- Should the spec pin this? no.

## C-14: Test command and build
- Spec reference: REQ-IF-001
- Situation: ambiguous (how the test command finds tests on both shells)
- What I chose: `python3 -m unittest discover -p "test_*.py"` with double quotes (valid in `/bin/sh` and cmd.exe); `build` is the empty string.
- Alternatives: `python3 -m unittest test_tape`.
- Should the spec pin this? no.

## C-15: Step order as full passes
- Spec reference: REQ-RD-001..004
- Situation: ambiguous
- What I chose: each of steps 1 to 4 is a full pass over the whole value, in order (step 1 exact keys, step 2 string patterns on all strings, step 3 key substrings, step 4). With `--no-redact-defaults` only the user patterns run on strings.
- Alternatives: one combined walk per node.
- Should the spec pin this? no; the spec's wording already implies passes.

## C-16: The `-0`, `\b` and `^bearer$` details
- Spec reference: REQ-RD-003
- Situation: ambiguous
- What I chose: `^bearer$` is anchored with `\Z` (no match for `bearer` followed by LF); case-insensitivity is ASCII-only.
- Alternatives: Python's `$`, Unicode case folding.
- Should the spec pin this? no.
