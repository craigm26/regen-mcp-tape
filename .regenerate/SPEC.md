# tape: specification

- Program: `tape`
- Document version: 1.1.0
- Date: 2026-10-07

`tape` is a transparent stdio proxy for Model Context Protocol (MCP) servers. A client starts
`tape` instead of the server; `tape` starts the server as its child, copies the client's
standard input to the child and the child's standard output back to the client, unchanged,
and on the side writes every JSON message it sees, in both directions, to a trace file in an
open line-oriented format. Secrets are redacted in the trace only, never in the forwarded
bytes. `tape` exits with the child's exit status.

`tape` is not any published package and does not claim to be one.

Conventions: MUST / MUST NOT are requirements; SHOULD marks an advisory requirement whose
test never fails a run. Requirements have IDs `REQ-<AREA>-<NNN>`. Deliberately unpinned
behavior has IDs `OPEN-<AREA>-<NNN>` (§ 10) and is never tested. "Client" is whoever started
`tape`; "child" is the server process `tape` starts. "Line" means a sequence of bytes ending
with LF (`0x0A`); the LF is not part of the line's content.

Primary sources: the JSON-RPC 2.0 specification; the Model Context Protocol specification,
its stdio transport (messages are newline-delimited JSON-RPC, UTF-8, with no embedded
newlines) and its lifecycle (to shut down a stdio server, the client closes the server's
input stream, waits for it to exit, then sends SIGTERM, then SIGKILL).

---

## 1. Interface

### 1.1 REGEN.json

**REQ-IF-001.** The implementation folder MUST contain `REGEN.json`, a JSON object with keys
`lang`, `build`, `test` and `driver`. `lang` is `"ts"` or `"py"`. Each of `build`, `test`
and `driver` is either a command string or an object whose keys are Node.js
`process.platform` values (for example `"win32"`) plus a required `"default"` key, each
mapping to a command string. The suite picks the entry for its own platform, else `default`.

- Commands run with the implementation folder as the working directory.
- `build` and `test` run through the platform shell (cmd.exe on Windows, `/bin/sh`
  elsewhere). An empty `build` means there is nothing to build.
- `driver` starts `tape` itself. It never goes through a shell: the suite splits it on single
  spaces, starts the first word as a program with the remaining words as arguments, and
  appends the arguments of the `tape` invocation being tested. It MUST therefore be plain
  space-separated words: no quotes, pipes, redirects, `&&`, or `.cmd` shims such as `npx`.
  Examples: `node tape.ts`; `{"win32": "py -3 tape.py", "default": "python3 tape.py"}`.
- The suite starts the driver with a temporary folder as the working directory. Before
  starting it, the suite replaces every driver word after the first that names an existing
  file or folder inside the implementation folder (for example `tape.ts`) with that file's
  absolute path. So write driver words as paths relative to the implementation folder; the
  implementation does not need to do anything to resolve them.
- Build output, if any, goes in `bin/`.
- The same REGEN.json MUST work on Windows and on Linux.

### 1.2 Invocation

```
tape [--out DIR] [--label NAME] [--redact REGEX]... [--no-redact-defaults] [--help] [--version] -- <command> [args...]
```

**REQ-CLI-001.** Options:

