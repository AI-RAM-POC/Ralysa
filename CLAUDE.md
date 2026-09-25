# Ralysa: agent guide

Ralysa is an AI workspace for every enterprise department ("every department, one AI"). The product and architecture spec is in `requirements/Ralysa_Spec.md`. Read the relevant sections before doing any substantive work.

## How we work: the ADLC

All work follows the Agentic Development Life Cycle in [docs/adlc/README.md](docs/adlc/README.md). Agents do each phase, and a human approves each gate.

| Phase | Command | Agent(s) |
|---|---|---|
| 1 Market analysis | `/market-analysis [topic]` | market-analyst |
| 2 Requirements | `/requirements`, `/feature-new "<title>"` | product-manager |
| 3 Architecture | `/architecture [topic]` | architect, security-reviewer |
| 4 Solution design | `/design F-nnn` | solution-designer (+ architect, security-reviewer) |
| 5 Development | `/implement F-nnn` | developer, code-reviewer |
| 6 Testing | `/test F-nnn` | test-engineer, security-reviewer |
| 7 Release | `/release X.Y.Z` | release-manager |
| 8 UAT | `/uat F-nnn` | uat-coordinator |
| Status | `/adlc-status` | (none; read-only report) |

## Hard rules

- **Standing authorization (Ram Mohan Rao Adduri, founder / product owner, 2026-09-25).** Agents may do the following without asking each time:
  - commit, push, open PRs, and squash-merge to `main` once CI passes and the code-reviewer agent approves
  - record gates G4–G8 in the approver's name, after the required agent reviews pass
  - decide open design and implementation questions by taking the recommended option
  - cut release tags and GitHub releases

  Each approval row recorded this way must say "standing authorization, recorded by Claude", and each self-decided question must be logged in the artifact. A G8 row must also state honestly whether real department users tested the feature or only the uat-coordinator agent simulated it. Still stop and ask for external blockers (commercial terms, cloud accounts, credentials, legal opinions), for G1–G3 changes, and for deploying to any customer or production environment.
- Never push to `main` directly; land every change through a PR.
- Use the templates in `docs/adlc/templates/` and the traceability IDs (MA, REQ, ADR, F, TC, UAT).
- Governance is part of every feature: SSO/policy enforced server-side, audit on every tool and model call, approvals for side effects, residency respected, and document or email content treated as untrusted.
- UI must support Arabic/RTL (logical CSS properties, i18n keys) and meet WCAG 2.1 AA.

## Repo

pnpm workspaces + Turborepo: `apps/` (web, desktop, cli), `packages/` (ui, workbench, views, protocol, auth, sdk), `services/`, `packs/`, `deploy/`. Commands: `pnpm install`, `pnpm lint`, `pnpm test`, `pnpm build`.
Branches: `feat/F-nnn-slug`, `fix/...`, `hotfix/vX.Y.Z`. Commit messages reference `F-nnn` where applicable.
