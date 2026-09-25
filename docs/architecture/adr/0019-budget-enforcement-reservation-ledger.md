# ADR-0019: Usage budgets and metering enforced by pre-call reservation with an append-only usage ledger

- **Status:** Accepted
- **Date:** 2026-09-25 (merged with the withdrawn ADR-0023 in the G3 consistency review, same date)
- **Deciders:** Tech lead (G3 approver); proposed by architect (streams B and C)
- **Related:** spec §6.4.4 budget, §6.5.3, §6.14, §6.15.3, §6.15.7 · REQ-027, REQ-032, REQ-054, REQ-073, REQ-074, REQ-079 · DV-4, DV-12 · F-007, F-014 · MA-402, MA-404, MA-407, MA-411, summary R-5(g), R-7 · [model-gateway.md](../model-gateway.md) §7 · [observability-audit.md](../observability-audit.md) §7 · Supersedes the content of [ADR-0023](0023-usage-metering-reserve-settle.md) (withdrawn, merged here)

## Context & forces

- DV-4: pooled org-level allowance with optional department pools, no rollover, $0.01 credit, org/department/user spend limits with alert → soft cap → block, per-request token caps, BYOM metered but not charged — all in Phase 1.
- Hard caps must actually stop spend, **before** the call (REQ-079c). Many concurrent streaming calls per department, across many gateway replicas, make post-hoc checks overshoot and create races on shared pools.
- Totals must reconcile with provider usage within 1 % (REQ-032b), be visible ≤ 15 min (REQ-032d) and feed chargeback (REQ-073) and billing export.
- Every usage record carries the inference region (DV-12).
- Gateway overhead p95 < 100 ms; the budget check gets about 5 ms ([overview §5](../overview.md#5-nfr-budget), N2).
- Must work on-prem/air-gapped with only Postgres and Redis (spec §10.3).
- The spec suggests LiteLLM Proxy, which has its own budgets and virtual keys (spec §6.5.4). The gateway structure is decided in [ADR-0014](0014-model-gateway-policy-front-and-provider-adapter.md).

## Options considered

| Criterion | A. Post-hoc decrement (check balance > 0, charge after call) | B. Reservation (estimate and hold before, settle after) in Redis + append-only Postgres ledger (chosen) | C. LiteLLM virtual keys and budgets as source of truth | D. Postgres row locks per pool on every call | E. Post-hoc async aggregation from a usage stream |
|---|---|---|---|---|---|
| Hard cap before the call | No: overshoot up to (concurrent calls × max cost) | Yes; overshoot bounded by estimate error | Per virtual key and team; the org/dept/user pool hierarchy and BYOM exclusion need custom work | Yes | No |
| Concurrency | Races | Atomic Redis script; no DB lock contention | Proxy-defined | Hot-row contention and lock waits | n/a |
| Pools with dept sub-pools, BYOM exclusion, credit unit | Custom anyway | Custom, designed for it | Needs bending or parallel bookkeeping | Custom | Custom |
| Reconciliation and audit | Ledger possible | Ledger with idempotent reservation/request ids | Split between LiteLLM DB and Ralysa | Ledger | Yes |
| Latency | ~1 ms | ~2–5 ms (atomic Redis script) | In-proxy | Lock waits under load | 0 |
| Failure behaviour | Simple | Needs rules for Redis loss (below) | LiteLLM-defined | DB-bound | Simple |
| Lock-in | None | None | Tied to the proxy | None | None |

## Decision

**Option B.**

1. **Reserve.** Before each model call the gateway estimates cost: input tokens (local count or `count_tokens`) × input price + requested `max_tokens` (clamped to the policy's `per_request_max_tokens`) × output price, from a versioned PriceBook. It reserves that amount **atomically** against the user, department and org SpendLimits and the relevant UsagePool with one Redis Lua script ([Redis scripting](https://redis.io/docs/latest/develop/programmability/eval-intro/)). Hard cap → deny `budget_exceeded`; soft cap or alert threshold → continue and emit a `usage.update` warning (en/ar).
2. **Settle.** After the call the gateway settles actual usage (including cache reads/writes from the provider response) and releases the remainder. Cancelled streams settle consumed tokens; where a provider reports usage only at stream end and the stream is cut, usage is estimated from gateway-counted tokens and flagged `estimated=true`.
3. **Ledger (source of truth).** Every settlement appends a `UsageRecord` (with `endpoint_region`, `inference_region`, `price_book_version`, `byom` flag) and, unless BYOM, a `PoolLedgerEntry(debit)` to Postgres. Both are append-only and idempotent on `request_id` / `reservation_id`. Redis holds only reservations and running counters.
4. **BYOM.** BYOM calls are metered and priced for reporting. They reserve against spend limits in provider-cost terms (if such limits are configured) but never against the credit pool.
5. **Redis loss.** Counters are rebuilt from the ledger for the current period. Until the rebuild finishes, calls are allowed only for scopes below 80 % of their limit at the last snapshot *(proposed)*, and each call is clamped to a conservative per-request cap, so the pool is never over-spent silently. This is the budget row of the canonical fail-closed table ([identity-and-policy.md §5.6](../identity-and-policy.md#56-governance-state-freshness-and-fail-closed-rules-canonical)).
6. **Reconciliation.** Nightly (and monthly for invoices) comparison with provider-reported usage per provider account; variance > 1 % is flagged (REQ-032b).
7. **Other usage kinds.** `workspace-runtime` writes `UsageRecord(kind=sandbox_seconds)` every 5 min per running sandbox against the same pools.
8. **LiteLLM** budgets and virtual keys, if LiteLLM is the provider adapter (ADR-0014), are disabled and never the system of record.

## Consequences

- Positive: hard caps hold under concurrency; one ledger for usage, chargeback, billing and the evidence pack; independent of the provider adapter and of the gateway product choice.
- Negative / risks: estimates over-reserve for large `max_tokens` (short-lived holds may cause false soft-cap warnings or block users near a cap; mitigate by clamping `max_tokens` to policy caps and releasing reservations promptly); Redis becomes part of the critical path (HA replica required); price-book maintenance per provider and region is an ops task.
- What would make us revisit: measured over-reservation causes frequent false denials; pilot data (OQ-11) shows budgets are rarely hit, making post-hoc checks sufficient for T1-only tenants; per-call ledger rows become too costly at volume (then batch the ledger per minute while keeping reservations per call); the provider-adapter layer gains a hierarchical-pool reservation feature we can trust as the source of truth.

## References

All accessed 2026-09-25.

- LiteLLM proxy budgets and virtual keys (considered): https://docs.litellm.ai/docs/proxy/users
- Anthropic prompt caching (cache read/write token accounting): https://platform.claude.com/docs/en/build-with-claude/prompt-caching
- Redis scripting (atomic Lua execution): https://redis.io/docs/latest/develop/programmability/eval-intro/
- docs/product/prd.md REQ-079, DV-4; docs/market/summary.md R-5(g), R-7
- Spec §6.5.4 (LiteLLM Proxy as base)

## Approval (G3)

> Filled by a human only. Agents must leave this blank.

| Approver | Role | Decision (Approved / Changes requested) | Date | Notes |
|---|---|---|---|---|
| Ram Mohan Rao Adduri | Founder / Product owner (acting tech lead) | Approved | 2026-09-25 | Approval given in chat ("accept all"); recorded by Claude on the approver's instruction. |