| option | meaning |
|---|---|
| `--out DIR` | directory for the trace file (default `./mcp-traces`, relative to `tape`'s working directory) |
| `--label NAME` | the trace label (default: derived from the command, § 5) |
| `--redact REGEX` | an extra redaction pattern (§ 6.4); may be given more than once |
| `--no-redact-defaults` | turn off the default redaction rules (§ 6) |
| `--help`, `-h` | write usage text to standard output and exit 0 |
| `--version`, `-v` | write a version line to standard output and exit 0 |

An option that takes a value takes the next argument as its value, whatever it looks like.

**REQ-CLI-002.** The command starts at the first argument after `--`, or, if there is no `--`,
at the first argument that is not an option or an option's value and does not begin with
`-`. Every argument from there on belongs to the command and is passed to it unchanged, even
if it looks like a `tape` option. Example: `tape --label x node srv.js --out y` runs
`node srv.js --out y`.

**REQ-CLI-003.** With `--help` or `--version`, `tape` writes a non-empty text to standard
output, exits 0, starts no child, and creates no trace file. If both are given, `--help`
wins. Their text is OPEN (OPEN-CLI-001).

**REQ-CLI-004.** Usage errors: an unknown option beginning with `--`, an option missing its
value, no command, or a `--redact` pattern that is not a valid regular expression. On a usage
error `tape` MUST write a message to standard error (wording OPEN), write nothing to standard
output, start no child, create no trace file, and exit with status 2.

---

## 2. Forwarding

**REQ-FW-001.** Every byte `tape` reads on its standard input MUST be written to the child's
standard input, in order, unchanged. Every byte the child writes to its standard output MUST
be written to `tape`'s standard output, in order, unchanged. This holds whatever the bytes
are: JSON or not, blank lines, CRLF line ends, invalid UTF-8, a final line without LF, and a
single line of several megabytes. Redaction never touches forwarded bytes.

**REQ-FW-002.** `tape` MUST write nothing to its standard output except the child's standard
output bytes.

**REQ-FW-003.** The child's standard error MUST reach `tape`'s standard error, byte for byte
and in order. `tape` may write its own lines to standard error as well; how they interleave
with the child's is OPEN (OPEN-FW-001).

**REQ-FW-004.** End of input. When `tape`'s standard input reaches end of file, `tape` MUST,
after forwarding every byte it read, close the child's standard input, so that the child sees
end of file. (This is the first step of MCP's stdio shutdown.)

**REQ-FW-005.** Child exit. When the child exits, `tape` MUST forward all remaining bytes of
the child's standard output and standard error, finish the trace file, and exit, **even if its
own standard input is still open**. It MUST NOT wait for the client to close standard input.

**REQ-FW-006.** The child is started with the same environment and working directory as
`tape`.

---

## 3. Exit status

**REQ-EX-001.** When the child exits with status N, `tape` MUST exit with status N.

**REQ-EX-002.** POSIX only: when the child is ended by signal number S, `tape` MUST exit with
status 128 + S, where S is the platform's number for that signal (for example SIGTERM 15,
SIGKILL 9, and on Linux SIGUSR1 10).

**REQ-EX-003.** POSIX only: when `tape` receives SIGINT or SIGTERM, it MUST send the same
signal to the child and keep running until the child exits; its exit status then follows
REQ-EX-001 and REQ-EX-002. (A child that handles SIGTERM and exits 0 makes `tape` exit 0.)

**REQ-EX-004.** If the command cannot be started (no such program, or not executable),
`tape` MUST write a message to standard error, write a complete trace file whose `end` line
has `exitCode` 127, and exit with status 127.

**REQ-EX-005.** If the trace file cannot be created (for example `--out` names an existing
regular file), `tape` MUST write a message to standard error, start no child, and exit with
status 1.

---

## 4. Trace file

### 4.1 Location and name

**REQ-TR-001.** `tape` writes exactly one trace file per run into the `--out` directory,
creating that directory and any missing parents. The file name is
`<stamp>-<name>.jsonl` where:

- `<stamp>` is the UTC time at which `tape` started, written `YYYY-MM-DDTHH-MM-SS-mmmZ`
  (an ISO 8601 timestamp with `:` and `.` replaced by `-`), e.g. `2026-10-07T21-14-54-168Z`;
- `<name>` is the label (§ 5) with every character other than ASCII letters, digits, `_` and
  `-` replaced by `-`, cut to its first 64 characters; if that is empty, `mcp`.

Example: label `my server/v2` gives name `my-server-v2`.

### 4.2 Lines

**REQ-TR-002.** The file is UTF-8 text. Every line is one JSON object followed by LF. The
first line is the meta line, the last line is the end line, and every line in between is a
message line. There is exactly one meta line and exactly one end line.

**REQ-TR-003.** Meta line:

```
{"v":1,"type":"meta","startedAt":"<time>","label":"<label>","command":[<arguments>]}
```

- `v` is the number 1; `type` is `"meta"`.
- `startedAt` is a UTC time in the form `YYYY-MM-DDTHH:MM:SS.mmmZ`.
- `label` is the label (§ 5): the `--label` value exactly as given, or the derived label.
- `command` is the child's command and arguments as strings, in order, each passed through
  the active string rules of redaction (REQ-RD-005).

**REQ-TR-004.** Message line, one per logged message (§ 4.3):

```
{"t":"<time>","dir":"in"|"out","raw":<message>}
```

- `t` is a UTC time in the same form as `startedAt`.
- `dir` is `"in"` for client→child traffic and `"out"` for child→client traffic.
- `raw` is the message, parsed as JSON and then redacted (§ 6).

**REQ-TR-005.** End line, written after every message line:

```
{"t":"<time>","type":"end","exitCode":<integer>,"durationMs":<integer>}
```

- `exitCode` is `tape`'s own exit status for this run (§ 3).
- `durationMs` is a non-negative integer: milliseconds from `startedAt` to this line's `t`.

Other members in meta, message and end lines are open (OPEN-TR-001); consumers ignore
unknown members.

### 4.3 Which lines are logged

**REQ-TR-007.** In each direction separately, `tape` splits the bytes into lines at LF. For
each line:

1. The line's bytes are decoded as UTF-8 **as a whole**. A multi-byte character split across
   two reads or writes MUST be decoded correctly.
2. If the line consists only of spaces, tabs and CRs, it is skipped.
3. Otherwise, if the line parses as JSON (any JSON value: object, array, string, number,
   `true`, `false`, `null`; a trailing CR is allowed, since CR is JSON whitespace), a message
   line is written with that value as `raw` (after redaction).
4. Otherwise (not JSON) it is not logged.

A JSON-RPC batch (a JSON array) is one message; its `raw` is the array.

**REQ-TR-008.** When a direction reaches end of file, any bytes after its last LF are treated
as one more line and handled by REQ-TR-007.

**REQ-TR-009.** Within one direction, message lines appear in the trace in the same order as
the messages appeared on the wire. How the two directions interleave is OPEN
(OPEN-TR-002).

**REQ-TR-010.** `raw` is compared as a JSON value: object members as a set, numbers as
binary64 values. A message's numbers MUST survive as the same binary64 value (so `1.0` may be
written `1`). Member order, whitespace and how numbers are written are OPEN (OPEN-TR-003).

