# F-003: Local Agent Host and Agent Protocol core: Feature Brief

> Phase 2 · Owner: product-manager · Release phase: **0 (Foundations)** · Source: [PRD](../../product/prd.md) (G2 approved 2026-09-25 with conditions), [roadmap](../../product/roadmap.md), spec §4 D2/D8, §5.1, §6.2.1, §6.2.2, §8, §12, §13 Phase 0
> MoSCoW: Must (REQ-010, REQ-011) · RICE 8.0 (R 10 · I 3 · C 80 % · E 3)

## Problem

Every Ralysa surface needs one agent that plans, calls tools and streams answers. That agent must not become a back door around governance. If the agent loop holds provider keys, talks to model providers directly, or exposes an unauthenticated local endpoint, then SSO, audit and residency can all be bypassed from the user's own machine.

The three surfaces also have to share one typed contract (spec §4 D8). Otherwise CLI, Desktop and Web drift apart, and the agent engine can't be swapped if the Claude Agent SDK terms change (spec §14; MA-109).

F-003 delivers two things:
- the **local-mode Agent Host**, which the CLI uses now and Desktop uses in Phase 1, built on the Claude Agent SDK per spec constraint D2
- the **core of the versioned Agent Protocol**

All model traffic goes through the Model Gateway. Every tool call is audited. Side-effecting tools are off unless server-side configuration turns them on.

## Personas & surfaces

| Persona | Need |
|---|---|
| DEV (Phase 0 user) | A local agent that can chat, read local files in the working folder and, where allowed, write files or run commands. |
| PA | Assurance that no local component holds provider credentials or reaches providers directly, and that file-write and terminal are controlled server-side. |
| ASR (indirect) | Every tool call attributable and audited from Phase 0. |

**Surfaces:** Service (local Agent Host process) serving the CLI in Phase 0 (F-005) and Desktop in Phase 1 (F-015). The server-side Web host is F-016, Phase 1.

## Requirements covered

| REQ | Phase 0 scope in this feature | Deferred |
|---|---|---|
| REQ-010 Local Agent Host on the Claude Agent SDK; no provider keys; model calls via the Model Gateway, external tools via the MCP/Data Gateway (Must, Phase 0) | Criteria (a)–(d) in local mode. Built-in local tools: file read and list, file write, terminal. Tool on/off setting delivered server-side. | External (MCP) tools through the MCP/Data Gateway: **F-009** (Phase 1). Hooks and approvals on file edits and terminal: **F-010**. Hidden-tool policy from the policy engine: **F-006**. Skills, memory, compaction and subagents: F-019, F-020, F-030. |
| REQ-011 Versioned typed Agent Protocol with `session.create`, `session.send`, `session.cancel`, `message.delta`, `tool.started`, `tool.completed` (Must, Phase 0) | Criteria (a), (c) and (d) here. Criterion (b), "the CLI talks to the host only through the protocol", is verified jointly with **F-005** (AC-7 there). | `session.resume`, `approval.respond`, `skill.invoke`, `session.compact`, other events, version negotiation and conformance suite: REQ-012, **F-017** (Phase 1). Engine-swap proof: REQ-015, F-017. |

## User stories

- As a developer, I want the agent to answer and stream its reply while it works so that I see progress, not a frozen terminal.
- As a developer, I want to stop the agent mid-turn and get control back within 2 seconds so that a wrong turn costs nothing.
- As a developer, I want the agent to read files in my working folder, and only there, so that it can help with my project without reaching the rest of my machine.
- As a platform admin, I want file-write and terminal tools turned off unless the server enables them so that no side-effecting local action happens before approvals exist (F-010).
- As a platform admin, I want the local host to hold no provider keys and never talk to a model provider directly so that SSO, audit and residency can't be bypassed.
- As an assurance user, I want every tool call recorded with who, what, when and the outcome so that local agent activity is as auditable as server activity.
- As a surface developer (CLI now, Desktop and Web later), I want a published, versioned protocol schema so that every surface speaks to the host the same way.

