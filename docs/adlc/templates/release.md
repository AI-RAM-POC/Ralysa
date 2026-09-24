# Release vX.Y.Z

> Phase 7 · Owner: release-manager · Target date: YYYY-MM-DD · RC: vX.Y.Z-rc.N

## Scope
| Feature | PR(s) | G5 review | G6 test | G8 UAT | Notes |
|---|---|---|---|---|---|

## Readiness checklist
- [ ] CI green on release commit <sha>
- [ ] No open Blocker/Major bugs for this release
- [ ] Migrations reversible or forward-fix documented
- [ ] Security review done for auth/gateway/connector changes
- [ ] Release notes & docs updated
- [ ] Rollback plan written and tested on staging

## Release notes (user-facing)
### Added
### Changed
### Fixed
### Security

## Deployment plan
Staging → UAT → Production steps (deploy/helm), owners and timings.

## Rollback plan
Trigger criteria, steps, data considerations.

## Go / No-go
| Evidence | Status |
|---|---|
| Tests (G6) | |
| UAT (G8) | |
| Security | |
| Open risks | |

## Post-release verification
Smoke tests, dashboards, error rates, incidents, follow-ups.

## Approval (G7 Release: go-live decision)

> Filled by a human only. Agents must leave this blank.

| Approver | Role | Decision (Approved / Changes requested) | Date | Notes |
|---|---|---|---|---|
| | | | | |
