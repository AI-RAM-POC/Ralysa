# F-005: CLI v0: sign-in and chat: Feature Brief

> Phase 2 · Owner: product-manager · Release phase: **0 (Foundations)** · Source: [PRD](../../product/prd.md) (G2 approved 2026-09-25 with conditions), [roadmap](../../product/roadmap.md), spec §3.2, §6.1.4, §6.4.1, §10.2, §13 Phase 0
> MoSCoW: Must (REQ-001) · RICE 2.0 (R 2 · I 1 · C 100 % · E 1)

## Problem

Phase 0's goal (roadmap) is that **a signed-in developer can chat with Claude from the CLI, through the Model Gateway, with every call audited and no provider key on the client.** F-002, F-003 and F-004 each prove one layer. The CLI is the first surface that joins them into a real user experience and exercises the full chain end to end:

IdP → control plane → local Agent Host → Agent Protocol → Model Gateway → provider → audit

Developers and technology managers are the CLI's default users (spec §3.2). F-005 gives them SSO sign-in and streaming chat with one approved model. It is also the Phase 0 exit demonstration.

## Personas & surfaces

| Persona | Need |
|---|---|
| DEV | Sign in from the terminal with company SSO and chat with Claude, with streaming, cancel and multi-turn context. |
| TM | Try Ralysa quickly from a terminal. Trust that it is SSO-governed and audited. |
| PA (indirect) | Confidence that a CLI install holds no provider key or plaintext token, and that every call is audited. |

**Surface:** CLI (`ralysa`), interactive mode only.

## Requirements covered

| REQ | Phase 0 scope in this feature | Deferred |
|---|---|---|
| REQ-001 CLI SSO sign-in (device-code flow) and streaming chat with one approved model (Must, Phase 0) | All criteria (a)–(e). | Full command set (`/profile`, `/skills`, `/plugins`, `/models`, `/usage`, `/memory`, `/connections`, `/approve`, `/compact`) and non-interactive/CI mode: REQ-002, **F-017** (Phase 1). |
| REQ-011(b) "The CLI talks to the host only through this protocol" (owned by F-003) | Verified from the CLI side (AC-7). | Conformance suite: REQ-012, F-017. |
| REQ-095 (supporting) | CLI package and config-directory scan (AC-5). | — |

## User stories

- As a developer, I want to run `/login`, see a code and URL, and finish sign-in in my browser with MFA so that I never type a password into the terminal.
- As a developer, I want replies to stream as they're generated, and `Ctrl+C` to stop a turn within 2 seconds, so that the CLI feels responsive and I stay in control.
- As a developer, I want follow-up questions in the same session to keep context so that I can have a real conversation, not single shots.
- As a developer, I want to see which model is answering so that I know what I'm using.
- As a developer, I want `/logout` to remove my credentials from this machine so that I can safely use a shared or temporary machine.
- As a developer, I want a clear message telling me to run `/login` when I'm not signed in, and a clear reason when something fails, so that I know what to do next.
- As an Arabic-speaking developer, I want Arabic prompts and replies to arrive without corruption so that I can work in my language.

## Acceptance criteria

Timings marked *(proposed)* need confirmation at G4 (G2 condition).

