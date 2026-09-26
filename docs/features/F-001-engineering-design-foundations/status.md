# F-001: Engineering and design-system foundations (tokens, RTL-ready layout, a11y lint): Status

- **Current phase:** 5 – Development. T01–T14 and T16 are merged (#12–#15, #17, #20, #22). T18 is in three PRs: #61 (`.github/CODEOWNERS`, human merge), #62 (code-reviewer checklist, human merge) and #63 (frontend docs and `ci-duration`, agent merge). T15 (Claude Code guard) and T17 (local secret guard) are not started (no PR) and need a human merge (`.claude/**`, `.githooks`). D-F001-E2E-1 blocks G6 until the manual TC-F-001-25 run in a stock Firefox. T20–T25 are deferred (BC-11).
- **GitHub issue:** https://github.com/AI-RAM-POC/Ralysa/issues/4
- **Branch / PR:** T13–T14 merged in #20. T18: #61 (`feat/F-001-codeowners-docs`), #62 (`feat/F-001-reviewer-checklist`), #63 (`feat/F-001-frontend-docs`).
- **Release:**

## Gate log
| Gate | Artifact | Approver | Date | Result |
|---|---|---|---|---|
| G2 Scope | brief.md | | | |
| G4 Design | design.md | Ram Mohan Rao Adduri (standing authorization, recorded by Claude) | 2026-09-25 | Approved |
| G5 Code review | PR | | | |
| G6 Quality | test-report.md | | | |
| G7 Release candidate | docs/releases/ | | | |
| G8 UAT sign-off | uat.md | | | |

## History
| Date | Event |
|---|---|
| 2026-09-25 | Feature workspace created from ADLC templates. brief.md drafted by product-manager from the PRD (G2 approved 2026-09-25 with conditions). Brief-level G2 approval pending. |
| 2026-09-25 | Solution design written; architect review (fits with changes) and security review (security.md) completed; design revised; G4 recorded under standing authorization. |
| 2026-09-25 | T13 (Playwright harness, `ui-e2e` job) implemented on `feat/F-001-e2e`. Open: D-F001-E2E-1 (Shift+Tab out of RadioGroup in Playwright's Firefox; confirm in a stock Firefox) and the manual keyboard run TC-F-001-25. |
| 2026-09-25 | T14 (visual and shaping snapshots, `e2e:update`) implemented on `feat/F-001-e2e`. **Open (OQ-D8):** the Arabic shaping and visual baselines and all Arabic strings need a native speaker's review. T14 merges with this open, as agreed; `needs-native-review` stays on every Arabic string. TC-F-001-16 (browser matrix) has not been run. |
| 2026-09-25 | PR #20 review (changes requested) addressed. **D-F001-E2E-1 stays open and blocks G6** for F-001 until the manual TC-F-001-25 run in a stock Firefox either clears it (a Playwright-Firefox artefact) or confirms it (then `RadioGroup` needs a fix: WCAG 2.1.2). |
| 2026-09-26 | Status corrected by the requirements audit (docs/product/requirements-audit.md): T13–T14 merged in #20 on 2026-09-25; T15, T17, T18 not started (need a human merge); D-F001-E2E-1 still blocks G6. |
| 2026-09-26 | T18 implemented in three PRs. #61 adds `.github/CODEOWNERS` (design §6.6 paths plus the F-002 protocol folders; owners `@radduri` and `@umaadduri`, as the founder decided on 2026-09-26; human merge). #62 adds the code-reviewer checklist items (new-dependency review, `protected-paths-reviewed` marker; human merge). #63 (`feat/F-001-frontend-docs`) adds `docs/engineering/frontend-foundations.md` and `ci-duration` (first run: p50 3m 05s, p95 4m 29s, within budget). |
