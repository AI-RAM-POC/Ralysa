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

pnpm workspaces + Turborepo on Node.js 24 LTS. pnpm comes from Corepack, which verifies the hash in `package.json#packageManager`.

```bash
nvm use && corepack enable
pnpm install
pnpm lint && pnpm typecheck && pnpm test && pnpm build
pnpm repo:check                                  # workspace, tsconfig and Turbo checks + prettier
pnpm scaffold services/<name> --kind service     # turn a placeholder into a real package
```

Conventions (workspaces, scaffold kinds, `test` vs `test:integration`, dependency rules) are in [docs/engineering/repo-conventions.md](docs/engineering/repo-conventions.md).
