# ADR-0025: Kill-switch enforced at the gateways by push + poll, fail closed on stale state

- **Status:** Accepted
- **Date:** 2026-09-25
- **Deciders:** Architect (proposal); Tech lead (G3)
- **Related:** REQ-064, REQ-070 (kill-switch tests in the evidence pack); DV-3; MA-305 (CBUAE AI guidance: ability to stop the service); F-012; `docs/architecture/observability-audit.md` §9; [ADR-0011](0011-policy-decision-model-and-pdp-placement.md) (signed bundles); canonical fail-closed table in [identity-and-policy.md §5.6](../identity-and-policy.md#56-governance-state-freshness-and-fail-closed-rules-canonical) (rule G-1 is this ADR)

## Context & forces

- The platform admin must be able to stop all agent activity, or activity scoped to a department, pack or agent, with **≤ 30 s** effect on all surfaces. In-flight turns must be cancelled and pending approvals frozen (REQ-064a).
- Clients (especially local CLI/Desktop hosts) are untrusted and may be offline or modified.
- The mechanism must work air-gapped and must not depend on a vendor service.

## Options considered

| Criterion | A. Gateway-enforced flag: push (pub/sub) + 5 s poll; fail closed if state older than 60 s | B. Revoke all user tokens at the IdP / control plane | C. Signal Agent Hosts only (protocol notification) | D. Scale gateways to zero |
|---|---|---|---|---|
| Works against a modified or offline client | Yes (gateways deny) | Yes, but slow: tokens live up to 15 min unless every gateway checks introspection | No | Yes |
| Scoped (dept / pack / agent) | Yes | Coarse (per user) | Yes | No, all or nothing |
| ≤ 30 s | Yes | Only with revocation checks on every call | Best effort | Minutes; kills admin access too |
| Reversible, auditable, drillable | Yes | Disruptive (users must sign in again) | Yes | Disruptive |

## Decision

Option **A**, plus the notification from C for user experience:

- KillSwitch state and a monotonically increasing governance epoch live in the control plane.
- Changes are published over Redis pub/sub as part of the **governance heartbeat** (kill-switch state, epoch, revocation feed, latest policy version). Every PEP (gateways, control-plane API, server Agent Host, egress proxy) also polls every 5 s and **fails closed if its state is older than 60 s**: it refuses every model and tool call, all tiers. This is rule G-1 of the canonical table; policy-bundle lag (ADR-0011) is rule G-2 in the same table and is never looser than G-1.
- *Clarified 2026-09-25 (F-002 design review): the 5 s poll alone meets the ≤ 30 s kill-switch and ≤ 60 s revocation targets; the Redis push is a latency optimisation. Until F-012 delivers the kill-switch API, the heartbeat is poll-only and no PEP depends on Redis for G-1. The decision itself has not changed.*
- The kill-switch state is also carried in the signed policy bundle (ADR-0011) as a second copy. The heartbeat is authoritative for freshness.
- Gateways deny new calls in scope and abort in-flight streams. The control plane freezes approvals, suspends Web sandboxes and notifies hosts, which relay the Agent Protocol notification `governance.halted` to surfaces. Local tools stop because the audit intent-ack from the client-attested ingestion path returns the halt (rule G-6).
- Activation requires the platform-admin role and a confirmation step. It is audited synchronously (fail closed). Drills are recorded for the evidence pack.

## Consequences

- Positive: meets ≤ 30 s against untrusted clients; scoped; testable through drills; works air-gapped.
- Negative / risks: the fail-closed-on-stale rule couples gateway availability to control-plane and Redis availability (a 60 s control-plane outage stops agents). This is accepted as consistent with governance-first design and covered by control-plane HA.
- What would make us revisit: pilot customers reject the availability coupling for T1 workloads (then make the G-1 threshold configurable per tier, with longer for T1, and update the canonical table). The earlier trigger "gateways move to a decentralised policy bundle model" has already happened (ADR-0011), and the kill-switch is now in the bundle as a second copy, as above.

## References

- PRD REQ-064; `docs/market/regulation.md` CBUAE Guidance Note row (ability to stop the service), accessed 2026-09-24.

## Approval (G3)

> Filled by a human only. Agents must leave this blank.

| Approver | Role | Decision (Approved / Changes requested) | Date | Notes |
|---|---|---|---|---|
| Ram Mohan Rao Adduri | Founder / Product owner (acting tech lead) | Approved | 2026-09-25 | Approval given in chat ("accept all"); recorded by Claude on the approver's instruction. |
