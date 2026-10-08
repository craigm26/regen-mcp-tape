# Decisions

Why SPEC.md says what it says. "The earlier implementation" means the program this spec was
extracted from, a TypeScript stdio proxy with the same trace format.

## D-001: Forwarded bytes are never touched
- Source: extraction
- Context: The earlier implementation wrote each chunk it read straight to the other side
  before looking at it, and kept redaction to the trace.
- Decision: REQ-FW-001, REQ-FW-002: byte-for-byte forwarding in both directions, whatever the
  bytes are, and nothing else on standard output.
- Why: A proxy that changes protocol bytes, or adds output, breaks the client.
- Alternatives: none.

## D-002: End of input reaches the child
- Source: extraction, primary source
- Context: The earlier implementation never closed the child's standard input when its own
  standard input ended. MCP's stdio shutdown begins with the client closing the server's
  input; a server that waits for that end of file (as many do) therefore never exits behind
  the earlier implementation, and the client has to kill the proxy.
- Decision: REQ-FW-004.
- Why: The proxy should be invisible to the shutdown sequence.
- Alternatives: Keep the earlier behavior (breaks clean shutdown).

## D-003: The proxy exits when the child exits
- Source: extraction
- Context: After the child exited, the earlier implementation also waited for its own
  standard input to end before exiting. A client that keeps the pipe open while waiting for
  the server to go away would wait forever.
- Decision: REQ-FW-005.
- Why: The child's exit is the end of the session.
- Alternatives: Wait for the client (the earlier behavior).

## D-004: A final line without LF is still logged
- Source: extraction
- Context: The earlier implementation forwarded the bytes after the last LF at end of file but
  never logged them.
- Decision: REQ-TR-008.
- Why: The trace should record what passed through. MCP requires LF-terminated messages, so
  this only matters for a misbehaving peer, which is when a trace is most useful.
- Alternatives: Leave it unlogged (and open).

## D-005: Lines are decoded whole
- Source: extraction
- Context: The earlier implementation decoded each read as UTF-8 on its own, so a multi-byte
  character split across two reads was logged as two replacement characters, while the
  forwarded bytes stayed correct.
- Decision: REQ-TR-007 step 1.
- Why: The trace would otherwise disagree with the wire for perfectly valid traffic.
- Alternatives: none reasonable.

## D-006: Any JSON line is a message; a batch is one message
- Source: extraction
- Context: The earlier implementation logged any line that parsed as JSON, including numbers,
  strings, `null` and arrays. A JSON-RPC batch is an array and was logged as one line.
- Decision: REQ-TR-007 steps 3 and 4.
- Why: Simple and lossless; consumers decide what is JSON-RPC.
- Alternatives: Log only objects (drops malformed traffic from the record).

