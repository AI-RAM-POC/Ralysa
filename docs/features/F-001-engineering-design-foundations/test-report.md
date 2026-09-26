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
| TC-F-001-24 (AC-12, E2E chromium and firefox; D-F001-E2E-1 also webkit) | **Pass** (2026-09-26, after the D-F001-E2E-1 fix) | `keyboard.spec.ts`: forward walk, reading order, rings, Select, Checkbox, RadioGroup and buttons, and the full Shift+Tab reverse walk, in Chromium and Firefox (the Firefox-only defect branch is removed). `radiogroup-shift-tab.spec.ts`: Shift+Tab leaves every RadioGroup and Tab returns to its checked item, in Chromium, Firefox and WebKit, en and ar. Evidence under D-F001-E2E-1 below. | D-F001-E2E-1 (fixed) |
| TC-F-001-19 (AC-9, manual canary, once) | **Pass** (2026-09-25, F-001-T14, local run in the pinned Playwright image on linux/amd64) | Changed `space.4` from 1rem to 1.125rem: `visual.spec.ts` 8 of 8 failed (for example, expected 1280×3385 and received 1280×3445, 3 % of pixels different against the 0.1 % threshold). Reverted: visual and shaping 71 of 71 passed. See implementation-notes.md, "T14". | – |
| TC-F-001-16 (AC-8, manual browser matrix) | **Not run** | Needs a person on macOS and Windows. Checklist below. | – |
| TC-F-001-25 (AC-12, manual keyboard-only run, en and ar, including Safari) | **Not run** | Needs a person. It no longer has to settle D-F001-E2E-1: that is fixed in code and covered by the automated keyboard specs in all three engines. The manual run should still try Shift+Tab out of each RadioGroup in a stock Firefox and Safari. | – |

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
| D-F001-E2E-1 | Major (WCAG 2.1.2 keyboard trap) | In Playwright's Firefox, Shift+Tab couldn't leave the Radix `RadioGroup` backwards: focus went to the group element, which gave it straight back to the checked item. **Root cause:** Radix `RovingFocusGroup` takes the group element (`tabIndex` 0) out of the tab order through a React state update in the item's Shift+Tab `keydown`. React commits that update in a microtask, and Firefox moved focus before running it, so the group was still a tab stop. **Fix:** `RadioGroup` (packages/ui) commits its own `tabIndex={-1}` override with `flushSync` in the Shift+Tab keydown and resets it on blur. Radix 1.6.7 is the latest release, and the latest roving-focus pre-release has the same logic, so a version bump wouldn't fix it. See implementation-notes.md, "Fix for D-F001-E2E-1". | **Fixed** 2026-09-26 on `fix/F-001-radiogroup-shift-tab`. Evidence below. |

### D-F001-E2E-1 fix evidence (2026-09-26, pinned image `mcr.microsoft.com/playwright:v1.63.0-noble@sha256:eff16c30…a4a27`)

| Run | Chromium | Firefox | WebKit | Result |
|---|---|---|---|---|
| Unfixed `Forms.tsx` + new specs (keyboard, radiogroup-shift-tab), linux/arm64 | pass | **4 fail** (backward walk and radiogroup-shift-tab, en and ar) | pass | Reproduces the defect; the specs catch it. |
| Full `ui-e2e` suite, fixed, linux/arm64 | 79 (78 pass + the expected-failure console-guard self-test) | 37 pass | 23 pass | **139 passed**, 0 failed, 1.7 min. |
| keyboard, radiogroup-shift-tab, visual, mirroring, fixed, linux/amd64 (CI's platform, emulated, 1 worker) | 30 pass | 16 pass | 2 pass | **48 passed**, 0 failed. Visual baselines unchanged. |
| Full `ui-e2e` suite, fixed, linux/amd64 emulated on Apple silicon, 2 workers | a11y 12 of 12 plus its self-tests pass | – | – | 132 passed, then the 12-minute `globalTimeout` stopped the run (emulation is about 7× slower than native). One WebKit `ar` case timed out in `openLab` waiting for `lang="ar"` before any Shift+Tab; it passes natively and in the amd64 rerun. CI's native amd64 `ui-e2e` run is the authoritative one. |
| `packages/ui` unit tests | – | – | – | 207 passed. The new synchronous-`tabIndex` test fails with `expected +0 to be -1` when `flushSync` is removed. |

## Known limitations
## Recommendation
Ready for release candidate / Not ready

## Approval (G6)

> Filled by a human only. Agents must leave this blank.

| Approver | Role | Decision (Approved / Changes requested) | Date | Notes |
|---|---|---|---|---|
| | | | | |
