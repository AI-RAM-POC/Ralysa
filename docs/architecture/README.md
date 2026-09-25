# Architecture (ADLC phase 3)

Created by `/architecture`. Every ADR is **Proposed** until a human approves it at gate G3.

## Reading order

1. [overview.md](overview.md): drivers, C4 context and containers, where each non-negotiable is enforced, risk ER-1, NFR budget, document and ADR index.
2. [security.md](security.md): threat model (TM-nn) and the security requirements (SR-nn) every design must meet.
3. [identity-and-policy.md](identity-and-policy.md): sign-in per surface, tokens, the policy decision model, and the **canonical fail-closed table** (§5.6).
4. [agent-protocol.md](agent-protocol.md): the surface ↔ Agent Host contract and the engine boundary.
5. [model-gateway.md](model-gateway.md) and [mcp-gateway.md](mcp-gateway.md): the two enforcement points for model and tool calls.
6. [observability-audit.md](observability-audit.md): the **canonical audit envelope** and two-phase audit rule (§3), tamper evidence, metering, kill-switch.
7. [data-model.md](data-model.md), [workspace-runtime.md](workspace-runtime.md), [deployment.md](deployment.md).
8. [adr/README.md](adr/README.md): the decisions, one line each.
9. [consistency-review.md](consistency-review.md): what was reconciled across streams before G3, SR traceability, brief changes proposed at G4, and the consolidated open questions (including those that block Phase 0 build).

For the Phase 0 features (F-001 to F-005), read overview → identity-and-policy §3–§5 → agent-protocol → model-gateway §1–§5 → observability-audit §3–§4 → ADR-0001, 0002, 0004, 0005, 0010, 0012, 0014, 0021, 0022 → consistency-review §4–§5.
