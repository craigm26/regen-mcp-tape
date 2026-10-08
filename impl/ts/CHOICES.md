## C-1: Unknown single-dash options
- Spec reference: OPEN-CLI-002, REQ-CLI-002
- Situation: ambiguous
- What I chose: An unknown argument beginning with a single `-` before the command is a usage error (status 2).
- Alternatives: Ignore it; treat it as the command start.
- Should the spec pin this? no, already open.

## C-2: --help/--version together with usage errors
- Spec reference: OPEN-CLI-003
- Situation: ambiguous
- What I chose: Parsing stops at the first error; help/version seen before it win, otherwise the error wins. Invalid `--redact` regexes and a missing command are checked only when neither help nor version was given.
- Alternatives: Errors always win.
- Should the spec pin this? no.

## C-3: Existing trace file of the same name
- Spec reference: OPEN-TR-005
- Situation: missing
- What I chose: Open with `w` (truncate).
- Alternatives: `wx` and fail with status 1; append.
- Should the spec pin this? no.

## C-4: Trace writes are synchronous
- Spec reference: OPEN-TR-005
- Situation: missing
- What I chose: Each line is written with a synchronous write as soon as it is complete. Forwarding of a chunk happens before it is logged.
- Alternatives: Buffered async writes.
- Should the spec pin this? no.

## C-5: Messages that cannot be redacted
- Spec reference: OPEN-TR-004
- Situation: missing
- What I chose: If redaction throws (for example nesting too deep), the message is not logged; it is still forwarded. Invalid UTF-8 is decoded with U+FFFD replacement; a leading BOM is kept, so such a line is not JSON and is not logged.
- Alternatives: Log a placeholder.
- Should the spec pin this? no.

## C-6: Step 4 sees already-redacted text
- Spec reference: OPEN-RD-002
- Situation: ambiguous
- What I chose: Step 4 patterns run over every string, including `[REDACTED]` written earlier in the string; the whole value replaced by steps 1 and 3 is also run over (not skipped).
- Alternatives: Skip replaced values.
- Should the spec pin this? no.

## C-7: Patterns 1–9 use the JavaScript engine directly
- Spec reference: REQ-RD-002, OPEN-RD-003
- Situation: ambiguous
- What I chose: Patterns 1–9 are plain regexes (pattern 9 with the lookbehind), so contrived inputs may be quadratic; patterns 10 and 11 follow the word-based descriptions in linear time (with a cheap `includes` pre-check per word).
- Alternatives: Hand-written scanners for all patterns.
- Should the spec pin this? no, already open.

## C-8: Redaction as four tree passes
- Spec reference: § 6
- Situation: ambiguous
- What I chose: Steps 1–4 each walk the whole tree in turn, producing a new tree each time. Objects are rebuilt with `Object.fromEntries` so a `__proto__` key stays an ordinary member. Duplicate keys: the last one wins (JSON.parse).
- Alternatives: Single pass.
- Should the spec pin this? no.

## C-9: Output spelling of numbers
- Spec reference: OPEN-TR-003
- Situation: missing
- What I chose: JSON.parse then JSON.stringify, so `1.0` becomes `1`, `-0` becomes `0`, `1e999` becomes `null`, integers above 2^53 lose precision.
- Alternatives: Preserve number text.
- Should the spec pin this? no.

## C-10: Process exit after the end line
- Spec reference: REQ-FW-005
- Situation: missing
- What I chose: After the child's `close` event (stdout/stderr fully read) write the end line, flush `process.stdout` with an empty write callback, then `process.exit(code)`. Input that arrives after the child exits is dropped. A grandchild holding the pipes open delays exit (the `close` event waits for it).
- Alternatives: Exit on `exit` event with a timeout.
- Should the spec pin this? no, already open (OPEN-FW-002).

## C-11: Signals and child stderr
- Spec reference: REQ-FW-003, REQ-EX-003
- Situation: missing
- What I chose: Child stderr is inherited directly (byte exact). SIGINT/SIGTERM handlers are installed only after the child is spawned, only on non-Windows. A child killed by a signal not known to Node's `os.constants.signals` gives 128.
- Alternatives: Pipe stderr through tape.
- Should the spec pin this? no.

## C-12: Command that cannot start
- Spec reference: REQ-EX-004
- Situation: ambiguous
- What I chose: The meta line is already on disk before spawn; on the spawn `error` event (no pid) tape writes a stderr message, then the end line with 127, and exits 127. Directory-component command names are not looked up differently.
- Alternatives: Check the command before creating the trace.
- Should the spec pin this? no.

## C-13: Windows command lookup
- Spec reference: REQ-PL-001, OPEN-PL-002
- Situation: ambiguous
- What I chose: A name without directory or extension is searched in `.` then `PATH`, trying each `PATHEXT`. `.cmd`/`.bat` files are run through `%ComSpec% /d /s /c "..."` with verbatim arguments, quoting only arguments with white space or empty. Not tested on Windows (no Windows available).
- Alternatives: `shell: true`.
- Should the spec pin this? no.

## C-14: Label name truncation unit and `--label` empty
- Spec reference: REQ-TR-001, OPEN-LB-001
- Situation: ambiguous
- What I chose: Lengths count UTF-16 units; each unit outside the allowed set becomes `-`. An empty `--label ""` is used exactly (meta label `""`), file name part `mcp`.
- Alternatives: Count code points.
- Should the spec pin this? no, already open.

## C-15: Option values and repeats
- Spec reference: OPEN-CLI-002
- Situation: ambiguous
- What I chose: Repeating `--out` or `--label`: last wins. `--redact ""` (empty pattern) is accepted; it matches empty strings and replaces them, inserting `[REDACTED]` at every position (JS semantics).
- Alternatives: Reject.
- Should the spec pin this? no.

## C-16: Test of SIGUSR on Node children
- Spec reference: REQ-EX-002
- Situation: missing
- What I chose: My test uses SIGUSR2 for the "other signal" case, because a Node child does not die on SIGUSR1 (it starts the inspector). The implementation uses the platform's number for any signal.
- Alternatives: A non-Node child.
- Should the spec pin this? no.
