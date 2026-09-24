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

- Never approve a gate (G1–G8). Leave approval blocks for humans.
- Never push to `main`, merge PRs, push tags, publish releases or deploy without explicit human approval for that action.
- Use the templates in `docs/adlc/templates/` and the traceability IDs (MA, REQ, ADR, F, TC, UAT).
- Governance is part of every feature: SSO/policy enforced server-side, audit on every tool and model call, approvals for side effects, residency respected, and document or email content treated as untrusted.
- UI must support Arabic/RTL (logical CSS properties, i18n keys) and meet WCAG 2.1 AA.

## Repo

pnpm workspaces + Turborepo: `apps/` (web, desktop, cli), `packages/` (ui, workbench, views, protocol, auth, sdk), `services/`, `packs/`, `deploy/`. Commands: `pnpm install`, `pnpm lint`, `pnpm test`, `pnpm build`.
Branches: `feat/F-nnn-slug`, `fix/...`, `hotfix/vX.Y.Z`. Commit messages reference `F-nnn` where applicable.
