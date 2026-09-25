# ADR-0015: Residency routing as data: endpoint eligibility labels, session tier high-water mark, never-widen fallback

- **Status:** Accepted
- **Date:** 2026-09-25
- **Deciders:** Tech lead (G3 approver); proposed by architect
- **Related:** spec §6.5.3, §7.7, §8 Data residency, §9 · REQ-025, REQ-028, REQ-030, REQ-031, REQ-032, REQ-094 · DV-2, DV-12, DV-13, DV-18 · MA-302, MA-303, summary R-5(a)(c) · [model-gateway.md](../model-gateway.md) §4.2, §5

## Context & forces

- Inference location is the binding constraint in the Gulf (MA-302): few in-country frontier endpoints; Bedrock Middle East uses global cross-region inference; Azure regional OpenAI only in UAE North.
- T3 must default-deny non-local models; C4 only in air-gapped; mapping T1–T3 to Qatar C0–C4 now and NDMO later, editable without release (REQ-028c, REQ-094c).
- Fallback must never pick a less restricted region or tier (REQ-028e).
- The client cannot be trusted to declare how sensitive a conversation is; sensitivity can rise mid-session when a tool returns T3 data.
- Every audit/usage record needs the inference region (DV-12).

## Options considered

| Criterion | A. Per-profile model allowlists only (spec §6.4.4 `models.allowed` + `data_residency`) | B. Endpoint eligibility labels + tier HWM + routing function as policy data (chosen) | C. Hard-coded routing tables per deployment |
|---|---|---|---|
| Handles sensitivity rising mid-session | No (static per profile) | Yes (HWM raised by MCP Gateway and Control Plane) | No |
| New jurisdiction / classification scheme without release | Partly | Yes (mapping + labels are data) | No |
| Never-widen fallback provable | Hard | Yes (fallback chain filtered by residency rank ≤ primary) | Yes but rigid |
| Evidence pack (data-location schedule) | Manual | Generated from labels and records | Manual |
| Admin effort | Low | Medium (label each endpoint, verify regions) | Low per deploy, high overall |
| Risk of misconfiguration | Medium | Medium; mitigated by validation (e.g. `global` cannot have `max_tier` > T1 without exception) | Low flexibility |

## Decision

**Option B.** Each ModelEndpoint carries `locality` (local, in_country, in_region, global), `inference_regions`, `max_tier`, `max_classification`, `jurisdictions`, per-department `eval_status`, `routing_class` and `byom_scope`. The gateway computes the effective tier as max(session HWM, department tier, client hint), selects from the eligible set, and builds a fallback chain restricted to the same or stricter residency. T3 → non-local is a `mandatory_deny` unless an explicit, time-boxed, two-approver exception exists. Every audit and usage record carries `endpoint_region`, `inference_region` (the **processing geography** from the registry, with vendor evidence and a verification date, security SR-04) and, where observable, `inference_region_observed`; mismatches alert. Field definitions are in the canonical audit envelope ([observability-audit.md §3.1](../observability-audit.md)). Registry validation rejects `global`, cross-region and data-zone deployment types with `max_tier` above T1 unless an audited exception exists. If the session HWM store is unavailable, the gateway treats the session as T3 (rule G-4, [identity-and-policy.md §5.6](../identity-and-policy.md#56-governance-state-freshness-and-fail-closed-rules-canonical)).

**Local endpoints and risk ER-1.** A `local` endpoint makes T3 routing *possible*; whether a department may *use* it depends on its `eval_status`. Local models are non-Claude, and Anthropic does not support running its agent harness against them through a gateway ([Claude Code, other LLM gateways](https://code.claude.com/docs/en/llm-gateway)). Mitigation plan (same text in overview §4.1, ADR-0006, ADR-0012, ADR-0014): (1) REQ-030 eval gate per department through the real engine + translation path before any non-Claude model is enabled (the `eval_status` label); (2) translation conformance tests in CI; (3) second-engine option: a Phase 2 spike of a second EnginePort adapter that speaks OpenAI-compatible APIs natively, with a go/no-go **before the RA pack (REQ-086) enables any T3 department**. If no local endpoint passes for a T3 department, routing returns an empty set and the call is denied; residency is never widened to compensate.

## Consequences

- Positive: residency rules are explicit, testable data; mid-session escalation is handled; regulators get a generated data-location schedule; new countries are configuration.
- Negative / risks: HWM store (Redis) becomes a dependency (fail closed to T3 if unavailable for regulated tenants); users may see model changes mid-session (surfaced in UI); declared regions depend on admin diligence and vendor docs; T3 availability depends on ER-1 (a department with no eval-passed local model gets no T3 service).
- What would make us revisit: providers expose reliable per-request serving region (then verify instead of declare); customers need per-document rather than per-session sensitivity (move to per-message tagging).

## References

All accessed 2026-09-25.

- Microsoft Learn, Foundry model region availability (via regulation.md): https://learn.microsoft.com/en-us/azure/foundry/foundry-models/concepts/models-sold-directly-by-azure-region-availability
- AWS, Bedrock global cross-region inference for Claude in the Middle East (via regulation.md): https://aws.amazon.com/blogs/machine-learning/introducing-amazon-bedrock-global-cross-region-inference-for-anthropics-claude-models-in-the-middle-east-regions
- Google Cloud, Vertex AI data residency: https://docs.cloud.google.com/vertex-ai/generative-ai/docs/learn/data-residency
- docs/market/regulation.md (MA-302, MA-303, deployment-acceptance matrix)
- Claude Code, other LLM gateways (non-Claude routing unsupported): https://code.claude.com/docs/en/llm-gateway
- docs/architecture/security.md TM-08, TM-20, SR-02, SR-04

## Approval (G3)

> Filled by a human only. Agents must leave this blank.

| Approver | Role | Decision (Approved / Changes requested) | Date | Notes |
|---|---|---|---|---|
| Ram Mohan Rao Adduri | Founder / Product owner (acting tech lead) | Approved | 2026-09-25 | Approval given in chat ("accept all"); recorded by Claude on the approver's instruction. |
