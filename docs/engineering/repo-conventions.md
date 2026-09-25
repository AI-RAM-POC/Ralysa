# Repository conventions

> Owner: tech lead · Source: [F-001 design](../features/F-001-engineering-design-foundations/design.md) §2.1, §3.1, §6.1, §6.4 · Created by F-001-T03 (2026-09-25). Later F-001 tasks add the local secret hook and the rotation runbook (T17).

## Toolchain

| Tool | Version | How you get it |
|---|---|---|
| Node.js | 24 LTS (`.nvmrc`; `engines.node` is `>=24.12 <25`) | `nvm install && nvm use` |
| pnpm | pinned in `package.json#packageManager`, with its sha512 | `corepack enable`. Corepack downloads that exact version and refuses one whose hash doesn't match. Node 26 no longer bundles Corepack; install it with `npm i -g corepack` there. |
| Turbo, TypeScript, ESLint, Vitest, Prettier | pinned in the root `package.json` and the `catalog:` in `pnpm-workspace.yaml` | `pnpm install` |

Set `TURBO_TELEMETRY_DISABLED=1` and `DO_NOT_TRACK=1` in your shell; CI sets both. The Turbo remote cache is disabled in `turbo.json`, and must stay disabled: build outputs don't leave the machine.

## Everyday commands

```sh
pnpm install            # frozen in CI; dependency build scripts are blocked unless reviewed
pnpm lint               # turbo run lint (every workspace)
pnpm typecheck
pnpm test               # hermetic unit tests (see below)
pnpm build
pnpm repo:check         # the CI repo-checks job: workspace, tsconfig and Turbo checks, then prettier --check
pnpm format             # prettier --write .
```

## Workspaces

Every folder directly under `apps/`, `packages/`, `services/` and `tooling/` is a pnpm workspace. It has the four scripts `lint`, `typecheck`, `test` and `build`, and a `ralysa` block in its `package.json`:

```jsonc
"ralysa": {
  "kind": "app | cli | library | service | tooling | placeholder",
  "runtime": "browser | node | isomorphic",   // libraries only
  "shipped": true,        // reaches users: its artefacts are secret-scanned, and demo content must be absent
  "ui": true,             // the UI lint layer (RTL, i18n, a11y) applies
  "artefacts": ["dist"]   // what the artefact scan reads when shipped
}
```

`check-workspaces` (in `pnpm repo:check`) enforces this, and fails on a folder with no `package.json`. `packs/` holds department packs, which are content, not workspaces; nothing may depend on them.

### Placeholders

A spec folder that no feature has started yet is a **placeholder package**: only `README.md` and `package.json`, with `ralysa.kind: "placeholder"`. Its four scripts run `ralysa-repo placeholder-guard`, which passes while the folder stays that way and fails as soon as any other file appears. Placeholders show up in every CI run as green workspaces, and no folder can quietly gain code without real lint and test wiring.

### Creating a real package: `pnpm scaffold`

```sh
pnpm scaffold services/agent-host --kind service
pnpm install
pnpm turbo run lint typecheck test build --filter=@ralysa/agent-host
```

`scaffold` converts a placeholder (or creates a new folder), keeps the placeholder's README, and adds the package to the root `tsconfig.json` references. The templates are in `tooling/repo-scripts/templates/<kind>/`, and each one passes every gate on creation (TC-F-001-46).

| Kind | Folder | tsconfig base | ESLint presets | Use for |
|---|---|---|---|---|
| `library` | `packages/` | `react-lib.json` | `base` + `reactUi` + `tests` | React/DOM libraries: `ui`, `workbench`, `views` |
| `library-isomorphic` | `packages/` | `lib-isomorphic.json` (no DOM, no Node types) | `base` + `isomorphic` (bans Node built-ins) + `tests` | Code that must run in browsers and Node: `protocol`, `auth`, `sdk` |
| `service` | `services/` | `node-service.json` | `base` + `tests` | Node services |
| `app` | `apps/` | `vite-app.json` | `base` + `reactUi` + `tests` | Vite + React apps (`apps/web`) |
| `cli` | `apps/` | `node-cli.json` (`jsx: react-jsx` for Ink) | `base` + `tests` | Node CLIs (`apps/cli`, F-005). The owning feature chooses the bundler. |

