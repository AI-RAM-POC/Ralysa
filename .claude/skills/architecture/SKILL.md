---
name: architecture
description: ADLC phase 3 - create or update Ralysa's system architecture (C4 views, cross-cutting topic docs, threat model) and ADRs for key decisions. Use for architecture work, technology choices, ADRs, or when a change affects multiple services.
argument-hint: "[optional: topic, e.g. 'identity-and-policy', 'ADR: OPA vs Cedar', or blank for full baseline]"
---

# Phase 3: Architecture

Topic: **$ARGUMENTS** (blank means build the full baseline).

1. Read `docs/adlc/README.md`, the spec (§4–§12), `docs/product/prd.md` if it exists, and all of `docs/architecture/`.
2. **Full baseline.** Launch in parallel:
   - **architect**: `overview.md` (C4 L1/L2 in Mermaid) plus ADRs for the spec's open technical questions: control-plane language, OPA vs Cedar, tenancy model, Agent Protocol transport, indexed search in v1
   - **architect**: topic docs for `identity-and-policy`, `agent-protocol`, `model-gateway`, `mcp-gateway`
   - **architect**: topic docs for `workspace-runtime`, `data-model`, `observability-audit`, `deployment`
   - **security-reviewer**: `docs/architecture/security.md`, the platform threat model
   **Single topic:** use one architect agent, plus the security-reviewer if the topic touches auth, gateways, connectors, sandboxes or audit.
3. **Verify consistency:**
   - service names match the `services/` folders
   - ADR numbers are unique and sequential
   - no topic doc contradicts an ADR
   - every NFR in spec §12 has an owner component
   - the security gaps are reflected as ADRs or backlog items
4. Report: the key decisions (as Proposed ADRs with the recommended option), the top risks and the open questions. Ask the tech lead to approve **G3** by setting the ADR status to `Accepted`.
