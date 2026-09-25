# F-002: SSO sign-in (OIDC) and control-plane skeleton: Feature Brief

> Phase 2 · Owner: product-manager · Release phase: **0 (Foundations)** · Source: [PRD](../../product/prd.md) (G2 approved 2026-09-25 with conditions), [roadmap](../../product/roadmap.md), spec §4 D3, §5.1, §6.4.1, §8 (Authentication, Secrets, Audit), §11, §13 Phase 0
> MoSCoW: Must (REQ-016, REQ-095) · RICE 20.0 (R 10 · I 3 · C 100 % · E 1.5)

## Problem

Spec §4 D3 says SSO login decides access, and the decision is enforced server-side. Without a control plane that authenticates users against the enterprise IdP and issues short-lived Ralysa tokens, nothing else can happen safely:
- no gateway can attribute a model call to a person,
- no audit event can name an actor,
- no client can be trusted.

Enterprise buyers in the target segments reject products with local passwords or credentials stored outside a vault (spec §8; MA-301, MA-306). This feature delivers the smallest control plane that makes identity real in Phase 0:
- OIDC sign-in with one IdP, including the device-authorization flow the CLI needs
- user and group records
- token issuance and validation for other Ralysa services
- a Phase 0 audit event store
- vault-held secrets

Everything later (policy, profiles, subscriptions, Console) builds on it.

## Personas & surfaces

| Persona | Need |
|---|---|
| DEV, TM (Phase 0 users) | Sign in once with company credentials and MFA, never a Ralysa password. |
| PA | Configure the IdP connection, the allowed access group and the admin group. Query sign-in audit. Rotate secrets without an outage. |
| ASR (indirect, Phase 1+) | Relies on complete, attributable sign-in audit from the start. |
| ALL (from Phase 1) | Same sign-in on every surface (REQ-016 persona = ALL). |

**Surfaces:** Service (control plane) and CLI (as the Phase 0 client through F-005). Browser sign-in happens on the IdP's own pages. Phase 0 plans no Ralysa-hosted web page (see Arabic/RTL).

## Requirements covered

| REQ | Phase 0 scope in this feature | Deferred |
|---|---|---|
| REQ-016 SSO-only sign-in through the enterprise IdP via OIDC; no local passwords; MFA by the IdP (Must, Phase 0) | All four criteria (a)–(d) for **one IdP** (Microsoft Entra ID test tenant, PRD A-1), web-redirect and device-authorization grants. | Okta, Ping, Keycloak and Google Workspace; SAML; Desktop PKCE; configurable token lifetime; admin session revocation: REQ-017, **F-006** (Phase 1). SCIM: REQ-018, F-030 (Phase 2). |
| REQ-095 All credentials in a vault; never on clients, in prompts, in logs or in the database (Must, Phase 0) | Control-plane scope: IdP client credentials, token-signing keys and service credentials held in the vault, and rotated without downtime. Criteria (a) and (b) for control-plane components. | Model-provider credentials are **F-004**. CLI package scan is **F-005**. CI secret-scan capability is **F-001**. Customer-managed keys are REQ-096 (Phase 1). |

## User stories

- As a developer, I want to sign in with my company account and MFA so that I never create or type a Ralysa password.
- As a platform admin, I want only members of one configured IdP group to be able to use Ralysa in Phase 0 so that access is decided by SSO before the policy engine exists.
- As a platform admin, I want a user I disable in the IdP to lose Ralysa access automatically so that leavers can't keep using it.
- As a platform admin, I want every sign-in success, failure and denial audited so that I can answer "who got in, and who tried" for any time range.
- As a platform admin, I want to rotate the IdP client secret and token-signing keys without an outage so that credential hygiene doesn't cost availability.
- As another Ralysa service (Agent Host, Model Gateway), I need to validate a Ralysa access token and learn the user and their groups so that I can attribute and authorize every call server-side.

## Acceptance criteria

Timing values marked *(proposed)* need confirmation at G4 (G2 condition).

