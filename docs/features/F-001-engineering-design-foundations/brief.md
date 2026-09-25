# F-001: Engineering and design-system foundations (tokens, RTL-ready layout, a11y lint): Feature Brief

> Phase 2 · Owner: product-manager · Release phase: **0 (Foundations)** · Source: [PRD](../../product/prd.md) (G2 approved 2026-09-25 with conditions), [roadmap](../../product/roadmap.md), spec §4 D9/D12, §6.1.1, §10.1, §10.4, §12, §13 Phase 0
> MoSCoW: Must (REQ-106, REQ-109) · RICE 5.0 (R 10 · I 1 · C 100 % · E 2)

## Problem

Spec §4 D12 says Arabic RTL and bilingual support must exist "from day one". The pilot is a Qatar telco (PRD pilot context, MA-106). Arabic and RTL are hard to retrofit. If the first Web, Desktop and Console screens use direction-specific styling, hard-coded English strings or colours that fail contrast, every Phase 1 screen will have to be reworked, and REQ-106 and REQ-109 (Phase 1 Musts) will be at risk. There is also no working engineering baseline yet. The repository is empty apart from folder stubs, CI has no workspaces to build, and nothing stops a provider key or a physical CSS property from being merged.

F-001 builds the guard-rails that later UI work runs on:
- the monorepo and CI baseline (spec §13 Phase 0 "Monorepo, CI, design system basics")
- design tokens with direction-neutral (logical) layout
- i18n plumbing with English and Arabic
- automated accessibility, string and layout lint that fails the build
- a secret scan that the Phase 0 exit criteria rely on

The target is that Phase 1 screens (F-015, F-016, F-018, F-021) are RTL-correct and accessible by construction.

## Personas & surfaces

| Persona | How F-001 serves them |
|---|---|
| Ralysa engineering team (direct users; DEV-style internal users) | Gets a shared design system, lint rules and CI that fail fast on RTL, a11y, i18n and secret violations. |
| ALL end-user personas, Arabic-first users especially (indirect) | Every later Web, Desktop and Console screen inherits RTL mirroring, Arabic translations, keyboard access and contrast. |
| PA (indirect) | Can later rebrand through tokens without a client release (REQ-007(e), Phase 1). |

**Surfaces:** Web, Desktop and Console at the **foundation level only**, meaning the shared design-system package plus one internal demo screen. No end-user screen ships in Phase 0. The CLI is not in scope for tokens or RTL layout; CI and the secret scan cover every workspace, including the CLI.

## Requirements covered

| REQ | Phase 0 slice delivered here | Remainder (delivered by) |
|---|---|---|
| REQ-106 English/Arabic UI, RTL mirroring, i18n keys, logical layout (Must, Phase 1) | i18n key infrastructure with `en` and `ar`; runtime locale switch; lint for hard-coded strings and direction-specific styling; RTL mirroring and LTR/RTL visual regression on the demo screen. | Locale taken from the profile, 100 % Arabic coverage for Phase 1 screens, and visual regression on every Phase 1 screen: **F-021** (Phase 1). |
| REQ-109 WCAG 2.1 AA in English and Arabic (Must, Phase 1) | Automated a11y scan in CI; token contrast checks; keyboard operability and focus visibility on the demo screen and design-system components. | Manual NVDA/VoiceOver audit of sign-in, chat, approval and `/me`, plus keyboard-only command palette: **F-021** (Phase 1). |

Supporting (not owned here): REQ-095(a) and the Phase 0 exit criterion "secret scan of repo, client builds … = 0 findings". F-001 provides the CI secret-scan capability. F-002, F-004 and F-005 own the REQ-095 criteria for their components.

Per the roadmap coverage check, REQ-106 and REQ-109 are **met in F-021**. F-001 alone does not close either REQ.

## User stories

- As a Ralysa engineer, I want CI to build, lint and test every workspace on every pull request so that a broken workspace never reaches `main`.
- As a Ralysa engineer, I want a lint error when I use direction-specific styling or a hard-coded UI string so that RTL and translation problems are caught before review.
- As a Ralysa engineer, I want a token-based design system with light and dark themes so that I build screens from shared, accessible values rather than ad-hoc colours and spacing.
- As an Arabic-speaking user (future screens), I want the interface to mirror correctly and show properly shaped Arabic text so that Ralysa feels native, not translated.
- As a keyboard or screen-reader user (future screens), I want every component to be reachable by keyboard with a visible focus indicator and adequate contrast so that I can use Ralysa without a mouse.
- As a security reviewer, I want CI to block any commit or client build that contains a credential so that REQ-095 holds from the first line of code.

## Acceptance criteria

"Demo screen" means an internal, non-production page that shows the design-system tokens and components with layout regions (navigation, main panel, side panel), directional icons, a form, and sample text in Arabic, English, mixed Arabic/English, code and digits. It is excluded from customer builds (AC-13).

