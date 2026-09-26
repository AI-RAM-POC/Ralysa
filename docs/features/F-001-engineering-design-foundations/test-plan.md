# F-001: Engineering and design-system foundations (tokens, RTL-ready layout, a11y lint): Test Plan

> Phase 6 · Owner: test-engineer · Baseline: `main` at `704fe4c` · Written 2026-09-26
> Sources: [brief.md](brief.md) (AC-1 to AC-13), [design.md](design.md) §8 (test strategy, TC-F-001-01 to 46) and §10 (T01–T18), [implementation-notes.md](implementation-notes.md), [security.md](security.md).

## Scope

F-001 is build-time tooling plus an unshipped demo app (`apps/ui-lab`). It delivers the **foundation slice** of two PRD requirements; neither is closed by F-001 (both are met in F-021):

| REQ | Foundation slice tested here | ACs |
|---|---|---|
| REQ-106 English/Arabic UI, RTL mirroring, i18n keys, logical layout | Logical-layout lint, i18n keys and `en`/`ar` catalogs, runtime locale switch, mirroring rules, Arabic shaping, LTR/RTL visual regression on the demo screen | AC-4 to AC-9 |
| REQ-109 WCAG 2.1 AA in English and Arabic | axe in CI (`en`/`ar` × light/dark), token contrast gate, keyboard operability and focus visibility on the demo screen and design-system components | AC-10 to AC-12 |
| Supporting: REQ-095(a), Phase 0 exit criteria | Every-workspace CI (AC-1), secret scan (AC-2), tokens (AC-3), demo excluded from shipped builds (AC-13); boundary, banned-deps and provider-host checks (ADR-0012, SR-03, SEC-F001) | AC-1 to AC-3, AC-13 |

Out of scope (brief): end-user screens, the manual NVDA/VoiceOver audit, profile-driven locale, number/date formatting (all F-021); SBOM, SCA, SAST, SHA pinning (BC-11, deferred by D-1, T20–T25).

## Traceability

Level: **U** unit (Vitest), **I** integration / CI job, **E** E2E (Playwright in the pinned image), **M** manual. "Test file :: name" is what implements the case; a `—` in that column is a TC with **no automated test**, flagged in the last column.

