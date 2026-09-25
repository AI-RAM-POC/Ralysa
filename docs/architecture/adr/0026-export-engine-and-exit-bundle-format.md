# ADR-0026: One export engine for the exit bundle, evidence pack and AI register; JSONL + CSV + original files with a signed manifest

- **Status:** Accepted
- **Date:** 2026-09-25
- **Deciders:** Architect (proposal); Tech lead (G3)
- **Related:** REQ-070, REQ-099, REQ-100; DV-3, DV-10; market R-5(i), compliance-artefact checklist #6 and #10 (QCB exit plan, CRA portability regulation); F-012; `docs/architecture/data-model.md` §6

## Context & forces

- Tenants must be able to export all their data in documented open formats within ≤ 24 h, with a two-person approval, audited (REQ-100). Regulators expect exit and portability plans (QCB Cloud Regulation; CRA portability regulation, per `regulation.md`).
- The evidence pack (≤ 10 min for 90 days) and the AI system register need the same entities, filtered and summarised.
- Exports must run **in-region** and must never contain secrets.
- Auditors must be able to verify audit integrity from the export alone, offline.

## Options considered

| Criterion | A. One export engine; JSONL per entity + CSV for tabular data + original files + JSON Schemas + signed manifest | B. Database dump (`pg_dump`) + object-store copy | C. Separate bespoke exporters per report |
|---|---|---|---|
| Open, documented format | Yes (JSON Schema per entity) | Postgres-specific, exposes internal schema | Varies |
| Excludes secrets and other tenants | By construction | Hard in shared-schema tenancy | Yes |
| Offline audit verification | Includes seals, checkpoints, public keys | Possible, but raw | Per report |
| Reuse for the evidence pack | Yes | No | No (duplication) |
| Effort | Medium, once | Low, but fails the "open formats" criterion | High over time |

## Decision

Option **A**:

- The export engine lives in `services/control-plane` and runs `ExportJob`s of kind `exit_bundle`, `evidence_pack`, `ai_register` or `audit_export`.
- It reads a consistent snapshot per entity, writes JSONL/CSV plus original content and SKILL.md folders, publishes JSON Schemas, and signs a manifest of per-file SHA-256 hashes with a tenant export key.
- The bundle can optionally be encrypted to a customer-supplied public key.
- The exit bundle requires platform admin plus a second approver. Bundles are stored in-region with a 7-day expiry.

## Consequences

- Positive: one code path for portability and regulator evidence; formats are independent of the tenancy and database choices; offline verifiability.
- Negative / risks: entity schemas become a public contract, so versioning discipline is needed. Large content (workspace files) makes bundles big, so it is opt-in.
- What would make us revisit: a regulator or customer mandates a specific format (for example a standard GRC evidence schema); the ≤ 10 min evidence-pack target cannot be met without a dedicated reporting store.

## References

- `docs/market/regulation.md` (QCB Cloud Computing Regulation exit plans; CRA *Regulation for Cloud Data Interoperability and Data Portability*), accessed 2026-09-24.
- JSON Lines: https://jsonlines.org/ ; JSON Schema: https://json-schema.org/ (accessed 2026-09-25)

## Approval (G3)

> Filled by a human only. Agents must leave this blank.

| Approver | Role | Decision (Approved / Changes requested) | Date | Notes |
|---|---|---|---|---|
| Ram Mohan Rao Adduri | Founder / Product owner (acting tech lead) | Approved | 2026-09-25 | Approval given in chat ("accept all"); recorded by Claude on the approver's instruction. |
