# @ralysa/repo-scripts

Repository checks for CI and developers (F-001 design §2.1, §3.1, §6.1). The TypeScript sources run directly on Node 24 through its built-in type stripping, so there is no build step and no TS runner dependency. The code therefore uses erasable syntax only (`erasableSyntaxOnly`).

```sh
node tooling/repo-scripts/src/pre-install-gate.ts      # BEFORE any pnpm command: static config gate, no packages needed
node tooling/repo-scripts/src/cli.ts config-gate
node tooling/repo-scripts/src/cli.ts repo-check        # every repo-level check (the CI repo-checks job)
node tooling/repo-scripts/src/cli.ts check-workspaces
node tooling/repo-scripts/src/cli.ts check-tsrefs
node tooling/repo-scripts/src/cli.ts check-turbo-config
node tooling/repo-scripts/src/cli.ts check-banned-deps
node tooling/repo-scripts/src/cli.ts check-imports
node tooling/repo-scripts/src/cli.ts check-gitleaks-config
node tooling/repo-scripts/src/cli.ts check-ci-invariants
sh tooling/repo-scripts/bin/install-tool.sh gitleaks [--verify]   # pnpm tools:install
node tooling/repo-scripts/src/secret-scan-cli.ts <pr --base <sha> --head <sha>|tree|history|artefacts|selftest>   # pnpm secret-scan
pnpm scaffold <apps|packages|services>/<name> --kind <library|library-isomorphic|service|app|cli>
node tooling/repo-scripts/src/cli.ts summary [--file .turbo/runs/<id>.json] [--out "$GITHUB_STEP_SUMMARY"]
ralysa-repo placeholder-guard                          # the four scripts of every placeholder package
```