| AC | REQ | TC | Level | Test file :: test name | Surface | Flag |
|---|---|---|---|---|---|---|
| AC-1 | Phase 0 exit | TC-F-001-01 | U + I | `tooling/repo-scripts/test/check-workspaces.test.ts` :: `check-workspaces: coverage (TC-F-001-01)`; CI `repo-checks` (`pnpm repo:check`) | repo | |
| AC-1 | Phase 0 exit | TC-F-001-02 | M (once) + I | — (throw-away PR canary; CI `quality` step summary) | CI | Manual by design |
| AC-1 | Phase 0 exit | TC-F-001-46 | I | `tooling/repo-scripts/test/scaffold.test.ts` :: `scaffold templates pass every gate on creation (TC-F-001-46)` | repo | |
| AC-2 | REQ-095(a) | TC-F-001-03 | U + I | `tooling/repo-scripts/test/secret-scan-selftest.test.ts` :: `TC-F-001-03: dir mode with --config .gitleaks.toml`; CI `secret-scan` → `secret-scan selftest` | CI | |
| AC-2 | REQ-095(a) | TC-F-001-04 | M (once) | — (throw-away PR with a synthetic key) | CI | Manual by design |
| AC-2 | REQ-095(a) | TC-F-001-05 | I | — (CI `secret-scan` `tree`/`history` and `quality` "Secret scan of shipped artefacts"; locally `pnpm secret-scan tree|history|artefacts`) | CI | No named unit test; CI-step evidence only |
| AC-2 | REQ-095(a) | TC-F-001-37 | U + I | `secret-scan-selftest.test.ts` :: `TC-F-001-37: git mode, range assertion, exit codes` | CI | |
| AC-2 | REQ-095(a) | TC-F-001-38 | U | `secret-scan-selftest.test.ts` :: `TC-F-001-38: artefact scan with the exact CI command`; `check-gitleaks-config.test.ts` | CI | |
| AC-2 | REQ-095(a) | TC-F-001-39 | U | `tooling/repo-scripts/test/gitleaks-rules.test.ts` :: `custom gitleaks rules (TC-F-001-39)` | CI | |
| AC-2 | REQ-095(a) | TC-F-001-40 | U + M | **Not on `main`**: `tooling/repo-scripts/test/pre-commit-hook.test.ts`, `.claude/hooks/test/` arrive with T17 | local | **PENDING (T17, no PR)** |
| AC-3 | REQ-106 | TC-F-001-06 | U | `packages/ui/test/tokens.test.ts` :: `defines %s tokens in light and dark (AC-3)`, `has identical semantic key sets in light and dark`, `validates and resolves every alias in both themes` | ui | |
| AC-3 | REQ-106 | TC-F-001-07 | U | `tooling/eslint-config/test/raw-color.test.ts` :: `react-ui preset: raw colours (AC-3)`; `tooling/stylelint-config/test/raw-color.test.ts` :: `raw colours in CSS (AC-3)`; `logical.test.ts` default-palette cases | ui | |
| AC-4 | REQ-106 | TC-F-001-08 | U | `tooling/stylelint-config/test/logical.test.ts` :: `inline-axis physical properties…`, `physical keywords…`, `shorthands and values…`; `tooling/eslint-config/test/logical.test.ts` :: `Tailwind classes (better-tailwindcss)` | ui | |
| AC-4, AC-5 | REQ-106 | TC-F-001-09 | I | — (`pnpm lint` / CI `quality`: 0 errors by construction) | CI | CI-step evidence only |
| AC-5 | REQ-106(a) | TC-F-001-10 | U | `tooling/eslint-config/test/i18n.test.ts` :: `no hard-coded UI strings (AC-5)` | ui | |
| AC-6 | REQ-106(b)(c) | TC-F-001-11 | E + U | `apps/ui-lab/e2e/locale.spec.ts` :: `en → ar → en with the LocaleSwitcher, without a reload`; `packages/ui/test/i18n.test.tsx` | web (ui-lab) | |
| AC-6 | REQ-106(c) | TC-F-001-12 | U + I | `packages/ui/test/i18n-extract.test.ts` :: `i18next-cli extract --ci --dry-run`; `tooling/repo-scripts/test/check-i18n.test.ts` :: `passes on the real repository`; console guard in every E2E | ui | |
| AC-7 | REQ-106(b) | TC-F-001-13 | E + U | `apps/ui-lab/e2e/mirroring.spec.ts` :: `regions follow the inline direction`, `directional icons mirror only in ar; non-directional never`, code/`[data-ltr]` LTR; `packages/ui/test/icons.test.tsx` | web (ui-lab) | |
| AC-8 | REQ-106 | TC-F-001-14 | U | `packages/ui/test/font-coverage.test.ts` :: `bundled font coverage (TC-F-001-14)`; `apps/ui-lab/test/samples.test.ts` :: `TC-F-001-14: 0 missing glyphs in the bundled fonts` | ui | |
| AC-8 | REQ-106 | TC-F-001-15 | E (chromium, firefox, webkit) | `apps/ui-lab/e2e/shaping.spec.ts` :: `Arabic shaping › the Arabic face is loaded…`, `sample <id>` × 20 | web (ui-lab) | Baselines not native-reviewed (OQ-D8) |
| AC-8 | REQ-106 | TC-F-001-16 | M | — (browser matrix checklist in test-report.md) | browsers | Manual by design; **not run** |
| AC-8 | REQ-106 | TC-F-001-17 | U | `packages/ui/test/font-licence.test.ts` :: `licence files in the output (TC-F-001-17)` | ui | |
| AC-9 | REQ-106(d) | TC-F-001-18 | E (chromium) | `apps/ui-lab/e2e/visual.spec.ts` :: showcase `en`/`ar` × `light`/`dark` × 1280×800 and 360×740 (8) | web (ui-lab) | |
| AC-9 | REQ-106(d) | TC-F-001-19 | M (once) | — (token-change canary, recorded 2026-09-25 in implementation-notes T14) | CI | Manual by design |
| AC-10 | REQ-109(a) | TC-F-001-20 | E (chromium) | `apps/ui-lab/e2e/a11y.spec.ts` :: `<view> <lang> <theme>: no serious or critical axe violations` (showcase, components, tokens × en/ar × light/dark = 12) + `the gallery shows every component example` | web (ui-lab) | |
| AC-10 | REQ-109(a) | TC-F-001-21 | E | `apps/ui-lab/e2e/a11y-selftest.spec.ts` (known violation fails; fixed page passes) | harness | |
| AC-11 | REQ-109(d) | TC-F-001-22 | U | `tooling/repo-scripts/test/contrast.test.ts` :: `contrastRatio (WCAG 2.1)`, `checkContrast` › `applies MIN_RATIO per kind`, `rejects translucent colours in a pair` | ui | |
| AC-11 | REQ-109(d) | TC-F-001-23 | U + I | `packages/ui/test/contrast.test.ts` :: `contrast gate on the real tokens (AC-11)`, `contrast gate on a failing fixture` | ui | |
| AC-12 | REQ-109(c) | TC-F-001-24 | E (chromium, firefox) | `apps/ui-lab/e2e/keyboard.spec.ts` :: `<lang> › Tab reaches every focusable element in reading order, with a visible ring`, `Shift+Tab walks the same stops in reverse…`, Select/Checkbox/RadioGroup/button cases; `harness-selftest.spec.ts` (walker self-tests) | web (ui-lab) | Firefox asserts D-F001-E2E-1 shape |
| AC-12 | REQ-109(c) | TC-F-001-25 | M | — (keyboard-only run in `en` and `ar`, including Safari and a stock Firefox) | browsers | Manual by design; **not run** |
| AC-13 | — | TC-F-001-26 | U | `tooling/repo-scripts/test/check-imports.test.ts` :: `TC-F-001-26: apps/web importing apps/ui-lab fails, by path or by package name (AC-13)` | repo | |
| AC-13 | — | TC-F-001-27 | U + I | `tooling/repo-scripts/test/check-no-demo.test.ts` :: `check-no-demo (TC-F-001-27)`; CI `quality` "No demo content in shipped artefacts"; `no-demo-in-web.spec.ts` negative control | CI | |
| AC-13 | — | TC-F-001-28 | E | `apps/ui-lab/e2e/no-demo-in-web.spec.ts` (web preview serves no demo at `/ui-lab`, `/demo`, `/__demo`, `?view=…`; ui-lab control) | web | |
| (ADR-0012, SR-03) | — | TC-F-001-29 | U | `tooling/eslint-config/test/boundaries.test.ts` :: `banned packages: no-restricted-imports in the base preset`, `allowed paths…`, `fires in %s too (RC-3)`; `check-imports.test.ts`; `check-banned-deps.test.ts` | repo | |
| (RF-7) | — | TC-F-001-30 | U + I | `check-workspaces.test.ts` :: `fails when packs/* is a workspace glob (RF-7)` (untagged); CI `repo-checks` | repo | Test not tagged with the TC id |
| (SEC-F001-07) | — | TC-F-001-40 | see AC-2 row | | | **PENDING** |
| (D-4, SEC-F001-10/-12) | — | TC-F-001-41 | U + M | **Not on `main`**: `.claude/hooks/test/guard-bash.test.mjs` arrives with T15 (branch `feat/F-001-claude-guard`, no PR) | agent | **PENDING (T15, no PR)** |
| (SEC-F001-09, -26) | — | TC-F-001-42 | U | `boundaries.test.ts` :: `dynamic loading ban…`, `lint-disable comments cannot switch the boundary rules off…`; `check-banned-deps.test.ts`; `check-workspaces.test.ts` :: `dependency specifiers (TC-F-001-42…)`; `check-provider-hosts.test.ts` :: `check-provider-hosts: source`, `--artefacts` | repo | |
| (SEC-F001-11, -19) | — | TC-F-001-43 | U | `check-workspaces.test.ts` :: `lifecycle scripts (TC-F-001-43…)`, `pnpm build settings…`, `Python ban…` | repo | |
| (SEC-F001-20, -21) | — | TC-F-001-44 | U | `tooling/repo-scripts/test/check-ci-invariants.test.ts`; `install-tool.test.ts` | CI | |
| (SEC-F001-12, -23) | — | TC-F-001-45 | U | `tooling/repo-scripts/test/check-turbo-config.test.ts` :: `globalDependencies invalidate every lint hash (TC-F-001-45…)` | CI | |
| T18 | — | (no TC) | U | **Not on `main`**: `ci-duration` script (PR #63), CODEOWNERS (PR #61) | repo | **PENDING (PR open)** |

TC-F-001-31 to 36 are the deferred BC-11 cases (design §11.11) and are not tested.

**TCs with no automated test:** 02, 04, 16, 19, 25 (manual by design); 05 and 09 (evidence is a CI step, no named test); 40 and 41 (tests not on `main`; T17 and T15). TC-F-001-30 is automated but its test isn't tagged with the id.

## Governance & security cases

F-001 has no runtime service, API, model or tool call (brief "Governance"). The template's runtime cases are recorded as N/A with the reason; the build-time controls that do apply are tested.

- [x] N/A Unauthorized group denied at API: no API. (Repository and CI permissions: ADLC rules; CODEOWNERS in PR #61 is advisory on GitHub Free, SEC-F001-04 accepted risk.)
- [x] N/A Approval gate blocks side effect: no side-effecting product action.
- [x] N/A Audit event per tool/model call: no tool or model call. CI logs are the AC-1/2/9/10/11 evidence.
- [x] PII: the demo, fixtures and snapshots use synthetic data only; secret fixtures are synthetic and assembled at runtime (TC-F-001-03, -39).
- [x] Model routing boundary: provider SDKs only in `services/model-gateway`, Agent SDK only in `engine/claude/**`, no provider hostname outside the gateway or in a shipped artefact (TC-F-001-29, -42; `check-banned-deps`, `check-provider-hosts`).
- [x] Secret leakage: CI secret scan of PR range, tree, `main` history and shipped artefacts (TC-F-001-03 to -05, -37 to -39); local and agent commit guards are PENDING (TC-F-001-40, -41).
- [x] N/A Prompt injection (documents, email, tool results): no model or untrusted content path. The agent-side control for this repo is the Claude Code guard (TC-F-001-41, PENDING).
- [x] Supply chain: lifecycle-script ban, `allowBuilds`, `packs/` isolation, pre-install config gate (TC-F-001-43, -30, -44).

## LLM evals

N/A. F-001 has no model behaviour (design §8.1).

## Cross-surface

Web only, at foundation level (the ui-lab demo and `apps/web` shell). Desktop is not scaffolded (OQ-F001-2) and the CLI is out of scope for tokens and RTL; CI and the secret scan cover every workspace including the CLI.

## NFR checks
| NFR | Target | Method |
|---|---|---|
| Gateway overhead p95 | < 100 ms | N/A: no runtime service |
| Workspace cold start | < 15 s | N/A: no workspace runtime |
| Accessibility | WCAG 2.1 AA, 0 serious/critical | axe via Playwright (TC-F-001-20), 12 scans; violation counts of every impact per view × lang × theme from the attached axe JSON; keyboard walker (TC-F-001-24); manual TC-F-001-25 |
| Contrast | text ≥ 4.5, large ≥ 3, non-text and focus ≥ 3 | `check-contrast` over `contrast-pairs.json`, both themes (TC-F-001-23); focus-ring contrast in the keyboard walker |
| RTL / Arabic | Mirroring, isolation, shaping, 0 tofu | TC-F-001-11 to -16 |
| Visual regression | `maxDiffPixelRatio` 0.001, `threshold` 0.2 | TC-F-001-18 (8 baselines), shaping (60 baselines) |
| Engineering throughput | Full PR CI ≤ 15 min p95, ≤ 10 min p50 (design §8.3) | `ci-duration` (PR #63, not merged) or the equivalent over `gh run list` / the jobs API for the last 30 completed PR runs |
| Bundle size | No budget in the design | Reported for information only |
| Flake rate | 0 unexplained failures | Full ui-e2e suite at least twice, plus the ui-e2e job history of the last 30 PR runs |

## Test data & environment

- Synthetic data only: the ui-lab samples (`apps/ui-lab/src/samples/arabic-samples.json`, 20 strings, `needs-native-review`), machine-assisted `ar` catalogs, runtime-generated synthetic credentials.
- Local: macOS (Darwin 27, arm64), Node 24.21.0, pnpm 11.27.1, gitleaks 8.30.1 (hash-pinned, `pnpm tools:install`), Docker 29.8.
- E2E: the pinned image `mcr.microsoft.com/playwright:v1.63.0-noble@sha256:eff16c30…a4a27` (CI's `ui-e2e` job, linux/amd64 on GitHub; locally through `pnpm --filter @ralysa/ui-lab e2e:container`).
- CI: GitHub Actions `CI` workflow (`repo-checks`, `quality`, `secret-scan`, `ui-e2e`, `integration`, `pr-traceability`).
- Manual cases (TC-F-001-16, -25) need a person with macOS and Windows machines, stock Chrome, Edge, Firefox and Safari (current and previous major), and an Arabic keyboard layout.
