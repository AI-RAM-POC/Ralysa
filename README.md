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
```

## Tooling

pnpm workspaces + Turborepo.

```bash
pnpm install
pnpm build
```
