# Roadmap

> Phase 2 · Owner: product-manager · Source: [prd.md](prd.md), spec §13, docs/market/summary.md (G1 approved 2026-09-25) · Last updated: 2026-09-25
> Status: **Draft for G2 review.** Phase placement follows spec §13 except where the PRD's [Deviations from spec](prd.md#deviations-from-spec) (DV-n) apply.

## Features

Implementation status by requirement: [requirements-audit.md](requirements-audit.md) (2026-09-26).

RICE columns: **R** reach (0–10), **I** impact (0.25–3), **C** confidence (%), **E** effort (person-months), **Score** = R × I × C / E. See [RICE method](#rice-method).

| Feature | Title | REQs | Phase | R | I | C | E | Score | Status | Folder |
|---|---|---|---|---|---|---|---|---|---|---|
| F-001 | Engineering and design-system foundations (tokens, RTL-ready layout, a11y lint) | REQ-106, REQ-109 (foundation slice) | 0 | 10 | 1 | 100% | 2 | 5.0 | In development (T01–T14, T16 merged; T15, T17, T18 not started (need a human merge); G6 blocked by D-F001-E2E-1) | [../features/F-001-engineering-design-foundations/](../features/F-001-engineering-design-foundations/) |
| F-002 | SSO sign-in (OIDC) and control-plane skeleton | REQ-016, REQ-095 | 0 | 10 | 3 | 100% | 1.5 | 20.0 | Testing: G6 approved with conditions (2026-09-26); next `/release` | [../features/F-002-sso-control-plane-skeleton/](../features/F-002-sso-control-plane-skeleton/) |
| F-003 | Local Agent Host and Agent Protocol core | REQ-010, REQ-011 | 0 | 10 | 3 | 80% | 3 | 8.0 | Not started | [../features/F-003-agent-host-protocol-core/](../features/F-003-agent-host-protocol-core/) |
| F-004 | Model Gateway v0 (one provider, vault credentials, per-call audit) | REQ-024, REQ-095 | 0 | 10 | 2 | 80% | 1.5 | 10.7 | Not started | [../features/F-004-model-gateway-v0/](../features/F-004-model-gateway-v0/) |
| F-005 | CLI v0: sign-in and chat | REQ-001 | 0 | 2 | 1 | 100% | 1 | 2.0 | Not started | [../features/F-005-cli-v0-signin-chat/](../features/F-005-cli-v0-signin-chat/) |
| F-006 | Identity and policy engine v1 (IdPs, profiles, declarative policy, server-side enforcement, hidden tools) | REQ-017, REQ-019, REQ-020, REQ-021, REQ-022 | 1 | 10 | 3 | 80% | 4 | 6.0 | Not started | |
| F-007 | Model Gateway v1 (Claude via Anthropic/Vertex/Bedrock, local runtime, policy check, fallback, metering) | REQ-025, REQ-027, REQ-031, REQ-032 | 1 | 10 | 2 | 80% | 3 | 5.3 | Not started | |
| F-008 | Sovereign routing: tier × classification × region routing, Arabic local model, pre-model PII masking, model eval gate | REQ-028, REQ-029, REQ-030, REQ-094 | 1 | 8 | 3 | 50% | 4 | 3.0 | Not started | |
| F-009 | MCP/Data Gateway v1 with identity-scoped MCP and PostgreSQL/SQL Server/Oracle | REQ-033, REQ-034, REQ-035, REQ-036, REQ-037 | 1 | 8 | 3 | 80% | 4 | 4.8 | Not started | |
| F-010 | Hooks, approvals and safety (approval matrix, never-automated rules, approval inbox, injection defence) | REQ-059, REQ-060, REQ-061, REQ-062, REQ-063 | 1 | 10 | 3 | 80% | 3 | 8.0 | Not started | |
| F-011 | Immutable audit log, tracing and session explainability | REQ-071, REQ-072 | 1 | 10 | 2 | 100% | 2 | 10.0 | Not started | |
| F-012 | Regulator evidence and control: AI register, evidence pack, kill-switch, AI-output labels, compliance mappings, exit bundle | REQ-064, REQ-065, REQ-070, REQ-099, REQ-100 | 1 | 10 | 2 | 50% | 3 | 3.3 | Not started | |
| F-013 | Subscriptions v1, entitlement enforcement and licensing | REQ-076, REQ-077, REQ-078, REQ-081 | 1 | 10 | 1 | 80% | 3 | 2.7 | Not started | |
| F-014 | Pooled usage allowance, spend limits and cost dashboards | REQ-079, REQ-073 | 1 | 10 | 1 | 80% | 2 | 4.0 | Not started | |
| F-015 | Desktop app with Chat and Code workspaces | REQ-003, REQ-005, REQ-007, REQ-008 | 1 | 3 | 2 | 80% | 4 | 1.2 | Not started | |
| F-016 | Web app: Chat workspace on isolated server-side Agent Host | REQ-004, REQ-013, REQ-007, REQ-008 | 1 | 8 | 3 | 80% | 4 | 4.8 | Not started | |
| F-017 | CLI v1 and Agent Protocol v1 (full command set, conformance suite, engine independence) | REQ-002, REQ-012, REQ-015 | 1 | 2 | 1 | 100% | 1.5 | 1.3 | Not started | |
| F-018 | Web Console v1: `/me`, `/admin`, deep links | REQ-066, REQ-067, REQ-069 | 1 | 10 | 1 | 80% | 3 | 2.7 | Not started | |
| F-019 | Skills and memory v1 (skill format, Skills Library, personal + org memory, privacy filter) | REQ-047, REQ-048, REQ-049, REQ-050 | 1 | 10 | 2 | 80% | 3 | 5.3 | Not started | |
| F-020 | Token optimization v1 (prompt caching, deferred tools, compaction) | REQ-054, REQ-055, REQ-056 | 1 | 10 | 1 | 80% | 2 | 4.0 | Not started | |
| F-021 | Arabic/RTL and accessibility baseline | REQ-106, REQ-107, REQ-109 | 1 | 10 | 2 | 100% | 2 | 10.0 | Not started | |
| F-022 | Department pack framework and Technology pilot pack (ITSM + Release Management) with pilot connectors | REQ-083, REQ-084, REQ-039, REQ-094 | 1 | 3 | 3 | 50% | 4 | 1.1 | Not started | |
| F-023 | Dedicated in-country cloud and on-prem deployment with local-model runtime | REQ-101, REQ-102, REQ-096, REQ-110 | 1 | 10 | 3 | 50% | 4 | 3.8 | Not started | |
| F-024 | Web Workspace Runtime (sandbox, git, Code on Web, session handoff, responsive web) | REQ-014, REQ-005, REQ-009 | 2 | 6 | 2 | 80% | 5 | 1.9 | Not started | |
| F-025 | Data workspace | REQ-006 | 2 | 4 | 2 | 80% | 3 | 2.1 | Not started | |
| F-026 | Docs workspace, document extraction with Arabic OCR, Arabic document output | REQ-006, REQ-042, REQ-108 | 2 | 7 | 2 | 80% | 4 | 2.8 | Not started | |
| F-027 | Productivity and content connectors (M365, Google Workspace, IMAP/SMTP, Exchange on-prem) | REQ-040, REQ-041 | 2 | 9 | 2 | 80% | 5 | 2.9 | Not started | |
| F-028 | Plugins and internal marketplace with supply-chain controls | REQ-052, REQ-098 | 2 | 6 | 1 | 80% | 3 | 1.6 | Not started | |
| F-029 | Department admin console and subscriptions v2 (seat pools, requests, trials, billing export, alerts) | REQ-068, REQ-080, REQ-074 | 2 | 10 | 1 | 80% | 3 | 2.7 | Not started | |
| F-030 | Platform v2: SCIM, more providers and dept/personal keys, subagents, size routing, dept/project memory | REQ-018, REQ-026, REQ-057, REQ-051 | 2 | 8 | 1 | 80% | 4 | 1.6 | Not started | |
| F-031 | Telecom Edition core: read-only BSS/CDR connectors and Revenue Assurance pack | REQ-045, REQ-086 | 2 | 1.5 | 3 | 50% | 4 | 0.56 | Not started | |
| F-032 | Prompt registry, department eval suites and A/B testing | REQ-058 | 3 | 10 | 1 | 80% | 3 | 2.7 | Not started | |
| F-033 | Access requests with time-boxed grants | REQ-023 | 3 | 10 | 1 | 80% | 2 | 4.0 | Not started | |
| F-034 | Fraud Management pack | REQ-087 | 3 | 1 | 3 | 50% | 4 | 0.38 | Not started | |
| F-035 | Network Operations (NOC) pack with OSS / TM Forum connectors | REQ-091 | 3 | 2 | 2 | 50% | 4 | 0.5 | Not started | |
| F-036 | Wave-1 packs: Technology suite completion, business and finance packs, extra DB connectors | REQ-085, REQ-088, REQ-038 | 3 | 5 | 2 | 50% | 8 | 0.63 | Not started | |
| F-037 | HR pack (support-only) | REQ-089 | 3 | 2 | 1 | 50% | 3 | 0.33 | Not started | |
| F-038 | Wave-2 packs: Customer Care, Sales & B2B, Legal, Compliance & Regulatory | REQ-090 | 3 | 5 | 2 | 50% | 8 | 0.63 | Not started | |
| F-039 | DMS and cloud-storage connectors, indexed enterprise search | REQ-043, REQ-044 | 3 | 5 | 1 | 50% | 5 | 0.5 | Not started | |
| F-040 | Ecosystem: Copilot coexistence and skill/plugin authoring SDK | REQ-046, REQ-053 | 3 | 6 | 1 | 50% | 4 | 0.75 | Not started | |
| F-041 | Commercial packaging: platform-fee tiers and pay-per-use for published agents | REQ-082 | 3 | 3 | 0.5 | 50% | 2 | 0.38 | Not started | |
| F-042 | Air-gapped packaging and offline licensing | REQ-103, REQ-081 | 4 | 1 | 3 | 80% | 5 | 0.48 | Not started | |
| F-043 | High availability and in-region multi-tenant SaaS | REQ-104, REQ-105, REQ-110 | 4 | 10 | 1 | 80% | 5 | 1.6 | Not started | |
| F-044 | DLP label enforcement and SIEM export | REQ-097, REQ-075 | 4 | 10 | 1 | 80% | 3 | 2.7 | Not started | |
| F-045 | Wave-3 packs: Security Operations, Internal Audit, Enterprise Risk | REQ-092 | 4 | 3 | 2 | 50% | 6 | 0.5 | Not started | |
| F-046 | Telecom Edition bundle | REQ-093 | 4 | 2 | 2 | 50% | 3 | 0.67 | Not started | |

## RICE method

| Factor | Scale used |
|---|---|
| **Reach (R)** | 0–10 index. 10 = every user across all target deployments in the 12 months after the phase ships; 1 ≈ 10 % of them. Pack reach is the share of users in that department across the S1–S4 segments (MA-201, MA-202, MA-205). |
| **Impact (I)** | 3 massive (blocks pilot or regulated sale without it), 2 high, 1 medium, 0.5 low, 0.25 minimal. |
| **Confidence (C)** | 100 % (spec and market agree, well understood), 80 % (clear requirement, some unknowns), 50 % (depends on open questions, pilot data or unverified vendor facts). |
| **Effort (E)** | Product-level estimate in person-months, to be replaced by the tech lead's estimate at G3/G4. |

**How RICE is used:** RICE orders features *within* a phase. Phase placement is set by spec §13, dependencies and G1 direction (DV-n). Some strategically required features score low because reach is one department: F-022 (Technology pilot, 1.1), F-031 (RA, 0.56), F-034 (Fraud, 0.38). They are kept in place because the pilot and the Telecom Edition differentiation depend on them (summary R-3, MA-105, MA-201).

## Phases (spec §13)

### Phase 0: Foundations (≈4 weeks, spec)

**Goal:** a signed-in developer can chat with Claude from the CLI, through the Model Gateway, with every call audited and no provider key on the client.

| Feature | Title | RICE |
|---|---|---|
| F-002 | SSO sign-in (OIDC) and control-plane skeleton | 20.0 |
| F-004 | Model Gateway v0 (one provider, vault credentials, per-call audit) | 10.7 |
| F-003 | Local Agent Host and Agent Protocol core | 8.0 |
| F-001 | Engineering and design-system foundations | 5.0 |
| F-005 | CLI v0: sign-in and chat | 2.0 |

**Exit criteria**
- REQ-001, REQ-010, REQ-011, REQ-016, REQ-024, REQ-095 pass their acceptance criteria.
- Secret scan of repo, client builds, logs and database = 0 findings.
- Every Phase 0 model call has an audit event with user, model, tokens and inference region.
- Design-system tokens use logical (direction-neutral) layout; a demo screen renders in LTR and RTL; a11y lint runs in CI.
- CI builds, lints and tests all workspaces.

**Key dependencies**
- G2 approved, then G3 architecture decisions (control-plane language §15 Q3; policy engine §15 Q6).
- IdP test tenant (Entra ID assumed, A-1); Anthropic or Vertex account; vault instance.
- Anthropic commercial-terms review started (OQ-4, Q-L5).

### Phase 1: MVP, pilot-ready (spec ≈8–12 weeks; to be re-estimated, OQ-3)

**Goal:** a Qatar telco can run the **Technology pack (ITSM + Release Management)** in its own dedicated in-country cloud or on-prem, with SSO-scoped access, tier-based routing to local/in-region models, approvals, immutable audit, a regulator evidence pack, pooled usage limits, and an Arabic/English RTL UI.

| Feature | Title | RICE |
|---|---|---|
| F-011 | Immutable audit log, tracing and explainability | 10.0 |
| F-021 | Arabic/RTL and accessibility baseline | 10.0 |
| F-010 | Hooks, approvals and safety | 8.0 |
| F-006 | Identity and policy engine v1 | 6.0 |
| F-007 | Model Gateway v1 | 5.3 |
| F-019 | Skills and memory v1 | 5.3 |
| F-009 | MCP/Data Gateway v1 + 3 DB connectors | 4.8 |
| F-016 | Web app: Chat on server-side Agent Host | 4.8 |
| F-014 | Pooled usage allowance, spend limits, cost dashboards | 4.0 |
| F-020 | Token optimization v1 | 4.0 |
| F-023 | Dedicated in-country and on-prem deployment (DV-1) | 3.8 |
| F-012 | Regulator evidence and control (DV-3, DV-9, DV-10, DV-11) | 3.3 |
| F-008 | Sovereign routing and Arabic local model (DV-2) | 3.0 |
| F-013 | Subscriptions v1, entitlements, licensing | 2.7 |
| F-018 | Web Console v1 | 2.7 |
| F-017 | CLI v1 and Agent Protocol v1 | 1.3 |
| F-015 | Desktop app with Chat and Code | 1.2 |
| F-022 | Pack framework + Technology pilot pack (DV-6) | 1.1 |

**Exit criteria**
- Every Phase 1 **Must** REQ passes its acceptance criteria; Should REQs either pass or are explicitly deferred at G7.
- Reference deployment completed in one dedicated in-country cloud **and** one on-prem cluster (REQ-101, REQ-102).
- A T3 test tenant proves non-local model calls are blocked; masking golden set meets REQ-029 targets in Arabic and English.
- Penetration test: 0 open critical/high findings. Qatar NIA mapping and QCB outsourcing-annex template are complete (REQ-099).
- Evidence pack exported for a 90-day test range; kill-switch drill stops activity ≤ 30 s (REQ-064, REQ-070).
- DR drill meets RPO ≤ 15 min and RTO ≤ 4 h; load test meets REQ-110 at 1,000 concurrent users.
- Technology pack meets REQ-084 golden-set targets; UAT (G8) with pilot users completed on a release candidate.
- RTL visual regression and WCAG 2.1 AA audits pass for every Phase 1 screen.

**Key dependencies**
- **Q-B1** pilot customer, sponsor and system access confirmed (OQ-1); pilot IdP, ServiceNow/Jira and log source available (A-7).
- GPU capacity for local models from the customer or hosting partner (A-4); Arabic model shortlist (OQ-6).
- Regional model availability verified (OQ-5, Q-V1/Q-V2).
- Anthropic terms (OQ-4); CRA stance for telco data (OQ-7) before any T2 customer data.
- Tech-lead re-estimate of Phase 1 against the H1 2027 pilot target (OQ-3, MA-206).
- Trademark clearance before pilot go-live (OQ-15).

### Phase 2: Productivity & Web Scale (≈8 weeks, spec)

Telecom Edition core (read-only BSS/CDR + RA) moves here from Phases 3–4 (DV-7).

| Feature | Title | RICE |
|---|---|---|
| F-027 | Productivity and content connectors | 2.9 |
| F-026 | Docs workspace, extraction with Arabic OCR, Arabic document output | 2.8 |
| F-029 | Department admin console and subscriptions v2 | 2.7 |
| F-025 | Data workspace | 2.1 |
| F-024 | Web Workspace Runtime and Code on Web | 1.9 |
| F-028 | Plugins and internal marketplace | 1.6 |
| F-030 | Platform v2 (SCIM, providers/keys, subagents, routing, shared memory) | 1.6 |
| F-031 | Telecom Edition core: BSS/CDR connectors + RA pack (DV-7) | 0.56 |

Key dependencies: F-025 before F-031 (RA requires Data Workspace, §6.15.3); Q-L4 answer before connecting CDR data (OQ-7).

### Phase 3: Department Packs & Quality (≈10–12 weeks, spec)

NOC moves here from Phase 4 (DV-8). Copilot coexistence and commercial packaging added (DV-17, DV-5).

| Feature | Title | RICE |
|---|---|---|
| F-033 | Access requests with time-boxed grants | 4.0 |
| F-032 | Prompt registry, eval suites, A/B | 2.7 |
| F-040 | Ecosystem: Copilot coexistence, authoring SDK | 0.75 |
| F-036 | Wave-1 packs: Technology suite, business and finance | 0.63 |
| F-038 | Wave-2 packs: Customer Care, Sales, Legal, Compliance | 0.63 |
| F-035 | NOC pack (DV-8) | 0.5 |
| F-039 | DMS, cloud storage, indexed search | 0.5 |
| F-034 | Fraud Management pack | 0.38 |
| F-041 | Commercial packaging | 0.38 |
| F-037 | HR pack (support-only) | 0.33 |

### Phase 4: Enterprise Hardening & Editions

On-prem, ISO/SOC and Telecom Edition core moved earlier (DV-1, DV-9, DV-7). Air-gapped targets Y1.

| Feature | Title | RICE |
|---|---|---|
| F-044 | DLP label enforcement and SIEM export | 2.7 |
| F-043 | HA and in-region multi-tenant SaaS (DV-15) | 1.6 |
| F-046 | Telecom Edition bundle | 0.67 |
| F-045 | Wave-3 packs: SOC, Internal Audit, Enterprise Risk | 0.5 |
| F-042 | Air-gapped packaging and offline licensing | 0.48 |

## Coverage check

**Totals:** 110 REQs, 46 features. Features per phase: P0 5, P1 18, P2 8, P3 10, P4 5.

| Check | Result |
|---|---|
| Every REQ maps to ≥ 1 feature | **Pass.** REQ-001 to REQ-110 each appear in at least one feature's REQ list. |
| Every feature traces to ≥ 1 REQ | **Pass.** F-001 to F-046 each list at least one REQ. |
| Every spec goal G1–G9 has ≥ 1 REQ | **Pass.** See the goals traceability table in [prd.md](prd.md#goals-traceability). |
| No REQ contradicts §2.2 non-goals | **Pass.** See the table below. |

**REQs delivered across more than one feature (split delivery, not gaps):**

| REQ | Main feature (phase) | Other feature (phase) | Note |
|---|---|---|---|
| REQ-005 Code workspace | F-015 (1, Desktop) | F-024 (2, Web) | Web half waits for the sandbox (DV-16). |
| REQ-006 Data & Docs | F-025 (2) | F-026 (2) | One REQ per the spec's workspace grouping; two features. |
| REQ-007, REQ-008 | F-015 (1) | F-016 (1) | Same criteria tested on Desktop and Web. |
| REQ-081 Licensing | F-013 (1) | F-042 (4) | Offline licence file arrives with air-gapped. |
| REQ-094 Tiers | F-008 (1) | F-022 (1) | Routing uses tiers; pack framework enforces tier floors. |
| REQ-095 Secrets | F-002 (0) | F-004 (0) | Control plane and gateway both store secrets in the vault. |
| REQ-106, REQ-109 | F-021 (1) | F-001 (0) | F-001 delivers foundations only; the REQ is met in F-021. |
| REQ-110 Service levels | F-023 (1, pilot targets) | F-043 (4, 5,000 users) | Staged targets within one REQ. |

**Non-goal check (§2.2):**

| Non-goal | REQs near the boundary | Verdict |
|---|---|---|
| No model training/fine-tuning | REQ-030, REQ-058 (evals only) | No conflict |
| Not replacing systems of record | REQ-037, REQ-039, REQ-045 (connect, read-mostly) | No conflict |
| No autonomous high-risk decisions | REQ-061 makes this non-configurable; REQ-084, REQ-087, REQ-089 add pack controls | No conflict |
| No native mobile | REQ-009 (responsive web only) | No conflict |
| No public consumer product | REQ-082 pay-per-use still requires enterprise SSO; REQ-105 enterprise tenants only | No conflict. **Watch:** REQ-082 must never allow anonymous access. |
| Watch item (not a §2.2 conflict) | REQ-090 permits autonomous customer replies on channels an admin explicitly approves (§6.12.2) | Allowed by spec; flag for G2 so the product owner confirms the stance. |

**Gaps and risks found**

| # | Gap | Recommendation |
|---|---|---|
| GAP-1 | No REQ covers in-product onboarding/training for non-technical departments (§14 "user adoption" mitigation). | Add a Should REQ for Phase 1 at G2 (PRD OQ-19). |
| GAP-2 | Phase 1 carries 65 of 110 REQs (18 features) after the G1 pull-forwards; the spec's 8–12 weeks is unlikely to hold. | Tech lead re-estimates at G3 (OQ-3); deferral candidates listed there. |
| GAP-3 | REQ-084 and REQ-086 acceptance depends on pilot golden sets that don't exist yet. | Build golden sets with the pilot customer during Phase 1 discovery; owner: product-manager + pilot sponsor. |
| GAP-4 | Several numeric targets are *(proposed)* product numbers, not market-sourced (masking recall, OCR error rates, thresholds). | Confirm or adjust at G2; revisit with pilot data. |
| GAP-5 | KSA NDMO classification mapping has no firm phase (REQ-094 says "before KSA entry"). | Fix a phase when the KSA timing (summary R-2, Azure/AWS KSA Nov/Dec 2026) is confirmed. |
| GAP-6 | Feature briefs (`docs/features/F-nnn-slug/brief.md`) and GitHub issues are not yet created. | Run `/feature-new` for Phase 0 and Phase 1 features after G2; create issues only after human confirmation. |
