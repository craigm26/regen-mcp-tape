## C-1: package.json with only "type": "module"
- Spec reference: REQ-FW-003, REQ-BU-002
- Situation: missing
- What I chose: Added a `package.json` with no dependencies and `"type": "module"`. Without it Node prints a MODULE_TYPELESS_PACKAGE_JSON warning to stderr, which would break byte-exact stderr forwarding.
- Alternatives: Use `.mts` file names; pass `--no-warnings` in the driver (the driver is fixed as plain words, so this is possible but noisy).
- Should the spec pin this? yes, a TS builder will hit it; the spec could mention that stray stderr from the runtime counts against REQ-FW-003.

## C-2: Single-dash unknown options are usage errors
- Spec reference: OPEN-CLI-002, REQ-CLI-002
- Situation: ambiguous
- What I chose: An unknown argument starting with a single `-` before the command (including a bare `-`) is a usage error, exit 2.
- Alternatives: Treat it as the start of the command; ignore it.
- Should the spec pin this? no, it is already OPEN.

## C-3: --help/--version win over usage errors
- Spec reference: OPEN-CLI-003
- Situation: ambiguous
- What I chose: Parsing records the first error and continues. If help is seen, help is printed and the exit is 0 even if there is an error. Version beats an error too.
- Alternatives: Errors win.
- Should the spec pin this? no.

## C-4: --redact patterns matching the empty string are ignored
- Spec reference: OPEN-RD-001
- Situation: ambiguous
- What I chose: Such a pattern is skipped with a warning on stderr. A global replace of an empty match would insert `[REDACTED]` between every character.
- Alternatives: Apply as-is; make it a usage error.
- Should the spec pin this? no. It is OPEN. Ignoring a redaction pattern is a quiet weakening, so a usage error might be better.

## C-5: User patterns always use the `g` flag only
- Spec reference: REQ-RD-004
- Situation: missing
- What I chose: `new RegExp(p, 'g')`; no other flags, so `^`/`$` anchor to the whole string value.
- Alternatives: Multiline mode.
- Should the spec pin this? unsure; `^`/`$` are in the allowed pattern syntax, so whether they mean whole string or line matters.

## C-6: Steps 1 to 3 run as one tree walk, step 4 as a second walk
- Spec reference: REQ-RD-001..004
- Situation: ambiguous
- What I chose: Exact keys, step 2 strings and key substrings are done in one pass (they commute). Step 4 is a separate pass over every string, including ones already replaced by `[REDACTED]`. So a `--redact` pattern can match inside `[REDACTED]` (a pattern `RED` gives `[[REDACTED]ACTED]`).
- Alternatives: Skip step 4 for already-redacted values.
- Should the spec pin this? unsure. It follows the text literally ("every string value at any depth").

## C-7: Messages that cannot be redacted are dropped from the trace
- Spec reference: OPEN-TR-004
- Situation: ambiguous
- What I chose: If redaction throws (for example, nesting too deep), the line is not logged. Forwarding is unaffected.
- Alternatives: Log a placeholder.
- Should the spec pin this? no.

## C-8: Lines with a BOM and invalid UTF-8
- Spec reference: OPEN-TR-004
- Situation: ambiguous
- What I chose: Decode non-fatally (invalid bytes become U+FFFD) and keep a BOM, so a BOM line fails JSON parsing and is not logged.
- Alternatives: Strip the BOM; skip invalid lines.
- Should the spec pin this? no.

## C-9: -0 and out-of-range numbers
- Spec reference: REQ-TR-010
- Situation: ambiguous
- What I chose: Used JSON.parse and JSON.stringify as is. `-0` is written as `0`, and `1e999` becomes `null`.
- Alternatives: A custom number-preserving parser.
- Should the spec pin this? yes, if the suite compares binary64 values strictly. `-0` and overflow are edge cases the text does not address.

## C-10: Trace file name collisions
- Spec reference: OPEN-TR-005, REQ-EX-005
- Situation: missing
- What I chose: The file is opened with `wx`. If a file of that name exists, creation fails and tape exits 1.
- Alternatives: Append a counter.
- Should the spec pin this? no.

## C-11: Trace lines are written synchronously
- Spec reference: OPEN-TR-005
- Situation: missing
- What I chose: Each line is written with a synchronous write as the message is seen. Forwarding happens first, because piping is set up before the logging listener.
- Alternatives: Buffer and flush on exit.
- Should the spec pin this? no.

## C-12: Exit waits for the child's pipes to close
- Spec reference: REQ-FW-005, OPEN-FW-002
- Situation: ambiguous
- What I chose: tape finishes on the child's `close` event (process exited and its stdout and stderr ended). A grandchild holding the pipes open delays exit indefinitely.
- Alternatives: A grace period after `exit`.
- Should the spec pin this? no. It is OPEN.

## C-13: Windows command lookup
- Spec reference: REQ-PL-001, OPEN-PL-002
- Situation: ambiguous
- What I chose: A bare name is looked up in the current directory then PATH, with each PATHEXT extension. A `.cmd`/`.bat` match runs through `cmd.exe /d /s /c` with my own quoting. Anything else, including names with a directory or extension, is passed straight to spawn. An unresolved name goes to spawn, so ENOENT gives 127.
- Alternatives: Always use the shell.
- Should the spec pin this? no.

## C-14: Pattern 10 and 11 implemented per word
- Spec reference: REQ-RD-002, REQ-RD-006
- Situation: ambiguous
- What I chose: Followed the word-based description exactly, with a scan from the right for `.env` start positions. Patterns 1 to 9 use native JS regexes. Patterns 4 and 9 are still worst-case quadratic on adversarial input such as `eyJeyJeyJ...`, but not on base64 blobs.
- Alternatives: Hand-written scanners for every pattern.
- Should the spec pin this? unsure. REQ-RD-006 only names patterns 10 and 11.

## C-15: Spawn failure detection
- Spec reference: REQ-EX-004
- Situation: missing
- What I chose: A child `error` event with no pid means the command could not be started; tape writes a message and finishes with 127. On POSIX a non-executable file gives EACCES and is treated the same.
- Alternatives: none.
- Should the spec pin this? no.

## C-16: Partial last line of stdin at child exit
- Spec reference: REQ-TR-008
- Situation: ambiguous
- What I chose: A partial last line is logged when its own direction reaches end of file. If the child exits before the client's input ends, a partial line from the client is not logged.
- Alternatives: Flush both on exit.
- Should the spec pin this? no.

## C-17: Test layout
- Spec reference: REQ-BU-003, PROMPT rule 2
- Situation: missing
- What I chose: Tests are `*.test.ts` at the top level; the fake server is `tests/fake.mjs`, in a `tests/` folder so it is excluded from the size budget and is not picked up by `node --test`.
- Alternatives: none.
- Should the spec pin this? no.
