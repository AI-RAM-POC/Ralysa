# F-002: SSO sign-in (OIDC) and control-plane skeleton: Status

- **Current phase:** 5 – Development (T01–T09, T11, T16 and the SEC-F002-34 remediation merged: #18, #19, #21, #23–#28; T10 in review as two stacked PRs; T12 next)
- **GitHub issue:** https://github.com/AI-RAM-POC/Ralysa/issues/5
- **Branch / PR:** `feat/F-002-foundations` (T01–T03, #18, merged); `feat/F-002-secrets-db-audit` (T04–T05)
- **Release:**

## Open items
| Item | Owner / where it lands | Notes |
|---|---|---|
| CODEOWNERS entries by folder for `packages/protocol/src/{common,audit,auth,control-plane}` (and `agent` for F-003) [AR-18], deferred from F-002-T01 | F-001-T18 (adds `.github/CODEOWNERS`, SEC-F001-04); the F-002 lines are appended there or in a follow-up once the file exists | `.github/CODEOWNERS` does not exist yet and is a human-merge path. Proposed entries: implementation-notes.md T01-1. Owners must be named by the founder. |
| SEC-F002-35 (b)–(d): checkpoint-key recovery by key epoch (key id or thumbprint in `audit_checkpoint`, payload v2, `retired_checkpoint_keys`); `audit-verify` still verifies the chain with a flagged key (`key_custody_violated`); full "checkpoint key compromised" runbook | **Blocks G6** unless a named human accepts them in writing as F-011 prerequisites | security.md T16-1 review §C/§E; implementation-notes "T16-1 remediation" |
| SEC-F002-36: pin the checkpoint trust anchor (JWK thumbprints logged by the sealer and pinned in `audit-verify`; separate OpenBao admin from DB superuser) | **Blocks G6** unless a named human accepts it in writing as an F-011 prerequisite | same |
| SEC-F002-37: detect a checkpoint key recreated under the same name across restarts (thumbprint tracking; the signer already stays stopped in-process) | **Blocks G6** unless a named human accepts it in writing as an F-011 prerequisite | same |
| RFC 8414 metadata (T07) already advertises the authorize, token and revoke endpoints and all four grants; the token/revoke routes land in T08 and authorize/callback plus the authorization_code and token-exchange grants in T10 | **No release may be cut before T08 and T10 have landed** | T07-4; code review of #25 |
| TC-F-002-02 end to end (flow A against the mock IdP plus the token-exchange grant) | T10, using T09's mock IdP and `@ralysa/auth`'s client flows | T11 covers the client half with fakes (implementation-notes T11-1). |
| TC-F-002-10's 20 stored `auth.token_rejected` events; the gateway-side aggregator in `packages/auth` or shared (§2.1 `verify/rejections.ts`); moving the control plane's own verifier onto `createAccessTokenVerifier` with a database `RevocationSource` | T12 | implementation-notes T11-2, T11-11 |
| Metrics exporter: `serve` passes no exporter, so the counters (`auth_device_ip_mismatch_total`, `idp_group_claims_ignored_total`, `graph_failures_total`, `audit_write_failures_total`, …) go to `noopMetrics` (review of #29, R29-n5) | Observability (Prometheus endpoint or OTel metrics), F-011 / F-023 | Until then the alert rules key on the log lines (`auth_device_ip_mismatch`, `sign_in_audit_unavailable`). |
| CLI message for the ~30 s `revoked_before` window after a revocation (T10 open item) | F-005 | [#31](https://github.com/AI-RAM-POC/Ralysa/issues/31) |
| UAT note: on dual-stack hosts the browser and the CLI may reach RTS over different IP families, so `access.loopback_ip_mismatch: deny` (default) can refuse a genuine flow-B sign-in | UAT (F-002) | implementation-notes R30-n5; the fallback is the tenant setting `alert` |
| SEC-F002-38: without the checkpoint log, tail truncation is invisible (`anchor: none` exit code; require `--log-checkpoints` outside dev; ship the log off-host) | **Blocks any non-dev deployment** | same |

## Gate log
| Gate | Artifact | Approver | Date | Result |
|---|---|---|---|---|
| G2 Scope | brief.md | | | |
| G4 Design | design.md | Ram Mohan Rao Adduri (standing authorization, recorded by Claude) | 2026-09-25 | Approved |
| G5 Code review | PR | | | |
| G6 Quality | test-report.md | | | |
| G7 Release candidate | docs/releases/ | | | |
| G8 UAT sign-off | uat.md | | | |

## History
| Date | Event |
|---|---|
| 2026-09-25 | Feature workspace created from ADLC templates. brief.md drafted by product-manager from the PRD (G2 approved 2026-09-25 with conditions). Brief-level G2 approval pending. |
| 2026-09-25 | Solution design written; architect review (sound, RC-1..12) and security review (security.md, 2 High) applied; G4 recorded under standing authorization. |
| 2026-09-25 | Phase 5 started. T01 (workspaces), T02 (dev stack, bootstrap, `integration` CI job) and T03 (protocol contracts, JSON Schema generator) implemented on `feat/F-002-foundations`; see implementation-notes.md. |
| 2026-09-25 | T01–T03 merged (#18). T04 (packages/secrets) and T05 (database, audit store, migrations) implemented on `feat/F-002-secrets-db-audit`; T06 split to a follow-up PR (slice size). |
| 2026-09-25 | #19 review round 1 addressed (R19-1..3). T06 (audit core: writer, spool, rejections, chain, sealer entry point, db.migration.applied) implemented on `feat/F-002-audit-core`. |
| 2026-09-25 | T06 merged (#21). T16 (signed checkpoints, custody monitor on the checkpoint key, `audit-verify`) implemented on `feat/F-002-checkpoints`. |
| 2026-09-25 | T16 (#23) and the T16-1 remediation (#24, SEC-F002-34) merged. T07 (config, guards, HTTP layer, signing keys, discovery, `serve`) implemented on `feat/F-002-app-skeleton`. |
| 2026-09-25 | T07 (#25) and T08 (#26) merged. T09 (mock IdP: Entra-shaped `oidc-provider`, fixtures, Graph stub, loopback test-control API with a per-run bearer, per-run keys, compose `mock-idp` service) implemented on `feat/F-002-mock-idp`; see implementation-notes.md T09. |
| 2026-09-25 | T11 (`packages/auth`) implemented on `feat/F-002-auth-package`, in parallel with T09. It covers the verifier, JWKS cache, revocation feed (G-1, freshness and epoch), principal resolver, service-token source and Transit assertion signer, plus the client flows and the single-flight token manager. TC-F-002-10, -11, -12 and -09 (gateway part) pass. TC-F-002-02 passes its client half against fakes; the end-to-end run waits for T09 and T10 (T11-1). Storing `auth.token_rejected` events waits for T12 (T11-2). |
| 2026-09-26 | T10 part 1 (flow A: Entra token validator with pinned discovery, consume-first replay key, Microsoft Graph directory with timeouts and circuit breaker, identity mapping with the strong-flow admin rule, the sign-in core with fail-closed audit, the token-exchange grant, the device-code switch, `POST /v1/auth/sign-in-failures`) implemented on `feat/F-002-idp-sign-in`, with the R27-N7 mock fix. TC-F-002-02 (end to end through `@ralysa/auth`, closing T11-1), -03, -04, -08 (flow A), -09, -21, -24, -31 and the flow-A part of -07 pass. Flow B (part 2) follows on a stacked branch. See implementation-notes.md T10. |
| 2026-09-26 | T10 part 2 (flow B: `openid-client` relying party, `/oauth2/authorize` with the browser-binding cookie, `/oauth2/idp/callback` with `DELETE … RETURNING`, the bound `authorization_code` grant with the redemption-IP check and the success event at redemption; migration `cp/0006`) implemented on `feat/F-002-idp-sign-in-browser`, stacked on part 1. TC-F-002-01, -30, and the flow-B parts of -07, -08 and -31 pass. |
