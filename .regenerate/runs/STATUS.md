# STATUS

- Project: mcp-tape (brief: kit/briefs/mcp-tape.md); second language py (go not installed on the laptop)
- Host: the laptop through r02. The laptop session stopped after scoring r02; from here an
  Anthropic cloud container (Linux) carries on from this record (WORKSPACE <WORKSPACE>,
  SANDBOX_ROOT <SANDBOX_ROOT>). The earlier implementation stays built on the laptop, so
  reference runs (r00.k) are still made there, on Windows.
- Phase: 5 (fix the spec from r03 and r04)
- Spec tag: spec-v1.1.0
- Last runs: r04 py 76/76 on Linux and 70/70 on Windows, not clean (own tests 16/19 on Windows;
  clarify REQ-IF-001); r03 ts clean at spec-v1.1.0
- Blind runs used: 4 of 6 (r03 clean; r04 not clean)
- Running processes: none
- Open question for Craig: run the 7 POSIX-only cases against the reference under WSL?
- Next step: spec 1.1.1 from r03 and r04, r00.4 on the laptop, then r05 (py).
