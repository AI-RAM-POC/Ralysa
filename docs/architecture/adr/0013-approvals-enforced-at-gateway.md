# ADR-0013: Approvals are enforced at the gateway with payload-bound, single-use grants

- **Status:** Accepted
- **Date:** 2026-09-25
- **Deciders:** Tech lead (G3 approver); proposed by architect
- **Related:** spec §4 D3, §6.1.3, §6.2.2 (`approval.required`, `approval.respond`), §6.12.2, §8 (prompt injection) · REQ-060, REQ-061, REQ-062, REQ-063, REQ-064 · [mcp-gateway.md](../mcp-gateway.md) §6 · [agent-protocol.md](../agent-protocol.md) §5.1

## Context & forces

- Side-effecting actions must pause until a named human approves (§6.12.2, REQ-062). The executed payload must match what was approved (REQ-062b); edits are re-checked (REQ-062c).
- On CLI and Desktop the Agent Host runs on a user-controlled machine and could be modified. Prompt injection is a High risk (§14): an injected instruction could try to make the host skip its own approval step.
- Approvals must work the same on every surface and survive session handoff (REQ-062, REQ-009).
- Kill-switch must freeze pending approvals (REQ-064a).

## Options considered

| Criterion | A. Host-only approvals (SDK `canUseTool` / hook asks the user) | B. Gateway-enforced approvals with grants (chosen) | C. Asynchronous job queue: gateway parks the call and executes it itself after approval |
|---|---|---|---|
| Resists a modified local host | No | Yes: gateway refuses side effects without a valid grant | Yes |
| Payload integrity (approved = executed) | Host-trusted | Hash of canonical payload verified at gateway | Stored payload executed |
| Works for local-only tools (terminal, file edit) | Yes | No (no gateway in path) → host-side approval stays for local tools | No |
| Latency and complexity | Lowest | One extra round trip after approval; grant signing | Needs durable job store, result delivery back into the turn |
| Fits agent loop | Natural | Natural (approval looks like a slow tool call, then retry) | Awkward (result arrives outside the tool call) |
| Scheduled / background agents (Phase 2+) | n/a | Grants expire; needs pre-approved runbooks | Natural fit |

## Decision

**Option B** for every tool that reaches an enterprise system through the MCP/Data Gateway (and any future side-effecting gateway). Option A remains only for local-only tools on Desktop/CLI, where the user's own machine is the only enforcement point, with decisions from the PDP decision API and audit posted before execution.

Mechanics: the gateway returns `approval_required` with `payload_hash = SHA-256(JCS(canonical call))`; the Control Plane stores the ApprovalRequest, routes it, and on approval issues a signed, single-use grant (≤ 10 min) bound to user, tool and payload hash; the host retries with the grant in `_meta`; the gateway verifies signature, expiry, nonce and hash and re-runs policy. Protected classes can be tightened but not loosened; "never automated" classes have no executing tool.

## Consequences

- Positive: approvals hold even if a local host or the model is compromised; one approval inbox across surfaces; strong audit (approver, time, hash).
- Negative / risks: extra round trip; grant-signing key management; long-running or scheduled agents need a separate pre-approval model (Option C revisited for Phase 2 automation).
- What would make us revisit: Phase 2 scheduled agents need approvals that outlive the session (adopt C for those); MCP adds a standard human-approval mechanism that gateways can verify.

## References

All accessed 2026-09-25.

- MCP tools, human in the loop and confirmation guidance: https://modelcontextprotocol.io/specification/2025-11-25/server/tools
- RFC 8785 JSON Canonicalization Scheme: https://www.rfc-editor.org/rfc/rfc8785
- OWASP LLM01:2025 Prompt Injection: https://genai.owasp.org/llmrisk/llm01-prompt-injection/
- Claude Agent SDK permissions (host-side approval path, `canUseTool`): https://code.claude.com/docs/en/agent-sdk/permissions

## Approval (G3)

> Filled by a human only. Agents must leave this blank.

| Approver | Role | Decision (Approved / Changes requested) | Date | Notes |
|---|---|---|---|---|
| Ram Mohan Rao Adduri | Founder / Product owner (acting tech lead) | Approved | 2026-09-25 | Approval given in chat ("accept all"); recorded by Claude on the approver's instruction. |
