## C-1: Driver path is relative to the working directory
- Spec reference: REQ-IF-001
- Situation: contradictory
- What I chose: `"driver": "node tape.ts"`, as in the spec's own example. A plain-words driver can't carry an absolute path, so it only works if the suite resolves the path against the implementation folder or starts there.
- Alternatives: None possible without a shell (no variables, no quoting).
- Should the spec pin this? yes: say how the suite resolves a relative program path in the driver.

## C-2: Single-dash unknown options are usage errors
- Spec reference: REQ-CLI-002, OPEN-CLI-002
- Situation: ambiguous
- What I chose: an argument before the command that begins with `-` and is not a known option (including a lone `-`) is a usage error (status 2).
- Alternatives: Treat it as the start of the command; ignore it.
- Should the spec pin this? no, it is OPEN.

## C-3: --help/--version win over usage errors
- Spec reference: REQ-CLI-003, REQ-CLI-004
- Situation: ambiguous
- What I chose: the whole option list is scanned first. If `--help` (or else `--version`) appears before the command starts, it is printed and `tape` exits 0, even if there is also a usage error. Otherwise any error gives status 2. A bad `--redact` regex is only checked after the help/version handling.
- Alternatives: Report the first problem found left to right.
- Should the spec pin this? unsure; rarely matters.

## C-4: Repeated --out / --label
- Spec reference: OPEN-CLI-002
- Situation: missing
- What I chose: the last occurrence wins.
- Alternatives: first wins; error.
- Should the spec pin this? no.

## C-5: Trace file name characters counted as code points
- Spec reference: REQ-TR-001
- Situation: ambiguous
- What I chose: each Unicode code point that is not `[A-Za-z0-9_-]` becomes one `-`, and the 64-character cut counts code points. (The derived label of REQ-LB-001 step 3 is counted in UTF-16 units, which is OPEN-LB-001.)
- Alternatives: UTF-16 units; UTF-8 bytes.
- Should the spec pin this? unsure; only matters for non-ASCII labels given with `--label`.

## C-6: Existing trace file of the same name is overwritten
- Spec reference: OPEN-TR-005
- Situation: missing
- What I chose: open with `w` (truncate).
- Alternatives: append; fail; add a suffix.
- Should the spec pin this? no, it is OPEN.

## C-7: Trace lines are written synchronously
- Spec reference: OPEN-TR-005
- Situation: missing
- What I chose: each line is written to the file with a blocking write as soon as it is complete, so the file is current if `tape` is killed. A message whose redaction or serialisation fails (for example JSON nested too deeply for the recursion) is dropped from the trace and forwarding continues.
- Alternatives: buffered stream writes.
- Should the spec pin this? no.

## C-8: Invalid UTF-8 is replaced, BOM is kept
- Spec reference: REQ-TR-007, OPEN-TR-004
- Situation: missing
- What I chose: lines are decoded with replacement characters for invalid bytes (a line that still parses as JSON is logged with U+FFFD in it). A leading BOM is not stripped, so the line fails to parse as JSON and is not logged.
- Alternatives: skip lines that are not valid UTF-8.
- Should the spec pin this? no, it is OPEN.

## C-9: Derived label for a redacted argument
- Spec reference: REQ-LB-001, REQ-RD-005
- Situation: ambiguous
- What I chose: the label is computed from the redacted text, so an argument that became `[REDACTED]` gives the label `-redacted-` (the brackets become `-`). The spec's rules say exactly this, but it is an odd outcome.
- Alternatives: skip redacted arguments and fall through to `mcp`.
- Should the spec pin this? unsure; an example would help.

## C-10: Stdin at child exit; late input
- Spec reference: REQ-FW-005, OPEN-FW-002
- Situation: missing
- What I chose: when the child has exited and its pipes are drained, `tape` stops reading its stdin, writes the end line, waits for its own stdout to flush and exits. If the child exits but a grandchild keeps the child's output pipes open, `tape` finishes 2 s after the exit event anyway.
- Alternatives: wait indefinitely for the pipes.
- Should the spec pin this? no.

## C-11: Signal exit on Windows
- Spec reference: REQ-EX-002, OPEN-EX-001
- Situation: missing
- What I chose: 128 + the number from `os.constants.signals` when Node reports a signal, 128 if it is unknown. SIGINT/SIGTERM handlers are only installed on non-Windows platforms.
- Alternatives: status 1.
- Should the spec pin this? no.

## C-12: Windows lookup details
- Spec reference: REQ-PL-001
- Situation: ambiguous
- What I chose: a name with an extension is tried as given; a name without one gets each `PATHEXT` extension. A name with a directory part is not searched on `PATH` but still gets `PATHEXT` tried. The current directory is searched first when there is no directory part. `.cmd`/`.bat` run via `%ComSpec% /d /s /c "..."` with arguments wrapped in quotes (inner quotes doubled) when they contain white space, quotes or `&|<>^%()`. A name that is not found is passed to `spawn` as is, which reports ENOENT and so gives status 127.
- Alternatives: `shell: true`.
- Should the spec pin this? no.

## C-13: Redaction passes over empty-match user patterns
- Spec reference: REQ-RD-004, OPEN-RD-001
- Situation: missing
- What I chose: `--redact` patterns are compiled with `new RegExp(p, 'g')` and applied as written; a pattern matching the empty string inserts `[REDACTED]` between every character.
- Alternatives: reject empty-matching patterns as usage errors.
- Should the spec pin this? no.

## C-14: Version string
- Spec reference: REQ-CLI-001
- Situation: missing
- What I chose: `tape 1.0.1` (the spec's document version).
- Alternatives: any text.
- Should the spec pin this? no, it is OPEN-CLI-001.