---

## 5. Label

**REQ-LB-001.** With `--label NAME`, the label is `NAME` exactly. Otherwise the label is
derived from the command **after** redaction (REQ-RD-005), so that a secret on the command line never reaches the file name:

1. Go through the command's arguments from the **last** to the first.
2. Skip an argument if it begins with `-`; or is one of `npx`, `-y`, `--yes`, `node`, `bun`,
   `deno`, `run`, `--`; or contains any whitespace character.
3. Otherwise take the part after its last `/` or `\` (the whole argument if it has neither);
   replace every character other than ASCII letters, digits and `-` with `-`; lowercase it;
   keep the first 32 characters. If the result is non-empty, that is the label.
4. If no argument gives a label, the label is `mcp`.

Examples:

| command | label |
|---|---|
| `node /opt/server.js` | `server-js` |
| `npx -y my-remote` | `my-remote` |
| `node srv.js --port 3000` | `3000` |
| `node C:\srv\files.mjs` | `files-mjs` |
| `npx -y srv https://example.test/mcp --header "X-Key: abc"` | `mcp` |
| `node KEY=value` | `key-value` |
| `npx -y --` | `mcp` |
| `node srv.js ghp_AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA` | `-redacted-` (the argument is redacted to `[REDACTED]` first, and `[` and `]` become `-`) |

---

## 6. Redaction

Redaction changes only the copy of each message written to the trace (`raw`) and the strings
in `meta.command`. The replacement text is always the 10 characters `[REDACTED]`.

When redaction is on (the default; `--no-redact-defaults` turns the default rules off) a
message value goes through steps 1 to 4 below, in order. With `--no-redact-defaults` only
step 4's `--redact` patterns apply.

### 6.1 Step 1: exact keys

**REQ-RD-001.** At any depth, for every object member whose key is exactly (case-sensitive)
one of

