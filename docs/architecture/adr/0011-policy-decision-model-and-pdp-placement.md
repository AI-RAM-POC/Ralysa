# ADR-0011: Policy decision model and embedded PDPs with signed policy bundles

- **Status:** Accepted
- **Date:** 2026-09-25
- **Deciders:** Tech lead (G3 approver); proposed by architect
- **Related:** spec §4 D3/D13, §6.4.2–6.4.5, §6.15.5, §12 · REQ-019, REQ-020, REQ-021, REQ-023, REQ-027, REQ-034, REQ-060, REQ-061, REQ-064, REQ-078, REQ-110 · DV-19 · [identity-and-policy.md](../identity-and-policy.md) · Engine: [ADR-0002](0002-policy-engine-cedar.md) proposes Cedar and implements this model in its Decision 2a · Kill-switch: [ADR-0025](0025-kill-switch-enforcement.md) · Fail-closed rules: [identity-and-policy.md §5.6](../identity-and-policy.md#56-governance-state-freshness-and-fail-closed-rules-canonical)

## Context & forces

- Policy is enforced at every gateway and at the server-side Agent Host (D3), on every model and tool call. Gateway overhead budget is p95 < 100 ms in total (§12), so the policy decision must be a few milliseconds.
- Gateways must keep working during a short Control Plane outage, but must fail closed when policy is unknown or too stale.
- Propagation of policy, entitlement and grant changes ≤ 60 s (REQ-021b, REQ-078a, REQ-023c).
- Semantics needed: multi-profile merge with deny overrides allow (REQ-019a); guardrails nobody can lift (never-automated classes REQ-061, T3 non-local default deny REQ-028, C4 only air-gapped REQ-094d, pack tier floors REQ-083b); time-boxed grants that can lift ordinary denies (REQ-023); obligations such as masking, row limits and approver chains.
- The engine (OPA/Rego or Cedar) is decided by stream A (ADR-0002 proposes Cedar); this decision must hold for both.
- Deployments include air-gapped on-prem with HA (§9); fewer moving parts is better for a small team.

## Options considered

| Criterion | A. Central PDP service (network call per decision) | B. Embedded PDP per PEP with signed bundles (chosen) | C. Decisions precomputed into tokens (claims-based) |
|---|---|---|---|
| Decision latency | 2–10 ms network + queueing; tail latency risk under load | Sub-ms to few ms in process | Zero at runtime |
| Availability coupling | Every call depends on PDP service | Works on last good bundle; fail closed past staleness budget | Works until token expiry |
| Propagation ≤ 60 s | Immediate | Push/pull delta, ≤ 60 s achievable | Only at token refresh (15 min): fails REQ-078a |
| Rich context (tables, labels, session tier) | Yes | Yes | No (too large, unknown at issuance) |
| Engine neutrality | Yes | Yes (OPA supports bundles and embedding; Cedar is a library evaluated in process) | n/a |
| Ops cost | One more HA service | Bundle build/sign/distribute pipeline; library in each service | Lowest |
| Audit of decisions | Central | Each PEP emits decision events with `policy_version` | Weak |

## Decision

**Option B**, with this decision model:

1. **Effects:** `allow`, `deny` (overridable only by an approved grant), `mandatory_deny` (never overridable; built-in guardrails plus platform-admin authored), `require_approval` (allow with an approval obligation).
2. **Evaluation order at every PEP:** token → kill-switch → entitlement → `mandatory_deny` → `deny` (unless an active grant covers it) → grant allow → profile allow → default deny; obligations merged strictest-wins.
3. **Output contract:** `{decision, obligations, reasons[], contributing_profiles[], policy_version, grant_id?}`; input schema `principal/action/resource/context` usable as OPA `input` or Cedar entities.
4. **Placement:** each PEP (Control Plane API, server Agent Host, Model Gateway, MCP Gateway, runtime egress) embeds the PDP as a library or local sidecar and evaluates a **signed bundle** (policy + reference data + grants + revocations + kill-switch state). The Control Plane builds, signs and versions bundles and pushes change notifications; PEPs pull deltas. Grants are also checked against `expires_at` at evaluation time.
5. **Staleness:** rules G-1 and G-2 of the canonical table in [identity-and-policy.md §5.6](../identity-and-policy.md#56-governance-state-freshness-and-fail-closed-rules-canonical). In short: the governance heartbeat (kill-switch, revocations, latest policy version; ADR-0025) must be confirmed within 60 s or the PEP refuses everything; a bundle more than 60 s behind the announced version denies T2/T3 and all writes, and more than 5 min *(proposed)* behind denies everything. This replaces the first draft's single "5 min → deny T2/T3 and writes" budget, which conflicted with ADR-0025's 60 s rule and with REQ-021b's 60 s propagation target. The kill-switch state in the bundle is a second copy; the heartbeat is authoritative for freshness.
6. The Control Plane also exposes a decision API used by the local Agent Host for local-only tools and by the effective-permission viewer.

Engine mapping (so the model holds for either engine; ADR-0002 proposes Cedar):

- **Cedar:** any matching `forbid` always overrides `permit`, and the default is deny, so a grant can't be a `permit` that lifts a deny. So `mandatory_deny` = `forbid` with no grant clause; ordinary `deny` = `forbid ... unless { context.active_grants.contains(<this action/resource>) }`; grants arrive as context/entity data, not as `permit` policies. [ADR-0002 Decision 2a](0002-policy-engine-cedar.md) adopts exactly this mapping, including how determining policies become reason codes.
- **OPA/Rego:** combining logic is written explicitly in a Ralysa base policy (`mandatory_deny` → `deny` unless grant → `allow` → default deny). Grants, revocations and kill-switch state are **data**, which suits OPA delta bundles; OPA delta bundles update data only, not policies, so policy text changes ship as full bundles.

## Consequences

- Positive: meets latency budget; survives short Control Plane outages; one semantics across all PEPs; decision events carry the exact policy version for the evidence pack (REQ-070); works air-gapped.
- Negative / risks: bundle size grows with users × grants (mitigate: partition reference data per tenant, deltas); version skew between PEPs for up to 60 s (acceptable per REQ-021b); signing-key management; two engines would need two validators if we later switch away from the ADR-0002 choice.
- What would make us revisit: bundles exceed ~50 MB per tenant or delta propagation cannot meet 60 s at 5,000 users; the chosen engine cannot express `mandatory_deny` vs `deny` cleanly; a regulator requires a single central decision log point.

## References

All accessed 2026-09-25.

- OPA bundles (distribution, signing, delta bundles for data only): https://www.openpolicyagent.org/docs/latest/management-bundles/
- Cedar policy syntax (forbid overrides permit, implicit deny): https://docs.cedarpolicy.com/policies/syntax-policy.html
- Spec §6.4.2 authorization model and §6.4.4 example policy (requirements/Ralysa_Spec.md)

## Approval (G3)

> Filled by a human only. Agents must leave this blank.

| Approver | Role | Decision (Approved / Changes requested) | Date | Notes |
|---|---|---|---|---|
| Ram Mohan Rao Adduri | Founder / Product owner (acting tech lead) | Approved | 2026-09-25 | Approval given in chat ("accept all"); recorded by Claude on the approver's instruction. |
