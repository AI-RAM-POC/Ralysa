# ADR-0027: One Helm umbrella chart (OCI) + per-cloud Terraform modules + signed air-gapped bundle

- **Status:** Accepted
- **Date:** 2026-09-25
- **Deciders:** Architect (proposal); Tech lead (G3)
- **Related:** spec §9, §10.4 (`deploy/helm`, `deploy/terraform`, `deploy/docker`); REQ-098, REQ-101, REQ-102, REQ-103; DV-1; market R-4; F-023, F-042; `docs/architecture/deployment.md` §4–§5

## Context & forces

- Dedicated in-country and on-prem ship in **Phase 1** (DV-1). Air-gapped follows by Y1. Customer ops must install in ≤ 1 working day.
- Targets: AKS, GKE, EKS in Gulf regions, sovereign partner clouds, and customer Kubernetes.
- Supply-chain evidence is required: signed images and charts, SBOM (REQ-098; market artefact #9).
- Small team: avoid maintaining several packaging systems.

## Options considered

| Criterion | A. Helm umbrella chart (OCI) + Terraform per cloud + signed offline bundle | B. Kubernetes operator (CRD-driven lifecycle) | C. Commercial distribution platform (KOTS-style) |
|---|---|---|---|
| Familiar to customer ops and CAB processes | High (Helm is common) | Medium | Medium |
| Air-gapped support | Yes, with a bundle (Zarf or in-house)[^zarf] and offline signature verification[^cosign] | Yes, still needs bundling | Yes |
| Upgrade orchestration (migrations, ordering) | Helm hooks + our preflight | Strong | Strong |
| Build effort for Phase 1 | Low–medium | High | Low, but licence cost and lock-in |
| Vendor lock-in | None | None | Vendor |

## Decision

Option **A**:

- Signed images (cosign) with SBOM attestations.
- One `ralysa` Helm umbrella chart published as an OCI artifact (Helm OCI support GA since v3.8[^helm]), with values profiles per deployment model and cloud.
- Terraform modules under `deploy/terraform/{azure,gcp,aws}` with a region allow-list.
- A preflight tool.
- An air-gapped bundle with a serialized trust root for offline verification. Zarf is evaluated as the bundler in Phase 3.

## Consequences

- Positive: one artifact set across all models; fits customer change processes; no licence cost.
- Negative / risks: complex upgrade ordering lives in Helm hooks and our preflight. An operator may be needed later (Phase 4) for day-2 automation such as DR restore and certificate rotation.
- What would make us revisit: repeated upgrade failures at customer sites; the day-2 operations burden grows (then add an operator that wraps the same chart).

## References

All accessed 2026-09-25.

[^helm]: https://helm.sh/docs/topics/registries/
[^zarf]: https://github.com/zarf-dev/zarf
[^cosign]: https://docs.sigstore.dev/cosign/verifying/verify/

## Approval (G3)

> Filled by a human only. Agents must leave this blank.

| Approver | Role | Decision (Approved / Changes requested) | Date | Notes |
|---|---|---|---|---|
| Ram Mohan Rao Adduri | Founder / Product owner (acting tech lead) | Approved | 2026-09-25 | Approval given in chat ("accept all"); recorded by Claude on the approver's instruction. |