| Check | Fails when |
|---|---|
| `config-gate` (also `pre-install-gate.ts`) | Anything pnpm would execute from this repo when it starts or installs isn't reviewed: a `configDependencies` entry not in `config-dependencies.json` with its exact `<version>+<integrity>` (every pnpm command, even `pnpm --version`, installs config dependencies, and pnpm auto-loads the pnpmfile of `pnpm-plugin-*`, `@pnpm/plugin-*` and `@<scope>/pnpm-plugin-*` ones); a `.pnpmfile.*`/`pnpmfile.*` file or `pnpmfile` setting not in `pnpmfile-allowlist.json` with a matching SHA-256, or any `globalPnpmfile`; a lifecycle script (including `pnpm:devPreinstall`) in the root or any folder pnpm could treat as a workspace that isn't in `lifecycle-allowlist.json`; a `package.yaml`/`package.json5` manifest; an unreviewed `allowBuilds`/`onlyBuiltDependencies` entry, `dangerouslyAllowAllBuilds`, or `enablePrePostScripts`; a malformed register; a carriage return not followed by a line feed in `pnpm-workspace.yaml` or `.npmrc` (`gate/lone-cr`: pnpm reads it as a line break); another spelling of a sensitive key (`gate/ambiguous-key`) or a `workspaceDir`/`workspace-dir` setting; an `npm_config_*`/`pnpm_config_*` environment variable (any case) naming a pnpmfile, global pnpmfile, config dependencies or workspace dir (`gate/env-config`); or a `pnpm-workspace.yaml` that uses YAML outside the strict subset the gate reads (`lib/mini-yaml.ts` fails closed on anchors, aliases, merge keys, tags, flow collections, escapes and so on). It imports only `node:*` modules and never starts a subprocess. |
| `check-workspaces` | The config gate has findings (it runs first and stops there); the gate's YAML reader and the `yaml` package read `pnpm-workspace.yaml` differently; a folder under `apps/`, `packages/`, `services/` or `tooling/` has no `package.json` or no `pnpm-workspace.yaml` glob includes it; the globs make a folder **outside** those four roots a workspace (resolved directly: the checks never run pnpm, because every pnpm command installs `configDependencies` first); a workspace lacks `lint`, `typecheck`, `test` or `build`; a `package.json` breaks the §3.1 contract (`src/contracts/workspace.ts`); a lifecycle script (including pnpm's root `pnpm:devPreinstall`) isn't in `lifecycle-allowlist.json`; a `.pnpmfile.*`/`pnpmfile.*` file or a `pnpmfile` setting isn't in `pnpmfile-allowlist.json` with a matching content hash, or `globalPnpmfile` is set; any `pnpm-workspace.yaml` `configDependencies` entry isn't in `config-dependencies.json` with its exact `<version>+<integrity>` value (pnpm auto-loads the pnpmfile of `pnpm-plugin-*`, `@pnpm/plugin-*` and `@<scope>/pnpm-plugin-*` config dependencies); `enablePrePostScripts`, `dangerouslyAllowAllBuilds` or an unreviewed `allowBuilds: true` appears (reviews go in `allow-builds.json`); `strictDepBuilds` is off; `packs/*` is a workspace glob; a dependency in any `package.json`, **or a value in `pnpm-workspace.yaml` `catalog`, `catalogs.*` or `overrides`**, uses an `npm:`, `file:`, `link:`, `portal:`, git or tarball specifier that `boundaries.js` doesn't allow (key `workspace: "pnpm-workspace.yaml"` for the latter), or any local specifier into `packs/`; an `@ralysa/*` dependency isn't `workspace:*`; a tooling package is a non-dev dependency; or a Python file exists outside `docs/` and `requirements/` (RC-7). |
| `check-turbo-config` | The root `turbo.json` doesn't disable the remote cache or lacks a required `globalDependencies` entry; or the root **or any package-level `<workspace>/turbo.json`** lets a `check*`, `scan*`, `check:generated` or `test:integration` task resolve to cached (a package task without `cache` inherits the root's value); or a package-level file carries a root-only key (SEC-F001-12, -23). |
| `check-banned-deps` | A banned package (the groups in `tooling/eslint-config/boundaries.js`) is anywhere in the `pnpm-lock.yaml` graph of a workspace or the root (prod, dev and optional, any depth) on a path that doesn't contain one of the group's `graphAllowedThrough` sequences. The Agent SDK only through `@ralysa/agent-host`; `@anthropic-ai/sdk` only through `@ralysa/agent-host` → `@anthropic-ai/claude-agent-sdk` or `@ralysa/model-gateway`; model providers only through `@ralysa/model-gateway`; vendor telemetry never. Names are the resolved names, so an `npm:` alias can't hide one. Also fails when `apps/web` or `packages/*` depend on `@ralysa/agent-host`, when anything depends on `@ralysa/ui-lab` (`WORKSPACE_DEPENDENCY_RULES`), and, fail-closed, on a lockfile version other than 9.0 or an entry it can't resolve. Each finding carries one witness path (ADR-0012, SR-03, ADR-0024, AC-13; SEC-F001-08, -09 a/c). |
| `check-imports` | dependency-cruiser, with the root `.dependency-cruiser.cjs`, finds a forbidden import (static, `require()` or `import()` with a literal, type-only included) in `apps/`, `packages/`, `services/`, `tooling/` or `packs/`: a banned package outside its allowed paths, anything importing `apps/ui-lab` or `packs/`, or a layering break (packages → apps/services, app → other app, apps → services, service → other service). Also fails if the options leave no package target in the graph (`imports/graph-sanity`), because then the package rules couldn't fire. |
| `check-gitleaks-config` | Fails when `.gitleaks.artefacts.toml` has any allow-list (top-level or per rule, `allowlist` or `allowlists`) or `[extend] disabledRules`; when either config drops `[extend] useDefault = true` or loads another config (`[extend] path`/`url`); when a `.gitleaks.toml` path allow-list entry isn't anchored with `^`, or that file has a content allow-list (`regexes`, `stopwords`, `commits`); when a custom rule (`azure-openai-key`, `litellm-key`, `mistral-api-key`, `groq-api-key`, `ralysa-selftest-canary`) is missing or lacks keywords or an entropy floor of at least 3; when the two files' `[[rules]]` differ; or when a `.gitleaksignore` is tracked anywhere, because gitleaks would read it as a second allow-list (SEC-F001-05, -24). |
| `check-ci-invariants` | Fails when `packageManager` isn't `pnpm@x.y.z+sha512.<hash>`; when a workflow or job has an unconditional `cancel-in-progress: true`; when a job running `secret-scan pr` or `history` checks out without `fetch-depth: 0`; when a direct gitleaks call in a workflow, `.githooks/*` or `bin/*` lacks `--config`; when the `secret-scan` job runs pnpm, npm, npx, corepack or turbo; or when a Playwright image isn't pinned by digest, or CI and `apps/ui-lab/scripts/e2e-update.sh` use different digests (SEC-F001-06, -20, -21). |
| `placeholder-guard` | A placeholder package holds anything besides `README.md` and `package.json`. |
| `summary` | A workspace is missing one of the four required tasks in the Turbo run. It also renders the workspace × task table for the CI job summary, reading only the run's `execution` and `tasks` (never the `user` or `scm` blocks). |
| `check-tsrefs` | The root `tsconfig.json` doesn't reference exactly the workspaces that have a `tsconfig.json`, or a workspace doesn't reference a TypeScript library it depends on. |

