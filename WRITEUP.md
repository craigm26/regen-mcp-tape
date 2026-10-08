# Rebuilding an MCP traffic recorder from its spec

## 1. What this is

This repository holds a specification for `tape`, a stdio proxy that sits between a Model Context
Protocol client and server, passes every byte through unchanged, and writes each JSON-RPC message
it sees to a JSON Lines trace with secrets redacted. It also holds a suite that judges any
implementation from the outside, over real pipes, with its own fake MCP server, and one released
implementation, in TypeScript, written by an agent that was shown only the specification. The
code under `impl/` is output. The files under `.regenerate/` are what I maintain.

The layout follows Carson Farmer's `.regenerate/` convention
([iroh-acp-go](https://github.com/carsonfarmer/iroh-acp-go)). The four things a regenerable
system needs (a spec, an evaluation that can judge any version, a limit on what the builder sees,
and a record of how each version was made) come from Chad Fowler's
[writing on regenerative software](https://chadfowler.com/regenerative-software/).

One caveat applies everywhere below. "Blind" means the builder was not shown the earlier
implementation, my `mcp-tape`. The model may have seen that public code in training. None of the
brief's nine identifiers appears in any of the six blind transcripts. One of its five
distinctive symbols does: all three TypeScript builds named their label function `deriveLabel`,
which is the earlier implementation's name for it. The spec calls it the derived label
throughout, which makes that the obvious name; it may also be memory.

## 2. Why this program

It is protocol plumbing. Its correctness is bytes on pipes and lines in a file, and its hard
parts are streams, framing, end of input, exit codes and platforms. That is where implementations
collect knowledge nobody wrote down, so it seemed the right place to test whether a written
contract can carry that knowledge.

## 3. What I wrote down

At the released tag, `spec-v1.1.0`:

- **SPEC.md**: 37 pinned requirements and 17 deliberately open items, in 464 lines (3,753 words).
  It restates the trace format, the eleven default redaction patterns and their exact
  regular-expression meanings, the label rules, exit statuses and the Windows command lookup.
- **DECISIONS.md**: 24 entries (2,303 words), each saying what forced the decision and what else
  was possible.
- **The suite**: 77 cases, each citing at least one requirement. It starts `tape` with a fake
  server, writes to its standard input in pieces with pauses, and compares the bytes each side
  received, the exit status, the file name and every trace line. Seven cases are POSIX-only and
  one is Windows-only. The runner refuses to start if a requirement has no case, and checks
  SPEC.md's own redaction examples against its model each time it loads.

`main` is at `spec-v1.1.2`: the same 37 requirements, 20 open items, 29 decisions, 78 cases.

## 4. Rebuilding it blind

| Run | Spec | Lang | Built on | Suite (Linux / Windows) | Own tests | Clean | Turns | Time | Cost |
|---|---|---|---|---|---|---|---|---|---|
| r00 | 1.0.0 | earlier TS | — | — / 45 of 65 | — | — | — | — | — |
| r01 | 1.0.1 | ts | laptop, Windows | 76/76 (later) / 69/69 | 26/26 | no (1 clarify) | 22 | 4.5 min | $0.57 |
| r02 | 1.0.2 | ts | laptop, Windows | 76/76 (later) / 69/69 | 28/28 | no (1 pin, 1 clarify) | 25 | 5.7 min | $0.70 |
| r03 | 1.1.0 | ts | cloud, Linux | 76/76 / 70/70 | 29/29 | **yes** | 18 | 4.1 min | $0.63 |
| r04 | 1.1.0 | py | cloud, Linux | 76/76 / 70/70 | 19/19, 16/19 on Windows | no | 19 | 5.8 min | $0.65 |
| r05 | 1.1.1 | py | cloud, Linux | 77/77 / 71/71 | 39/39, 38/39 on Windows | no | 10 | 4.5 min | $0.68 |
| r06 | 1.1.2 | py | cloud, Linux | 75/77 / 69/71 | 33/33 on both | no | 13 | 4.1 min | $0.63 |

Every builder was `claude-sonnet-5-5`, with file tools confined to its folder, no web or MCP
tools and a shell allowlist, and every transcript audit found zero violations. The first two
builds ran on my laptop; that session stopped after r02, and the rest ran in a cloud container,
which is why the table has two platforms. `impl/ts` is r03 (241 lines). Python is not released:
all six runs were used, and none of the three Python builds was clean.

## 5. What extraction found

Every one of the brief's eight hypotheses held. Run against the earlier implementation, the
suite failed 20 cases, each a correction the spec makes. The two that matter most for real use
were found by running it, not by reading it:

- **It hangs at the end of a normal MCP session.** It never closes the server's input when the
  client's input ends, and after the server exits it waits for the client to close its input.
  MCP's shutdown has the client close the server's input and wait. Each side waits for the other.
- **It stalls on large payloads.** Two default redaction patterns are quadratic in word length:
  18 ms at 5,000 characters, 1,020 ms at 40,000. I found it when the suite's own model stalled on
  a 1 MB test message; the spec now describes both patterns word by word, in linear time.

The rest: the command line went into the trace unredacted, and a token argument became the file
name; a multi-byte character split across two reads was corrupted in the log (forwarding stayed
exact); a final line without a newline was forwarded but not logged; on Windows, starting the
server through the shell re-split arguments and expanded `%PATH%`, and a missing command exited
1 rather than 127. After r03, one more: it drops message members named `__proto__`, because it
rebuilds objects by assignment.

What it got right was the part that looked hardest to restate. All 13 redaction cases passed:
the four-step restatement reproduces its two-stage redaction exactly, quirks included.

## 6. What the rebuilds found

- **Unwritten choices.** r02 noticed that `--redact` patterns could use `^` and `$`, but nothing
  said whether they anchor to the whole string or to each line, and Python's `$` also matches
  before a final newline. The spec now says (D-023), and the Python build two runs later translated
  user patterns to exactly those meanings.
- **Contradictions.** One, between a requirement and the interface: r01 was asked to make the
  driver's path resolve relative to its folder, which only the suite can do (D-021).
- **Reference quirks.** All settled in DECISIONS before the first build. r03's careful handling
  of `__proto__` exposed one more, now a case (D-025).
- **Documentation errors.** The trace format says producers should redact command-line arguments;
  the earlier implementation did not.
- **Silent divergences.** None in the first five builds. The last had two: when the server exits
  first, it leaves without logging client messages it has already forwarded.

The other findings were about platforms, and two were about my side. The first time the
POSIX-only cases ran, on Linux after r02, one failed because of the suite: its fake server, a
Node.js process, was asked to die by SIGUSR1, and Node starts its debugger on SIGUSR1 instead.
r03's build notes reported the same fact independently. Then the Python builds, made on Linux,
passed every case on Windows, but their own tests did not: they expected LF from a Python child
whose output ends lines with CRLF on Windows, and sent a signal Windows does not have. After r04
I put the CRLF fact in a decision as context, and r05 skipped its signal tests as required but
still expected LF. After r05 it went into the requirement, and r06's tests passed on Windows. A
builder acts on requirements; context it only reads. And on my laptop, a stray `package.json` in
the user folder made Node print a warning on standard error for every TypeScript run, which a
byte-exact test of standard error noticed.

## 7. How much to write down

The spec grew by 310 words between 1.0.0 and the released 1.1.0, and by 159 more by 1.1.2. The
number of requirements never changed. Everything added was a sentence that made a requirement
exact (the driver path, regular-expression flags, which tests must pass where) or a new open item
for something a build chose differently that nothing depends on. Each build recorded 14 to 18
choices. From r03 on, the spec had already answered, or deliberately left open, all but one or
two of them.

The brief expected the remembered knowledge to be about streams and processes, not JSON. In the
earlier implementation it was: half of its 20 failures were end of input, exit timing, partial
lines, split characters and Windows process starting, and the rest were redaction and labels.
Once those were written down as requirements, every build got them right, until the last one
lost messages in a race at shutdown. What the builds asked about was mostly regular-expression dialects and
the edges of the interface, and what they got wrong, apart from that race, was the other
platform, in their own tests.

## 8. What it cost

Six blind runs, the whole budget, all `claude-sonnet-5-5`: 107 turns, about 29 minutes of builder
time and $3.87, as reported by each transcript's last line, plus $0.02 for the isolation test on
the cloud host (the laptop's was not priced). The orchestrating sessions (extraction, the suite, the reference runs on the
laptop, triage and these documents) took much longer, and their cost is not in the ledger.

## 9. The checklist

| # | Property | Evidence |
|---|---|---|
| P1 | `.regenerate/` is the asset; `impl/` is output | Layout; README |
| P2 | Every file under `impl/` came from a logged blind run | `purity-check.mjs`: `impl/ts` equals r03's promoted tree |
| P3 | The suite judges from outside, in any language | Driver and pipes only; judged TypeScript and Python builds and the earlier implementation |
| P4 | The suite ran against the reference first; every failure explained | r00 to r00.5: 20, then 21 failures, each mapped to a decision |
| P5 | Builders saw only SPEC, DECISIONS and PROMPT; clean audits | Leak check before each launch; six audits with 0 violations; isolation tests in PREFLIGHT.md. Caveat: r01 and r02 ran before the launcher cleared the environment |
| P6 | Promoted builds come from clean runs on their tag | r03 at `spec-v1.1.0`, `clean: true` |
| P7 | Every run is in the ledger, failures included | r00 to r00.5, r01 to r06, rescores, Windows checks, the promotion |
| P8 | Every number here traces to the ledger or a run file | Runs table from `ledger.jsonl`; sizes from the tags; extraction from SOURCES.md and PROVENANCE.md |

## 10. What's next

- Build Python again from `spec-v1.1.2`, under a new run budget.
- Run the seven POSIX-only cases against the earlier implementation on Linux; so far it has only
  been run on Windows.
- Fix the earlier `mcp-tape`: the end-of-session hang and the large-payload stall are the two
  findings that matter in real use.
- Try Go, the brief's first choice for a second language; it was not installed on the laptop when
  the project began.