## Acceptance criteria

The **scripted session** is a repeatable test session of ≥ 10 turns. It includes at least one file-read tool call, one cancelled turn, one Arabic prompt and, where enabled, one file-write and one terminal call.

| ID | Given | When | Then |
|---|---|---|---|
| AC-1 | The scripted session running with network capture | The capture is analysed | There are **0** connections from the host to model-provider endpoints (Anthropic, Google Vertex AI, AWS Bedrock, Azure OpenAI/Foundry, OpenAI domains). All model traffic goes to the configured Ralysa Model Gateway (F-004). (REQ-010(a)) |
| AC-2 | The host install directory, configuration files, environment and memory-dumped process strings after the scripted session | A credential scan runs | Provider-credential findings = **0**. The only credential the host holds is the signed-in user's Ralysa token, obtained from F-002. (REQ-010(b)) |
| AC-3 | The Model Gateway is unreachable | A user sends a message | Within ≤ 10 s *(proposed)* the host returns an error naming the gateway as unavailable. No model call is made to any other endpoint (capture). When the gateway is reachable again, the next message in the same session succeeds. (REQ-010(c)) |
| AC-4 | The server-side setting for the user's organization has file-write **off** and terminal **off** (the Phase 0 default) | A session is created and the user asks the agent to write a file or run a command | Those tools are absent from the tool list sent to the model (visible in the gateway request capture). The agent replies that the capability is not available. The filesystem diff of the working folder is empty and no process is spawned. (REQ-010(d)) |
| AC-5 | The same server-side setting switched to file-write **on** and terminal **on** | The same requests are made in a new session | The file is written and the command runs, each as a tool call with `tool.started` and `tool.completed`. When the setting is switched back off, the tools are gone at the next `session.create`. Editing local host configuration files does **not** enable a tool that the server setting has off. (REQ-010(d)) |
| AC-6 | A session started in folder X | The agent (or a crafted prompt) tries to read or write a path outside X, including `..` traversal, absolute paths and symlinks that resolve outside X | The tool refuses. The refusal is returned as a tool result, audited with `outcome=denied`, and no byte outside X is read or written. |
| AC-7 | The host is running | A connection to its protocol endpoint is attempted from another machine, or from the same machine without the per-session client credential | The connection is refused and the attempt is logged locally. Only the client that launched or paired with the host can connect. |
| AC-8 | The Agent Protocol schema in `packages/protocol` | A reviewer inspects the published package | The schema is machine-readable and carries a semantic version number. Every message declares the protocol version. CI validates host and CLI messages against the schema. (REQ-011(a)) |
| AC-9 | A test client that uses only the published schema | It calls `session.create`, then `session.send` with a prompt that triggers a file read | It receives `message.delta` events in order, a `tool.started` then `tool.completed` pair with matching ids, and a turn-completion signal. A message that violates the schema is rejected with a structured error and does not crash the session. (REQ-011) |
| AC-10 | A turn that is streaming text, or running a tool (including a long-running terminal command where enabled) | The client sends `session.cancel` | Emission of `message.delta` stops and the running tool is terminated **≤ 2 s** after the cancel is received, in 20 of 20 trials. The session then accepts a new `session.send`. (REQ-011(c)) |
| AC-11 | A server-provided redaction rule, where the Phase 0 default redacts values matching credential/token patterns, plus a test rule for one named field | A tool result contains matching values | The `tool.completed` payload leaving the host carries a redaction marker in place of each matching value. The raw value is absent from the protocol capture. (REQ-011(d)) |
| AC-12 | Any tool call (read, list, write, terminal; allowed or denied) | It executes or is refused | An audit event is written to the control plane (F-002) with user, `session_id`, tool name, outcome (`success` / `error` / `denied` / `cancelled`), duration and `trace_id`. It contains **no file contents, command output or argument values** (Phase 0 metadata-only). Tool-call count equals audit-event count across the scripted session. (Spec §12 Observability; §8 Audit) |
| AC-13 | The audit service is unreachable | The agent attempts a tool call | The tool does not execute. The user is told that audit is unavailable, and the turn ends with an error. (Fail-closed audit, pulled forward from REQ-071(c) so AC-12's 100 % holds) |
| AC-14 | A host with no valid Ralysa session token, or with a token rejected by F-002 validation | `session.create` or `session.send` is called | The request is refused with an authentication-required error and no model or tool call is made. Every model call the host makes carries the signed-in user's identity, so the gateway attributes it to that user. |
| AC-15 | An Arabic prompt and a UTF-8 file containing Arabic and mixed Arabic/English text | They pass through the protocol and a file-read tool | The text arrives byte-identical at the gateway (capture) and in the client (`message.delta`, `tool.completed`), with 0 replacement characters. |

## Governance

- **Access (SSO groups / policy):** The host runs only for a user with a valid Ralysa token (AC-14), which carries the F-002 access-group decision. Tool availability (file-write, terminal) and redaction rules come from **server-side settings** (AC-4, AC-5, AC-11), not local config. The model and gateway decisions stay server-side in F-004. The full policy engine, profiles and hidden-tool rules come in F-006 (REQ-019 to REQ-022).
- **Approvals required:** File-write and terminal are side-effecting and the approval system (F-010, REQ-059 to REQ-062) doesn't exist in Phase 0. So they are **off by default** and may be turned on only in internal engineering test organizations (OQ-F003-2). When F-010 ships, these tools must pass through hooks and approvals before any customer environment enables them.
- **Audit events:** `tool.call` (success / error / denied / cancelled), `session.create`, `session.cancel` and `host.connection_refused` (local log only). Model-call audit is written by the gateway (F-004), not the host, so each model call is audited exactly once.
- **PII / data classification / residency:**
  - Audit is metadata-only: no file contents, command output or arguments (AC-12).
  - Tool results sent to the model are redacted per server rule (AC-11). Full PII masking before model calls is REQ-029, F-008 (Phase 1).
  - Local file content is **untrusted input**. Phase 0 limits the blast radius with: working-folder scope (AC-6), side-effect tools off by default (AC-4), and no external tools. Injection defence hooks are REQ-063 (F-010).
  - Residency: the host sends model traffic only to the configured gateway (AC-1). Inference region is enforced and recorded in F-004.
  - Phase 0 uses internal and synthetic data only.

## Non-functional (spec §12)

| §12 category | Phase 0 target |
|---|---|
| Latency | Cancel ≤ 2 s (AC-10; PRD NFR table). The host adds ≤ 50 ms p95 between receiving a gateway token and emitting `message.delta` *(proposed)*. First-token time is otherwise dominated by the model (§12). |
| Security (§8) | AC-1, AC-2, AC-6, AC-7, AC-13, AC-14. |
| Observability | 100 % of tool calls audited and traced (AC-12). |
| Extensibility | The protocol is versioned (AC-8). New tools come later by registration (MCP, F-009). |
| Availability, scale, web runtime, recoverability | N/A for a single-user local process in Phase 0. |
| Accessibility, localization | See Arabic/RTL. |

## Arabic / RTL

- The host has no UI. Arabic text must pass through prompts, file reads, protocol events and tool results byte-identical (AC-15).
- Visual RTL and bidi rendering are handled by the surfaces: F-005 for the CLI (terminal-limited), and F-015, F-016 and F-021 for GUI.
- The rule "the agent replies in the user's language" is REQ-107(b), F-021 (Phase 1).

## Out of scope

- Server-side Web Agent Host and isolation (REQ-013, F-016). Web sandbox (REQ-014, F-024).
- External/MCP tools and connectors (F-009, F-022).
- Hooks, approval cards and `approval.required` / `approval.respond` (F-010, F-017).
- Skills, memory, compaction, subagents and deferred tool loading (F-019, F-020, F-030).
- Full protocol method and event set, version negotiation, conformance suite and engine-swap proof (REQ-012, REQ-015, F-017).
- Protection against a user who modifies the host binary itself. The residual risk is recorded here. Server-side controls at the gateways (F-004 now; F-006 and F-009 in Phase 1) are the enforcement point.
- Technology choices beyond the spec constraint D2 (transport, packaging, local endpoint mechanism): architect and solution designer.

## Dependencies

| Type | Item |
|---|---|
| Other features | **Upstream:** F-001 (CI, secret scan), F-002 (token validation, audit store, server-side settings for tool on/off and redaction), F-004 (Model Gateway: AC-1, AC-3 and AC-14 need it; development can start against a gateway stub). **Downstream:** F-005 (CLI uses the host through the protocol), F-015 (Desktop, Phase 1), F-017 (Protocol v1). |
| Architecture (G3) | ADRs on host packaging and lifecycle, the local endpoint security model, protocol schema format and versioning, and where the server-side tool settings live until F-006. |
| External / commercial | **PRD OQ-4 (Anthropic commercial terms for embedding the Agent SDK, spec §15 Q4) must be answered before Phase 0 build starts** (PRD recommendation). This is a blocking dependency for starting F-003 development. |
| Process | Brief-level G2 approval, then G3, then `/design F-003` (G4). |

## Success metrics

| Metric | Target | Measured by |
|---|---|---|
| Direct host→provider connections | 0 | AC-1 capture at Phase 0 exit |
| Provider credentials on the client | 0 findings | AC-2 scan |
| Tool calls with an audit event | 100 % | AC-12 reconciliation |
| Cancel latency | ≤ 2 s in 20/20 trials | AC-10 |
| Out-of-folder file access attempts that succeed | 0 | AC-6 test set (≥ 15 traversal cases) |

## Open questions

| # | Question | Recommendation | Owner |
|---|---|---|---|
| OQ-F003-1 | Anthropic commercial terms for embedding the Claude Agent SDK in a resold product (PRD OQ-4). | Get the answer before F-003 development starts. Either way, keep the protocol free of engine-vendor types (see OQ-F003-3) so REQ-015 stays cheap. | Founder |
| OQ-F003-2 | Should file-write and terminal be available at all in Phase 0, given approvals arrive in F-010? | Yes, but **off by default** and enabled only in internal engineering test organizations, so REQ-010(d) can be proven. Never enabled for a customer or pilot environment until F-010 hooks and approvals are in place. | Product owner |
| OQ-F003-3 | Should the Phase 0 schema already avoid engine-vendor-specific types (REQ-015(a), Should, Phase 1)? | Yes. It costs little now and removes a Phase 1 deferral candidate (PRD OQ-3). | Architect |
| OQ-F003-4 | How much tool-call detail goes into audit in Phase 0? | Metadata only (tool name, outcome, duration, ids). Argument and content capture follows the retention-per-tier decision (PRD OQ-16) in F-011. | Product owner + CISO advisor |
| OQ-F003-5 | The gateway-unreachable error time (≤ 10 s) and host streaming overhead (≤ 50 ms p95) are *(proposed)*. | Confirm at G4 (G2 condition). | Tech lead |

**G2 approval conditions (2026-09-25) and how they affect this feature:**
- *(Proposed)* numeric targets are confirmed at design: applies to AC-3 and the latency target.
- Phase 1 re-estimate: REQ-015 is a Phase 1 deferral candidate. OQ-F003-3 keeps that deferral low-risk.
- DV-16 (Phase 1 Web = Chat only) concerns the server-side host in F-016, not this local host. Not applicable here.
- REQ-090 and the onboarding REQ: not applicable.

Scope derived from PRD approved at G2 (2026-09-25); brief-level approval pending.

## Approval (G2)

> Filled by a human only. Agents must leave this blank.

| Approver | Role | Decision (Approved / Changes requested) | Date | Notes |
|---|---|---|---|---|
| | | | | |
