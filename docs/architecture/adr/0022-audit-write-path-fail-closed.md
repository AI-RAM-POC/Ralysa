# ADR-0022: Write-ahead audit intent, fail-closed before any model or tool call

- **Status:** Proposed
- **Date:** 2026-09-25
- **Deciders:** Architect (proposal); Tech lead (G3)
- **Related:** spec §6.12.1, §12 Observability; REQ-024, REQ-059d, REQ-071c, REQ-003e; F-003, F-004, F-011; `docs/architecture/observability-audit.md` §4

## Context & forces

- NFR: 100 % of model and tool calls audited. REQ-071c says a call whose audit write fails must not execute.
- The Phase 0 briefs propose fail-closed, metadata-only audit (F-003 AC-12/AC-13, F-004 AC-4/AC-6/AC-12; checked in the G3 consistency review).
- The gateway overhead budget is p95 < 100 ms.
- Streaming responses: outcome data (tokens, finish reason) is known only at stream end.
- Local Agent Hosts (CLI/Desktop) run local tools that never pass a gateway.

## Options considered

| Criterion | A. Sync intent insert before call + completion after (spool on failure) | B. Async audit via a queue (fire-and-forget) | C. Single sync record after the call | D. Transactional outbox in the gateway's own DB |
|---|---|---|---|---|
| Guarantees "no call without audit" | Yes | No (fail-open) | No: the call happens before the record exists | Yes, if the gateway has a DB, which it does not |
| Hot-path latency | +1 INSERT (≤ 10 ms p95 target) | ~0 | +1 INSERT after the call | +1 local commit |
| Detects lost outcomes | Yes: orphan intents are flagged | No | n/a | Yes |
| Complexity | Low–medium | Low | Low | Adds a database per gateway |

## Decision

Option **A**:

1. Gateways (and the control plane for admin actions) synchronously commit a `*.requested` event (`model.call.requested`, `tool.call.requested`), with a 250 ms timeout, **before** forwarding a call. On failure or timeout the call is refused with "audit unavailable" (Agent Protocol error `audit_unavailable`).
2. After the call they write `*.completed` with `outcome` `success` / `error` / `cancelled`. If that write fails, the event goes to a disk spool with retry, and the sealer alerts on intents without a completion after 5 min.
3. A call refused before execution gets one `*.denied` event and no intent.
4. The local Agent Host must obtain an intent ack from the control plane's **client-attested** ingestion path before running a local tool. That path authenticates the user token, overwrites `actor` from the token subject and stores the events with `attestation=client` (resolves security TM-45(b); see [observability-audit.md §3.3](../observability-audit.md)). The service path stays service-identity-only (F-002 AC-11).
5. Phase 0 stores metadata only: no prompt or response content, only hashes and counts.

The envelope, event names and the reconciliation rule ("one terminal event per call, and one intent per completion") are defined once in [observability-audit.md §3](../observability-audit.md). Model Gateway and MCP Gateway pipelines (model-gateway.md §4.1, mcp-gateway.md §4) implement exactly this rule.

## Consequences

- Positive: "100 % audited" is testable by fault injection. Denials and errors are audited as well. Orphan detection covers crash cases.
- Negative / risks: audit-DB availability becomes gateway availability, so the audit DB needs HA equal to the control plane. The extra INSERT consumes part of the latency budget. Local-tool audit depends on an honest client (marked unattested).
- What would make us revisit: measured intent latency > 10 ms p95 at Phase 4 scale, or audit-DB availability incidents (then consider a region-local replicated log such as a Raft-based queue with sync ack, which is also the durable write-ahead queue security TM-46 / SR-29 suggest); customers who require fail-open for T1 during outages (would need a policy flag, which we would resist).
- Brief impact: F-003 AC-12, F-004 AC-4 and F-005 AC-6 say "exactly one audit event per call". Under this ADR each executed call has an intent and a completion. The proposed brief wording is in `consistency-review.md` (BC-06, BC-07).

## References

- PRD REQ-071 acceptance criterion (c); spec §12 Observability.
- F-002, F-003, F-004 and F-005 briefs (`docs/features/F-00{2..5}-*/brief.md`), read in the G3 consistency review.
- `docs/architecture/security.md` TM-45, TM-46, SR-29.

## Approval (G3)

> Filled by a human only. Agents must leave this blank.

| Approver | Role | Decision (Approved / Changes requested) | Date | Notes |
|---|---|---|---|---|
| | | | | |