| ID | Given | When | Then |
|---|---|---|---|
| AC-1 | A user who is not signed in, in the configured access group (F-002) | They run `/login` | The CLI shows a device code and a verification URL, and offers to open the system browser where one is available. After the user completes IdP sign-in with MFA, the CLI shows "signed in as <name>" **≤ 5 s** later. At no point does the CLI prompt for a password. (REQ-001(a)) |
| AC-2 | A user who is not signed in, or whose session can't be refreshed | They send a chat message | The message is refused with an instruction to run `/login`. No request reaches the Agent Host's model path or the gateway (capture). (REQ-001(e)) |
| AC-3 | A signed-in user | They send a prompt | The reply is printed incrementally as it streams. The first characters appear ≤ 200 ms after the host emits the first `message.delta` *(proposed)*. The reply is not buffered until completion. The CLI shows the approved model's name at session start. (REQ-001(b)) |
| AC-4 | A reply is streaming or a tool is running | The user presses `Ctrl+C` once | The turn stops **≤ 2 s** later in 20 of 20 trials. The CLI returns to the prompt with the session intact. A second `Ctrl+C` at an idle prompt, or `/exit`, quits the CLI. (REQ-001(b)) |
| AC-5 | A machine after `/login` and a scripted chat session | The CLI config directory, CLI install directory, shell history and CLI-set environment variables are scanned | There are **0** provider keys and **0** plaintext access or refresh tokens. Any persisted token is stored only in a form the OS protects for this user. The published CLI package also scans at 0 findings. (REQ-001(c), REQ-095(a)) |
| AC-6 | A scripted session of 10 chat turns, one of them cancelled | Audit events are reconciled | Each model call from the session has exactly one audit event with user, model, tokens in/out and inference region (written by F-004). Turn count reconciles with model-call events. (REQ-001(d)) |
| AC-7 | The CLI during the scripted session | Its network and process connections are captured, and its package dependencies are inspected | The CLI connects only to the local Agent Host (through the Agent Protocol) and to the control plane / IdP for sign-in and refresh. It makes 0 connections to model-provider endpoints or the Model Gateway directly, and doesn't use the agent engine directly. (REQ-011(b)) |
| AC-8 | A signed-in user in a session longer than one access-token lifetime (15 min *(proposed)*) | They keep chatting | The CLI continues without asking them to sign in again while the refresh is valid. If the refresh is refused (user disabled or signed out elsewhere), the CLI stops the turn and tells them to run `/login`. |
| AC-9 | A signed-in user | They run `/logout` | Local tokens are deleted, the refresh token is revoked at the control plane (F-002 AC-8), and the next chat message behaves as in AC-2. |
| AC-10 | A signed-in user | They ask a follow-up question that depends on the previous answer | The reply uses the earlier turns of the same session. Starting a new session with `/new` *(proposed command name)* clears that context. |
| AC-11 | The gateway is unavailable, a request is denied, or the audit store is down (F-003 AC-3/AC-13, F-004 AC-3/AC-6) | The user sends a prompt | The CLI shows a readable message with a reason category (`sign-in required` / `access denied` / `service unavailable` / `audit unavailable`) and a `trace_id` to quote to support. No stack trace is shown unless the user sets a debug option. |
| AC-12 | Arabic and mixed Arabic/English prompts typed or pasted, including the 10 Arabic golden prompts from F-004 | They are sent and answered | The text reaches the gateway byte-identical in UTF-8 (capture). Replies are printed with 0 replacement characters. Visual bidi ordering is left to the terminal (see Arabic/RTL). |
| AC-13 | The CLI package | It is installed on macOS 13+, Windows 10/11 and Ubuntu 22.04 LTS *(proposed platform list)* | `ralysa` starts, `/login` works, and a chat turn completes on each platform in the Phase 0 test run. |

## Governance

- **Access (SSO groups / policy):**
  - Sign-in only through the enterprise IdP, using the device-authorization flow (F-002).
  - The Phase 0 access-group decision is made server-side. The CLI only shows the result (AC-1, AC-2, AC-11).
  - The CLI never decides access itself. Model choice is fixed server-side (F-004 AC-3).
- **Approvals required:** None in Phase 0. The CLI v0 offers chat. File-write and terminal tools are off by default server-side (F-003 AC-4). `/approve` and approval handling come in F-010 and F-017.
- **Audit events:**
  - The CLI generates none itself.
  - Sign-in and sign-out are audited by F-002 (`auth.sign_in`, `auth.sign_out`).
  - Tool calls are audited by F-003 (`tool.call`).
  - Model calls are audited by F-004 (`model.call`).
  - AC-6 verifies the chain from the CLI's point of view.
- **PII / data classification / residency:**
  - No provider key or plaintext token on disk (AC-5).
  - The CLI keeps no local transcript file in Phase 0 *(proposed; see OQ-F005-3)*.
  - Phase 0 use is internal with synthetic or non-sensitive data, T1 only, until F-008 masking and routing exist.
  - Inference region is set by F-004.

## Non-functional (spec §12)

| §12 category | Phase 0 target |
|---|---|
| Latency | Signed in ≤ 5 s after IdP completion (AC-1). First characters ≤ 200 ms after first `message.delta` *(proposed)* (AC-3). Cancel ≤ 2 s (AC-4). |
| Security | AC-2, AC-5, AC-7, AC-9. |
| Observability | 100 % of CLI-originated model calls audited (AC-6). User-visible `trace_id` on errors (AC-11). |
| Accessibility | WCAG applies to GUI surfaces (REQ-109). For the CLI, meaning is never conveyed by colour alone. The CLI honours `NO_COLOR` and disables animations and spinners when output is not a TTY, so screen readers and logs get plain text. These are verified in the test plan. |
| Localization | See Arabic/RTL. |
| Availability, scale, web runtime, recoverability | N/A for a client. |

## Arabic / RTL

- **In scope for Phase 0:**
  - Arabic input and output are preserved as UTF-8 with no corruption (AC-12). This pulls forward a small, cheap part of REQ-002(e), which is Phase 1, because an Arabic-market CLI that corrupts Arabic would be a visible defect.