Each package's `tsconfig.json` is the composite project over `src/`, `test/` and `*.config.ts` that `typecheck` and type-aware lint use. `tsconfig.build.json` emits `src/` to `dist/`. Apps are bundled by Vite instead.

### Referenceable libraries (`.tsc/`)

A workspace that depends on a TypeScript library must reference it in its `tsconfig.json` (`check-tsrefs`). TypeScript rejects a reference to a project that disables emit (`TS6310 Referenced project … may not disable emit`, reported by `tsc -p`, which every `typecheck` script runs). So a **library's** `tsconfig.json` doesn't use `noEmit`. It emits declarations only, into a git-ignored scratch folder:

```jsonc
// packages/<library>/tsconfig.json (the library and library-isomorphic templates do this)
"compilerOptions": {
  "noEmit": false,
  "emitDeclarationOnly": true,
  "outDir": "${configDir}/.tsc"
}
```

- `.tsc/` is in `.gitignore` and in the ESLint base ignores. Nothing reads it; `typecheck` and `tsc -b` just write it.
- `tsconfig.build.json` sets `"emitDeclarationOnly": false` again, so `build` still emits JavaScript and declarations to `dist/`.
- `check-tsrefs` fails when a referenced project isn't `composite` (`tsrefs/reference-not-composite`, TS6306) or sets `noEmit` (`tsrefs/reference-no-emit`, TS6310). It reads the effective options, with `extends` resolved.
- Apps, services and CLIs are leaves (nothing references them), so their `tsconfig.json` stays no-emit.
- A dependent imports the library through its package entry point (`dist/`), so it type-checks against the built library; Turbo's `^build` puts that first. `tsc -b <app>` builds the whole reference graph; the scaffold test proves it with a scaffolded app referencing a scaffolded library (TC-F-001-46).

## Tests: `test` vs `test:integration`

- **`test` is hermetic:** no network, no database, no containers, and nothing outside the workspace's own files and temp folders. It runs for every workspace in the CI `quality` job.
- Tests that need Postgres, Redis or another service go in an optional **`test:integration`** script. `turbo.json` already defines the task (`cache: false`). The first feature that adds one (F-002 is expected to) also adds the `integration` CI job with service containers, so `quality` stays within the CI time budget.
- Put unit tests in `test/**/*.test.ts(x)` or next to the code as `src/**/*.test.ts(x)`.

## Dependencies

- Internal dependencies use `workspace:*`, so an `@ralysa/*` name can never resolve from the public registry. Tooling packages (`@ralysa/tsconfig`, `eslint-config`, `vitest-config`, `repo-scripts`) appear only in `devDependencies`.
- Shared toolchain versions come from the `catalog:` in `pnpm-workspace.yaml`. Use `"typescript": "catalog:"` rather than repeating a version.
- **Allowed specifiers:** registry versions and ranges, `catalog:`, and `workspace:*`. `npm:` aliases, `file:`, `link:`, `portal:`, git, GitHub shorthand and tarball URLs fail `check-workspaces`, unless `tooling/eslint-config/boundaries.js` `SPECIFIER_ALLOWLIST` lists that exact specifier with a reason. A local specifier into `packs/` can never be allow-listed.
- **Supply-chain settings** (`pnpm-workspace.yaml`):
  - `minimumReleaseAge` is 3 days: pnpm won't install a version younger than that.
  - `trustPolicy: no-downgrade`: pnpm refuses a version with weaker publish provenance than an earlier one. Exceptions go in `trustPolicyExclude`, one exact version per entry, each with a comment giving the reason.
  - `blockExoticSubdeps`: transitive dependencies come from the registry only.
  - `strictDepBuilds`: install fails if a dependency wants to run a build script that isn't reviewed.
