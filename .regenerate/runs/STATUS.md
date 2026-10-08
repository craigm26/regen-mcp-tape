# STATUS

- Project: mcp-tape (brief: kit/briefs/mcp-tape.md); second language py (go not installed on the laptop)
- Host: the laptop through r02. The laptop session stopped after scoring r02; from here an
  Anthropic cloud container (Linux) carries on from this record (WORKSPACE <WORKSPACE>,
  SANDBOX_ROOT <SANDBOX_ROOT>). The earlier implementation stays built on the laptop, so
  reference runs (r00.k) are still made there, on Windows.
- Phase: 3 (blind rebuild, py on spec-v1.1.1)
- Spec tag: spec-v1.1.1 (r03 ts is clean at spec-v1.1.0)
- Last runs: r00.4 reference 46/67 on Windows (21 explained failures); r01 to r04 rescored
  77/77 on Linux; r04 py not clean (own tests 16/19 on Windows)
- Blind runs used: 4 of 6 (r03 clean; r04 not clean)
- Running processes: none
- Open question for Craig: run the 7 POSIX-only cases against the reference under WSL?
- Next step: r05 - py, sonnet, spec-v1.1.1; check its own tests on Windows before promotion.
