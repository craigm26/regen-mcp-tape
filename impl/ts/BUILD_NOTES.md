# Build notes

- Build: none. Node 22.18+ runs the `.ts` files directly by type stripping.
- Test: `node --test` (unit tests in `redact.test.ts`, process-level tests in `tape.test.ts`, fake server in `tests/fake.mjs`). POSIX-only tests are skipped on Windows; the `npx` test is skipped on POSIX.
- Run: `node tape.ts [--out DIR] [--label NAME] [--redact REGEX]... [--no-redact-defaults] -- <command> [args...]`
- Files: `tape.ts` (proxy), `cli.ts` (argument parsing, label), `redact.ts` (redaction). Non-test source is well under 450 non-blank lines.

## Surprises
- Without a `package.json` containing `"type": "module"`, Node writes a warning to stderr at startup. That would corrupt stderr forwarding (REQ-FW-003), so `package.json` exists (see C-1).
- Only the POSIX tests for signals (REQ-EX-002/003) could not run on the Windows machine where this was built, so they are unverified here.
- Steps 1 to 3 of redaction commute, so one tree walk does them; step 4 must stay separate (C-6).
- `\bpwd\b` does not match `myPwd`, because ASCII word boundaries need a non-word neighbour.