| ID | Given | When | Then |
|---|---|---|---|
| AC-1 | A pull request against any branch | CI runs | Install, lint, test and build run for **every** workspace under `apps/`, `packages/` and `services/`. The PR check fails if any step fails in any workspace. The run log lists each workspace and its result. (Phase 0 exit criterion "CI builds, lints and tests all workspaces") |
| AC-2 | A commit containing a synthetic credential that matches a provider-key or private-key pattern (test fixture in a throw-away branch) | CI runs | The secret scan fails the build and reports the file and line. Scans of the repository at the `main` head, and of every built client artefact (CLI package, web bundle, desktop package once it exists), report **0 findings**. (Supports REQ-095(a) and the Phase 0 exit criterion) |
| AC-3 | The design-system package | An engineer inspects its tokens | Colour, typography, spacing, sizing, radius, elevation and motion are defined as named tokens for **light and dark** themes. Lint reports 0 raw colour values (hex/rgb/hsl) in component or app code outside token definition files. |
| AC-4 | Any style declaration in the UI apps and packages (`apps/web`, `apps/desktop`, `packages/ui`, `packages/workbench`, `packages/views`) | Lint runs | Physical direction properties and values (left/right margin, padding, border, inset/position, `text-align: left/right`, `float: left/right`, and utility classes equivalent to them) are reported as **errors**. The count on `main` is 0. (REQ-106 "logical layout") |
| AC-5 | User-visible text in the same UI apps and packages | Lint runs | A string literal rendered to the user without an i18n key is reported as an error. The count on `main` is 0. (REQ-106(a)) |
| AC-6 | The demo screen | The locale is switched between `en` and `ar` at runtime | Document direction becomes `rtl` for `ar` and `ltr` for `en` without a page reload. The `lang` attribute matches the locale. A missing-key check reports 0 missing `ar` or `en` keys for the demo screen and design-system components. (REQ-106(b)(c), foundation slice) |
| AC-7 | The demo screen in `ar` | It renders | Regions that are on the inline-start side in `en` appear on the right. Directional icons (back/forward, chevrons, "send") are mirrored. Non-directional icons (search, check, close) are not mirrored. Code samples, file paths and Latin identifiers stay LTR inside the RTL layout. (REQ-106(b); REQ-005(e) and REQ-107 foundation) |
| AC-8 | A 20-string Arabic sample (pure Arabic, mixed Arabic/English, Arabic with Western and Arabic-Indic digits) on the demo screen | It is rendered in the current and previous major versions of Chrome, Edge, Firefox and Safari | Every string shows connected Arabic letterforms, the correct order of mixed runs, and 0 missing-glyph boxes. Any bundled typeface's licence permits redistribution in customer deployments. |
| AC-9 | CI | The demo screen changes | Visual regression snapshots are compared in four configurations (`en`/LTR and `ar`/RTL, each in light and dark). A difference above the agreed threshold fails the build until the snapshot is approved in the PR. (REQ-106(d), foundation slice) |
| AC-10 | CI | The demo screen and every design-system component story/example are scanned in `en` and `ar` | The automated accessibility scan reports **0 serious or critical** violations, otherwise the build fails. (REQ-109(a), foundation slice) |
| AC-11 | Every text/background token pair used for text in light and dark themes | The contrast check runs in CI | Normal text is ≥ 4.5:1, large text ≥ 3:1, and focus indicators and UI component boundaries ≥ 3:1 (WCAG 1.4.3, 1.4.11). Any failing pair fails the build. (REQ-109(d)) |
| AC-12 | The demo screen in `en` and in `ar` | A tester uses the keyboard only | Every interactive element can be reached and operated. Tab order follows the visual reading order (right-to-left in `ar`). Every focused element has a visible focus indicator. There are 0 keyboard traps. (REQ-109(c), foundation slice) |
| AC-13 | A production build of any app | The build output is inspected | The demo screen and its synthetic sample data are not included and are not reachable by URL. |

## Governance

- **Access (SSO groups / policy):** N/A at runtime. F-001 ships no end-user capability. The demo screen is excluded from customer builds (AC-13) and needs no sign-in in development builds. Repository and CI permissions follow the ADLC rules (no pushes to `main` without review).
- **Approvals required:** N/A. No side-effecting product actions. Changes to CI and lint rules go through normal PR review (G5).
- **Audit events:** N/A. No runtime tool or model calls. CI run logs are the evidence for AC-1, AC-2, AC-9, AC-10 and AC-11.
- **PII / data classification / residency:** Demo screen, fixtures and visual snapshots use **synthetic data only**. No real names, IDs or customer text. Secret-scan fixtures use synthetic credentials that can't be used anywhere. Residency is N/A (nothing is deployed to a customer environment).

## Non-functional (spec §12)

