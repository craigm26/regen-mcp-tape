# Choices

## C-1: --help/--version beat usage errors
- Spec reference: OPEN-CLI-003, REQ-CLI-004
- Situation: ambiguous
- What I chose: the whole command line is scanned; if `--help` (or else `--version`) was seen before the command starts, it wins and any usage error is ignored.
- Alternatives: report the usage error (status 2).
- Should the spec pin this? no, it is already open.

## C-2: Unknown single-dash options are usage errors
- Spec reference: OPEN-CLI-002, REQ-CLI-002
- Situation: missing
- What I chose: any unknown argument that starts with `-` before the command (including a lone `-`) is a usage error, status 2.
- Alternatives: ignore it; treat it as the start of the command.
- Should the spec pin this? no.

## C-3: Repeated --out / --label
- Spec reference: OPEN-CLI-002
- Situation: missing
- What I chose: the last one given wins.
- Alternatives: first wins; usage error.
- Should the spec pin this? no.

## C-4: Version text
- Spec reference: OPEN-CLI-001
- Situation: missing
- What I chose: `tape 1.1.2` (the spec's document version).
- Alternatives: a separate program version.
- Should the spec pin this? no.

## C-5: Trace JSON is ASCII-only
- Spec reference: REQ-TR-002, OPEN-TR-003, OPEN-TR-004
- Situation: missing
- What I chose: every trace line is written with `\uXXXX` escapes for non-ASCII characters (still valid UTF-8 and valid JSON). This also lets lone surrogates (from `"\ud800"`) survive.
- Alternatives: raw UTF-8 text, which fails on lone surrogates.
- Should the spec pin this? no; consumers parse JSON.

## C-6: Lines that cannot be handled are silently not logged
- Spec reference: OPEN-TR-004
- Situation: missing
- What I chose: invalid UTF-8, a leading BOM, `NaN`/`Infinity` literals, integers over Python's 4300-digit limit, nesting too deep for the recursion limit, and any other internal error: the line is forwarded but not logged. Numbers outside binary64 such as `1e999` become `null`.
- Alternatives: log with replacement characters; raise the recursion limit.
- Should the spec pin this? no.

## C-7: Blank-line test and JSON whitespace
- Spec reference: REQ-TR-007
- Situation: ambiguous
- What I chose: skip a line only if it is made of spaces, tabs and CRs. Other white space (U+00A0 and so on) goes to the JSON parser and is then not logged because it is not JSON.
- Alternatives: none really.
- Should the spec pin this? no (already OPEN-TR-004).

## C-8: Redaction regexes are translated to Python
- Spec reference: REQ-RD-002, REQ-RD-004, OPEN-RD-001
- Situation: ambiguous
- What I chose: patterns 1–8 are Python regexes with `re.ASCII` and with `\s` and `.` spelled out as the ECMAScript sets. Pattern 9 uses a capturing prefix instead of a lookbehind. Patterns 10 and 11 use the word-based algorithms. `--redact` patterns go through a small translator (`\s`, `\S` outside classes, `.`, `$` as `\Z`, `(?<name>` as `(?P<name>`, `[` inside a class escaped); everything else is passed to Python's `re` as it is. `\S` inside a class keeps Python's ASCII meaning.
- Alternatives: write my own regex engine.
- Should the spec pin this? no.

## C-9: Step 4 sees text already replaced
- Spec reference: OPEN-RD-002
- Situation: ambiguous
- What I chose: step 4 and `--redact` patterns run over every string, including `[REDACTED]` written earlier, so `--redact RED` gives `[[REDACTED]ACTED]`.
- Alternatives: skip replaced values.
- Should the spec pin this? no.

## C-10: `--redact` patterns that match the empty string
- Spec reference: OPEN-RD-001
- Situation: missing
- What I chose: whatever Python's `re.sub` does (it inserts the replacement at each empty match).
- Alternatives: reject them as usage errors; ignore empty matches.
- Should the spec pin this? no.

## C-11: Pattern 10 on many `.env` occurrences
- Spec reference: REQ-RD-002, OPEN-RD-003
- Situation: ambiguous
- What I chose: for each word, try `.env` positions from the last to the first and stop at the first that matches; a word full of failing `.env` candidates is quadratic, which is contrived input.
- Alternatives: a precomputed single right-to-left pass.
- Should the spec pin this? no.

## C-12: `t` is taken when a line is handled
- Spec reference: OPEN-TR-002
- Situation: ambiguous
- What I chose: `t` is the time the complete line was processed, after forwarding, just before writing it.
- Alternatives: the time the first byte was read.
- Should the spec pin this? no.

## C-13: Existing trace file of the same name
- Spec reference: OPEN-TR-005
- Situation: missing
- What I chose: it is overwritten (`wb`). Each line is flushed to the OS as it is written.
- Alternatives: pick another name; fail with status 1.
- Should the spec pin this? no.

## C-14: Waiting for output after the child exits
- Spec reference: REQ-FW-005, OPEN-FW-002
- Situation: ambiguous
- What I chose: after the child exits, wait for its stdout/stderr to reach end of file, but give up when no bytes have moved for 3 seconds (a grandchild may hold the pipes). If forwarding to the client fails (broken pipe), `tape` keeps reading and logging the child's output and drops the bytes. Input that arrives after the child exits is dropped.
- Alternatives: wait forever; stop at once.
- Should the spec pin this? no; open already.

## C-15: Signals before the child starts
- Spec reference: OPEN-EX-002
- Situation: missing
- What I chose: handlers are installed before the child is started; a signal that arrives earlier is sent to the child as soon as it exists. A signal that kills the child gives 128+S as normal. A signal number the child cannot be given a name for is still 128 + number.
- Alternatives: default handling.
- Should the spec pin this? no.

## C-16: Windows support is untested
- Spec reference: REQ-PL-001, REQ-PL-002
- Situation: ambiguous
- What I chose: for a bare command name on Windows I look it up with `shutil.which` (current directory, `PATH`, `PATHEXT`) and hand the list to `subprocess.Popen`, which quotes arguments for `CreateProcess` and runs `.cmd`/`.bat` through the command interpreter. I could not run Windows here, so this is untested; POSIX-only tests skip on `nt`.
- Alternatives: run through `cmd.exe /c` (breaks argument exactness).
- Should the spec pin this? no.

## C-17: What `--label` does to the label when empty
- Spec reference: REQ-LB-001, REQ-TR-001
- Situation: ambiguous
- What I chose: `--label ""` is the label exactly (empty) in the meta line, and the file name falls back to `mcp`. Non-ASCII characters outside the BMP become one `-` (Python counts code points).
- Alternatives: treat the empty label as absent.
- Should the spec pin this? unsure; "exactly as given" implies empty stays empty.

## C-18: Which stage creates what on a start failure
- Spec reference: REQ-EX-004, REQ-EX-005, REQ-CLI-004
- Situation: ambiguous
- What I chose: order is: arguments and `--redact` patterns checked (status 2, nothing created), trace file created (status 1 on failure), child started (status 127 with a full trace on failure). A `ValueError` from starting (for example a NUL in an argument) also counts as "cannot start".
- Alternatives: none.
- Should the spec pin this? no.
