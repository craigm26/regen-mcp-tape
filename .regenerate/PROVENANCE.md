# Provenance

How every version of this program was made. Machine-readable record: `ledger.jsonl`.

## Runs

| Run | Kind | Spec tag | Model | Lang | Outcome | Suite | Own tests | Clean | Notes |
|---|---|---|---|---|---|---|---|---|---|
| r00 | reference | spec-v1.0.0 | — | earlier TS implementation via adapter | finished | 45/65 (7 skipped, 4 n/a) | — | — | all 20 failures are corrections (below) |
| r00.1 | reference | spec-v1.0.1 | — | earlier TS implementation | finished | 45/65 (7 skipped, 4 n/a) | — | — | same 20 failures; spec-v1.0.0 failed the leak check and was never built from |
| r01 | blind | spec-v1.0.1 | claude-sonnet-5-5 | ts | finished | 69/69 (7 skipped, Windows) | 26/26 | no | C-1 clarify: driver-path requirement was impossible for the builder; 22 turns, 4.5 min, $0.57 |
| r00.2 | reference | spec-v1.0.2 | — | earlier TS implementation | finished | 45/65 (7 skipped, 4 n/a) | — | — | same 20 failures |
| r02 | blind | spec-v1.0.2 | claude-sonnet-5-5 | ts | finished | 69/69 (7 skipped, Windows) | 28/28 | no | C-5 pin: `--redact` flags and anchors unstated; C-14 clarify: REQ-RD-006 promised more than it tested; 25 turns, 5.7 min, $0.70 |
| r00.3 | reference | spec-v1.1.0 | — | earlier TS implementation | finished | 46/66 (7 skipped, 4 n/a) | — | — | same 20 failures; the new `--redact` case passes |
| r03 | blind | spec-v1.1.0 | claude-sonnet-5-5 | ts | finished | 76/76 (1 skipped, Linux); 70/70 on Windows | 29/29 | **yes** | first clean run; first on the cloud host; 18 turns, 4.1 min, $0.63 |
| r04 | blind | spec-v1.1.0 | claude-sonnet-5-5 | py | finished | 76/76 (1 skipped, Linux); 70/70 on Windows | 19/19 Linux; 16/19 Windows | no | its own tests fail on Windows (clarify, D-026); 19 turns, 5.8 min, $0.65 |
| r00.4 | reference | spec-v1.1.1 | — | earlier TS implementation | finished | 46/67 (7 skipped, 4 n/a) | — | — | the 20 explained failures plus `fw-proto-member` (D-025) |
| r05 | blind | spec-v1.1.1 | claude-sonnet-5-5 | py | finished | 77/77 (1 skipped, Linux); 71/71 on Windows | 39/39 Linux; 38/39 Windows | no | one own test expects LF on Windows (clarify, D-028); 10 turns, 4.5 min, $0.68 |

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

## The first Linux run (after r02)

r01 and r02 were built and scored on Windows, where the 7 POSIX-only cases are skipped. When the
work moved to a Linux host, both builds were rescored against `spec-v1.1.0`'s suite, and one
case failed because of the suite (class (a)): `exit-child-signal-SIGUSR1` had the fake server
send itself SIGUSR1, and a Node.js process starts its debugger on SIGUSR1 instead of dying. The
case now uses SIGUSR2 (12 on Linux). With that fixed, both builds pass all 76 cases that run on
Linux, including the signal cases, which no run had exercised before. The earlier
implementation has still only been run on Windows, so its behavior on those 7 cases is unknown.

## r00.4: one more correction

The case added after r03 (`fw-proto-member`, D-025) sends a message with members named
`__proto__` and `constructor`. The earlier implementation logged `{"constructor":"c","x":{}}`
for `{"__proto__":{"a":1},"constructor":"c","x":{"__proto__":[1,2]}}`: it rebuilds objects by
assignment, and in JavaScript assigning to `__proto__` sets the prototype instead of adding a
member. All four blind builds keep both members (rescores at `spec-v1.1.1`, Linux).

## What each run taught

- **r00.** Every one of the brief's eight hypotheses held. The two that matter most for real
  use were found by running, not reading: the earlier implementation hangs at the end of a
  normal MCP session, and it stalls on large base64 payloads. The redaction rules, the part
  that looked hardest to restate, came out identical.
- **r01.** The first blind TypeScript build passed every case on Windows, including all the ones the earlier implementation hung or stalled on. Its one real finding was wording: REQ-IF-001 asked the builder to make a relative path resolve, which only the suite can do. The POSIX signal half of the spec is still unexercised.
- **r02.** A second TypeScript build, laid out differently (three modules, its own fake server), passed every case on Windows again. Its findings were about regular expressions, the part of the spec most exposed to a second language: `^` and `$` were allowed in `--redact` patterns but their meaning was never stated, and a sentence promising linear time for every input was broader than anything the suite checks or the default patterns deliver. It also found that `--redact` can match inside an earlier `[REDACTED]`, where the earlier implementation is itself inconsistent; that became an open item.
- **r03.** The first clean run, on the third version of the spec and the first Linux host. Every choice it recorded was required by the text or already left open, most of those open items written because r01 or r02 asked. Its notes independently found the same thing the Linux rescore had just found in the suite: a Node.js child starts its debugger on SIGUSR1 instead of dying. On the laptop's Windows its suite result was 70/70; its own stderr test failed there only because a stray `package.json` in the user folder makes Node print a warning, which the spec allows.
- **r04.** The Python build passed every suite case on Linux and Windows, and translated `--redact` patterns to ECMAScript meanings because r02's finding had become a sentence in the spec. Its own tests, written on Linux, failed on Windows: they expected LF from a Python child that writes CRLF there, and sent SIGUSR1, which Windows lacks. The program was right and the tests did not travel, so REQ-IF-001 now says the tests run on both platforms. The run also left a hung background test that kept the builder's CLI from exiting after its result line; the audit now handles the extra turn that followed.
- **r05.** The fastest build (10 turns), and it followed the new sentence in REQ-IF-001 exactly: its POSIX-only tests skip on Windows. It still expected LF from a Python child, whose text-mode output writes CRLF on Windows. That fact had been in D-026 only as context. A builder acts on requirements and reads context; the fact is now in the requirement.