- **Dependency build scripts:** an `allowBuilds` entry defaults to `false`. Setting one to `true` needs a matching entry in `tooling/repo-scripts/allow-builds.json` (package, reason, reviewer, date). `dangerouslyAllowAllBuilds` and `enablePrePostScripts` are never allowed.
- **Our own lifecycle scripts** (pnpm's root `pnpm:devPreinstall`, `preinstall`, `install`, `postinstall`, `prepare`, `prepack`, `postpack`, `prepublish`, `prepublishOnly`, `publish`, `postpublish`) are banned in the root and every workspace. The exception is an entry in `tooling/repo-scripts/lifecycle-allowlist.json` with the exact command, an owner and a reason. These would otherwise run on every `pnpm install`.
- **pnpmfiles.** pnpm loads a root `.pnpmfile.cjs`/`.pnpmfile.mjs` (or the file the `pnpmfile` setting names) on every install, and its hooks can rewrite any manifest. Any pnpmfile needs an entry in `tooling/repo-scripts/pnpmfile-allowlist.json` with the SHA-256 of the reviewed content; `globalPnpmfile` is never allowed.
- **Config dependencies.** `configDependencies` in `pnpm-workspace.yaml` install before everything else and can change how pnpm behaves; pnpm also loads the pnpmfile of any `pnpm-plugin-*`, `@pnpm/plugin-*` or `@<scope>/pnpm-plugin-*` config dependency and runs its hooks before install. Each entry needs a reviewed entry in `tooling/repo-scripts/config-dependencies.json` for its exact `<version>+<integrity>`.
- **Catalogs and overrides** in `pnpm-workspace.yaml` follow the same specifier rules as `package.json`: a `catalog:` reference is only as safe as the catalog value behind it.
- **Workspace globs** may only cover folders directly under `apps/`, `packages/`, `services/` and `tooling/`; `check-workspaces` flags anything else pnpm would pick up.
- **No Python yet.** `*.py`, `pyproject.toml`, `requirements*.txt`, `Pipfile`, `setup.cfg` and `uv.lock` fail `check-workspaces` outside `docs/` and `requirements/`, until the F-004 design lands the Python lint, test and SR-03 import ban (RC-7).

## Turbo

- Tasks: `build`, `typecheck`, `lint`, `test` (all depend on `^build`), `test:integration`, `check:generated` and `e2e` (all uncached).
- A package may add a `turbo.json` (`extends: ["//"]`) to adjust its tasks, but a check, scan, `check:generated` or `test:integration` task must still resolve to `cache: false`, and root-only keys are not allowed there.
- `globalDependencies` lists the root configs and `tooling/**`. Changing any lint, type or boundary config therefore invalidates every cached result, so a cache replay can't stand in for a gate. `check-turbo-config` enforces this.
- Generated files: a workspace that commits generated files defines `check:generated`, which regenerates them in place. CI then fails on any `git status --porcelain` output.

## Before running pnpm on a branch you didn't write

Every pnpm command, even `pnpm --version`, installs the `configDependencies` in `pnpm-workspace.yaml` and loads pnpmfiles, and `pnpm install` runs lifecycle scripts. After pulling someone else's branch, run the static gate with plain Node first:

```sh
node tooling/repo-scripts/src/pre-install-gate.ts
```

It needs no installed packages and starts no subprocess. It also fails if your shell sets an `npm_config_*`/`pnpm_config_*` variable for a pnpmfile, config dependencies or workspace dir, and it refuses `pnpm-workspace.yaml` or `.npmrc` files that contain a carriage return without a line feed. CI runs it before any pnpm command in every job that installs.

## CI (`.github/workflows/ci.yml`)

| Job | What it runs |
|---|---|
| `repo-checks` | The pre-install config gate, then `pnpm install --frozen-lockfile`, then `pnpm repo:check` |
| `quality` | The pre-install config gate, `pnpm install --frozen-lockfile`, then `turbo run lint typecheck test build check:generated --continue=dependencies-successful --summarize`, a generated-drift check, then a workspace × task table in the job summary |
| `pr-traceability` | The PR title or body references `F-nnn`, or the PR carries a chore/docs/adlc label |

`.github/required-checks.json` names the checks that must be green before an agent squash-merges (design §6.3.3). Each task that adds a job adds its name in the same PR.
