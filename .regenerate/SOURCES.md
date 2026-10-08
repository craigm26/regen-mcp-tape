# Sources

Where every requirement came from. **Never given to builders.**

## References

- `https://github.com/craigm26/mcp-tape` at `793eb85f57924e01e06d5af15b35fc889bb658fc`
  (2026-07-15, package version 0.4.0; its CLI reports 0.3.0). MIT, © 2026 Craig Merry.
  Cloned fresh with `git clone -c core.autocrlf=false` into the workspace's `_reference/`,
  2026-10-07. Built in a copy under `_reference/_build/` with `npm ci` and `npx tsc` (the
  package's `build` script ends in `chmod`, which does not run under npm on Windows).
- `https://github.com/craigm26/mcp-replay` at `969351129c52fb025679e30ef4a0420a027d4891`:
  `docs/format.md` (trace format v1) only. `format-extensions.md` is out of scope.
- Not used: anything under a private organization, including its mirrors of these repos, and
  any hosted upload or share endpoint.

### Files read in full

- mcp-tape: `package.json`, `src/proxy.ts`, `src/writer.ts`, `src/args.ts`, `src/cli.ts`,
  `src/redact.ts`, `src/redact-config.ts`, `src/jsonpath.ts`, `src/rotation.ts` (because
  `writer.ts` delegates to it), `default-redact.json`, `test/args.test.mjs`,
  `test/redact.test.mjs`, `test/jsonpath.test.mjs`, `test/derive-label.test.mjs`,
  `test/fixtures/echo-server.mjs`, `README.md` (Usage, Secret redaction, Trace format),
  `LICENSE`, `CHANGELOG.md`.
- mcp-replay: `docs/format.md`.
- Out of scope per the brief, not read: install/uninstall, share, upload, login/logout/auth,
  websocket live mode, rotation options, `--redact-file` configuration files.

## Requirement provenance

Paths are relative to the mcp-tape root at `793eb85` unless they say `format.md`.

| Requirement | Source |
|---|---|
| REQ-IF-001 | New (process interface); `kit/REGEN.md` § 3 |
| REQ-CLI-001 | `src/args.ts:126-222` (proxy options), `src/cli.ts:18-31` (help, version) |
| REQ-CLI-002 | `src/args.ts:131-134, 216-220`; test `args.test.mjs` "command without -- is still captured"; D-018 |
| REQ-CLI-003 | `src/cli.ts:18-26` |
| REQ-CLI-004 | `src/cli.ts:10-16, 168-174` (status 2); bad `--redact` crashes later in `src/proxy.ts:24-27` → `src/cli.ts:266-269` (status 1); D-015 |
| REQ-FW-001 | `src/proxy.ts:158-163` (`dst.write(chunk)` before parsing); README "forwards JSON-RPC byte-for-byte" |
| REQ-FW-002 | `src/proxy.ts` and `src/cli.ts` write their own messages to stderr only |
| REQ-FW-003 | `src/proxy.ts:80-83` (`stdio: ['pipe','pipe','inherit']`) |
| REQ-FW-004 | Not in the reference (`pipeWithLog` never ends `dst`, `src/proxy.ts:150-185`); MCP stdio shutdown; D-002 |
| REQ-FW-005 | Not in the reference (`await Promise.allSettled([inDone, outDone])` waits for client EOF, `src/proxy.ts:95-103`); D-003 |
| REQ-FW-006 | `src/proxy.ts:80-83` (spawn inherits env and cwd) |
| REQ-EX-001 | `src/proxy.ts:95-100`, `src/cli.ts:176-177` |
| REQ-EX-002 | `src/proxy.ts:97, 203-207` (five-entry table); D-013 |
| REQ-EX-003 | `src/proxy.ts:88-93` |
| REQ-EX-004 | Reference: unhandled spawn `error` (POSIX) or shell exit 1 (Windows); D-014 |
| REQ-EX-005 | `src/proxy.ts:14` (`mkdir` throws) → `src/cli.ts:266-269` (status 1) |
| REQ-TR-001 | `src/writer.ts:30-32, 80-82`; `src/args.ts:65` (default `./mcp-traces`); `src/proxy.ts:14` (recursive mkdir) |
| REQ-TR-002…005 | `format.md` "Line types"; `src/writer.ts:41-64`; producer-version member dropped per brief (D-016) |
| REQ-TR-007 | `src/proxy.ts:159-180` (split at LF, skip `!line.trim()`, `JSON.parse`, skip non-JSON); per-chunk decoding at `:161` (D-005); batches D-006 |
| REQ-TR-008 | Not in the reference (buffer never flushed at end); D-004 |
| REQ-TR-009 | `src/rotation.ts:24-29` (single write chain); `format.md` "Ordering and timing" |
| REQ-TR-010 | `JSON.parse`/`JSON.stringify` round trip in `src/proxy.ts:171`, `src/writer.ts:76`; D-019 |
| REQ-LB-001 | `src/proxy.ts:187-201`; test `derive-label.test.mjs`; `\` separator D-012; redacted input D-011 |
| REQ-RD-001 | `default-redact.json:3-16` (path rules `$..key`); `src/redact.ts:58-85` (replace any value type); `src/jsonpath.ts` |
| REQ-RD-002 | `default-redact.json:17-27`; `src/redact-config.ts:75-91`; meanings D-008; pattern 9 restated D-009; patterns 10-11 restated D-010 |
| REQ-RD-003 | `src/redact.ts:5-16, 99-108` (key substrings; strings/objects/arrays replaced, other types kept) |
| REQ-RD-004 | `src/redact.ts:20-25, 35-43, 87-95` (four patterns plus `--redact`, flag `g`); order `src/proxy.ts:172-173`; flags and anchors stated D-023 |
| REQ-RD-005 | `format.md` "Redaction": producers should redact command-line arguments; reference does not (`src/writer.ts:46`); D-011 |
| REQ-RD-006 | Measured quadratic cost of `default-redact.json:26-27` (below); D-010; narrowed to the tested case D-024 |
| REQ-PL-001, 002 | `src/proxy.ts:76-83` (`shell: process.platform === 'win32'`); D-017 |
| REQ-BU-001…003 | `kit/briefs/mcp-tape.md` § Budgets |

## Primary sources

- JSON-RPC 2.0 Specification (jsonrpc.org): batches are arrays; notifications have no `id`.
- Model Context Protocol specification, Transports (stdio) and Lifecycle (shutdown):
  newline-delimited UTF-8 JSON-RPC messages with no embedded newlines; to shut down a stdio
  server the client closes the server's input stream, waits for it to exit, then sends
  SIGTERM, then SIGKILL. (Cited from the published specification at modelcontextprotocol.io;
  not re-fetched in this session.)

## Extraction checks (brief § Check during extraction)

| # | Hypothesis | Finding | Decision |
|---|---|---|---|
| 1 | EOF does not propagate | Confirmed by code (`src/proxy.ts:150-185`) and by a hang: a one-line ping through the built reference to its own `echo-server.mjs` was answered, then never exited. | D-002 |
| 2 | `meta.command` not redacted | Confirmed (`src/writer.ts:46`). | D-011 |
| 3 | Last line without newline not logged | Confirmed (`src/proxy.ts:159-183`: buffer kept, never flushed on `end`). | D-004 |
| 4 | Split multi-byte UTF-8 | Confirmed by code (`chunk.toString('utf8')` per chunk, `:161`); r00 case `utf8-split-*`. | D-005 |
| 5 | Batch arrays | Logged as one line, `raw` the array; redaction walks into it. | D-006 |
| 6 | Redaction semantics | Regex rules touch string values only, never keys or numbers. `$..key` replaces the whole value of any type, objects included. The key-substring pass replaces strings, objects and arrays but keeps numbers, booleans and null. | D-007 |
| 7 | Windows | Spawns through the shell on Windows: `.cmd` shims resolve, but arguments are re-split and empty ones dropped (r00 `pl-args-exact`). | D-017 |
| 8 | Signal exit codes | `128 + table[sig]`, table of five; other signals give 128. End line records the same value. Confirmed by running on Linux: SIGUSR2 gives 128 (r00.5.linux). | D-013 |

Additional findings (not in the brief's list):
- After the child exits, the reference waits for the client to close standard input (D-003).
- Patterns 10 and 11 are quadratic in word length: measured 18 ms at 5,000 characters,
  64 ms at 10,000, 254 ms at 20,000 and 1,020 ms at 40,000 (Node 22.20, Windows). Found when
  the suite's own oracle stalled on a 1 MB test message (D-010).
- An invalid `--redact` pattern is compiled after the output directory is created and
  crashes with status 1 (D-015).
- The package version (0.4.0) and the CLI's reported version (0.3.0) differ; the version
  is not part of this spec.

## Fixtures

The suite brings its own fake server (`suite/servers/fake.mjs`), written for this suite. No
fixture files are copied from the reference.
