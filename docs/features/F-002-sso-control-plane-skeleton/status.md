# F-002: SSO sign-in (OIDC) and control-plane skeleton: Status

- **Current phase:** 5 – Development (T01–T06, T16 and the SEC-F002-34 remediation merged: #18, #19, #21, #23, #24; T07 in review; T08 next)
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