| §12 category | Applies? | Phase 0 target in this feature |
|---|---|---|
| Accessibility (WCAG 2.1 AA) | Yes, foundation | AC-10 to AC-12. The full audit is in F-021. |
| Localization (English + Arabic RTL at launch) | Yes, foundation | AC-4 to AC-9. |
| Security (§8 secrets, supply chain) | Partly | AC-2 (secret scan). Dependency scanning and SBOM are REQ-098 (Phase 2, F-028), not here. |
| Extensibility | Yes | Themes and brand values change through tokens only (AC-3). Customer brand tokens are REQ-007(e), F-015/F-016. |
| Engineering throughput | Yes (product proposal) | A full CI run on a PR takes ≤ 15 min at p95 *(proposed; confirm at G4 per G2 condition)*. |
| Availability, latency, scale, web runtime, recoverability, observability | No | No runtime service in this feature. |

## Arabic / RTL

This is the core of the feature: AC-4 to AC-9 and AC-12.
- The layout is direction-neutral by lint.
- Every string goes through an i18n key, with `en` and `ar` present.
- The locale switches at runtime.
- Mirroring rules cover both directional and non-directional icons.
- Code and identifiers stay LTR.
- Arabic shaping and mixed-direction text are checked on a 20-string sample.
- Visual regression runs in both directions.

Locale-aware digit and date formatting (REQ-107(c)) and taking the locale from the profile are deferred to F-021.

## Out of scope

- Any end-user screen, workspace or console page. Those are F-015, F-016 and F-018 (Phase 1).
- Full REQ-106 and REQ-109 compliance: 100 % Arabic coverage of Phase 1 screens, the manual screen-reader audit, command-palette keyboard flow and profile-driven locale (all **F-021**, Phase 1).
- Bidi and locale formatting of numbers and dates, and the Arabic-reply language rule (REQ-107, F-021).
- Customer brand tokens editable by a platform admin (REQ-007(e), Phase 1).
- Arabic document export (REQ-108, Phase 2).
- CLI terminal rendering of Arabic (see F-005 and F-017).
- Dependency scanning and SBOM (REQ-098, Phase 2).
- Final Ralysa brand palette, logo and typography (blocked on OQ-15, §15 Q1). Placeholder tokens are used.
- Technology choices for lint, scan, test and visual-regression tools. These belong to the architect and solution designer. Spec §10 is treated as a constraint (PRD A-6).

## Dependencies

| Type | Item |
|---|---|
| Other features | None upstream. **F-002, F-003, F-004 and F-005 depend on F-001** for the monorepo and CI baseline and the secret scan. **F-015, F-016, F-018 and F-021** (Phase 1) build on its tokens, i18n and lint. |
| Architecture (G3) | The monorepo and CI conventions are confirmed in the architecture overview. No ADR is blocking. |
| External | An Arabic-capable typeface with a redistributable licence (AC-8). Brand assets are not required (placeholders). |
| Process | Brief-level G2 approval, then `/design F-001` (G4). |

## Success metrics

| Metric | Target | Measured by |
|---|---|---|
| Physical-direction style violations on `main` | 0 at Phase 0 exit and at every later release | Lint report (AC-4) |
| Hard-coded UI strings on `main` | 0 | Lint report (AC-5) |
| Serious/critical a11y violations on the demo screen and components | 0 in `en` and `ar` | CI scan (AC-10) |
| Secret-scan findings (repo + client builds) | 0 | CI scan (AC-2) |
| RTL defects raised against Phase 1 screens that trace to a missing foundation (token, lint rule or i18n plumbing) | ≤ 3 across Phase 1 *(proposed)* | Defect log tagged `rtl-foundation` during F-021 |

## Open questions

| # | Question | Recommendation | Owner |
|---|---|---|---|
| OQ-F001-1 | Brand palette, logo and typography are not decided (PRD OQ-15, spec §15 Q1). | Ship neutral placeholder tokens that pass AC-11. Swap in brand values through tokens only once trademark clearance and brand work finish. | Founder |
| OQ-F001-2 | Should the Desktop (Electron) shell be scaffolded in Phase 0? | No. F-001 covers the shared design system and the web demo screen only. The Desktop shell starts with F-015 (Phase 1), and AC-2 extends to the desktop package once it exists. | Product owner |
| OQ-F001-3 | Which Arabic typeface? | Choose a typeface with full Arabic and Latin coverage and a licence that allows redistribution in on-prem and air-gapped builds. The designer proposes it at G4. | Solution designer + founder |
| OQ-F001-4 | The CI-duration target (≤ 15 min p95) and the regression threshold are *(proposed)*. | Confirm at G4 as required by the G2 condition on *(proposed)* numeric targets. | Tech lead |

**G2 approval conditions (2026-09-25) and how they affect this feature:**
- *(Proposed)* numeric targets are confirmed at design: applies to the CI-duration and RTL-defect targets above.
- Phase 1 scope re-estimate: REQ-106 and REQ-109 are not on the OQ-3 deferral list. The F-001 foundations lower F-021's Phase 1 effort.
- REQ-090 and DV-16: not applicable.
- Onboarding/training REQ: not applicable.

Scope derived from PRD approved at G2 (2026-09-25); brief-level approval pending.

## Approval (G2)

> Filled by a human only. Agents must leave this blank.

| Approver | Role | Decision (Approved / Changes requested) | Date | Notes |
|---|---|---|---|---|
| | | | | |
