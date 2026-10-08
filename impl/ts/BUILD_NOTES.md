# Build notes

- Build: nothing (`build` is empty in REGEN.json). Node 22.18+ runs `.ts` by type stripping.
- Test: `node --test` (29 tests in `tape.test.ts`, each written for one or more REQs; they start real
  `tape` processes and a fake child script written to a temp folder).
- Run: `node tape.ts [options] -- <command> [args...]`.
- Source: `tape.ts` (CLI, spawn, forwarding, trace) and `redact.ts` (redaction). About 240 non-blank lines.

Surprises:
- A Node child does not die from SIGUSR1 (inspector), so signal tests use SIGUSR2.
- `\bpwd\b` in a key means `myPwd` is not redacted by step 3 (no word boundary), but `my-pwd` is.
- A spawn failure emits both `error` and `close` (code -2); the `close` handler must be ignored then.
- Windows paths are implemented but untested here.
