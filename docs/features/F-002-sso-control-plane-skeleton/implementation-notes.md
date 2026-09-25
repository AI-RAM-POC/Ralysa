# F-002: Implementation notes

> Phase 5 · Owner: developer agent · Branch `feat/F-002-foundations` (T01–T04, one commit per task) · Design: [design.md](./design.md) (G4 recorded 2026-09-25) · Security review: [security.md](./security.md) · Date: 2026-09-25
> These notes carry the evidence the design asks each task to record: versions, deviations, "to verify" results and anything left open. The PR description links here.

## Environment

- Node.js **24.21.0**, pnpm **11.27.1** (Corepack), Turbo 2.11.2, TypeScript 6.0.3, Vitest 4.1.11.
- Docker Desktop on macOS (darwin_arm64): `docker info` succeeds, so the dev stack and `test:integration` ran locally (see T02 and T04).

## T01: workspaces

### What landed

- `pnpm scaffold services/control-plane --kind service`, `packages/auth --kind library-isomorphic`, `packages/protocol --kind library-isomorphic` (F-003 had not scaffolded it; it was still a placeholder) and `packages/secrets --kind library-isomorphic` (new folder). The placeholders' READMEs were kept and extended.
- `tooling/dev-stack` by hand from the service template: `ralysa.kind: "tooling"`, `shipped: false`, `artefacts: []`. Its `tsconfig.json` allows `.ts` import extensions with `erasableSyntaxOnly` (like `@ralysa/repo-scripts`), because the `.env` generator must run on plain Node before `pnpm install` (design §8.2); `tsconfig.build.json` sets `rewriteRelativeImportExtensions` so `build` still emits a runnable `dist/` for the T09 compose `mock-idp` service.
- `packages/protocol` subpath exports `./common`, `./audit`, `./auth`, `./control-plane` (plus `.`, which re-exports each family as a namespace). `./agent` is left for F-003 [AR-18].
- `test:integration` (`vitest run --config vitest.integration.config.ts`) in `services/control-plane`, `packages/secrets` and `tooling/dev-stack`, each with a wiring test `test/integration/wiring.int.ts`.
- New shared Vitest preset `integration` in `@ralysa/vitest-config`: `test/integration/**/*.int.ts` only, longer timeouts, used on its own because `mergeConfig` concatenates `include` arrays. The hermetic `node` include never matches `*.int.ts` (preset test).
- Repo check `deps/dev-only-in-shipped` in `check-workspaces`, over the list `DEV_ONLY_PACKAGES = ['@ralysa/dev-stack', 'oidc-provider']` in `tooling/eslint-config/boundaries.js` (the shared boundary list, so T14's dependency-cruiser and `check-banned-deps` modes read the same list).

### Recorded decisions and deviations

| # | Type | What | Why |
|---|---|---|---|
| T01-1 | **Not done, by instruction** | `.github/CODEOWNERS` entries by folder for `packages/protocol/src/{common,audit,auth,control-plane}` [AR-18]. | `.github/CODEOWNERS` does not exist in the repository, and CODEOWNERS is human-merge territory. **Proposed entries for a human to add** (owners to be named by the founder): `/packages/protocol/src/common/ @<f-002-owner>`, `/packages/protocol/src/audit/ @<f-002-owner>`, `/packages/protocol/src/auth/ @<f-002-owner>`, `/packages/protocol/src/control-plane/ @<f-002-owner>`, `/packages/protocol/src/agent/ @<f-003-owner>`. |
| T01-2 | Scope of the first exclusion check | `deps/dev-only-in-shipped` walks the **workspace graph**: a `shipped: true` workspace fails if a development-only package is in its `dependencies`, `optionalDependencies` or `peerDependencies`, or in those of any workspace reachable through them. The finding names the witness path. `devDependencies` are allowed (integration tests import the harness from `test/**`). | The design's T01 row asks for "no `shipped: true` workspace depends on `@ralysa/dev-stack`"; walking workspace production edges is the same check made transitive at no cost. The lockfile closure (an npm package that pulls `oidc-provider` in) is T14's `check-banned-deps` production-closure mode, as designed. `@ralysa/dev-stack` is also `kind: "tooling"`, which the existing `deps/tooling-dev-only` rule already keeps out of every production field. |
| T01-3 | Implementation choice | The placeholder wiring test asserts `expect.getState().testPath` ends in `.int.ts`. | `import.meta.url` is not typed under `lib-isomorphic.json` (no DOM, no Node types), which confirms the isomorphic base keeps Node and DOM globals out even with Vitest's types loaded. |

### Checks (T01 definition of done)

- All five workspaces pass `lint`, `typecheck`, `test`, `build` and `test:integration` (the wiring test).
- `pnpm repo:check`: `check-workspaces` and `check-tsrefs` green.
- `check-workspaces.test.ts` (5 new cases): direct `oidc-provider`; a path through an optional and a peer dependency across two workspaces (with the witness path); `@ralysa/dev-stack` as a production dependency; devDependencies and unshipped workspaces allowed; the real repository clean.
