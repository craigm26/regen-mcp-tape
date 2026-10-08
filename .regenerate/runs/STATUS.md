# STATUS

- Project: mcp-tape (brief: kit/briefs/mcp-tape.md); second language py (go not installed on the laptop)
- Host: the laptop through r02. The laptop session stopped after scoring r02; from here an
  Anthropic cloud container (Linux) carries on from this record (WORKSPACE <WORKSPACE>,
  SANDBOX_ROOT <SANDBOX_ROOT>). The earlier implementation stays built on the laptop, so
  reference runs (r00.k) are still made there, on Windows.
- Phase: 3 (blind rebuild, primary language ts)
- Spec tag: spec-v1.1.0
- Last runs: r00.3 reference 46/66 on Windows (same 20 explained failures); r01 and r02
  rescored 76/76 on Linux (first run of the POSIX-only cases; one suite bug fixed)
- Blind runs used: 2 of 6
- Running processes: none
- Open question for Craig: run the 7 POSIX-only cases against the reference under WSL?
- Next step: r03 - ts, sonnet, spec-v1.1.0, in the cloud.
