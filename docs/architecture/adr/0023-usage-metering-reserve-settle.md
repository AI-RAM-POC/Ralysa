# ADR-0023: Usage metering with reserve-and-settle against a Postgres ledger and Redis counters

- **Status:** Withdrawn: merged into [ADR-0019](0019-budget-enforcement-reservation-ledger.md)
- **Date:** 2026-09-25
- **Deciders:** Architect (proposal); Tech lead (G3)
- **Related:** [ADR-0019](0019-budget-enforcement-reservation-ledger.md); `docs/architecture/consistency-review.md` (issue C-01)

This ADR duplicated ADR-0019 (same decision: reserve atomically in Redis before the call, settle after, Postgres ledger as the source of truth, LiteLLM budgets not the system of record). Its unique content (options D "Postgres row locks" and E "post-hoc async aggregation", the Redis Lua reference, the `PoolLedgerEntry` debit skipped for BYOM, `price_book_version` on UsageRecord, the conservative per-request cap during a Redis rebuild, and the "batch the ledger per minute" revisit trigger) was folded into ADR-0019 on 2026-09-25. Refer to ADR-0019 only. The number 0023 is not reused.

## Approval (G3)

> Filled by a human only. Agents must leave this blank.

| Approver | Role | Decision (Approved / Changes requested) | Date | Notes |
|---|---|---|---|---|
| | | | | |