## D-007: Redaction keeps the earlier implementation's rules exactly, quirks included
- Source: extraction
- Context: The earlier implementation redacted in two stages: a rule file (exact-key rules
  plus string patterns), then an older built-in pass (key substrings plus four of the same
  string patterns again, plus user patterns). The key-substring pass leaves numbers alone
  (`max_tokens: 100` survives) but redacts any string, object or array under a key containing
  `token` (so MCP's `progressToken` is redacted). The exact-key pass replaces any value type.
- Decision: § 6 restates both stages as four steps, in the same order, with the same lists.
- Why: Traces made by this program and the earlier one should redact the same things. The
  quirks are visible but harmless: they err toward hiding.
- Alternatives: A cleaner single pass (different traces for the same traffic).

## D-008: Regular-expression meanings are pinned
- Source: extraction
- Context: The patterns were written for JavaScript. Other engines differ: Python's `\b` and
  `\s` are Unicode-aware by default, and Python's `.` matches CR and U+2028, which JavaScript's
  does not. `Authorization: x` followed by CRLF redacts only up to the CR in JavaScript.
- Decision: REQ-RD-002 pins `\b` (ASCII), `\s` (the ECMAScript set) and `.`.
- Why: Two implementations must redact the same text.
- Alternatives: Let each language use its own defaults (different traces).

## D-009: Pattern 9 is restated without lookbehind
- Source: extraction
- Context: The connection-string pattern uses a variable-length lookbehind, which some engines
  (including Python's standard `re`) do not support.
- Decision: REQ-RD-002 describes pattern 9 in words.
- Why: The behavior, not the regex, is the contract.
- Alternatives: none.

## D-010: Redaction must run in linear time
- Source: extraction
- Context: Patterns 10 and 11 begin with `[^\s"]*`. A backtracking engine evaluates them in
  time proportional to the square of the length of a run of non-space characters. Measured
  with the JavaScript engine: 1 s for a 40,000-character word, so tens of minutes for a 2 MB
  base64 blob, which MCP servers do send (images, resources). The earlier implementation
  evaluated them directly, on the same thread that forwards bytes.
- Decision: REQ-RD-002 gives exact word-based equivalents of patterns 10 and 11 (checked
  against the regexes on random inputs), and REQ-RD-006 requires a 2 MB blob to go through
  within the suite's time limit.
- Why: A proxy must not stall on large messages.
- Alternatives: Drop the two patterns (weaker redaction).

## D-011: The command line is redacted, and the label comes from the redacted command
- Source: extraction, primary source
- Context: The trace format says producers should redact command-line arguments the way they
  redact messages. The earlier implementation wrote `meta.command` verbatim; its label
  derivation skipped arguments containing white space, but a token passed as a single argument
  could still end up in the label and so in the file name.
- Decision: REQ-RD-005 and REQ-LB-001: string rules on each argument; label derived after.
- Why: The file name is the least protected place a secret can land.
- Alternatives: Leave the command verbatim (the earlier behavior).

## D-012: Labels split on `\` as well as `/`
- Source: extraction
- Context: The earlier implementation took the part after the last `/`, so on Windows
  `C:\srv\files.mjs` became `c--srv-files-mjs`.
- Decision: REQ-LB-001 step 3 splits on both.
- Why: Windows paths should label the same way as POSIX ones.
- Alternatives: Keep `/` only.

## D-013: Signal exits use the real signal number
- Source: extraction
- Context: The earlier implementation mapped five signal names to numbers and wrote 128 + 0 for
  any other signal (so SIGUSR1 gave 128).
- Decision: REQ-EX-002: 128 + the platform's number.
- Why: That is the shell convention, and clients that inspect exit codes rely on it.
- Alternatives: Keep the table.

## D-014: A command that cannot start exits 127 and still leaves a trace
- Source: extraction
- Context: On POSIX the earlier implementation crashed (status 1) when the command was not
  found, before writing the end line. On Windows it started commands through the shell, which
  printed an error and returned 1.
- Decision: REQ-EX-004: status 127, as shells do, and a complete trace with `exitCode` 127.
- Why: A predictable status, and a record that the attempt happened.
- Alternatives: Status 1, no trace.

## D-015: Usage errors are status 2, including a bad `--redact` pattern
- Source: extraction
- Context: The earlier implementation used status 2 for argument errors, but compiled
  `--redact` patterns only after creating the output directory, so an invalid pattern crashed
  with status 1.
- Decision: REQ-CLI-004.
- Why: An invalid pattern is a usage error, and nothing should be created.
- Alternatives: Status 1.

## D-016: The trace format is restated, without a producer-version member
- Source: extraction
- Context: The trace format allows an optional member naming the producing program's version.
- Decision: REQ-TR-003 to REQ-TR-006 restate the three line types; extra members are open
  (OPEN-TR-001), so neither including nor omitting such a member is wrong.
- Why: This program is not the earlier one and should not claim its name.
- Alternatives: Forbid extra members.

## D-017: Windows command lookup and arguments
- Source: extraction
- Context: The earlier implementation started the child through the Windows shell so that
  `.cmd` shims such as `npx` would resolve. Going through the shell also re-splits arguments
  that contain spaces and drops empty ones.
- Decision: REQ-PL-001 (PATH and PATHEXT lookup, `.cmd`/`.bat` run) and REQ-PL-002 (arguments
  exact for programs); arguments to `.cmd`/`.bat` with special characters are open
  (OPEN-PL-001), because the Windows command interpreter has its own quoting rules.
- Why: `npx`-style commands are the common case on Windows; exact arguments are what a proxy
  owes its child.
- Alternatives: Always use the shell (breaks arguments); never use it (breaks `npx`).

## D-018: A command may follow the options without `--`
- Source: extraction
- Context: The earlier implementation treated the first non-option argument as the start of
  the command, because some Windows shells drop a literal `--` before passing arguments on.
- Decision: REQ-CLI-002.
- Why: Compatibility with how the program is actually invoked.
- Alternatives: Require `--`.

## D-019: What is compared exactly
- Source: extraction
- Context: Timestamps depend on the clock; the order in which the two directions are read
  depends on scheduling; JSON numbers can be written several ways.
- Decision: Pinned: forwarded bytes, order within one direction, `raw` as a JSON value with
  binary64 numbers (REQ-TR-009, REQ-TR-010), exit status, file name shape. Open: timestamps
  beyond their format, cross-direction interleaving, number spelling (OPEN-TR-002,
  OPEN-TR-003).
- Why: Pin what a consumer can rely on; leave what no two runs could reproduce.
- Alternatives: Compare whole trace files (impossible across runs).

## D-020: Configuration files, environment variables and the earlier extras are out of scope
- Source: extraction
- Context: The earlier implementation also read a per-user redaction file and several
  environment variables, rotated large traces, streamed over a websocket and uploaded traces.
- Decision: None of that is in this spec. The options are exactly those in REQ-CLI-001;
  others are open (OPEN-CLI-002).
- Why: The core proxy is the part worth pinning first.
- Alternatives: Include them (a much larger spec).

## D-021: The suite resolves driver paths
- Source: r01
- Context: REQ-IF-001 said the driver's program path "MUST resolve relative to the
  implementation folder" although the suite may start it elsewhere. A driver made of plain
  words cannot do that by itself. The r01 builder wrote `node tape.ts` and noted it would only
  work if the suite resolved the path (C-1).
- Decision: REQ-IF-001 now says what the suite does: it turns driver words that name files in
  the implementation folder into absolute paths before starting the driver.
- Why: The requirement asked the builder for something only the suite can do.
- Alternatives: Start the driver inside the implementation folder (then the default `--out`
  would write into it).

## D-022: More edges are open
- Source: r01
- Context: r01 made choices about `--help` alongside usage errors, non-ASCII characters in file
  names, lines with a byte-order mark, messages it cannot redact for internal reasons, a
  grandchild holding the child's pipes open, Windows lookup of names with a directory or
  extension, and `--redact` patterns that match the empty string (C-3, C-5, C-7, C-8, C-10,
  C-12, C-13).
- Decision: OPEN-CLI-003, OPEN-PL-002, and wider OPEN-LB-001, OPEN-TR-004, OPEN-FW-002 and
  OPEN-RD-001. REQ-LB-001 gains an example for a redacted argument (C-9).
- Why: Nothing a normal client or server does depends on these.
- Alternatives: Pin each one.

## D-023: `--redact` flags and anchors are pinned
- Source: r02
- Context: REQ-RD-004 listed the anchors `^` and `$` among the syntax the suite uses in
  `--redact` patterns but never said which flags apply, so whether they anchor to the whole
  string or to each line was unstated. In Python, `$` also matches just before a final LF. The
  r02 builder chose the global flag alone and asked whether the spec should say so (C-5). The
  earlier implementation compiles each pattern with the global flag alone (`src/redact.ts:40`).
- Decision: Patterns are applied with the global flag and no other. `^` and `$` anchor to the
  whole string value, `$` does not match before a final LF, `.`, `\b` and `\s` keep the
  meanings of REQ-RD-002, and matching is case-sensitive. REQ-RD-004 gains examples and the
  suite a case (`rd-user-pattern-meanings`).
- Why: The same pattern would otherwise redact different text in different languages, and
  anchors were already in the tested syntax.
- Alternatives: Multiline mode; drop anchors from the tested syntax and leave them open.

## D-024: Redacting already-replaced text, contrived worst cases, and odd numbers are open
- Source: r02
- Context: Three places where the text said more, or less, than anything depends on.
  1. Step 4 runs over every string value, so a `--redact` pattern can match inside a
     `[REDACTED]` written by an earlier step (r02: `--redact RED` gives `[[REDACTED]ACTED]`).
     The earlier implementation skips values replaced by the key-substring step but not values
     replaced by steps 1 and 2 (C-6).
  2. REQ-RD-006's first sentence promised time roughly proportional to message size for every
     input. The suite tests only the large-blob case, and the r02 builder noted that patterns
     4 and 9, run by a backtracking engine, are still quadratic on contrived input such as a
     long run of `eyJ` (C-14).
  3. A standard JSON reader turns `-0` into `0` and `1e999` into infinity, which a standard
     writer turns into `null` (C-9).
- Decision: OPEN-RD-002 (whether step 4 sees already-replaced text) and OPEN-RD-003 (time on
  contrived input). REQ-RD-006 now pins only the large-blob case it tests. OPEN-TR-003 now
  names `-0` and numbers outside the binary64 range.
- Why: No client, server or trace reader depends on any of them.
- Alternatives: Pin the earlier implementation's partial skipping; require linear time for
  every pattern (which rules out a language's own regular-expression engine for patterns 4
  and 9); require exact number text in `raw`.

## D-025: A member named `__proto__` is an ordinary member
- Source: r03
- Context: r03 rebuilt objects with `Object.fromEntries` so that a message member named
  `__proto__` stays a member (C-8). The earlier implementation rebuilds objects by assignment
  (`obj[k] = ...`), and in JavaScript assigning to `__proto__` sets the object's prototype
  instead, so such a member drops out of the trace. No case covered it.
- Decision: No change to the text: REQ-TR-010 already keeps every member. The suite gains a case
  (`fw-proto-member`) with `__proto__` and `constructor` members.
- Why: A trace that silently drops members is wrong for any client that sends them.
- Alternatives: Leave it untested.

## D-026: The builder's own tests run on both platforms
- Source: r04 (a check on Windows, outside the suite)
- Context: REQ-IF-001 said the same REGEN.json must work on Windows and on Linux, but not that
  the builder's own `test` command runs on both. r04 was built and tested on Linux. On Windows
  its program passed every suite case, and 3 of its 19 tests failed: two expected LF line ends
  from a Python child, whose `print` writes CRLF on Windows, and one used SIGUSR1, which Windows
  does not have.
- Decision: REQ-IF-001 now says CI runs `build`, `test` and the suite on both platforms, so
  `test` must pass on both, and tests of POSIX-only behavior skip on Windows.
- Why: CI runs the tests on both, as the brief requires, and a builder working on one platform
  cannot see the other.
- Alternatives: Run the builder's tests only on the platform it built on.

## D-027: More edges are open (from r03 and r04)
- Source: r03, r04
- Context: r03 installs its signal handlers after starting the child, and gives 128 for a signal
  its runtime cannot name (C-11). r04 takes white space in REQ-LB-001 to be ECMAScript's, where
  Python's `str.isspace` also counts U+0085 and U+001C to U+001F (C-9), and takes `t` when a line is
  read rather than when it is written (C-15).
- Decision: OPEN-EX-002 and OPEN-LB-002, and a wider OPEN-TR-002.
- Why: No client or server depends on these.
- Alternatives: Pin each one.

## D-028: Windows line ends are part of the test requirement
- Source: r05 (a check on Windows, outside the suite)
- Context: After D-026, r05 skipped its POSIX-only tests on Windows as REQ-IF-001 asked, but one
  of its tests still expected LF from a Python child that writes through `sys.stdout.write`. On
  Windows, Python's text-mode standard output writes CRLF. D-026 described that trap, but only as
  context for r04.
- Decision: REQ-IF-001 states it: a test that compares bytes a child wrote has the child write
  bytes, or accepts CRLF.
- Why: A builder acts on requirements and reads context. Neither r04 nor r05 could run Windows.
- Alternatives: Leave it in this file; run builder tests only on the build's own platform.

## D-029: Two more edges are open (from r05)
- Source: r05
- Context: r05 translates `--redact` patterns into Python with ECMAScript meanings, except `\S`
  inside a bracketed class, which keeps Python's ASCII meaning (C-4). It matches key substrings
  case-insensitively for ASCII letters only, which is also what the earlier implementation's
  regular expressions do (C-16).
- Decision: OPEN-RD-001 names `\S` inside a bracketed class; OPEN-RD-004 is new.
- Why: The differences need white space or letters outside ASCII in a user pattern or a key name.
  Nothing depends on them.
- Alternatives: Require a full ECMAScript translation; require Unicode case folding.