`api_key`, `apiKey`, `token`, `bearer`, `secret`, `password`, `passwd`, `pwd`,
`private_key`, `privateKey`, `access_key`, `accessKey`, `authorization`, `Authorization`

the member's value, **whatever its type** (string, number, boolean, null, object or array),
is replaced by the string `[REDACTED]`, and nothing inside it is examined further.

### 6.2 Step 2: string patterns

**REQ-RD-002.** Every string value at any depth (not object keys, not numbers) has each of the
following patterns replaced, in this order, every non-overlapping match left to right, by
`[REDACTED]`. Patterns are written in ECMAScript regular-expression syntax with these
meanings, which an implementation in another language MUST reproduce: `\b` is an ASCII word
boundary (word characters are `A-Z a-z 0-9 _` only); `\s` is ECMAScript white space and line
terminators (space, tab, VT, FF, CR, LF, U+00A0, U+1680, U+2000–U+200A, U+2028, U+2029, U+202F,
U+205F, U+3000, U+FEFF); `.` matches any character except LF, CR, U+2028 and U+2029.

| # | pattern | what it catches |
|---|---|---|
| 1 | `\bAKIA[0-9A-Z]{16}\b` | AWS access key ids |
| 2 | `\bsk-[A-Za-z0-9_-]{20,}\b` | `sk-` API keys |
| 3 | `\bgh[pousr]_[A-Za-z0-9]{36,}\b` | GitHub tokens |
| 4 | `\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\b` | JWTs |
| 5 | `[Aa]uthorization\s*:\s*.+` | an `Authorization:` header to the end of its line |
| 6 | `[Bb]earer\s+[A-Za-z0-9._\-+/=]+` | bearer credentials |
| 7 | `\b(?:xoxb\|xoxa\|xoxp\|xoxr\|xoxs)-[A-Za-z0-9-]{10,}` | Slack tokens |
| 8 | `\b(?:rk_live\|sk_live)_[A-Za-z0-9]{8,}\b` | Stripe live keys |
| 9 | (see below) | the password in `scheme://user:password@host` |
| 10 | `[^\s"]*\.env(?:\.[A-Za-z0-9._\-]+)?\b` | `.env` file paths |
| 11 | `[^\s"]*\bid_(?:rsa\|ed25519\|ecdsa\|dsa)\b[^\s"]*` | SSH private key paths |

(In patterns 7, 8 and 11, `\|` stands for the alternation bar `|`; it is escaped only for the
table.)

Pattern 9, in words: replace the text P in every occurrence of `://U:P@`, where U is 1 to 128
characters none of which is `/`, `:`, `@` or white space, and P is one or more characters none
of which is `/`, `@` or white space. Only P is replaced. (In ECMAScript this is
`(?<=://[^/\s:@]{1,128}:)[^/\s@]+(?=@)`.)

