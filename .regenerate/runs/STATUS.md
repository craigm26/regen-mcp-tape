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
- Reference on Linux: r00.5.linux under WSL on the laptop (Craig said to proceed): 53/73; six of
  the seven POSIX-only cases pass, SIGUSR2 gives 128 (D-013).
- Released: impl/ts from r03 at spec-v1.1.0 (promotion in the ledger; purity ok; CI simulated on
  Linux: auditor self-test 24/24, own tests 29/29, suite 76/76). Python not released.
- Done: README.md, WRITEUP.md, publish-gate scan (no local paths, secrets or private repo names in
  any ref; the AKIA and ghp_ strings are the spec's example values).
- CI: run 37736719682 on main (11c7032): purity ok, auditor 24/24; ts on ubuntu 29/29 and 76/76,
  on windows 27/27 (2 skipped) and 70/70. Every run up to then was started by hand: pushes to main
  did not start the workflow. On 2026-10-08 it was disabled and re-enabled to reset its triggers.
- Upstream: the fixes went to the earlier project on 2026-10-08 (UTC) as craigm26/mcp-tape#2
  (open, not merged). At b07b9f3 it passes this suite 67/67 on Windows (laptop) and 73/73 on
  Linux (ledger upstream.1, upstream.1.linux; PROVENANCE).
- Open for Craig: kit/posts/mcp-tape.md (draft post).