| ID | Given | When | Then |
|---|---|---|---|
| AC-1 | A user in the configured Entra ID test tenant who is in the configured Ralysa access group | They complete OIDC sign-in (browser-redirect grant) | Ralysa issues a session. A User record exists with `idp_subject`, email, display name, `org_id` and the group claims from the token. On a later sign-in after an IdP group change, the stored groups match the new claims. (REQ-016(b)) |
| AC-2 | A client starts a device-authorization sign-in | The control plane responds | The client receives a user code, a verification URL and a polling interval. After the user completes IdP sign-in with MFA, the next poll returns Ralysa tokens. Redeeming an expired or already-used code is refused. (REQ-016; enables REQ-001(a) in F-005) |
| AC-3 | The published control-plane API description and every Phase 0 client | They are reviewed and scanned automatically | No endpoint accepts a password or other shared-secret user credential, and no Ralysa UI or CLI prompt asks for one. MFA is required by IdP configuration and is never bypassed by a Ralysa flow. (REQ-016(a)) |
| AC-4 | Any sign-in attempt | It succeeds, fails at the IdP, or is denied by Ralysa | An audit event is written with timestamp, actor (`idp_subject`, or the attempted identifier where the IdP returns none), action `auth.sign_in`, outcome (`success` / `failure` / `denied`), reason category, client type, source IP and `trace_id`. Across 50 scripted attempts, event count equals attempt count. Events contain 0 tokens, codes or secrets. (REQ-016(c)) |
| AC-5 | A user authenticated by the IdP but **not** in the configured access group | They try to sign in | No Ralysa tokens are issued. The client shows a message telling them to contact their administrator. An audit event records `outcome=denied`. |
| AC-6 | A user who is disabled in the IdP | They try to sign in, or their client tries to refresh a token | Sign-in is refused and refresh is refused, and both are audited. The Model Gateway accepts no request from that user after their current access token expires. Access tokens live ≤ 15 min *(proposed; REQ-017(b) default)*. (REQ-016(d)) |
| AC-7 | A Ralysa access token presented to another Ralysa service | The service validates it | A valid token yields user id, `org_id` and groups. An expired token, one with a tampered signature, one for the wrong audience, or one from an unknown issuer is rejected. In 100 % of 20 negative cases the rejection is audited with `outcome=denied`. |
| AC-8 | A signed-in user | They sign out (as `/logout` in F-005 calls it) | Their refresh token is revoked at the control plane. Any later refresh with it is refused and audited. |
| AC-9 | The IdP client secret, token-signing keys and control-plane service credentials | The database, service logs, configuration files and container images are scanned | Scan findings = **0**. The database holds only vault references (`Credential.vault_path`), never secret values. (REQ-095(a)) |
| AC-10 | Continuous sign-in and token-validation traffic (≥ 1 request/s for 10 min) | The IdP client secret and the token-signing key are rotated in the vault | 0 requests fail because of the rotation. Tokens signed with the previous key stay valid until they expire. The new values are in use ≤ 5 min after rotation *(proposed)*. (REQ-095(b)) |
| AC-11 | An authenticated Ralysa service (Model Gateway, Agent Host) | It submits an audit event | The event is stored append-only with `id`, `ts`, `actor`, `action`, `resource`, `outcome`, `trace_id` and optional `inference_region`, `model`, `tokens_in`, `tokens_out`, `session_id`. A caller without a valid service identity is refused. No API exists to update or delete an event. |
| AC-12 | A user in the configured platform-admin IdP group | They query audit events by user, action, outcome and time range through the control-plane API | Matching events are returned. A user outside that group gets a denial, and the denied query is itself audited. |
| AC-13 | The control-plane data store | Its entities are inspected | Organization (with `residency`), User (with `locale`), Group, AuditEvent, UsageRecord and Credential exist with the spec §11 fields needed in Phase 0. `inference_region` is on AuditEvent and UsageRecord (DV-12). |
| AC-14 | Control-plane operational logs from the AC-4 and AC-10 test runs | They are scanned | They contain 0 access, refresh or ID tokens, authorization or device codes, or secrets. Users appear by internal user id, not email. |
| AC-15 | A user whose IdP display name and group names are in Arabic (synthetic test user) | They sign in and their record is read back through the API | Display name and group names round-trip byte-identical in UTF-8. |

## Governance

- **Access (SSO groups / policy):**
  - SSO-only, server-side.
  - Phase 0 access = membership of **one configured access group** (AC-5), plus a **platform-admin group** for admin APIs (AC-12). Both are set by deployment configuration.
  - Profiles and the declarative policy engine replace this in F-006 (REQ-019 to REQ-021).
  - The decision is enforced in the control plane and, through token validation, in every Ralysa service (AC-7). Clients only reflect it.
- **Approvals required:** None for user actions. F-002 has no side-effecting agent actions. Changing the access-group or admin-group configuration is a deployment change through the normal review process in Phase 0. It becomes an audited Console action in F-018.
- **Audit events:**
  - `auth.sign_in` (success / failure / denied)
  - `auth.refresh` (denied)
  - `auth.sign_out`
  - `auth.token_rejected`
  - `audit.query` (success / denied)
  - `secret.rotated`

  Phase 0 audit is append-only through the API. Tamper-evidence, immutable storage, retention and SIEM export are F-011 and F-044.
- **PII / data classification / residency:**
  - Stored PII is limited to `idp_subject`, email, display name, group membership, locale and source IP in audit.
  - Operational logs use internal ids, not email (AC-14).
  - Phase 0 environments hold **internal and synthetic identities only**, with no customer data (PRD A-5).
  - Organization carries a `residency` setting from Phase 0. Enforcement and tests of "no tenant content outside region" are REQ-096 (F-023, Phase 1).

## Non-functional (spec §12)

