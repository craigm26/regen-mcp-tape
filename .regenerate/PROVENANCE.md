# Provenance

How every version of this program was made. Machine-readable record: `ledger.jsonl`.

## Runs

| Run | Kind | Spec tag | Model | Lang | Outcome | Suite | Own tests | Clean | Notes |
|---|---|---|---|---|---|---|---|---|---|
| r00 | reference | spec-v1.0.0 | — | earlier TS implementation via adapter | finished | 45/65 (7 skipped, 4 n/a) | — | — | all 20 failures are corrections (below) |

## r00: the suite against the earlier implementation

Ran 2026-10-07 on Windows, Node v22.20.0, against the earlier implementation at `793eb85`
built from source and run in-process by `suite/adapters/reference/`. 76 cases: 4 are folder
checks (n/a for the reference) and 7 are POSIX-only signal cases, skipped on Windows and so
not yet run against the reference.

All 20 failures are behavior this spec corrects (class (c)):

| Decision | Cases | What the earlier implementation does |
|---|---|---|
| D-002 | `eof-propagates-to-child`, `eof-empty-input`, `eof-unterminated-in-line` | never closes the child's input; the child waits forever (timeout) |
| D-003 | `child-exit-with-stdin-open`, `child-exits-immediately-stdin-open` | after the child exits, waits for the client to close input (timeout) |
| D-004 | `eof-unterminated-out-line` | the final unterminated line is forwarded but not logged |
| D-005 | `utf8-split-out`, `utf8-split-in` | logs `héllo ���uro ��� done` for `héllo €uro 😀 done` split across writes |
| D-010 | `fw-big-message-out`, `fw-big-message-in`, `rd-large-blob-in`, `rd-large-blob-out` | stalls on 1-2 MB messages without white space (quadratic redaction; timeout) |
| D-011 | `label-derived-redacted-secret`, `command-redacted-in-meta`, `command-not-redacted-without-defaults` | writes the command line verbatim; a token argument becomes the file name |
| D-012 | `label-derived-config-name`, `label-derived-backslash` | Windows paths become labels like `c--srv-files-mjs` |
| D-014 | `exit-command-not-found` | status 1 (Windows shell), not 127 |
| D-015 | `cli-bad-redact-regex` | crashes with status 1 after creating the output directory |
| D-017 | `pl-args-exact` | on Windows, `a b` arrives as two arguments, quotes vanish, `%PATH%` is expanded |

Everything else passed, including all 13 redaction cases: the four-step restatement in SPEC
§ 6 reproduces the earlier implementation's two-stage redaction exactly, including its
quirks, and the `.cmd` shim case.

Suite bugs found while building r00 (class (a), fixed before the run was recorded):
1. REQ-TR-006 ("other members are open") was written as a requirement but cannot be tested;
   it is now prose pointing at OPEN-TR-001.
2. The suite's oracle used redaction patterns 10 and 11 as written and took minutes on a
   1 MB test message. That became finding D-010; the oracle now uses the word-based rules,
   checked against the regexes on random strings each time the suite loads (a first attempt at
   those rules was itself wrong and the check caught it).
3. Every case derived its label from the temporary config path, so on Windows one label
   difference (D-012) failed 31 unrelated cases. Cases now pass `--label` unless they are
   about labels.

## What each run taught

- **r00.** Every one of the brief's eight hypotheses held. The two that matter most for real
  use were found by running, not reading: the earlier implementation hangs at the end of a
  normal MCP session, and it stalls on large base64 payloads. The redaction rules, the part
  that looked hardest to restate, came out identical.
