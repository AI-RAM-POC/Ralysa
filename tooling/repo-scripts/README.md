# @ralysa/repo-scripts

Repository checks for CI and developers (F-001 design §2.1, §3.1, §6.1). The TypeScript sources run directly on Node 24 through its built-in type stripping, so there is no build step and no TS runner dependency. The code therefore uses erasable syntax only (`erasableSyntaxOnly`).

```sh
node tooling/repo-scripts/src/cli.ts repo-check        # every repo-level check (the CI repo-checks job)
node tooling/repo-scripts/src/cli.ts check-workspaces
node tooling/repo-scripts/src/cli.ts check-tsrefs
node tooling/repo-scripts/src/cli.ts check-turbo-config
pnpm scaffold <apps|packages|services>/<name> --kind <library|library-isomorphic|service|app|cli>
node tooling/repo-scripts/src/cli.ts summary [--file .turbo/runs/<id>.json] [--out "$GITHUB_STEP_SUMMARY"]
ralysa-repo placeholder-guard                          # the four scripts of every placeholder package
```

| Check | Fails when |
|---|---|
| `check-workspaces` | A folder under `apps/`, `packages/`, `services/` or `tooling/` has no `package.json` or isn't a pnpm workspace; pnpm would treat a folder **outside** those four roots as a workspace (checked from `pnpm ls -r` and by resolving the `pnpm-workspace.yaml` globs directly); a workspace lacks `lint`, `typecheck`, `test` or `build`; a `package.json` breaks the §3.1 contract (`src/contracts/workspace.ts`); a lifecycle script (including pnpm's root `pnpm:devPreinstall`) isn't in `lifecycle-allowlist.json`; a `.pnpmfile.*`/`pnpmfile.*` file or a `pnpmfile` setting isn't in `pnpmfile-allowlist.json` with a matching content hash, or `globalPnpmfile` is set; any `pnpm-workspace.yaml` `configDependencies` entry isn't in `config-dependencies.json` with its exact `<version>+<integrity>` value (pnpm auto-loads the pnpmfile of `pnpm-plugin-*`, `@pnpm/plugin-*` and `@<scope>/pnpm-plugin-*` config dependencies); `enablePrePostScripts`, `dangerouslyAllowAllBuilds` or an unreviewed `allowBuilds: true` appears (reviews go in `allow-builds.json`); `strictDepBuilds` is off; `packs/*` is a workspace glob; a dependency in any `package.json`, **or a value in `pnpm-workspace.yaml` `catalog`, `catalogs.*` or `overrides`**, uses an `npm:`, `file:`, `link:`, `portal:`, git or tarball specifier that `boundaries.js` doesn't allow (key `workspace: "pnpm-workspace.yaml"` for the latter), or any local specifier into `packs/`; an `@ralysa/*` dependency isn't `workspace:*`; a tooling package is a non-dev dependency; or a Python file exists outside `docs/` and `requirements/` (RC-7). |
| `check-turbo-config` | The root `turbo.json` doesn't disable the remote cache or lacks a required `globalDependencies` entry; or the root **or any package-level `<workspace>/turbo.json`** lets a `check*`, `scan*`, `check:generated` or `test:integration` task resolve to cached (a package task without `cache` inherits the root's value); or a package-level file carries a root-only key (SEC-F001-12, -23). |
| `placeholder-guard` | A placeholder package holds anything besides `README.md` and `package.json`. |
| `summary` | A workspace is missing one of the four required tasks in the Turbo run. It also renders the workspace × task table for the CI job summary, reading only the run's `execution` and `tasks` (never the `user` or `scm` blocks). |
| `check-tsrefs` | The root `tsconfig.json` doesn't reference exactly the workspaces that have a `tsconfig.json`, or a workspace doesn't reference a TypeScript library it depends on. |

## Scaffold templates

`templates/<kind>/` holds one template per kind. Every file ends in `.tmpl`, so nothing in the repo lints, type-checks or runs them in place. `{{name}}`, `{{package}}`, `{{dir}}` and `{{kind}}` are substituted. `test/scaffold.test.ts` scaffolds all five kinds into a copy of the repo and runs `check-workspaces`, `lint`, `typecheck`, `test` and `build` on each (TC-F-001-46).

## Registers

- `lifecycle-allowlist.json`: reviewed lifecycle scripts (`package`, `script`, exact `command`, `owner`, `reason`). Starts empty.
- `allow-builds.json`: reviewed dependency build scripts (`package`, `reason`, `reviewer`, `date`). Starts empty.
- `config-dependencies.json`: reviewed pnpm `configDependencies` (`package`, exact `specifier` `<version>+sha512-…`, `owner`, `reason`, optional `date`). A version bump or a different integrity needs a new review. Starts empty.
- `pnpmfile-allowlist.json`: reviewed pnpmfiles (`path`, `sha256` of the reviewed content, `owner`, `reason`, `date`). pnpm runs a root `.pnpmfile.cjs`/`.mjs` on every install, so an edit changes the hash and needs a new review. Starts empty.

Tests put every temp folder through `test/temp.ts`; `test/setup.ts` removes them after each test file.

Both are protected paths: loosening them is a reviewed change.

There are no environment variables.
