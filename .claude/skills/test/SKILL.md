---
name: test
description: ADLC phase 6 - plan and run testing for a feature (functional, governance, security, prompt-injection, LLM evals, cross-surface, NFR/accessibility/RTL) and produce a test report. Use when the user asks to test, QA, or verify a feature or release candidate.
argument-hint: "F-nnn | vX.Y.Z-rc.N"
---

# Phase 6: Testing for $ARGUMENTS

1. For a feature, read its `brief.md`, `design.md` and the PR or branch diff. For a release candidate, collect every feature listed in `docs/releases/<version>.md`.
2. Launch in parallel:
   - **test-engineer**: complete `test-plan.md` (the traceability matrix), write and run the automated tests (Vitest, Playwright, evals) and fill in `test-report.md`
   - **security-reviewer**: a security and prompt-injection pass that writes or updates `security.md` (skip it only if the feature touches no auth, data, connectors, tools or UI input, and say that it was skipped)
3. **Verify:**
   - every acceptance criterion has at least one executed test with its real output
   - failed tests are reported as failed
   - NFR measurements show actual numbers
   - defects have a severity
4. Ask the user before filing defects as GitHub issues (`bug` label, linked to F-nnn).
5. Update `status.md` to phase **6 – Testing (awaiting G6)**. Report the pass/fail counts, the defects, the security findings and the test-engineer's recommendation. Ask the QA lead to approve **G6**. Next step: the feature is ready to go into the next `/release`.