- **Deferred:**
  - Visual bidi reordering depends on the user's terminal emulator. Terminal-specific rendering guidance and the bidi golden set for CLI are REQ-107 (F-017, F-021).
  - Arabic translations of CLI messages are deferred to F-017. Phase 0 CLI messages are English (OQ-F005-2).
  - The Arabic-reply language rule is REQ-107(b), Phase 1.

## Out of scope

- Commands beyond `/login`, `/logout`, `/new`, `/exit` and chat. In particular `/models` (the model is fixed in Phase 0), `/usage`, `/approve`, `/skills`, `/memory`, `/connections`, `/compact` and `/profile` are REQ-002, F-017.
- Non-interactive / CI mode and the Automation subscription check (REQ-002(d), F-017, F-013).
- Session resume across CLI restarts and handoff (REQ-012, REQ-009).
- Approval prompts in the CLI (F-010, F-017).
- Desktop and Web surfaces (F-015, F-016).
- CLI distribution channel, code signing and auto-update mechanics. These are for the architect and release manager, and are recorded as design inputs.

## Dependencies

| Type | Item |
|---|---|
| Other features | **Upstream (all required for the ACs):** F-001 (CI, secret scan), F-002 (device-code sign-in, refresh, sign-out, access group), F-003 (local Agent Host and protocol), F-004 (Model Gateway, audit per call). **Downstream:** F-017 CLI v1 (Phase 1). F-005 is the last Phase 0 feature to complete and the Phase 0 exit demo. |
| Architecture (G3) | How the CLI launches or pairs with the local host (F-003 AC-7). Where tokens are protected on each OS. |
| External | IdP test tenant (F-002). Provider account (F-004). Test machines for the three platforms in AC-13. |
| Process | Brief-level G2 approval, then G3, then `/design F-005` (G4). |

## Success metrics

| Metric | Target | Measured by |
|---|---|---|
| Phase 0 exit demo: new internal developer goes from install to first streamed reply | ≤ 10 min median across ≥ 5 developers *(proposed)* | Timed Phase 0 exit session |
| REQ-001 criteria (a)–(e) passing | 5 of 5 | Test report (G6) |
| CLI-originated model calls with an audit event | 100 % | AC-6 |
| Secrets or plaintext tokens found on client | 0 | AC-5 |

## Open questions

| # | Question | Recommendation | Owner |
|---|---|---|---|
| OQ-F005-1 | Supported platforms for CLI v0. | macOS 13+, Windows 10/11 and Ubuntu 22.04 LTS, matching REQ-003's desktop OS range plus the most common developer Linux. Confirm at G4. | Product owner |
| OQ-F005-2 | Should CLI messages already go through i18n keys with Arabic translations? | Put the strings behind keys now (low cost, avoids a Phase 1 rewrite). Ship English only in Phase 0, and add Arabic translations with F-017 and F-021. | Product owner |
| OQ-F005-3 | Should the CLI keep a local transcript in Phase 0? | No. Keep the transcript in memory for the session only. Persisted and resumable sessions arrive with REQ-012 (`session.resume`) and follow the retention decision (PRD OQ-16). | Product owner + CISO advisor |
| OQ-F005-4 | `/logout` and `/new` are not named in REQ-001 or spec §6.1.4. | Include both. `/logout` is needed for shared machines (least privilege, spec §8). `/new` resets context. Add both to the REQ-002 command list in the next PRD revision. | Product owner |
| OQ-F005-5 | The timing values (≤ 200 ms render, 15 min token life, ≤ 10 min time to first reply) are *(proposed)*. | Confirm at G4 (G2 condition). | Tech lead |

**G2 approval conditions (2026-09-25) and how they affect this feature:**
- *(Proposed)* numeric targets are confirmed at design: applies to AC-3, AC-8, AC-10, AC-13 and the success metric.
- Onboarding/training REQ (to be added in the next PRD revision): the CLI v0 audience is internal developers, so no in-product onboarding is planned. Clear `/login` guidance (AC-2) and `--help` text are the Phase 0 minimum.
- Phase 1 re-estimate: REQ-002 non-interactive mode is a named Phase 1 deferral candidate (PRD OQ-3). This brief doesn't depend on that.
- REQ-090 and DV-16: not applicable.

Scope derived from PRD approved at G2 (2026-09-25); brief-level approval pending.

## Approval (G2)

> Filled by a human only. Agents must leave this blank.

| Approver | Role | Decision (Approved / Changes requested) | Date | Notes |
|---|---|---|---|---|
| | | | | |