Patterns 10 and 11, in words (these descriptions are exact equivalents of the patterns, and
can be implemented in time linear in the string's length; see REQ-RD-006). Call a **word** a
maximal run of characters that are neither white space nor `"`.

- Pattern 10: in each word, find the **last position where `.env` begins** such that
  `\.env(?:\.[A-Za-z0-9._\-]+)?\b` matches starting exactly there (taking the longest suffix
  that still ends at a `\b`). If there is one, replace the text from the start of the word to
  the end of that match; the rest of the word stays. Examples: `a/.env.x+b/.env` becomes
  `[REDACTED]`; `my.envy` is unchanged; `cfg/.env.` becomes `[REDACTED].`;
  `.env.env-id_` becomes `[REDACTED]-id_` (the match starting at the second `.env` ends
  before `-`, even though the first `.env` could reach the end of the word).
- Pattern 11: every word that contains a match of `\bid_(?:rsa|ed25519|ecdsa|dsa)\b` is
  replaced whole.

Examples (each string as it appears after step 2):

| input string | after step 2 |
|---|---|
| `try AKIAIOSFODNN7EXAMPLE today` | `try [REDACTED] today` |
| `Authorization: Bearer abc.def` | `[REDACTED]` |
| `Authorization: x` + CR + LF + `next` | `[REDACTED]` + CR + LF + `next` |
| `postgres://admin:hunter2@db:5432/x` | `postgres://admin:[REDACTED]@db:5432/x` |
| `load /srv/app/.env.local now` | `load [REDACTED] now` |
| `key is ~/.ssh/id_ed25519.pub` | `key is [REDACTED]` |
| `café AKIAIOSFODNN7EXAMPLE` | `café [REDACTED]` |
| `éAKIAIOSFODNN7EXAMPLE` | `é[REDACTED]` (é is not a word character, so `\b` holds) |

### 6.3 Step 3: key substrings

**REQ-RD-003.** At any depth, for every object member whose key matches, case-insensitively,
any of `password`, `passwd`, `\bpwd\b`, `secret`, `token`, `api[_-]?key`, `authorization`,
`^bearer$`, `private[_-]?key`, `access[_-]?key` (each searched anywhere in the key unless
anchored; `\b` has the ASCII meaning of § 6.2), the value is replaced by `[REDACTED]` **if it is a string, an object or an array**;
a number, boolean or null value is left as it is. Members whose key does not match are
examined recursively.

Examples: `{"db_password":"x"}` ⟶ `{"db_password":"[REDACTED]"}`;
`{"max_tokens":100}` ⟶ unchanged; `{"progressToken":"abc"}` ⟶ `{"progressToken":"[REDACTED]"}`;
`{"tokens":[1,2]}` ⟶ `{"tokens":"[REDACTED]"}`.

### 6.4 Step 4: string patterns again, then `--redact`

**REQ-RD-004.** Every string value at any depth then has, in order: patterns 1 to 4 of
REQ-RD-002 again (only when the defaults are on), then each `--redact` pattern, in the order
given on the command line, replaced (every non-overlapping match) by `[REDACTED]`.
`--redact` patterns are ECMAScript regular expressions, applied with the global flag and no
other flag. So `^` matches only at the start of the whole string value and `$` only at its
very end (not at a line break, and not before a final LF); `.`, `\b` and `\s` have the
meanings given in REQ-RD-002; matching is case-sensitive. The suite uses only patterns built
from literal characters, character classes, `{m,n}` and `+`/`*`/`?` quantifiers, the anchors
`^` and `$`, groups and alternation (OPEN-RD-001).

Examples with `--redact '^id'` and `--redact 'end$'`: `id 7` becomes `[REDACTED] 7`;
`my id` is unchanged; `the end` becomes `the [REDACTED]`; `the end` followed by LF is
unchanged.

**REQ-RD-006.** A message line of 2 MB whose payload is one string of base64 characters
(`A-Z a-z 0-9 + / =`, no white space) MUST be logged, and the traffic after it forwarded,
within the suite's time limit (§ 9). A direct backtracking evaluation of patterns 10 and 11
takes time proportional to the square of the word length and does not meet this; use the
word-based descriptions in REQ-RD-002. Worst-case time on other contrived inputs is open
(OPEN-RD-003).

**REQ-RD-005.** Redaction applies to `meta.command` too: each argument string goes through the
active string rules (steps 2 and 4 with the defaults on; only the `--redact` patterns with
`--no-redact-defaults`). Steps 1 and 3 need keys and do not apply. The derived label (§ 5) is
computed from these redacted arguments.

---

## 7. Platforms

**REQ-PL-001.** Windows: a command name with no directory part and no extension MUST be found
the way a Windows command prompt finds it: in the current directory, then in each `PATH`
directory, trying each `PATHEXT` extension. A command that resolves to a `.cmd` or `.bat`
file (such as `npx`) MUST run.

**REQ-PL-002.** Each argument after the command MUST reach the child as exactly one argument
with exactly the same characters, including arguments that contain spaces or double quotes,
when the command is a program (on Windows: an `.exe`). Arguments passed to `.cmd`/`.bat`
files are covered only when they contain no spaces, quotes or `&|<>^%` characters
(OPEN-PL-001).

---

## 8. Budgets

**REQ-BU-001.** Runtime: TypeScript on Node.js 22.18 or later, run directly by type stripping
(erasable syntax only; no build step); Python 3.11 or later.

**REQ-BU-002.** Dependencies: the language's standard library only. No packages are
installed.

**REQ-BU-003.** Size: at most 450 non-blank lines per implementation. Count non-blank lines in
source files (ts: `.ts .mts .mjs .js`; py: `.py`) under the implementation folder, excluding
test files (`*.test.*`, `*_test.*`, `test_*.py`, and anything under a `test/` or `tests/`
folder).

(The budgets are checked by the scorer.)

---

## 9. What the suite does

For orientation only (no requirements here): the suite starts `tape` through REGEN.json's
`driver` with `--out` set to a fresh temporary directory and a small Node.js program of its
own as the child. It writes bytes to `tape`'s standard input, sometimes in several writes with
pauses, then closes it or keeps it open; it reads `tape`'s standard output and standard error
to the end; it waits up to 15 seconds for `tape` to exit (a timeout fails the case); then it
compares the bytes each side received, the exit status, the trace file's name and every trace
line. POSIX-only cases are skipped on Windows and counted as skipped.

---

## 10. Open

These are deliberately unpinned. Nothing should depend on them, and the suite never tests
them.

- **OPEN-CLI-001.** The text of `--help` and `--version`, and of every message `tape` writes
  to standard error.
- **OPEN-CLI-002.** Options other than those in REQ-CLI-001, unknown options beginning with a
  single `-`, and repeating `--out` or `--label`.
- **OPEN-CLI-003.** Which wins when `--help` or `--version` appears together with a usage
  error.
- **OPEN-FW-001.** How `tape`'s own standard-error lines interleave with the child's.
- **OPEN-FW-002.** Behavior when the client closes `tape`'s standard output early (a broken
  pipe); what `tape` does with input that arrives after the child exits; and how long `tape`
  waits when the child has exited but a process it started still holds the child's output
  pipes open.
