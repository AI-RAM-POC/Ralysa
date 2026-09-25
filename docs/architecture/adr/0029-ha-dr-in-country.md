# ADR-0029: Zone-level HA with synchronous Postgres standby; DR to a second in-country location, never cross-border by default

- **Status:** Accepted
- **Date:** 2026-09-25
- **Deciders:** Architect (proposal); Tech lead (G3)
- **Related:** spec §8 Data residency, §12 Availability and Recoverability; REQ-096, REQ-104, REQ-110; DV-1; market MA-301, MA-303; F-023, F-043; `docs/architecture/deployment.md` §6–§7

## Context & forces

- NFRs: RPO ≤ 15 min and RTO ≤ 4 h for control-plane data. Losing a node or zone causes no data loss and ≤ 5 min disruption. SaaS availability is 99.9 %.
- **Residency:** Tier-3 data and, for banks, PII and financial data must stay in-country (QCB Art. 21.4 and similar). DR copies are data too.
- **Single-region countries:** Azure Qatar Central has 3 AZs and **no paired region**. UAE North pairs with UAE Central, which is access-restricted.[^az] Google Doha and Dammam are each the only Google region in their country.[^gcp]
- Audit must stay tamper-evident across failover and restore.

## Options considered

| Criterion | A. 3-zone HA + sync standby; PITR; backups continuously copied to a second **in-country** location (other provider or customer DC) | B. Cross-region DR in the provider's paired region | C. Zone-level HA only, restore from in-region backups |
|---|---|---|---|
| Residency | Kept | **Violates** residency where the pair is in another country, or no pair exists | Kept |
| Region or site loss covered | Yes (RTO ≤ 4 h via IaC rebuild + restore) | Yes | **No** |
| Cost and complexity | Medium (cross-provider backup copy, runbook) | Medium | Low |
| Works on-prem and air-gapped | Yes (second DC) | n/a | Yes |

## Decision

Option **A**:

- Stateless services span 3 zones.
- Postgres runs HA with a synchronous standby in another zone, plus continuous WAL archiving (≤ 5 min) for PITR. The WORM checkpoint bucket and object storage are zone-redundant.
- Encrypted backups (base, WAL, object storage, WORM checkpoints) are copied continuously to a second in-country location. For Qatar that is Azure Qatar Central ↔ Google Doha, or the customer's DC. For the UAE it is UAE Central on request, AWS me-central-1, or the customer DC.
- Recovery is by Terraform + Helm + restore, following a drilled runbook.
- Cross-border DR only through an explicit, audited policy exception.

## Consequences

- Positive: meets RPO/RTO without breaking residency; works for every deployment model; the DR restore also exercises the exit-bundle and audit-verify tooling.
- Negative / risks: cross-provider backup copies need credentials and network paths between clouds, which adds complexity and a security review. RTO depends on DB size (≤ 2 h restore estimated at pilot scale; must be measured). Workspace volumes are outside RPO scope (daily snapshots).
- What would make us revisit: a provider opens a second in-country region (for example Azure or AWS in KSA going live), which allows same-provider DR; regulators reject cross-provider DR (then customer-DC DR only); database growth pushes restore time beyond 4 h (then a warm standby in the DR location).

## References

All accessed 2026-09-25.

[^az]: https://learn.microsoft.com/en-us/azure/reliability/regions-list
[^gcp]: https://docs.cloud.google.com/compute/docs/regions-zones

Also: CloudNativePG WAL archiving and PITR, https://cloudnative-pg.io/docs/1.28/wal_archiving/ ; `docs/market/regulation.md` (QCB Cloud Computing Regulation, accessed 2026-09-24).

## Approval (G3)

> Filled by a human only. Agents must leave this blank.

| Approver | Role | Decision (Approved / Changes requested) | Date | Notes |
|---|---|---|---|---|
| Ram Mohan Rao Adduri | Founder / Product owner (acting tech lead) | Approved | 2026-09-25 | Approval given in chat ("accept all"); recorded by Claude on the approver's instruction. |
