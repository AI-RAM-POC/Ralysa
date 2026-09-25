# @ralysa/repo-scripts

Repository checks for CI and developers (F-001 design §2.1, §3.1, §6.1). The TypeScript sources run directly on Node 24 through its built-in type stripping, so there is no build step and no TS runner dependency. The code therefore uses erasable syntax only (`erasableSyntaxOnly`).

```sh
node tooling/repo-scripts/src/cli.ts repo-check        # every repo-level check (the CI repo-checks job)
node tooling/repo-scripts/src/cli.ts check-workspaces
node tooling/repo-scripts/src/cli.ts check-tsrefs
```

| Check | Fails when |
|---|---|
| `check-workspaces` | A folder under `apps/`, `packages/`, `services/` or `tooling/` has no `package.json` or isn't a pnpm workspace; a workspace lacks `lint`, `typecheck`, `test` or `build`; a `package.json` breaks the §3.1 contract (`src/contracts/workspace.ts`); a lifecycle script isn't in `lifecycle-allowlist.json`; `enablePrePostScripts`, `dangerouslyAllowAllBuilds` or an unreviewed `allowBuilds: true` appears (reviews go in `allow-builds.json`); `strictDepBuilds` is off; `packs/*` is a workspace glob; a dependency uses an `npm:`, `file:`, `link:`, `portal:`, git or tarball specifier that `boundaries.js` doesn't allow, or any local specifier into `packs/`; an `@ralysa/*` dependency isn't `workspace:*`; a tooling package is a non-dev dependency; or a Python file exists outside `docs/` and `requirements/` (RC-7). |
| `check-tsrefs` | The root `tsconfig.json` doesn't reference exactly the workspaces that have a `tsconfig.json`, or a workspace doesn't reference a TypeScript library it depends on. |

## Registers

- `lifecycle-allowlist.json`: reviewed lifecycle scripts (`package`, `script`, exact `command`, `owner`, `reason`). Starts empty.
- `allow-builds.json`: reviewed dependency build scripts (`package`, `reason`, `reviewer`, `date`). Starts empty.

Both are protected paths: loosening them is a reviewed change.

There are no environment variables.