| §12 category | Phase 0 target |
|---|---|
| Security (§8 Authentication, Secrets) | AC-3, AC-6, AC-7, AC-9, AC-10 and AC-14. The pentest comes before pilot go-live (REQ-099, Phase 1). |
| Latency | Token validation adds ≤ 10 ms p95 to a gateway request *(proposed)*, so the §12 gateway overhead budget (p95 < 100 ms, measured in F-004) holds. |
| Observability | 100 % of sign-in attempts audited (AC-4). Each audit event carries a `trace_id`. |
| Recoverability | No Phase 0 target. RPO ≤ 15 min and RTO ≤ 4 h are proven by DR drill in Phase 1 (REQ-110). |
| Availability, scale | No Phase 0 target. Phase 1: REQ-110 (1,000 concurrent users). |
| Accessibility, localization | See Arabic/RTL. |

## Arabic / RTL

- Arabic names and group names are stored and returned without corruption (AC-15).
- User has a `locale` field (AC-13), which F-021 uses for profile-driven locale.
- Phase 0 plans **no Ralysa-hosted web page**: IdP pages handle sign-in, and the CLI shows the result. If design introduces one (for example, a "you can return to your terminal" page), it must use F-001 tokens and i18n keys, ship in `en` and `ar` with RTL, and pass the F-001 a11y scan. That would be a scope change to note at G4.

## Out of scope

- IdPs other than Entra ID; SAML; Desktop PKCE; configurable token lifetime; admin session revocation ≤ 60 s (REQ-017, F-006).
- Group→profile mapping, declarative policy and hidden tools (REQ-019 to REQ-022, F-006).
- SCIM provisioning (REQ-018, Phase 2).
- Web Console `/me` and `/admin` (F-018).
- Subscriptions and entitlements (F-013).
- Immutable, tamper-evident audit, retention policy and explainability (F-011); SIEM export (F-044).
- Multi-tenant SaaS (REQ-105, Phase 4). Phase 0 assumes **one organization per deployment**. The data model keeps `org_id`.
- Technology choices for the control-plane language, IdP library, vault product and database layout (spec §15 Q3; architect at G3).

## Dependencies

| Type | Item |
|---|---|
| Other features | **Upstream:** F-001 (monorepo and CI baseline, secret scan). **Downstream:** F-003 (validates tokens, writes tool audit events), F-004 (validates tokens, writes model audit events and usage records), F-005 (device-code sign-in, sign-out). F-002 is the critical-path start of Phase 0. |
| Architecture (G3) | Control-plane language (spec §15 Q3) and the token model are decided by the architect before `/design F-002`. |
| External | Entra ID test tenant with an app registration and test users, including an Arabic-named user and a disabled user (PRD A-1). A vault instance for the dev environment. |
| Process | Brief-level G2 approval, then G3 decisions, then `/design F-002` (G4). |

## Success metrics

| Metric | Target | Measured by |
|---|---|---|
| Sign-in attempts with an audit event | 100 % | AC-4 reconciliation |
| Secret-scan findings in control-plane DB, logs, config and images | 0 at Phase 0 exit | AC-9 scan |
| Failed requests during secret rotation | 0 | AC-10 test |
| Password fields or password-accepting endpoints | 0 | AC-3 review |
| Time for a disabled IdP user to lose all model access | ≤ 15 min *(proposed)* | AC-6 test |

## Open questions

| # | Question | Recommendation | Owner |
|---|---|---|---|
| OQ-F002-1 | How is access decided in Phase 0, before profiles and policy (F-006)? | One configured IdP **access group** grants use, and one **admin group** grants audit query and admin APIs. Both are deployment config and replaced by F-006. | Product owner |
| OQ-F002-2 | Access-token lifetime in Phase 0. | 15 min, matching the REQ-017(b) proposal. Confirm at G4 (G2 condition). | Product owner + architect |
| OQ-F002-3 | Which IdP for Phase 0? | Microsoft Entra ID (PRD A-1). Revisit if the pilot customer (OQ-1) uses another IdP. | Founder |
| OQ-F002-4 | One organization per deployment in Phase 0? | Yes. This matches "customer-operated first" (PRD OQ-12, R-4). Keep `org_id` on every entity so multi-tenant SaaS (REQ-105) needs no migration of meaning. | Product owner |
| OQ-F002-5 | Should Phase 0 audit store prompt text? | No. Phase 0 audit is metadata only until the retention-per-tier decision (PRD OQ-16) is made in F-011. | Product owner + CISO advisor |

**G2 approval conditions (2026-09-25) and how they affect this feature:**
- *(Proposed)* numeric targets are confirmed at design: applies to AC-6, AC-10 and the latency target.
- Phase 1 re-estimate: F-006 will extend this skeleton, so its effort depends on the control-plane decisions made here.
- REQ-090, DV-16 and the onboarding REQ: not applicable.

Scope derived from PRD approved at G2 (2026-09-25); brief-level approval pending.

## Approval (G2)

> Filled by a human only. Agents must leave this blank.

| Approver | Role | Decision (Approved / Changes requested) | Date | Notes |
|---|---|---|---|---|
| | | | | |