- **OPEN-EX-001.** On Windows, how a forced termination of `tape` or the child is reported.
- **OPEN-TR-001.** Extra members in trace lines (for example a producer version in the meta
  line).
- **OPEN-TR-002.** How message lines from the two directions interleave, and whether `t`
  values are monotonic across directions.
- **OPEN-TR-003.** In `raw`: member order, whitespace, how numbers are written (as long as the
  value survives), integers beyond 2^53, `-0`, numbers outside the binary64 range (such as
  `1e999`), and duplicate member names.
- **OPEN-TR-004.** Lines that are not valid UTF-8; lines that begin with a byte-order mark;
  lines that are blank under some other definition of white space (for example U+00A0); and
  messages that cannot be redacted or written because of an internal limit (for example
  nesting deeper than the implementation can recurse).
- **OPEN-TR-005.** When trace lines are flushed to disk while `tape` runs; what happens if a
  file of the same name already exists; how `<stamp>` relates to `startedAt` beyond both being
  the start time to within normal startup delay.
- **OPEN-RD-001.** `--redact` patterns that use syntax beyond REQ-RD-004's list (lookaround,
  backreferences, Unicode property escapes, flags), patterns that can match the empty string,
  and how such patterns behave.
- **OPEN-RD-002.** Whether a `--redact` pattern (or step 4's repeat of patterns 1 to 4) is
  applied to text that an earlier step already replaced with `[REDACTED]` (for example,
  whether `--redact RED` changes `[REDACTED]`).
- **OPEN-RD-003.** Redaction time on contrived inputs other than REQ-RD-006's large blob
  (for example a long run of repeated `eyJ`).
- **OPEN-PL-001.** Arguments with spaces, quotes or shell metacharacters passed to `.cmd` or
  `.bat` files on Windows.
- **OPEN-PL-002.** On Windows, how a command name that already has a directory part or an
  extension is looked up, and how `.cmd`/`.bat` files are started (for example through the
  command interpreter).
- **OPEN-LB-001.** Non-ASCII characters in a derived label or in the file-name part: each
  becomes `-`, but whether a character outside the Basic Multilingual Plane becomes one `-` or
  two, and whether the 32- and 64-character limits count code points or UTF-16 units, is open.
