# ADR-0021: Tamper-evident audit store (insert-only Postgres, sharded hash chain, signed Merkle checkpoints on WORM storage)

- **Status:** Proposed
- **Date:** 2026-09-25
- **Deciders:** Architect (proposal); Tech lead (G3)
- **Related:** spec §6.14, §8 Audit, §12 Observability; REQ-071, REQ-072, REQ-075, REQ-099, REQ-100; DV-12; F-004, F-011; `docs/architecture/observability-audit.md` §5

## Context & forces

- The audit log must be immutable and tamper-evident (REQ-071a/b), stored in the tenant region, retained 1–7 years, and cover 100 % of model and tool calls.
- It must work identically on Azure, Google, AWS, on-prem and **air-gapped** installs, with no dependency on a cloud-only ledger service.
- It must not add significant latency to the gateway hot path (100 ms p95 total overhead).
- Content (prompts) must be erasable or expirable by tier without breaking verification.
- Regulators and auditors must be able to verify integrity **offline** from an export (REQ-070, REQ-100).

## Options considered

| Criterion | A. Postgres insert-only + hash chain + signed checkpoints to WORM | B. Dedicated ledger database (for example immudb) | C. Cloud-managed ledger (for example Azure Confidential Ledger) | D. WORM object storage only (append event files) |
|---|---|---|---|---|
| Runs air-gapped and on every cloud | Yes | Yes (self-hosted) | No, cloud-specific | Yes (MinIO object lock) |
| Tamper evidence | Chain + Merkle proofs (RFC 9162 style); WORM anchors | Built-in | Built-in | Immutable, but no inclusion proofs without extra work |
| Query for console, explainability, evidence | SQL | Limited SQL | API only | Poor; needs a second index |
| Ops burden | Uses the Postgres we already run | One more stateful system | Low, but per cloud | Low |
| Hot-path cost | One INSERT; sealing is async | Similar | Remote call | Batching delay |
| Lock-in | Low | Medium | High | Low |

## Decision

Option **A**:

- A separate audit database or schema with an **insert-only** writer role and triggers that reject UPDATE/DELETE and audit the attempt.
- An async **sealer** assigns `seq` per `(org_id, shard)` and computes a SHA-256 chain over RFC 8785-canonical events within ≤ 5 s.
- Every 60 s the sealer signs a Merkle checkpoint (per-tenant key in KMS or Vault transit) and writes it to **WORM object storage**: S3 Object Lock, Azure immutable blob, GCS Bucket Lock or MinIO object lock.
- Content is stored by reference, with only its hash in the chain.
- **Phasing (aligned with security SR-29 / P0-4):** the insert-only writer role and the sealer hash chain run from the **first Phase 0 event**, because a chain added later cannot vouch for earlier events. Signed checkpoints to WORM, `audit verify` and retention purge arrive with F-011 (Phase 1) and anchor the existing chain. The F-002 brief puts all tamper-evidence in F-011; the proposed brief change is BC-05 in `consistency-review.md`.
- The event envelope the sealer canonicalises is the one in [observability-audit.md §3.1](../observability-audit.md).

## Consequences

- Positive: portable to every deployment model; SQL-queryable for console views, explainability and exports; offline verification with inclusion proofs; content can be erased without breaking the chain.
- Negative / risks: a residual tamper window for DB superusers (≤ 5 s before sealing, ≤ 60 s before the checkpoint), mitigated by SIEM export and a configurable 10 s checkpoint for regulated tenants. We own the sealer and verifier code, which needs careful testing. Partition-drop retention needs dual control and anchor events.
- What would make us revisit: a regulator requires per-event signatures or third-party timestamping (RFC 3161); audit volume exceeds what Postgres can handle per deployment (then a columnar or log store with the same chain design); a mature open-source verifiable-log component (for example a Trillian-style log) becomes simple to operate air-gapped.

## References

All accessed 2026-09-25.

- RFC 9162, Certificate Transparency 2.0: https://www.rfc-editor.org/rfc/rfc9162
- RFC 8785, JSON Canonicalization Scheme: https://www.rfc-editor.org/rfc/rfc8785
- S3 Object Lock: https://docs.aws.amazon.com/AmazonS3/latest/userguide/object-lock.html
- Azure immutable blob storage: https://learn.microsoft.com/en-us/azure/storage/blobs/immutable-storage-overview
- GCS Bucket Lock: https://docs.cloud.google.com/storage/docs/bucket-lock
- MinIO object locking: https://docs.min.io/aistor/administration/object-locking-and-immutability/

## Approval (G3)

> Filled by a human only. Agents must leave this blank.

| Approver | Role | Decision (Approved / Changes requested) | Date | Notes |
|---|---|---|---|---|
| | | | | |
