# STATUS

- Project: mcp-tape (brief: kit/briefs/mcp-tape.md); second language py (go not installed on the laptop)
- Host: the laptop through r02. The laptop session stopped after scoring r02; from here an
  Anthropic cloud container (Linux) carries on from this record (WORKSPACE <WORKSPACE>,
  SANDBOX_ROOT <SANDBOX_ROOT>). The earlier implementation stays built on the laptop, so
  reference runs (r00.k) are still made there, on Windows.
- Phase: 3 (blind rebuild, py on spec-v1.1.2; the last run)
- Spec tag: spec-v1.1.2 (r03 ts is clean at spec-v1.1.0)
- Last runs: r05 py 77/77 on Linux and 71/71 on Windows, not clean (own tests 38/39 on Windows,
  a CRLF expectation; clarify REQ-IF-001); r03 ts clean at spec-v1.1.0
- Blind runs used: 5 of 6 (r03 clean; r04 and r05 not clean, both for their own tests on Windows)
- Running processes: none
- Open question for Craig: run the 7 POSIX-only cases against the reference under WSL?
- Next step: r06 - py, sonnet, spec-v1.1.2; check its own tests on Windows before promotion.
