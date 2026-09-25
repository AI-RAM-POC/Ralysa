# control-plane

`@ralysa/control-plane`: Profiles, policies, skills, plugins, memory, approvals, audit API.

F-002 builds the Phase 0 slice: the Ralysa Token Service (OIDC relying party toward Entra ID,
OAuth authorization server toward Ralysa clients), users, groups and sessions, the audit store
with its sealer and signed checkpoints, and the governance feed. Design:
[docs/features/F-002-sso-control-plane-skeleton/design.md](../../docs/features/F-002-sso-control-plane-skeleton/design.md).

## Scripts

| Script | What it runs |
|---|---|
| `test` | Hermetic unit tests (`test/**/*.test.ts`). |
| `test:integration` | `test/integration/**/*.int.ts` against the dev stack (`deploy/docker/dev`, see `tooling/dev-stack`). |

## Configuration

None yet. Each entry point gets its own config schema in F-002-T07 (design §3.8).
