## C-1: Unknown single-dash options
- Spec reference: OPEN-CLI-002
- Situation: missing
- What I chose: any unknown argument starting with `-` before the command is a usage error (status 2).
- Alternatives: ignore it; treat it as the start of the command.
- Should the spec pin this? no, already open.

## C-2: Help/version versus usage errors
- Spec reference: OPEN-CLI-003, REQ-CLI-003
- Situation: ambiguous
- What I chose: the whole option list is parsed first. `--help` wins, then `--version`, then any usage error. So `tape --help --bogus` prints help and exits 0.
- Alternatives: report the error first.
- Should the spec pin this? no.

## C-3: Existing trace file of the same name
- Spec reference: OPEN-TR-005
- Situation: missing
- What I chose: the file is opened with truncation (`wb`), so each trace always has one meta line first.
- Alternatives: append; add a suffix to the name; fail.
- Should the spec pin this? no. The stamp has millisecond resolution.

## C-4: Lines that are not valid UTF-8, or that begin with a BOM
- Spec reference: OPEN-TR-004
- Situation: missing
- What I chose: they are forwarded but not logged. A BOM makes the JSON parse fail, so the line is dropped.
- Alternatives: decode with replacement characters; strip the BOM.
- Should the spec pin this? no.

## C-5: Numbers outside binary64, NaN and Infinity
- Spec reference: OPEN-TR-003, REQ-TR-007
- Situation: missing
- What I chose: `NaN`, `Infinity` and `-Infinity` are not JSON, so such lines are not logged. A number like `1e999` is logged as `null`. Big integers are written exactly. `-0` is written as `-0.0`. For duplicate keys the last one wins.
- Alternatives: write the number as a string; drop the message.
- Should the spec pin this? no.

## C-6: Non-ASCII in the trace file
- Spec reference: REQ-TR-002
- Situation: ambiguous
- What I chose: trace lines are written with `\uXXXX` escapes for non-ASCII characters. This is still valid UTF-8 text and the same JSON value, and it survives lone surrogates.
- Alternatives: write raw UTF-8.
- Should the spec pin this? no. The spec compares JSON values.

## C-7: Redacting text a previous step already replaced
- Spec reference: OPEN-RD-002
- Situation: ambiguous
- What I chose: step 4 and `--redact` patterns run over every string, including `[REDACTED]` from earlier steps. So `--redact RED` turns it into `[[REDACTED]ACTED]`.
- Alternatives: skip replaced values.
- Should the spec pin this? no, already open.

## C-8: Translating `--redact` patterns to Python
- Spec reference: REQ-RD-004
- Situation: missing
- What I chose: a small translator rewrites `.`, `$`, `\s` and `\S` into explicit classes, and compiles the result with `re.ASCII`. This gives ECMAScript meanings: `$` is `\Z`, and `\s` is the ECMAScript whitespace set. Everything else is passed to Python `re` unchanged. Patterns that Python rejects are usage errors (status 2).
- Alternatives: write a full ECMAScript regex engine (too big for the budget).
- Should the spec pin this? no. OPEN-RD-001 covers syntax beyond the tested list.

## C-9: Where "whitespace" applies in label derivation
- Spec reference: REQ-LB-001
- Situation: ambiguous
- What I chose: "contains any whitespace character" uses the ECMAScript whitespace set from § 6.2. If the part after the last `/` or `\` is empty, that argument is skipped and the search continues.
- Alternatives: Python `str.isspace`.
- Should the spec pin this? unsure. The two sets differ only for exotic characters (for example U+0085 and U+001C to U+001F).

## C-10: Label and file-name limits count code points
- Spec reference: OPEN-LB-001
- Situation: ambiguous
- What I chose: each code point outside the allowed set becomes one `-`, and the 32- and 64-character limits count code points.
- Alternatives: count UTF-16 units.
- Should the spec pin this? no, already open.

## C-11: Grandchild holding the child's pipes
- Spec reference: OPEN-FW-002, REQ-FW-005
- Situation: missing
- What I chose: after the child exits, wait up to 5 seconds per output pipe for end of file, then finish.
- Alternatives: wait forever; don't wait.
- Should the spec pin this? no.

## C-12: Input arriving after the child exits, and broken pipes
- Spec reference: OPEN-FW-002
- Situation: missing
- What I chose: once writing to the child's stdin fails, further input is read and dropped (not forwarded). A failure writing to `tape`'s stdout stops forwarding, but `tape` keeps draining the child. Lines are logged only until the child exits.
- Alternatives: exit immediately on a broken pipe.
- Should the spec pin this? no, already open.

## C-13: Windows support is untested
- Spec reference: REQ-PL-001, REQ-PL-002
- Situation: missing
- What I chose: on Windows a bare command name is resolved with `shutil.which` (which uses `PATHEXT` and the current directory) and handed to `subprocess.Popen` as an argument list. Names with a directory or extension go straight to Popen. This could not be run here (Linux only).
- Alternatives: implement the lookup by hand.
- Should the spec pin this? no.

## C-14: Redaction of the command line when the command is not found
- Spec reference: REQ-EX-004, REQ-RD-005
- Situation: ambiguous
- What I chose: the meta line holds the redacted command, and the error message on stderr shows only the program name.
- Alternatives: show the whole command.
- Should the spec pin this? no.

## C-15: Timestamps on message lines
- Spec reference: REQ-TR-004, OPEN-TR-002
- Situation: ambiguous
- What I chose: `t` is taken when the line is complete on the wire (before redaction), not when it is written to the file.
- Alternatives: the write time.
- Should the spec pin this? no.

## C-16: Usage error versus a trace for `--label` alone
- Spec reference: REQ-CLI-004
- Situation: ambiguous
- What I chose: `tape --label x` with no command is "no command", a usage error (status 2), and writes nothing.
- Alternatives: none.
- Should the spec pin this? no.

## C-17: Recursion limit
- Spec reference: OPEN-TR-004
- Situation: missing
- What I chose: the recursion limit is 3000. A message nested deeper than that, or too deep for the JSON parser, is forwarded but not logged. The error is caught and ignored.
- Alternatives: an iterative redactor.
- Should the spec pin this? no.
