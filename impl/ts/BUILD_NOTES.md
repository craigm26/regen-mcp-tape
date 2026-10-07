# Build notes

- Build: none (Node.js 22.18+ runs the `.ts` files directly by type stripping).
- Test: `node --test` (tests are in `test/tape.test.ts`; fake servers are generated into a temp dir by the tests).
- Run: `node tape.ts [--out DIR] [--label NAME] [--redact REGEX]... [--no-redact-defaults] -- <command> [args...]`
- Files: `tape.ts` (CLI, proxy, trace), `redact.ts` (redaction), `REGEN.json`, `CHOICES.md`.

## Notes and surprises

- The POSIX-only tests (signals: REQ-EX-002, REQ-EX-003) skip on Windows. I developed on Windows, so the signal code paths were not run here.
- Redaction patterns 1-9 use the ECMAScript regexes from the spec directly (pattern 9 with its lookbehind). Patterns 10 and 11 use the word-based linear versions. `.env` is searched backwards from the last occurrence; a failed attempt costs O(1), so the scan stays linear.
- Node 22 refuses to spawn `.cmd`/`.bat` directly, so those go through `cmd.exe /d /s /c`.
- A trace copy is made by a separate `data` listener next to `pipe()`, so forwarding never depends on trace parsing.
- `node --test` also treats files under `test/` as tests, so the fake server is written to a temp dir at test time rather than stored in `test/`.
- A redacted command argument gives the label `-redacted-` (see C-9).
