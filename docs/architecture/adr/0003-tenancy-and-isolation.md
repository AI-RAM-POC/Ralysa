# ADR-0003: Tenancy and isolation: one organization per deployment through Phase 3

- **Status:** Proposed
- **Date:** 2026-09-25
- **Deciders:** Proposed by architect agent (stream A). Decision owner: Tech lead (G3) with Product owner (OQ-12).
- **Related:** spec §8 (Isolation), §9, §11, §15 Q2; PRD DV-1, DV-15, OQ-12, A-2; REQ-013, REQ-081, REQ-087, REQ-090, REQ-096, REQ-100, REQ-101, REQ-102, REQ-103, REQ-105; summary R-4; MA-301, MA-302, MA-304; F-002, F-023, F-043

## Context & forces

The spec lists four deployment models, including multi-tenant SaaS (§9). The G1/G2 direction reorders them:

- Launch is **customer-dedicated in-country cloud and on-prem** (DV-1, R-4).
- Air-gapped follows by Y1.
- Multi-tenant SaaS is **in-region only, Could priority, Phase 4**, and never foreign-hosted for regulated Gulf buyers (DV-15, REQ-105).
- Ralysa is treated as a product sold to many enterprises, customer-operated first (OQ-12).
- Customer-operated deployment keeps Ralysa out of material-outsourcing scope (R-4).

Forces:

- **Residency and regulator acceptance.** Every beachhead segment accepts dedicated and on-prem deployments; none accepts foreign multi-tenant SaaS (MA-301, MA-302).
- **Blast radius.** A cross-tenant data leak would be fatal in the Gulf regulated market.
- **Delivery.** Phase 1 is already overloaded (OQ-3). Pooled multi-tenancy adds tenant provisioning, per-tenant IdP routing, noisy-neighbour controls, per-tenant keys, tenant-aware operations and isolation tests.
- **Future SaaS must not require a rewrite** (REQ-105, Phase 4).
- **Isolation inside an organization still matters:** per-user web sandboxes (REQ-013), Fraud case isolation (REQ-087), Legal per-matter isolation (REQ-090), T3 departments.
- Licensing binds a deployment to a customer (REQ-081). Exit/export is per organization (REQ-100).

## Options considered

| Criterion | A. One organization per deployment (silo) in Phases 0–3; multi-tenant-ready schema | B. Pooled multi-tenant from day one; dedicated installs are single-tenant instances of it | C. Silo per tenant everywhere, including SaaS (vendor-run fleet of single-tenant stacks) |
|---|---|---|---|
| Fit with launch deployments (DV-1) | Exact fit | Works, but carries unused complexity | Exact fit |
| Regulator acceptance | Highest: customer-operated, no shared infrastructure | Pooled is irrelevant on-prem, but auditors will ask about the tenant code paths | High |
| Cross-tenant leak risk | None within a deployment (one org) | Depends on correct row-level security, cache keys, queues and object prefixes everywhere | None |
| Time to MVP | Fastest | Slowest: tenant provisioning, routing, quotas, isolation test suite | As A for Phases 0–3 |
| Cost per customer | Higher (a full stack each); paid by the customer or partner (platform fee, R-7) | Lowest | Highest if applied to SMB SaaS |
| Path to Phase 4 SaaS | Additive if the schema is tenant-ready now | Already there | Needs fleet automation; no code change |
| Operations for a small team | Customer or partner operates; we ship Helm/Terraform | We operate shared infrastructure | We operate many stacks |
| Kubernetes isolation model | Whole cluster or namespace set per customer (hard isolation) | Namespace-per-tenant "soft" multi-tenancy, or more | Cluster per tenant; the Kubernetes docs note the stronger isolation must be weighed against the cost and complexity of many clusters ([Kubernetes multi-tenancy](https://kubernetes.io/docs/concepts/security/multi-tenancy/), accessed 2026-09-25) |

## Decision

**Option A.** Through Phase 3, each Ralysa deployment serves **exactly one Organization**, bound by the licence file (REQ-081). Provisioning refuses a second Organization. Dedicated in-country, on-prem and air-gapped deployments are all this shape.

To keep Phase 4 additive, these rules apply from Phase 0:

1. **`org_id` on every tenant-owned table** (spec §11 Organization is the root) and on every audit, usage, cache key, queue topic and object-storage prefix.
2. **PostgreSQL row-level security on `org_id`**, with `FORCE ROW LEVEL SECURITY` so the owning role doesn't bypass it. Services connect as a non-owner role that sets `app.org_id` per transaction. Once RLS is enabled, a table without a policy denies all rows ([PostgreSQL row security](https://www.postgresql.org/docs/current/ddl-rowsecurity.html), accessed 2026-09-25). This is defence in depth now and the isolation mechanism later.
3. **Org resolution from the token.** Each service derives `org_id` from the validated token's issuer and audience mapping, never from a client-supplied header.
4. **Isolation inside the organization** uses policy and data scoping, not tenancy:
   - per-user or per-workspace sandboxes (workspace-runtime);
   - `department_id` and case/matter scoping with RLS for T3 isolation (REQ-087, REQ-090);
   - separate encryption keys per sensitivity tier where the customer supplies customer-managed keys.

**Phase 4 SaaS** will get its own ADR. The current lean is: pooled (option B on this schema) for non-regulated in-region tenants, and a dedicated silo (option C) for any tenant with T3 data or a regulator requirement.

## Consequences

- Positive:
  - Matches how the pilot and the regulated segments want to buy (customer-operated, in-country). Cross-tenant leakage is impossible by construction in Phases 0–3.
  - No tenant-provisioning, noisy-neighbour or cross-tenant test machinery in the Phase 1 critical path.
  - RLS on `org_id` from day one gives a second barrier and makes Phase 4 an extension, not a migration.
- Negative / risks:
  - Every customer is a full stack (PostgreSQL, Redis, gateways, runtime, GPUs), which raises entry cost for smaller customers. The platform fee by deployment tier (R-7) has to cover it.
  - Upgrades are spread across many customer-operated installs. We need a disciplined N → N+1 upgrade path (REQ-102c) and support for skipped versions.
  - `org_id` and RLS add a little friction to every migration and query, for a benefit only realised in Phase 4.
- What would make us revisit:
  - A paying in-region SaaS customer before Phase 4. Then pull the Phase 4 ADR forward.
  - OQ-12 is answered "internal platform for one organization". Then drop the SaaS path and keep RLS only as defence in depth.
  - Fleet support for more than about 15 dedicated deployments proves too costly for the team.
  - A regulator explicitly accepts pooled multi-tenant AI processing for T2.

## References

- Kubernetes multi-tenancy (soft vs hard isolation, cost trade-off): https://kubernetes.io/docs/concepts/security/multi-tenancy/ (accessed 2026-09-25)
- PostgreSQL row security policies (default deny, FORCE ROW LEVEL SECURITY): https://www.postgresql.org/docs/current/ddl-rowsecurity.html (accessed 2026-09-25)
- `docs/market/summary.md` R-4; `docs/market/regulation.md` deployment-acceptance matrix (MA-301 to MA-304)
- PRD DV-1, DV-15, OQ-12, REQ-101 to REQ-105

## Approval (G3)

> Filled by a human only. Agents must leave this blank.

| Approver | Role | Decision (Approved / Changes requested) | Date | Notes |
|---|---|---|---|---|
| | | | | |