## Secret scanning (F-001 design §6.2)

- **`bin/install-tool.sh gitleaks`** (`pnpm tools:install`) downloads gitleaks for `linux_x64`, `darwin_arm64` or `darwin_x64` into `.tools/gitleaks/<version>/`, which git ignores.
  - It checks the archive **and** the extracted binary against **`bin/tool-hashes.txt`**. That file is committed and holds the version, the URL and both SHA-256 values. A hash is never read from a downloaded checksums file.
  - An existing binary (a restored cache) is re-verified and never replaced. `--verify` only verifies.
  - gitleaks 8.30.1 is pinned. To upgrade, update all three lines after checking the release digests, the release's checksums file and your own download.
- **`src/secret-scan-cli.ts`** (`pnpm secret-scan`) is the only way gitleaks runs. It imports only `node:*`, so the CI `secret-scan` job needs no install.
  - Every call re-hashes the binary and passes `--config` explicitly, with `--redact --ignore-gitleaks-allow --exit-code 1` and a JSON report.
  - It points `--gitleaks-ignore-path` at an empty folder, and refuses a target that holds a `.gitleaksignore`.
  - Exit codes: 0 is clean; 1 is findings or a failed self-test; 2 is a usage or scanner error, which covers any gitleaks exit other than 0 or 1.
  - `pr --base <sha> --head <sha>` scans the new commits. It fails on an empty range ("is the base commit fetched?").
  - `tree` and `history` scan the working tree and the full history, with `.gitleaks.toml`.
  - `artefacts` scans every `ralysa.artefacts` path of every `shipped: true` workspace, with `.gitleaks.artefacts.toml`. A missing path fails.
  - `selftest` runs the dir, git, artefact and canary cases, with synthetic credentials assembled at runtime.
- Reports go to `$RUNNER_TEMP/secret-scan-reports` in CI (uploaded on failure), to `.tools/reports` locally, or to `--report-dir`. Secrets are redacted in them.
- The `@ralysa/repo-scripts` tests run the real binary. They fail with "run pnpm tools:install" if it isn't installed.

## Scaffold templates

`templates/<kind>/` holds one template per kind. Every file ends in `.tmpl`, so nothing in the repo lints, type-checks or runs them in place. `{{name}}`, `{{package}}`, `{{dir}}` and `{{kind}}` are substituted. `test/scaffold.test.ts` scaffolds all five kinds into a copy of the repo and runs `check-workspaces`, `lint`, `typecheck`, `test` and `build` on each (TC-F-001-46).

## Registers

- `lifecycle-allowlist.json`: reviewed lifecycle scripts (`package`, `script`, exact `command`, `owner`, `reason`). Starts empty.
- `allow-builds.json`: reviewed dependency build scripts (`package`, `reason`, `reviewer`, `date`). Starts empty.
- `config-dependencies.json`: reviewed pnpm `configDependencies` (`package`, exact `specifier` `<version>+sha512-…`, `owner`, `reason`, optional `date`). A version bump or a different integrity needs a new review. Starts empty.
- `pnpmfile-allowlist.json`: reviewed pnpmfiles (`path`, `sha256` of the reviewed content, `owner`, `reason`, `date`). pnpm runs a root `.pnpmfile.cjs`/`.mjs` on every install, so an edit changes the hash and needs a new review. Starts empty.

Tests put every temp folder through `test/temp.ts`; `test/setup.ts` removes them after each test file.

Both are protected paths: loosening them is a reviewed change.

Dependencies: `dependency-cruiser` 18.2.0 (MIT) for `check-imports`, and `smol-toml` 1.8.0 (BSD-3-Clause, no dependencies) for `check-gitleaks-config`. Both are provenance-attested and have no install scripts.

Environment: the secret-scan commands read `RUNNER_TEMP` (set by GitHub Actions) to choose the report and self-test folders. There are no other environment variables.
