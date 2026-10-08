# regen-mcp-tape

A stdio proxy that records MCP JSON-RPC traffic to an open JSONL trace format, rebuilt by
agents from a spec. The spec is the asset; the code is disposable.

The durable asset is [`.regenerate/`](.regenerate/): the specification, the decisions behind it,
a suite that judges any implementation from the outside, and a ledger of every build. The code in
[`impl/`](impl/) is output: each tree was written by an agent that was shown only the spec, its decisions and a
prompt, and
CI checks that it is byte for byte what that logged run produced. The story is in
[WRITEUP.md](WRITEUP.md).

## What the program does

`tape` sits between a Model Context Protocol client and a server that talks over standard input
and output. The client starts `tape` instead of the server. `tape` starts the server as its
child, copies bytes both ways unchanged, and writes every JSON message it sees to a trace file,
one JSON object per line. Secrets are redacted in the trace only, never in the forwarded bytes.
`tape` exits with the server's exit status.

```
node impl/ts/tape.ts --out traces -- node my-server.js          # Node 22.18+
node impl/ts/tape.ts --label files -- npx -y some-server
```

- **Options:** `--out DIR` (default `./mcp-traces`), `--label NAME`, `--redact REGEX`
  (repeatable), `--no-redact-defaults`, `--help`, `--version`. Usage errors exit with status 2.
- **Trace file:** `DIR/<UTC start time>-<label>.jsonl`. A `meta` line (start time, label, and the
  command with secrets redacted), one `{"t", "dir", "raw"}` line per message (`in` is client to
  server, `out` is server to client), and an `end` line with `exitCode` and `durationMs`.
- **Redaction:** fixed key names and key substrings, eleven value patterns (AWS, `sk-`, GitHub,
  Slack and Stripe keys, JWTs, bearer and `Authorization` headers, URL passwords, `.env` and SSH
  key paths), and any `--redact` patterns. Each match becomes `[REDACTED]`.
- **Shutdown:** when the client closes its input, `tape` closes the server's input, as MCP's
  stdio shutdown expects. When the server exits, `tape` finishes the trace and exits with the
  server's status (128 + N for signal N on POSIX), even if the client has not closed its input.

The exact behavior is in [`.regenerate/SPEC.md`](.regenerate/SPEC.md). `tape` is a rebuild of the
proxy path of my earlier `mcp-tape` package, not that package.

## Releases

| Language | Folder | Built by | Spec tag | Suite at its tag | Own tests | Lines |
|---|---|---|---|---|---|---|
| TypeScript (Node 22.18+, no dependencies) | `impl/ts` | r03 | `spec-v1.1.0` | 76/76 on Linux, 70/70 on Windows | 29 | 241 |

CI runs `impl/ts` on ubuntu-latest and windows-latest: its own tests and the suite at its tag.

Python is not released. All six allowed builds were used, and none of the three Python builds
(r04 to r06) was clean. The first two passed every suite case on Linux and on Windows, but their
own tests, written on Linux, failed on Windows. The third fixed that and instead loses client
messages it has already forwarded when the server exits first. Their code stays on the branches
`regen/r04` to `regen/r06`, and the reasons are in `.regenerate/runs/`.

`main` carries `spec-v1.1.2`: builder tests must pass on both platforms (with the Windows line-end
fact that tripped two builds), three more open items and two wider ones, and a case for message
members named
`__proto__`, which the earlier implementation drops. No clean build has been made from it; the
released TypeScript tree passes its suite (77/77 on Linux).

## Regenerating it

1. Copy `SPEC.md`, `DECISIONS.md` and `PROMPT.<lang>.md` (renamed `PROMPT.md`) from a spec tag into
   an empty folder, and run `node .regenerate/tools/leak-check.mjs <folder>`.
2. Launch a builder with `.regenerate/tools/launch-blind.sh <sandbox> <model> <lang>`. It starts
   Claude Code with file tools confined to the folder, no web or MCP tools, a shell allowlist and
   an allow-listed environment.
3. Audit the transcript (`audit-transcript.mjs`), then score the output against the tag's suite:
   `node .regenerate/tools/score.mjs --impl <output> --suite .regenerate/suite`.
4. Any implementation, in any language, can be judged the same way:
   `node .regenerate/suite/run.mjs --impl <folder with REGEN.json>`. The suite brings its own fake
   MCP server and drives `tape` over real pipes.

"Blind" means the builder was not shown the earlier implementation. Its model may still have
seen that public code in training. Isolation is by flags plus an audit of every transcript, not
an operating-system sandbox.

The protocol these steps come from, and the brief for this project, live outside the repo; the
record of what happened is in `.regenerate/PROVENANCE.md`, `.regenerate/runs/` and
`.regenerate/ledger.jsonl`.

## Credits and license

- The behavior is restated from my earlier
  [mcp-tape](https://github.com/craigm26/mcp-tape) at `793eb85` (MIT, © 2026 Craig Merry), and the
  trace format from `docs/format.md` in [mcp-replay](https://github.com/craigm26/mcp-replay) at
  `9693511`. No code from either is in this repository; the reference adapter loads a local build.
- Primary sources: the JSON-RPC 2.0 specification, and the Model Context Protocol's stdio
  transport and lifecycle.
- The `.regenerate/` layout follows Carson Farmer's
  [iroh-acp-go](https://github.com/carsonfarmer/iroh-acp-go); the method follows Chad Fowler's
  [writing on regenerative software](https://chadfowler.com/regenerative-software/).
- Code in this repository: MIT (see LICENSE).
