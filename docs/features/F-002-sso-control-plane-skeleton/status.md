# F-002: SSO sign-in (OIDC) and control-plane skeleton: Status

- **Current phase:** 5 – Development (T01–T03 merged in #18; T04–T05 in review #19; T06 on `feat/F-002-audit-core`, stacked on #19)
- **GitHub issue:** https://github.com/AI-RAM-POC/Ralysa/issues/5
- **Branch / PR:** `feat/F-002-foundations` (T01–T03, #18, merged); `feat/F-002-secrets-db-audit` (T04–T05)
- **Release:**

## Open items
| Item | Owner / where it lands | Notes |
|---|---|---|
| CODEOWNERS entries by folder for `packages/protocol/src/{common,audit,auth,control-plane}` (and `agent` for F-003) [AR-18], deferred from F-002-T01 | F-001-T18 (adds `.github/CODEOWNERS`, SEC-F001-04); the F-002 lines are appended there or in a follow-up once the file exists | `.github/CODEOWNERS` does not exist yet and is a human-merge path. Proposed entries: implementation-notes.md T01-1. Owners must be named by the founder. |

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
