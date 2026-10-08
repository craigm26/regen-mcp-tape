# STATUS

- Project: mcp-tape (brief: kit/briefs/mcp-tape.md); second language py (go not installed on the laptop)
- Host: the laptop through r02. The laptop session stopped after scoring r02; from here an
  Anthropic cloud container (Linux) carries on from this record (WORKSPACE <WORKSPACE>,
  SANDBOX_ROOT <SANDBOX_ROOT>). The earlier implementation stays built on the laptop, so
  reference runs (r00.k) are still made there, on Windows.
- Phase: done. Published 2026-10-08 (UTC) at https://github.com/craigm26/regen-mcp-tape.
- Spec tag: spec-v1.1.2 (r03 ts is clean at spec-v1.1.0)
- Last runs: r06 py 75/77 on Linux and 69/71 on Windows, not clean (two silent divergences);
  own tests 33/33 on both platforms
- Blind runs used: 6 of 6. Clean: r03 (ts, spec-v1.1.0). Python has no clean run (r04 and r05:
  own tests fail on Windows; r06: two suite failures).
- Running processes: none
- Open question for Craig: run the 7 POSIX-only cases against the reference under WSL?
- Released: impl/ts from r03 at spec-v1.1.0 (promotion in the ledger; purity ok; CI simulated on
  Linux: auditor self-test 24/24, own tests 29/29, suite 76/76). Python not released.
- Done: README.md, WRITEUP.md, publish-gate scan (no local paths, secrets or private repo names in
  any ref; the AKIA and ghp_ strings are the spec's example values).
- CI: run 37719985414 on main (9b4f37a): purity ok, auditor 24/24; ts on ubuntu 29/29 and 76/76,
  on windows 27/27 (2 skipped) and 70/70.
- Open for Craig: the WSL question below; kit/posts/mcp-tape.md (draft post).
