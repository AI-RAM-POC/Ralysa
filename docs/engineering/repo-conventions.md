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

Each package's `tsconfig.json` is a no-emit project over `src/`, `test/` and `*.config.ts`, used by `typecheck` and type-aware lint. `tsconfig.build.json` emits `src/` to `dist/`. Apps are bundled by Vite instead.

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
- **Our own lifecycle scripts** (`preinstall`, `install`, `postinstall`, `prepare`, `prepack`, `postpack`, `prepublish`, `prepublishOnly`, `publish`, `postpublish`) are banned in the root and every workspace. The exception is an entry in `tooling/repo-scripts/lifecycle-allowlist.json` with the exact command, an owner and a reason. These would otherwise run on every `pnpm install`.
- **No Python yet.** `*.py`, `pyproject.toml`, `requirements*.txt`, `Pipfile`, `setup.cfg` and `uv.lock` fail `check-workspaces` outside `docs/` and `requirements/`, until the F-004 design lands the Python lint, test and SR-03 import ban (RC-7).

## Turbo

- Tasks: `build`, `typecheck`, `lint`, `test` (all depend on `^build`), `test:integration`, `check:generated` and `e2e` (all uncached).
- `globalDependencies` lists the root configs and `tooling/**`. Changing any lint, type or boundary config therefore invalidates every cached result, so a cache replay can't stand in for a gate. `check-turbo-config` enforces this.
- Generated files: a workspace that commits generated files defines `check:generated`, which regenerates them in place. CI then fails on any `git status --porcelain` output.

## CI (`.github/workflows/ci.yml`)

| Job | What it runs |
|---|---|
| `repo-checks` | `pnpm install --frozen-lockfile`, then `pnpm repo:check` |
| `quality` | `turbo run lint typecheck test build check:generated --continue=dependencies-successful --summarize`, a generated-drift check, then a workspace × task table in the job summary |
| `pr-traceability` | The PR title or body references `F-nnn`, or the PR carries a chore/docs/adlc label |

`.github/required-checks.json` names the checks that must be green before an agent squash-merges (design §6.3.3). Each task that adds a job adds its name in the same PR.
