# F-001: Engineering and design-system foundations (tokens, RTL-ready layout, a11y lint): Test Report

> Phase 6 · Owner: test-engineer · Commit: <sha> · Environment: <env>

## Summary
| Total | Passed | Failed | Blocked | Skipped |
|---|---|---|---|---|

## Results
| Test case | Result | Evidence (output / link) | Defect |
|---|---|---|---|
| TC-F-001-15 (AC-8, E2E chromium, firefox, webkit) | **Automated pass; native-speaker approval pending (OQ-D8)** | `shaping.spec.ts`: a loaded Noto Sans Arabic face covering U+0600–06FF, then 20 samples × 3 engines matching the baselines. CI `ui-e2e` on PR #20. The baselines aren't yet approved by a native speaker. | – |
| TC-F-001-18 (AC-9, E2E chromium) | **Pass** | `visual.spec.ts`: showcase in en/ar × light/dark at 1280×800 and 360×740 (8 baselines) within `maxDiffPixelRatio` 0.001. CI `ui-e2e` on PR #20. | – |
| TC-F-001-20 (AC-10, E2E chromium) | **Pass** | `a11y.spec.ts`: showcase, whole gallery and tokens × en/ar × light/dark, 0 serious or critical axe violations; every violation attached as JSON. CI `ui-e2e` on PR #20. | – |
| TC-F-001-24 (AC-12, E2E chromium and firefox) | **Pass, with one known Firefox shape** | `keyboard.spec.ts`: forward walk, reading order, rings, Select, Checkbox, RadioGroup and buttons pass in both engines. Shift+Tab reverses fully in Chromium. In Firefox the test asserts the known D-F001-E2E-1 shape (stops at the RadioGroup), so other regressions still fail. | D-F001-E2E-1 |
| TC-F-001-19 (AC-9, manual canary, once) | **Pass** (2026-09-25, F-001-T14, local run in the pinned Playwright image on linux/amd64) | Changed `space.4` from 1rem to 1.125rem: `visual.spec.ts` 8 of 8 failed (for example, expected 1280×3385 and received 1280×3445, 3 % of pixels different against the 0.1 % threshold). Reverted: visual and shaping 71 of 71 passed. See implementation-notes.md, "T14". | – |
| TC-F-001-16 (AC-8, manual browser matrix) | **Not run** | Needs a person on macOS and Windows. Checklist below. | – |
| TC-F-001-25 (AC-12, manual keyboard-only run, en and ar, including Safari) | **Not run** | Needs a person. Must also confirm or clear D-F001-E2E-1 in a stock Firefox. | D-F001-E2E-1 |

### TC-F-001-16 checklist (to fill in)

For each browser, open ui-lab `?view=showcase&lang=ar` and check the 20 samples: letterforms connected, correct order in mixed runs, 0 tofu (missing-glyph boxes), digits as written.

| Browser | macOS (current / previous) | Windows (current / previous) |
|---|---|---|
| Chrome | / | / |
| Edge | / | / |
| Firefox | / | / |
| Safari | / | n/a |

## NFR measurements
## Security review summary (link security.md)
## Defects
| ID / issue | Severity | Summary | Status |
|---|---|---|---|
| D-F001-E2E-1 | Major if it reproduces in a stock Firefox (WCAG 2.1.2); otherwise a harness limitation | In Playwright's Firefox, Shift+Tab can't leave the Radix `RadioGroup` backwards: focus goes to the group element, which gives it straight back to the checked item. Chromium passes. In Firefox, `keyboard.spec.ts` asserts exactly this shape, so other regressions still fail (T13-11). | Open; **blocks G6**. Confirm or clear in a stock Firefox (TC-F-001-25). |

## Known limitations
## Recommendation
Ready for release candidate / Not ready

## Approval (G6)

> Filled by a human only. Agents must leave this blank.

| Approver | Role | Decision (Approved / Changes requested) | Date | Notes |
|---|---|---|---|---|
| | | | | |
