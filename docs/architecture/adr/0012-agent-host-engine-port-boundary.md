# ADR-0012: Agent Host engine port and adapter boundary; engine-neutral protocol contract; governance outside the engine

- **Status:** Accepted
- **Date:** 2026-09-25
- **Deciders:** Tech lead (G3 approver); proposed by architect
- **Related:** spec §4 D2/D8, §6.2, §10.3, §14 (SDK dependency) · REQ-010, REQ-011, REQ-012, REQ-015, REQ-022, REQ-059 · OQ-4 · F-003 · [agent-protocol.md](../agent-protocol.md) · Transport and schema rule: [ADR-0004](0004-agent-protocol-transport-and-schema.md) · Language: [ADR-0001](0001-services-language-typescript.md)

## Context & forces

- The Agent Host is built on the Claude Agent SDK (D2), but the spec lists dependency on the SDK and vendor terms as a risk and requires the engine to stay swappable behind the Agent Protocol (§14, REQ-015). Anthropic commercial terms for embedding the SDK are still open (OQ-4).
- T3 packs need local non-Claude models; Anthropic does not support routing its agent harness to non-Claude models through any gateway ([Claude Code, other LLM gateways](https://code.claude.com/docs/en/llm-gateway)). This is risk **ER-1** ([overview.md §4.1](../overview.md#41-non-negotiables-where-each-is-enforced)). A second engine may be needed later.
- Governance (policy, approvals, audit, masking, untrusted-content handling) must be identical on all surfaces and must not break when the SDK changes defaults.
- The SDK loads hooks and permission rules from settings files by default, and its permission modes include a bypass mode.
- One small team; TypeScript is preferred for sharing types across UI, CLI and host (§6.2.1); ADR-0001 proposes TypeScript for all Ralysa-owned services.

## Options considered

| Criterion | A. Use SDK types in the protocol and wire governance through SDK settings | B. Ralysa engine port + adapter; governance layer outside the engine; JSON Schema protocol (chosen) | C. Build our own agent loop now |
|---|---|---|---|
| Engine swappability (REQ-015) | Poor: SDK types leak to all surfaces | Good: only `engine/claude/**` imports the SDK | Full, but we own everything |
| Time to Phase 0 | Fastest | +1–2 weeks for the port and mock engine | Much slower; rebuilds the hardest layer (D2 rationale) |
| Governance robustness to SDK changes | Fragile (defaults, settings files) | Governance in Ralysa code; SDK hooks are only interception points; adapter tests assert SDK settings | Robust |
| Capability (compaction, subagents, skills, tool search) | Full | Full, via adapter | Must rebuild |
| Non-TS hosts or clients later | Hard | Published JSON Schema contract (ADR-0004) allows generated types in any language | Possible |
| Conformance testing | Hard to mock | Mock engine behind the port runs the same suite | Possible |

## Decision

**Option B.**

1. `packages/protocol` holds the Agent Protocol. The rule is stated once, in [ADR-0004](0004-agent-protocol-transport-and-schema.md) decision 5: the **published JSON Schema 2020-12 is the normative, language-neutral wire contract**, authored in zod and generated from it, with TypeScript types and validators from the same zod source; CI fails if the committed JSON Schema and zod drift. No engine or model-vendor types. CI rejects vendor names and engine imports in the schema.
2. `services/agent-host` is layered: protocol server → session manager → **governance layer** → **EnginePort** (Ralysa interface) → adapters. Only `services/agent-host/src/engine/claude/**` may import `@anthropic-ai/claude-agent-sdk` (lint + dependency check in CI).
3. Governance decisions are made by Ralysa code and by gateways. The adapter registers Ralysa callbacks as SDK `PreToolUse`/`PostToolUse`/session hooks, disables settings-file sources, never uses bypass permission mode, removes denied built-in tools by bare name, and routes all model traffic to the Model Gateway. Adapter unit tests assert these settings.
4. A mock engine behind the same port passes the protocol conformance suite; CLI, Desktop and Web run a scripted session against it (REQ-015b).
5. Session transcripts are persisted in a Ralysa format so another engine can take over a session from a summary.

## Consequences

- Positive: engine can be replaced without a client release; governance survives SDK upgrades; conformance testing is cheap; clear place to add a second engine for T3 local models if evals require it.
- Negative / risks: adapter must track SDK releases (new events, hook fields); some SDK features may not map 1:1 to the port and need port extensions; slight Phase 0 cost.
- ER-1 mitigation plan (same text in overview §4.1, ADR-0006, ADR-0014, ADR-0015): (1) REQ-030 eval gate per department through the real engine + translation path before any non-Claude model is enabled; (2) translation conformance tests in CI; (3) second-engine option: a Phase 2 spike of a second EnginePort adapter that speaks OpenAI-compatible APIs natively, with a go/no-go **before the RA pack (REQ-086) enables any T3 department**. This port is what makes (3) possible without a client release.
- What would make us revisit: Anthropic terms forbid embedding (switch engine sooner); the SDK gains first-class support for non-Claude models (reduces need for a second engine); the port becomes a lowest-common-denominator that blocks important SDK features.

## References

All accessed 2026-09-25.

- Claude Agent SDK hooks (events, settings sources, permissionDecision): https://code.claude.com/docs/en/agent-sdk/hooks
- Claude Agent SDK permissions (evaluation order, modes, bare-name deny removes tool): https://code.claude.com/docs/en/agent-sdk/permissions
- Claude Agent SDK custom tools (in-process MCP servers, tool naming): https://code.claude.com/docs/en/agent-sdk/custom-tools
- Claude Code, other LLM gateways (non-Claude routing unsupported): https://code.claude.com/docs/en/llm-gateway
- JSON Schema 2020-12: https://json-schema.org/draft/2020-12

## Approval (G3)

> Filled by a human only. Agents must leave this blank.

| Approver | Role | Decision (Approved / Changes requested) | Date | Notes |
|---|---|---|---|---|
| Ram Mohan Rao Adduri | Founder / Product owner (acting tech lead) | Approved | 2026-09-25 | Approval given in chat ("accept all"); recorded by Claude on the approver's instruction. |
