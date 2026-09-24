# Ralysa

*Every department, one AI.* See [requirements/Ralysa_Spec.md](requirements/Ralysa_Spec.md) for the full product and architecture specification.

## Repository layout

```
apps/        web (Vite SPA), desktop (Electron), cli (Ink)
packages/    ui, workbench, views, protocol, auth, sdk
services/    agent-host, control-plane, model-gateway, mcp-gateway, workspace-runtime, extraction
packs/       department packs (technology, finance, hr, ... soc)
deploy/      helm, terraform, docker
requirements/ product specification
docs/        ADLC framework and lifecycle artifacts
.claude/     ADLC agents and phase commands
```

## How we build

Ralysa is built using an **Agentic Development Life Cycle**: agents do each phase and humans approve each gate. See [docs/adlc/README.md](docs/adlc/README.md) and [CLAUDE.md](CLAUDE.md).

```
/market-analysis → /requirements → /architecture → /feature-new → /design → /implement → /test → /release (RC) → /uat → /release go-live
```

## Tooling

pnpm workspaces + Turborepo.

```bash
pnpm install
pnpm build
```
