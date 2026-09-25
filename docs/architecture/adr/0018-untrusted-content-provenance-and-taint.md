# ADR-0018: Untrusted tool and document content: provenance envelope, spotlighting and session taint rule

- **Status:** Accepted
- **Date:** 2026-09-25
- **Deciders:** Tech lead (G3 approver); proposed by architect
- **Related:** spec §6.7.3, §6.12, §8 Prompt injection, §14 (High risk) · REQ-040d, REQ-042e, REQ-059, REQ-060, REQ-063 · [mcp-gateway.md](../mcp-gateway.md) §5 · [agent-protocol.md](../agent-protocol.md) §3.4

## Context & forces

- Email, documents, web pages and DB fields can carry injected instructions (§14 High; OWASP LLM01). Target: 0 side effects without approval on a ≥ 100-sample Arabic/English red-team set; ≥ 90 % flagged (REQ-063).
- No detector is perfect, so safety cannot rely on detection alone; controls must limit what a successful injection can do.
- MCP tool annotations (e.g. `readOnlyHint`, `destructiveHint`) are untrusted unless the server is trusted.
- Must work with local models (T3, air-gapped), so no cloud-only guard service.
- Must not make ordinary read/summarize work painful (§6.12.2: reads and drafts are auto).

## Options considered

| Criterion | A. Detection only (classifier blocks suspicious content) | B. Provenance + spotlighting + taint-escalated approvals + detection as a flag (chosen) | C. Dual-LLM / quarantined planner (untrusted content only seen by a tool-less model) |
|---|---|---|---|
| Guarantees on side effects | None (misses pass) | Strong: external side effects need approval in tainted sessions | Strong |
| User friction | Low, but false positives block work | Moderate: approvals only for side effects after untrusted content | Low for users, high for design |
| Works with local models | Yes | Yes | Yes, but doubles model calls |
| Engineering effort | Low | Medium | High; changes agent loop semantics, hard with the SDK harness |
| Explainability for approvers | Low | Approval card lists untrusted sources in context | Medium |
| Coverage of exfiltration via URLs/images | No | Yes (egress allowlists, no auto-loading, approval for URLs from untrusted content in T2/T3) | Partial |

## Decision

**Option B**, with Option C kept as a future hardening for high-risk packs.

1. Every tool/document result carries a provenance envelope (`trust: untrusted`, source, tier, labels) and is placed in model context inside explicit data delimiters, never in the system prompt.
2. An injection scanner (rules + local classifier, Arabic and English) flags content; flags are shown and audited but never grant anything.
3. **Taint rule:** after a session consumes untrusted content, every external side-effect class (send, publish, external share, business-system write, delete/move, deploy/config) requires approval regardless of policy auto settings; the approval card shows the untrusted sources.
4. Operation classes come from the admin-reviewed registry, not from server annotations.
5. Egress: URL-taking tools use allowlists; URLs first seen in untrusted content need approval in T2/T3; surfaces do not auto-load remote content from model output.

## Consequences

- Positive: bounded blast radius even when detection fails; works everywhere including air-gapped; clear audit story for regulators.
- Negative / risks: more approvals in mail-heavy workflows (monitor approval fatigue; batch approvals UX); scanner quality in Arabic needs its own golden set; nearly every real session will be tainted, so the rule effectively makes external side effects always approval-gated (which matches §6.12.2 defaults).
- What would make us revisit: approval fatigue measurably reduces approval quality (e.g. median review time < 2 s); a proven, locally deployable isolation pattern (Option C) becomes available in the engine; red-team results show exfiltration paths not covered.

## References

All accessed 2026-09-25.

- OWASP LLM01:2025 Prompt Injection: https://genai.owasp.org/llmrisk/llm01-prompt-injection/
- MCP tools (annotations untrusted, validate results): https://modelcontextprotocol.io/specification/2025-11-25/server/tools
- MCP security best practices: https://modelcontextprotocol.io/specification/2025-11-25/basic/security_best_practices

## Approval (G3)

> Filled by a human only. Agents must leave this blank.

| Approver | Role | Decision (Approved / Changes requested) | Date | Notes |
|---|---|---|---|---|
| Ram Mohan Rao Adduri | Founder / Product owner (acting tech lead) | Approved | 2026-09-25 | Approval given in chat ("accept all"); recorded by Claude on the approver's instruction. |
