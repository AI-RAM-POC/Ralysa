# F-001: Implementation notes (T01–T03)

> Phase 5 · Owner: developer agent · Branch `feat/F-001-foundations` · Design: [design.md](./design.md) (G4 recorded 2026-09-25) · Date: 2026-09-25
> These notes carry the PR evidence the design asks each task to record: version confirmations, deviations, spike results and anything left open. The PR description links here.

## Environment

- Node.js **24.21.0** (latest 24.x "Krypton" LTS on 2026-09-25), installed with nvm; `.nvmrc` is `24`.
- pnpm **11.27.1**, obtained through Corepack 0.36.0 (bundled with Node 24) with `corepack use pnpm@11.27.1`.
- Turbo 2.11.2, TypeScript 6.0.3, ESLint 10.11.0 (see the version table below).

## T01: toolchain baseline

### Recorded checks (T01 definition of done)

| Check | Result |
|---|---|
| `packageManager` with hash | `pnpm@11.27.1+sha512.a81d4c21…cdca23c`, written by `corepack use`. |
| Corepack verifies the hash | **Yes.** With the hash replaced by zeros in a scratch `package.json`, `corepack pnpm --version` fails with `Error: Mismatch hashes. Expected 0000…, got a81d4c21…`. CI therefore switches from `pnpm/action-setup` to `corepack enable` (design §6.4 allows either, provided the hash is honoured). |
| `trustPolicy` | **Available** in pnpm 11.27.1 (`trust-policy: off \| no-downgrade`). Enabled as `trustPolicy: no-downgrade`. |
| `globalDependencies` negation | **Supported** by Turbo 2.11.2. Probe: with an extra entry `!tooling/**/skipme/**` and files `tooling/zz-probe/keep.txt` and `tooling/zz-probe/skipme/x.txt` (neither git-ignored), `turbo run build --dry=json` listed only `keep.txt` in `globalCacheInputs.files`. |
| `minimumReleaseAge` works | **Yes.** The old lockfile (turbo 2.11.3, published 2026-09-22T20:39Z) was rejected with `ERR_PNPM_MINIMUM_RELEASE_AGE_VIOLATION`; the lockfile was regenerated from a fresh resolution. |
| 0 dependency build scripts | `allowBuilds: {}` and `strictDepBuilds: true`; the T01 install has no dependency with a build script (turbo and prettier only). |
| `packs/*` not in the workspace | `pnpm ls -r --depth -1` lists only the root after T01. |

### Notes

- `release.yml` is left byte-identical (design §2 "unchanged"; hardening deferred with T25). It is listed in `.prettierignore` so the new formatting check doesn't force a cosmetic edit.
- Markdown and `docs/` are excluded from Prettier: they are prose owned by other ADLC phases, and reformatting them is out of F-001's scope.
- Root scripts `repo:check` and `scaffold` arrive with T03 (see T02-7). `e2e`, `tools:install` and `hooks:install` arrive with T13, T05 and T17, the tasks that create what they run.

## T02: shared tooling packages

### Spike: jsx-a11y under ESLint 10 through `@eslint/compat` (design §2.2, T02 definition of done)

**Result: works. No fallback to `eslint-plugin-jsx-a11y-x` needed.**

- Versions: `eslint` 10.11.0, `eslint-plugin-jsx-a11y` 6.10.2 (peer `eslint ^3 … ^9`; pnpm reports the unmet peer, which is expected), `@eslint/compat` 2.1.1.
- Method: `ESLint#lintText` on a JSX fixture with one violation per rule, using `jsxA11y.flatConfigs.strict.rules`, once with the raw plugin and once wrapped in `fixupPluginRules`. A second targeted fixture was used for the rules the broad fixture didn't trigger.
- Findings:
  - `strict` enables 31 rules; `control-has-associated-label` is `off` in the preset itself. **All 31 fired**, with 0 fatal (crash) messages, both with and without `fixupPluginRules`.
  - The raw plugin doesn't call any context API that ESLint 10 removed on these code paths. The compat wrapper stays anyway, as designed, so a future jsx-a11y code path that uses a removed API is shimmed rather than crashing.
- Regression guard: `tooling/eslint-config/test/presets.test.ts` ("react-ui preset: jsx-a11y …") lints fixtures through the real `base` + `reactUi` presets and asserts that 9 representative rules fire with no fatal message, and that an accessible element passes. If a jsx-a11y or ESLint upgrade breaks the plugin, this test fails.

### Recorded decisions and deviations

| # | Type | What | Why |
|---|---|---|---|
| T02-1 | Design deviation (small) | `trustPolicyExclude: [semver@6.3.1]` in `pnpm-workspace.yaml`. | `trustPolicy: no-downgrade` (enabled in T01) blocks `semver@6.3.1`, which reaches us through `eslint-plugin-react-hooks` → `@babel/core`. 6.3.1 is the 2023-07-10 security backport on the 6.x line, published three days after the provenance-attested 7.5.4 (registry times checked). The 6.x line never had provenance, so this is a known false positive, not a takeover. The exclusion names one exact version and carries its reason inline; the policy stays on for everything else. |
| T02-2 | Adopted recommendation | pnpm `catalog:` for shared toolchain versions (`typescript`, `eslint`, `vitest`, `@types/*`, `react`, `vite`, `zod`, `yaml`). | Architect review AR-7 (non-blocking) recommends it; the five scaffold templates would otherwise repeat every version. `check-workspaces` accepts `catalog:` as a registry specifier. |
| T02-3 | Implementation choice | `@ralysa/repo-scripts` runs its TypeScript from source on Node 24's built-in type stripping (`node src/cli.ts`). Its `build` script is an explicit no-op message. | Avoids a TS runner dependency (`tsx`) and a build-before-check ordering in `repo-checks`. `erasableSyntaxOnly` guarantees the sources stay strippable. Node 24.21.0 strips types with no warning. |
| T02-4 | Implementation choice | `@ralysa/eslint-config` and `@ralysa/vitest-config` are plain ESM JavaScript (as the design names them: `base.js` …). Their `build` emits `.d.ts` files only (`tsconfig.build.json`, exposed through `exports.types`). `@ralysa/tsconfig` is JSON; its `lint`/`typecheck` run a dependency-free JSON and `extends` check, and its compile-level tests live in `@ralysa/repo-scripts` (`test/tsconfig-bases.test.ts`). | Consumers' `checkJs` would otherwise type-check the config packages' JS source, including an untyped plugin. The tsconfig package can't depend on eslint-config or vitest-config (both extend it), because Turbo rejects workspace cycles. |
| T02-5 | Implementation choice | Each workspace's `tsconfig.json` is a **no-emit composite** project covering `src/`, `test/` and `*.config.ts`, which is what `typecheck`, type-aware lint and the root solution file use. Emit goes through `tsconfig.build.json`, which extends `@ralysa/tsconfig/build.json`. | TypeScript 6.0.3 accepts `composite` with `noEmit` (checked). Tests and configs get full type checking without being emitted into `dist/`. |
| T02-6 | Scope note | `check-workspaces` also enforces, beyond the §2.1 list: `packs/*` absent from the workspace globs (RF-7, listed as a `repo-checks` assertion), `strictDepBuilds` not turned off, `.npmrc` equivalents of the banned settings, `workspace:*` for `@ralysa/*` (§3.1), tooling packages only in `devDependencies` (AR-3, listed under T04 in §6.1), and a `placeholder` kind declaring no artefacts. | All are one-line rules in the same check. Having them in T02 means T04 doesn't reopen this file. |
| T02-7 | Sequencing | The root `repo:check` script and its CI step land in **T03**, not T02. | Until T03 turns the 15 README-only folders into packages, `check-workspaces` correctly fails on them. Wiring it into CI in T02 would leave the T02 commit red. |
| T02-8 | Implementation note | TypeScript 6 changed the default of `types` to `[]`, so each base names its ambient types (`lib-node.json` → `["node"]`, `vite-app.json` → `["vite/client"]`). Under `NodeNext`, a folder without `"type": "module"` compiles as CommonJS; every workspace has it. | Found while writing the base-config tests. |

### Tests added (T02)

- `tooling/eslint-config/test/presets.test.ts` (28): boundary rules stay `error` for source, test, e2e, script and config paths with every preset composed; `tests` touches no boundary or lint-comment rule (RC-3; the T04 fixtures in TC-F-001-29 build on this); lint-comment rules (SEC-F001-09 f, part of TC-F-001-42); isomorphic Node built-in ban (part of TC-F-001-46); jsx-a11y regression.
- `tooling/vitest-config/test/presets.test.ts` (2).
- `tooling/repo-scripts/test/check-workspaces.test.ts`: TC-F-001-01 (unit part), **TC-F-001-43**, and the lifecycle, specifier and `packs/` parts of **TC-F-001-42**.
- `tooling/repo-scripts/test/check-tsrefs.test.ts`, `test/tsconfig-bases.test.ts` (AR-4 c; the isomorphic base rejects DOM and Node globals, part of TC-F-001-46).

## T03: placeholders, scaffold, `apps/web`, CI jobs

### What landed

- **14 placeholder packages** (`apps/cli`, `apps/desktop`, `packages/{auth,protocol,sdk,ui,views,workbench}`, `services/{agent-host,control-plane,extraction,mcp-gateway,model-gateway,workspace-runtime}`). Their four scripts run `ralysa-repo placeholder-guard`. Each README is kept, and `ralysa.shipped` follows §3.1 (services `true` with no artefacts yet; `apps/cli` and `apps/desktop` `false` until converted; `packages/*` `false`). `ralysa.ui` is `true` for `apps/desktop` and `packages/{ui,workbench,views}` (the §7.3.1 scope).
- **`pnpm scaffold`** with templates `library`, `library-isomorphic`, `service`, `app` and `cli`. **`apps/web` was created with `pnpm scaffold apps/web --kind app`**, so the app template is proven in the real repo, not only in the test copy. `apps/web` renders an empty `<main>` landmark with no text (T08 adds the i18n'd heading) and is `shipped: true`.
- `placeholder-guard`, `summary` (the workspace × task table in `$GITHUB_STEP_SUMMARY`, which also fails if a workspace is missing a required task) and `check-turbo-config`.
- CI: `repo-checks` (`pnpm repo:check`) and `quality` (`turbo run lint typecheck test build check:generated --continue=dependencies-successful --summarize`, the `git status --porcelain` drift check, and the summary) replace `build`. `pr-traceability` is unchanged. The Turbo local cache uses `actions/cache` with key `turbo-quality-<os>-<sha>`.
- `.github/required-checks.json` = `["pr-traceability", "quality", "repo-checks"]`.
- `docs/engineering/repo-conventions.md`; root README tooling section.

### Recorded decisions and deviations

| # | Type | What | Why |
|---|---|---|---|
| T03-1 | **Design deviation** | `turbo.json` `globalDependencies` gains `!tooling/**/.turbo/**` and `!tooling/**/dist/**` next to the design's `!tooling/**/node_modules/**`. `check-turbo-config` still requires every entry the design lists. | Turbo's `globalDependencies` globs don't honour `.gitignore`. As designed, `tooling/**/*` matched the tooling packages' Turbo logs (`.turbo/turbo-*.log`) and `dist/` declarations, which every run rewrites. Every task hash therefore changed on every run: two identical consecutive runs gave `0 cached, 76 total`. With the two negations the second run gives `76 cached, 76 total`. Tooling *sources* are still global inputs, so SEC-F001-23 holds: the TC-F-001-45 test shows that editing `.dependency-cruiser.cjs` or `tooling/eslint-config/base.js` changes every lint hash. |
| T03-2 | Design deviation (sequencing) | `.github/required-checks.json` is **created** by T03 with the T03 content. | §6.3.3 has T15 create it as `["build", "pr-traceability"]` and T03 replace `build`. T15 (human merge) hasn't landed, so T03 writes the post-T03 state directly. T15 must keep this content rather than the initial list. |
| T03-3 | Scope note | `repo-checks` does not yet run `node --test .claude/hooks/test/`. | The guard fixtures arrive with T15, which touches `.claude/**` and is out of scope here. T15 adds the step. |
| T03-4 | Implementation choice (revised after code review m3) | TC-F-001-46 (`tooling/repo-scripts/test/scaffold.test.ts`) scaffolds the five kinds into a temp copy of the working tree and **does not run `pnpm install`**. Each new package's `node_modules` is built by `test/link-deps.ts` from **exactly the dependencies its template declares**: each is a symlink to the copy the real repo has installed, and each executable gets a `node` shim in `.bin/`. The package's own `lint`/`typecheck`/`test`/`build` scripts then run with that `.bin` on `PATH`. The first version borrowed a whole real `node_modules` (`apps/web` or `tooling/repo-scripts`), which would have hidden a missing template dependency. | An offline install in the copy fails: pnpm 11's supply-chain verification (`minimumReleaseAge`, `trustPolicy`) and `catalog:` resolution need registry metadata that isn't cached (`ERR_PNPM_NO_OFFLINE_META`). Going online would make `test` non-hermetic (§2.1), and switching the policies off in the copy would defeat them. `pnpm scaffold apps/web --kind app` in the real repo, followed by a real `pnpm install`, covers the install path once. |
| T03-5 | Implementation note | The placeholders' and tooling packages' `build` tasks produce Turbo "no output files found" warnings. | Placeholders and no-emit tooling builds have nothing to output. Suppressing the warning would need a per-package `turbo.json`, which would itself break the placeholder rule (only `README.md` and `package.json`). |
| T03-6 | Implementation note | `pnpm scaffold` and other root scripts may trigger pnpm 11's automatic dependency check before running. | This is pnpm 11 default behaviour. It installs only what the lockfile already allows (release-age and trust policies apply). |

### TC-F-001-02 canary (manual, once)

The design asks for a throw-away PR whose run is linked in the PR. **Not done**: the brief for this change says not to open PRs. **Local equivalent, recorded here:** with one assertion in `apps/web/test/App.test.tsx` inverted, `turbo run lint typecheck test build --continue=dependencies-successful --summarize` exited 1. 75 tasks succeeded, 1 failed, and the rendered summary listed all 19 workspaces, with `@ralysa/web | … | **FAILED** |` in the `test` column and every other workspace still `pass`. The edit was reverted. The CI version still needs to run once, on the first PR.

### Tests added (T03)

- `test/placeholder-guard.test.ts`: the guard passes, fails with the scaffold hint, refuses non-placeholders, and every real placeholder passes.
- `test/scaffold.test.ts`: target and kind validation, placeholder conversion, the root tsconfig format; **TC-F-001-46** (the five kinds × check-workspaces, lint, typecheck, test and build; an isomorphic `node:fs` import fails lint; `document` fails typecheck).
- `test/summary.test.ts`: the workspace × task table, a missing-task finding, and a check that `user`/`scm` are never echoed (AC-1 support).
- `test/check-turbo-config.test.ts`: **TC-F-001-45** (remote cache, each required `globalDependencies` entry, cacheable `check*`/`scan*`/`check:generated`/`test:integration`, and lint hashes changing when `.dependency-cruiser.cjs` or a tooling config changes, through `turbo run lint --dry=json` on a copy).
- TC-F-001-01: `check-workspaces` unit tests (T02) plus the real-repo run in `repo-checks`.

## Code review fixes (G5 "Request changes", 2026-09-25)

| Finding | Fix | Tests |
|---|---|---|
| **M1** `catalog:` was trusted blindly: `pnpm-workspace.yaml` `catalog`, `catalogs.*` and `overrides` were never read, so `zod: "npm:openai@4.0.0"` or `overrides: { zod: "github:o/r" }` passed. | `checkWorkspaceSpecifiers` runs every value in `catalog`, each `catalogs.<name>` and `overrides` through the same `exoticSpecifierKind` and `packs/` rules as a `package.json` specifier (shared `checkSpecifierValue`). Exceptions use the `boundaries.js` allow-list with `workspace: "pnpm-workspace.yaml"`; `packs/` targets are never excepted. Non-mapping values are reported. | `check-workspaces.test.ts`, "catalogs and overrides (code review M1)": `npm:`, `github:`, tarball URL, `git+https` and `file:packs/…` in `catalog`; `npm:` and `link:./packs/…` in `catalogs.*`; `github:`, `npm:` behind a `a>b` selector and `portal:packs/…` in `overrides`; plain versions, a range and `-` pass; the allow-list works for `github:` but not for `packs/`. |
| **M2** pnpm 11 runs the root `pnpm:devPreinstall` script and loads a root `.pnpmfile.cjs`/`.mjs` on install. | `pnpm:devPreinstall` added to `LIFECYCLE_SCRIPTS`. New `checkPnpmfiles` fails on any tracked `.pnpmfile.{js,cjs,mjs}` or `pnpmfile.{js,cjs,mjs}`, and on any file the `pnpmfile` setting names (in `pnpm-workspace.yaml` or `.npmrc`), unless `tooling/repo-scripts/pnpmfile-allowlist.json` (new, empty) has an entry for that path **with the SHA-256 of the reviewed content**, so an edit forces a new review. A `pnpmfile` pointing outside the repo, and any `globalPnpmfile`/`global-pnpmfile`, always fail. | "install-time hooks (code review M2)": `pnpm:devPreinstall` fails, and passes when allow-listed with the exact command; four pnpmfile names and locations; a `pnpmfile` setting to an unreviewed file, outside the repo, and `globalPnpmfile` in YAML and `.npmrc`; a reviewed pnpmfile passes and fails again after one-line edit. |
| **m1** Only `apps\|packages\|services\|tooling/*` were walked, and the packs guard was one regex. | `checkWorkspaces` takes the union of `pnpm ls -r --depth -1` and its own resolution of the `pnpm-workspace.yaml` `packages` globs (`resolveWorkspaceGlobs`, Node 24 `fs.globSync`, negations honoured, `node_modules` skipped). Any workspace outside the four roots fails with `workspace/outside-roots`. The `packs/*` regex stays as a second, clearer message. | "workspaces outside the four roots (code review m1)": `deploy/docker` from pnpm's list; the globs `*/*`, `deploy/*`, `**` and `./packs/**` resolved without pnpm; a negated glob is honoured. |
| **m2** Only the root `turbo.json` was checked. | `checkTurboConfigFile` also reads every `<workspace>/turbo.json`. A check, scan, `check:generated` or `test:integration` task there must resolve to `cache: false`: its own `cache`, or else the root task's (package configs inherit field by field), or else Turbo's default `true`. Root-only keys (`remoteCache`, `globalDependencies`, `globalEnv`, `globalPassThroughEnv`) in a package file fail. | "package-level turbo.json (code review m2)": `check:generated` with `cache: true` fails; a new `check:contrast` without `cache` fails; an override that only changes `inputs` passes (it inherits `false`); `remoteCache` in a package file fails. |
| **m3** The scaffold test borrowed whole real `node_modules`. | `test/link-deps.ts` links only declared dependencies (see T03-4). | **Proof, run once and reverted:** with `vitest` removed from `templates/service/package.json.tmpl` and `@types/node` removed from `templates/cli/package.json.tmpl`, the scaffold test failed in 6 cases: service `lint`, `typecheck` and `test` (`/bin/sh: vitest: command not found`, and `vitest/config` unresolved), and cli `lint`, `typecheck` and `build` (`error TS2688: Cannot find type definition file for 'node'`). After restoring both templates (`git status` clean), 34 of 34 pass. |
| Nit: `pr-traceability` had no timeout | `timeout-minutes: 20`. | – |
| Nit: summary on a fully cached run | Counts now come from the task states (`pass` + `cached` = succeeded). Turbo reports `execution.success: 0` when all 76 tasks are cache hits (checked). | `summary.test.ts`, "a fully cached run". |
| Nit: temp dirs left behind | Every test temp folder goes through `test/temp.ts`; `test/setup.ts` (Vitest `setupFiles`) removes them in `afterAll`. A full suite run now leaves the count of `ralysa-*` folders in the OS temp dir unchanged (343 before and after). The 343 existing folders from earlier runs (296 `fixture`, 45 `tsbase`, 1 `copy`, 1 `scaffold`; all matched `^ralysa-(fixture\|tsbase\|copy\|scaffold)-[A-Za-z0-9]{6}$`) were removed with `fs.rmSync`, which doesn't follow the scaffold copy's symlinks into the real `node_modules` (checked intact afterwards). | – |
| Nit: issue-template reformatting | Left as is, as asked. | – |

### Re-review fix (2026-09-25)

| Finding | Fix | Tests |
|---|---|---|
| **N1** `check-workspaces` ignored `configDependencies` in `pnpm-workspace.yaml`. pnpm 11.27.1 auto-loads `pnpmfile.mjs`/`pnpmfile.cjs` from any config dependency whose name matches `pnpm-plugin-*`, `@pnpm/plugin-*` or `@<scope>/pnpm-plugin-*` (`calcPnpmfilePathsOfPluginDeps`, `isPluginName`) and runs its `updateConfig` hooks before install, so `configDependencies: { "pnpm-plugin-evil": "1.0.0+sha512-…" }` ran code with no findings. | New `checkConfigDependencies` fails on **every** `configDependencies` entry, plugin name or not, unless the new register `tooling/repo-scripts/config-dependencies.json` (empty) lists that package with the **exact** `<version>+<integrity>` value (schema: `package`, `specifier` matching `<version>+sha512-…`, `owner`, `reason`, optional `date`). A version bump or a different integrity needs a new review. The finding says so explicitly when the name is a plugin name (`isPnpmPluginName` mirrors pnpm's rule). The object form `{ version, integrity }` is checked the same way, and a non-mapping value fails. | `check-workspaces.test.ts`, "pnpm configDependencies (code review N1)": bare `pnpm-plugin-evil`, `@pnpm/plugin-evil` and scoped `@acme/pnpm-plugin-evil` fail with the plugin warning; non-plugin `@acme/shared-config` fails without it; a registered entry passes, and fails again after a version bump or with another integrity; object form and list value fail; a malformed register entry fails. Integrity strings are synthetic. |

### Static config gate before any pnpm invocation (orchestrator attack test on f2e1de9)

**The problem.** With `configDependencies: { pnpm-plugin-evil: "1.0.0+sha512-AAAA" }` appended to the real `pnpm-workspace.yaml`, `node tooling/repo-scripts/src/cli.ts check-workspaces` crashed inside `listPnpmWorkspaces` (`pnpm ls -r --depth -1 --json` → `GET https://registry.npmjs.org/pnpm-plugin-evil 404`). The checker started pnpm, and pnpm resolved the config dependency **before** the static gate ran. A real published plugin would have been downloaded and its hooks run by the checker itself. CI had the same ordering problem: `pnpm --version`, `pnpm store path` and `pnpm install` all ran before `repo-checks`.

**What pnpm 11.27.1 actually does** (read in `dist/pnpm.mjs` and tested live in a scratch repo, 2026-09-25):
- `installConfigDepsAndLoadHooks` runs in pnpm's main entry for **every command**. It installs `configDependencies` first, then (unless `ignorePnpmfile`) loads the default `.pnpmfile.mjs`/`.pnpmfile.cjs`, any `pnpmfile` setting, and the `pnpmfile.mjs`/`pnpmfile.cjs` of every config dependency that `isPluginName` matches, and runs their `updateConfig` hooks.
- Live test, with that `configDependencies` entry: `pnpm --version`, `pnpm store path --silent`, `pnpm ls -r --depth -1 --json` and `pnpm run --if-present nothing` **all** failed with `GET https://registry.npmjs.org/pnpm-plugin-evil: Not Found - 404`. Even printing the version installs config dependencies.
- **No option skips `configDependencies`.** `ignorePnpmfile` only skips hook *loading*: the config dependencies are still downloaded and extracted. `pnpm ls --ignore-pnpmfile` is rejected (`Unknown option: 'ignore-pnpmfile'`). No `--config.*` setting or environment variable disables the install.
- `npm_config_registry=http://127.0.0.1:9/` did **not** redirect the request (it still went to registry.npmjs.org), so a registry variable is not a reliable sentinel. The tests use PATH shims instead.

**Decision (step 2): pnpm is dropped from the checker entirely.** Because no pnpm option prevents the config-dependency install, "invoke pnpm, but safely" isn't possible. `listPnpmWorkspaces` is deleted. Workspace discovery for the m1 check (`workspace/outside-roots`) and the coverage check (renamed `workspace/not-in-pnpm` → `workspace/not-in-globs`) comes only from resolving the `pnpm-workspace.yaml` `packages` globs with Node's `fs.globSync` (negations honoured, `node_modules` skipped). No repo check starts pnpm. They still use `git ls-files`, which runs no repository-controlled code.

**The gate.**
- `src/config-gate.ts` holds every check for code pnpm would run: `configDependencies` (in `pnpm-workspace.yaml`, and any `pnpm.configDependencies` in `package.json`); pnpmfiles (files anywhere in the tree, the `pnpmfile`/`globalPnpmfile` settings in YAML, `.npmrc` and `package.json#pnpm`); lifecycle scripts in the root and in every folder pnpm could treat as a workspace (the four roots plus whatever the globs resolve to); `package.yaml`/`package.json5` manifests; `allowBuilds`, `onlyBuiltDependencies`, `dangerouslyAllowAllBuilds` and `enablePrePostScripts`; and the four registers.
  - These checks moved out of `check-workspaces.ts`, and the zod register schemas became hand validation.
  - The rule ids are unchanged, so the earlier fixtures still apply.
  - Settings are judged fail-safe: anything other than "absent" or `false` counts as enabled.
- It imports only `node:*`, `lib/core.ts` (new; dependency-free helpers split out of `lib/repo.ts`) and `lib/mini-yaml.ts` (new). It starts no subprocess.
- `lib/mini-yaml.ts` is a strict YAML-subset reader, because the gate runs before `yaml` is installed. It **fails closed**: anchors, aliases, merge keys, tags, explicit `?` keys, flow collections other than `{}`/`[]`, block scalars, escapes, multi-line plain scalars, document markers, tabs, duplicate keys and type-ambiguous plain scalars (`True`, `yes`, `1.5`, `0x1F`, `010`, `.inf`) are all rejected with `gate/unsupported-yaml`. After install, `check-workspaces` also compares its result with the `yaml` package's and fails with `pnpm/yaml-differential` on any difference. On the real file the two are identical. Vendoring `yaml` was the alternative; a small fail-closed reader was preferred because the gate should understand less than pnpm does, never more.
- **Entry points.**
  - `node tooling/repo-scripts/src/pre-install-gate.ts` is the standalone gate.
  - `cli.ts config-gate` runs it through the CLI.
  - `check-workspaces` runs the gate first and **returns its findings without doing anything else**.
  - `repo-check` runs `config-gate` first and stops with exit 1 if it has findings.

**CI ordering (step 4).** `ci.yml` now runs `node tooling/repo-scripts/src/pre-install-gate.ts` as the first step after `setup-node`, **before the Corepack step** (whose `pnpm --version` would already install config dependencies), in both jobs that run pnpm (`repo-checks` and `quality`). `pr-traceability` runs no pnpm. **This closes the order-of-operations gap:** a PR that adds an unreviewed config dependency, pnpmfile, lifecycle script or dependency build now fails before any pnpm command runs in CI, instead of being detected after it has run.

**Residual risk.** A developer who runs `pnpm install` (or any pnpm command) locally on an untrusted branch is still exposed: nothing runs before their pnpm. The conventions doc tells developers to run the pre-install gate first after pulling someone else's branch, but that is discipline, not a control. This falls under the accepted risks of D-3 (SEC-F001-01: controls cover only what runs in CI or through Claude Code). T17's local hooks are the planned partial mitigation: they could run this gate from the pre-commit hook and the Claude Code guard (for example on `git checkout`/`git pull` or before an agent's `pnpm` commands). Agents are covered once T15/T17 route their pnpm commands through the guard.

**Tests.**
- `test/cli-gate.test.ts` (9) runs the **real entry points** as subprocesses. Fake `pnpm`, `npm`, `npx`, `pnpx` and `corepack` executables come first on `PATH` and write a marker file if called, and the registry variables point at `127.0.0.1:9`. The cases:
  - a positive control that the shim does record a pnpm call;
  - the orchestrator's exact attack on a copy of the real repo, which exits 1 cleanly with the finding, no stack trace and no marker;
  - `check-workspaces` on a fixture with `pnpm-plugin-evil`, which exits 1 with the plugin warning;
  - `repo-check`, which stops after `config-gate`;
  - a clean fixture, which passes with no pnpm call;
  - `pre-install-gate.ts` run from a **copy of `src/` with no `node_modules` anywhere above it**, proving it needs no packages: it fails on the plugin, passes a clean fixture and the real repository, and fails closed on YAML aliases.
- `test/mini-yaml.test.ts` (39): 10 accepted documents, including the real `pnpm-workspace.yaml`, deep-equal the `yaml` package's parse, and 29 unsupported constructs are rejected.

### Round-3 review: lone CR and environment config

| Finding | Fix | Tests |
|---|---|---|
| **R3-1 (Major)** `lib/mini-yaml.ts` split lines on `\n` only, but pnpm 11.27.1 reads `pnpm-workspace.yaml` with `@zkochan/js-yaml`, which treats a lone `\r` as a line break. `# reviewed\rconfigDependencies:\r  pnpm-plugin-zzzprobe: …` passed the gate while pnpm fetched the plugin, and `# note\rpnpmfile: probe.cjs` made pnpm run `probe.cjs`. | **Fail closed.** `mini-yaml` rejects any CR not followed by LF (`LONE_CR`) with the line number, splits on CRLF or LF only, and now also rejects C0 controls, DEL, NEL (U+0085), the line and paragraph separators (U+2028/9), the BOM, no-break and other non-ASCII spaces, since readers disagree on whether these are line breaks or whitespace. The gate checks for a lone CR **before** parsing and reports `gate/lone-cr` for `pnpm-workspace.yaml` and `.npmrc`. `.npmrc` is now read the way pnpm's `ini` reader splits it (CR, LF and CRLF are all line breaks; keys case-insensitive with `-`/`_` ignored), so `PNPMFILE=`, `global_pnpmfile=` and `Enable_Pre_Post_Scripts=` are caught too. A file name containing CR or LF is also reported. Package manifests are JSON, where a raw CR can only sit in whitespace, so they're unaffected. **Invariant:** after install, `check-workspaces` asserts again that `pnpm-workspace.yaml` has no lone CR (`pnpm/lone-cr`), next to the existing `mini-yaml` vs `yaml` comparison. | `mini-yaml.test.ts` (50): both probe strings, a trailing lone CR, NEL, LS, PS, BOM, NBSP, form feed and NUL rejected; the line number of a lone CR reported; CRLF still accepted. `cli-gate.test.ts`: both lone-CR probes through the **real `pre-install-gate.ts`** (from the no-`node_modules` copy of `src/`), which exits 1 with `[gate/lone-cr] pnpm-workspace.yaml`, no stack trace, no pnpm call (shims) and no `PNPMFILE_RAN` marker; plus a lone CR in `.npmrc`. `check-workspaces.test.ts`: the YAML lone-CR case returns only `gate/lone-cr`, and five `.npmrc` spelling and line-break cases. |
| **R3-2 (Minor)** The gate ignored environment config: `pnpm_config_pnpmfile=probe.cjs` made pnpm run `probe.cjs`. | `checkEnv` fails (`gate/env-config`) on any `npm_config_*` or `pnpm_config_*` variable, in any case, whose setting name (with `-`/`_` ignored) is `pnpmfile`, `global-pnpmfile`, `config-dependencies` or `workspace-dir`. That covers `NPM_CONFIG_WORKSPACE_DIR` and `PNPM_CONFIG_WORKSPACE_DIR`. The environment is injectable (`options.env`, default `process.env`). The only `*_config_*` variables pnpm itself exports to scripts, `npm_config_user_agent` and `pnpm_config_verify_deps_before_run` (checked with `pnpm exec`), are not sensitive, so `pnpm repo:check` doesn't trip it. Also refused as defence in depth: `workspaceDir` in `pnpm-workspace.yaml` or `package.json#pnpm`, `workspace-dir`/`config-dependencies` in `.npmrc`, and any other spelling of a sensitive key (`config-dependencies:`, `PnpmFile:`) as `gate/ambiguous-key`. pnpm 11 ignores these spellings today (the harness's kebab-key case), but a reader change could start honouring one. | `cli-gate.test.ts`: nine variables (`pnpm_config_pnpmfile`, `npm_config_pnpmfile`, `NPM_CONFIG_GLOBAL_PNPMFILE`, `pnpm_config_global-pnpmfile`, `pnpm_config_config_dependencies`, `npm_config_config-dependencies`, `NPM_CONFIG_WORKSPACE_DIR`, `PNPM_CONFIG_WORKSPACE_DIR`, `pnpm_config_workspace_dir`) each fail the real `pre-install-gate.ts`, and pnpm's own exported variables pass. `check-workspaces.test.ts`: injected env, and the key-spelling cases. |

**Reviewer's probe harness** (`diff.mjs`, read in full before running; every case directory's `.npmrc` sets `registry=http://127.0.0.1:9/`, and `pnpm-plugin-zzzprobe` doesn't exist on npm). The harness runs the real `pnpm config get registry` in each case directory and calls `checkConfigGate` in its own process.

Before the fix (at `f4d45dd`):
```
control: clean                                 | gate: PASS                                             | pnpm: configDep -  pnpmfile - 
control: configDependencies                    | gate: pnpm/config-dependencies                         | pnpm: configDep SEEN  pnpmfile - 
lone CR after comment                          | gate: PASS                                             | pnpm: configDep SEEN  pnpmfile - 
lone CR after comment (pnpmfile)               | gate: PASS                                             | pnpm: configDep -  pnpmfile RAN 
CRLF                                           | gate: pnpm/config-dependencies                         | pnpm: configDep SEEN  pnpmfile - 
BOM                                            | gate: gate/unsupported-yaml                            | pnpm: configDep SEEN  pnpmfile - 
tab indent                                     | gate: gate/unsupported-yaml                            | pnpm: configDep SEEN  pnpmfile - 
duplicate key (2nd hides?)                     | gate: gate/unsupported-yaml                            | pnpm: configDep SEEN  pnpmfile - 
trailing document                              | gate: gate/unsupported-yaml                            | pnpm: configDep -  pnpmfile - pnpm-error
document end ...                               | gate: gate/unsupported-yaml                            | pnpm: configDep -  pnpmfile - pnpm-error
NEL U+0085 after comment                       | gate: PASS                                             | pnpm: configDep -  pnpmfile - 
LS U+2028 after comment                        | gate: PASS                                             | pnpm: configDep -  pnpmfile - 
NBSP-indented comment line                     | gate: pnpm/config-dependencies                         | pnpm: configDep SEEN  pnpmfile - 
.npmrc pnpmfile                                | gate: pnpm/pnpmfile                                    | pnpm: configDep -  pnpmfile - 
package.json pnpm.pnpmfile                     | gate: pnpm/pnpmfile                                    | pnpm: configDep -  pnpmfile - 
package.json pnpm.configDependencies           | gate: pnpm/config-dependencies                         | pnpm: configDep -  pnpmfile - 
env pnpm_config_pnpmfile                       | gate: PASS                                             | pnpm: configDep -  pnpmfile RAN 
env npm_config_pnpmfile                        | gate: PASS                                             | pnpm: configDep -  pnpmfile - 
kebab key config-dependencies                  | gate: PASS                                             | pnpm: configDep -  pnpmfile - 
yaml pnpmfile (control)                        | gate: pnpm/pnpmfile                                    | pnpm: configDep -  pnpmfile RAN
```
After the fix:
```
control: clean                                 | gate: PASS                                             | pnpm: configDep -  pnpmfile - 
control: configDependencies                    | gate: pnpm/config-dependencies                         | pnpm: configDep SEEN  pnpmfile - 
lone CR after comment                          | gate: gate/lone-cr                                     | pnpm: configDep SEEN  pnpmfile - 
lone CR after comment (pnpmfile)               | gate: gate/lone-cr                                     | pnpm: configDep -  pnpmfile RAN 
CRLF                                           | gate: pnpm/config-dependencies                         | pnpm: configDep SEEN  pnpmfile - 
BOM                                            | gate: gate/unsupported-yaml                            | pnpm: configDep SEEN  pnpmfile - 
tab indent                                     | gate: gate/unsupported-yaml                            | pnpm: configDep SEEN  pnpmfile - 
duplicate key (2nd hides?)                     | gate: gate/unsupported-yaml                            | pnpm: configDep SEEN  pnpmfile - 
trailing document                              | gate: gate/unsupported-yaml                            | pnpm: configDep -  pnpmfile - pnpm-error
document end ...                               | gate: gate/unsupported-yaml                            | pnpm: configDep -  pnpmfile - pnpm-error
NEL U+0085 after comment                       | gate: gate/unsupported-yaml                            | pnpm: configDep -  pnpmfile - 
LS U+2028 after comment                        | gate: gate/unsupported-yaml                            | pnpm: configDep -  pnpmfile - 
NBSP-indented comment line                     | gate: gate/unsupported-yaml                            | pnpm: configDep SEEN  pnpmfile - 
.npmrc pnpmfile                                | gate: pnpm/pnpmfile                                    | pnpm: configDep -  pnpmfile - 
package.json pnpm.pnpmfile                     | gate: pnpm/pnpmfile                                    | pnpm: configDep -  pnpmfile - 
package.json pnpm.configDependencies           | gate: pnpm/config-dependencies                         | pnpm: configDep -  pnpmfile - 
env pnpm_config_pnpmfile                       | gate: PASS                                             | pnpm: configDep -  pnpmfile RAN 
env npm_config_pnpmfile                        | gate: PASS                                             | pnpm: configDep -  pnpmfile - 
kebab key config-dependencies                  | gate: gate/ambiguous-key                               | pnpm: configDep -  pnpmfile - 
yaml pnpmfile (control)                        | gate: pnpm/pnpmfile                                    | pnpm: configDep -  pnpmfile RAN
```
- **Lone-CR cases:** both now fail closed with `gate/lone-cr`, where the gate had passed while pnpm saw the config dependency or ran the pnpmfile.
- **The other cases pnpm acts on** are all caught: CRLF, BOM, tab, duplicate key, NBSP, `.npmrc` and `package.json` settings.
- **NEL, LS and the kebab key** now fail closed as well, although pnpm ignores them.
- **The two `env …` rows still read `PASS`** because the harness passes the variable only to pnpm, not to its in-process gate call. Calling `checkConfigGate` on those two case directories with the variable in `options.env` gives `gate/env-config env pnpm_config_pnpmfile` and `gate/env-config env npm_config_pnpmfile`. The CLI tests above cover the same through the real entry point.

## T06: design tokens

Branch `feat/F-001-tokens-i18n` (T06 to T08 together).

### What landed

- `packages/ui` converted from a placeholder with `pnpm scaffold packages/ui --kind library` and then filled in:
  - DTCG 2025.10 source in `tokens/`: `core.tokens.json` holds primitives and the theme-independent categories, and `semantic.{light,dark}.tokens.json` hold semantic colours and shadows as aliases.
  - The §7.1.3 placeholder values are used unchanged.
  - `src/contracts/tokens.ts` is the §3.2 zod contract.
  - `scripts/build-tokens.ts` is the generator. It emits `dist/css/tokens.css`, `dist/css/theme.css` and `src/tokens/generated.ts`. It is about 550 lines after Prettier, against the design's estimate of about 200. The extra length is validation messages, DTCG group and `$type` inheritance, alias cycle and type checks, the shadow and font-family formatters, and collision checks on the generated names.
  - Theme plumbing: `ThemeProvider`, `useTheme`, `resolveInitialTheme` and `applyTheme`.
  - Scripts: `build` (tokens, then tsc), `check:generated` and `lint` (ESLint, then Stylelint).
- `@ralysa/repo-scripts` `src/check-contrast.ts` holds the WCAG 2.1 ratio, `MIN_RATIO` and `checkContrast`. It is exported as `@ralysa/repo-scripts/check-contrast` and run by `packages/ui` `test` against the parsed token model.
- The new `tooling/stylelint-config` (`@ralysa/stylelint-config`) contains the raw-colour rules and requires a description on every disable comment.
- `@ralysa/eslint-config` has a local plugin (`rules/`, registered as `ralysa/`) with `ralysa/no-raw-color`, wired into `reactUi()`.

### Placeholder token contrast (`check-contrast`, TC-F-001-23)

There are 25 pairs, checked in both themes (50 checks): **all pass**. Every ratio matches the §7.1.3 table. The lowest ratio per kind:

| Kind | Minimum | Lowest light | Lowest dark |
|---|---|---|---|
| text | 4.5 | 5.41 (`status.success` on `bg.surface`/`bg.canvas`) | 6.88 (`fg.muted` on `bg.subtle`) |
| nonText | 3 | 3.89 (`border.control` on `bg.subtle`) | 4.35 (`border.control` on `bg.subtle`) |
| focus | 3 | 5.88 (`focus.ring` on `bg.subtle`) | 7.13 (`focus.ring` on `bg.subtle`) |

The full table prints in the `@ralysa/ui:test` log. Exempt: `color.fg.disabled` (WCAG 1.4.3 inactive components) and `color.border.decor` (decorative, never a control's only boundary).

### Recorded decisions and deviations

| # | Type | What | Why |
|---|---|---|---|
| T06-1 | Design inconsistency, fixed | `TokenPath` and `Alias` allow `_` in every segment after the first. | The §3.2 regex (`[a-zA-Z0-9]+` segments) rejects `space.0_5` and `space.1_5`, which §7.1.2 requires. DTCG allows `_` in names. |
| T06-2 | Design deviation (small) | `MIN_RATIO` lives in `check-contrast.ts` (repo-scripts), not in `packages/ui/src/contracts/tokens.ts`. There is no `ralysa-repo check-contrast` CLI command: the gate runs inside `@ralysa/ui` `test` (as §7.1.4 says), which passes in its own resolved tokens. | The threshold belongs to the gate. `packages/ui` src must not import a tooling package (AR-3), and repo-scripts can't depend on `@ralysa/ui`. `check-contrast.ts` imports nothing, so the browser-library workspace can import it from source. |
| T06-3 | Contract detail | `contrast-pairs.json` is `{ pairs, exempt }`. `exempt` entries need a reason of at least 20 characters. A pair that names an exempt token fails. A test fails if any semantic colour token is in neither a pair nor `exempt`. | §3.2 says exempt tokens are "listed with a reason" but gives no shape. The coverage test stops a new colour token from skipping the gate. |
| T06-4 | Addition | Pairs beyond the §7.1.3 list: `fg.default` and `fg.muted` on `bg.surface`, `link` on `bg.surface`, `accent.default` on `bg.canvas`, `border.control` and `focus.ring` on `bg.canvas`/`bg.surface`, and the status colours on `bg.canvas`/`bg.subtle`. | These are combinations the components will use. All pass. |
| T06-5 | **Gap in the design (not filled)** | `color.bg.surfaceRaised` (§7.1.2 examples) has no value in §7.1.3, so it isn't defined. | Picking a colour is a design decision. The first raised component (the T11 `Select` popover) should add it with light and dark values and its contrast pairs. |
| T06-6 | Implementation choice | Tailwind names: the `bg` group and a trailing `default` are dropped (`bg-canvas`, `text-fg`, `bg-accent`, `bg-accent-hover`). `font.*` maps to `font`/`text`/`font-weight`/`leading`/`tracking`; `space.*`, `size.control.*` and `size.icon.*` map to `--spacing-*`; `size.container.*` maps to `--container-*`; `elevation.shadow.*` to `--shadow-*`; `motion.easing.*` to `--ease-*`. Layers, durations and the focus-ring size stay CSS-variable only. The reset list is in `TAILWIND_RESETS`. | §7.1.1 gives one example (`--color-canvas`). The rule has to be mechanical so generated names never collide; the generator fails on a collision. |
| T06-7 | Implementation choice | Palette primitives aren't emitted as CSS variables. Semantic values are emitted resolved. | "Components use semantic tokens only" (§7.1.1). |
| T06-8 | Scope note | The §7.2 `:lang(ar)` values are in the token source now, as `$extensions["solutions.ralysa.lang"]`: body line height 1.7, letter spacing 0. The font stacks are the §7.2 stacks. | The generator's `:lang()` support is part of §7.1.1, and the values are known. T09 still owns the font packages and `fonts.css`. |
| T06-9 | Implementation choice | `packages/ui/tsconfig.json` (no emit: src, tests, scripts) adds `types: ["node"]` and `allowImportingTsExtensions`. `tsconfig.build.json` switches both off. | The generator and the token tests run on Node type stripping. Turning both off for the emit build means `build` fails if shipped `src/` code ever uses a Node type or a `.ts` import. |
| T06-10 | Implementation choice | `ralysa/no-raw-color` doesn't apply to test files (`TEST_FILES`). | AC-3 targets "component or app code". Tests assert on colour values. |
| T06-11 | Sequencing | The "default-palette classes → error" part of TC-F-001-07 is proven here at the theme level: Tailwind's own compiler builds nothing for `bg-red-500`, `text-slate-900`, `bg-white`, `shadow-2xl` and `font-serif` against the generated theme (`test/tokens.test.ts`). The **lint** error (`better-tailwindcss/no-unknown-classes`) lands with T07, which wires the plugin to the Tailwind entry point. | `better-tailwindcss` belongs to T07's file list (`react-ui.js`, logical, restricted and unknown rules). |
| T06-12 | Note | `letterSpacing` values are in `rem`. | DTCG 2025.10 `dimension` allows only `px` and `rem`. |

### Versions (npm registry, 2026-09-25 ~10:10 UTC; 3-day cut-off 2026-09-22T10:10Z)

| Package | Design | Pinned | Notes |
|---|---|---|---|
| `stylelint` | 17.x | **17.15.0** (catalog) | Published 2026-09-04. MIT, no install scripts. |
| `tailwindcss` | 4.3.x | **4.3.3** (catalog) | Published 2026-07-16. It is a devDependency of `@ralysa/ui` for the theme compile test; T07 uses it for `better-tailwindcss`. |
| `jsdom` | (not pinned) | **30.1.0** (catalog) | **30.1.1 (2026-09-22T02:07Z) is inside the 3-day window.** 30.1.0 was published 2026-09-17, and the 30 line has been GA since 2026-07-27. Engines `^24.15.0` is satisfied by 24.21.0. |
| `zod` | 4.6.x | 4.6.5 (existing catalog) | `.finite()` is deprecated in zod 4 (it's the default), so it isn't used. |

None of these runs an install script. `allowBuilds` is unchanged in T06.

### Tests added (T06)

- `packages/ui/test/tokens.test.ts` (**TC-F-001-06**):
  - the real source validates, with all 7 categories in both themes, identical light/dark keys, and the §7.1.3 values;
  - failure fixtures: key-set mismatch, unresolved alias, alias of the wrong type, alias cycle, hex/components mismatch, missing `$type`, unknown key, `.` in a name, primitive in a semantic file, missing category;
  - generator outputs, and `generated.ts` equal to the source;
  - Tailwind compile: token classes resolve to `var(--ralysa-*)`, and default-palette classes produce nothing.
- `packages/ui/test/contrast.test.ts` (**TC-F-001-23**): every real pair passes in both themes; every semantic colour token is covered; a `#777777` fixture (4.48:1) and a translucent fixture fail.
- `tooling/repo-scripts/test/contrast.test.ts` (**TC-F-001-22**): reference ratios (21, 1, 4.478, 4.542, 7.0 and the design values); symmetry; the linearisation knee; `MIN_RATIO` per kind; no rounding up (4.478 fails text); translucent, unresolved and exempt-in-pair findings.
- `packages/ui/test/theme.test.tsx` (jsdom): `resolveInitialTheme` order and throwing storage; `ThemeProvider` sets and removes `data-theme`; `useTheme` outside a provider; `tokenVar`.
- **TC-F-001-07**:
  - `tooling/eslint-config/test/raw-color.test.ts`: `RuleTester`, 11 valid and 21 invalid cases (hex forms, every colour function, template literals, style objects, `bg-[#fff]`, `text-[rgb(…)]`, `border-[oklch(…)]`); the composed preset reports component code and not test files.
  - `tooling/stylelint-config/test/raw-color.test.ts`: hex, named colours and every colour function report an error; tokens, `color-mix()` over `var()`, `currentcolor`/`transparent` and Tailwind `@theme` with `var()` pass; token and `dist` files are ignored; disable comments must carry a description, and a needless disable is reported.

## T07: logical-layout lint

### What landed

- **Stylelint** (`@ralysa/stylelint-config`):
  - `stylelint-plugin-logical-css`: `require-logical-properties`, with `ignore` set to the block-axis and sizing properties the plugin maps (`BLOCK_AXIS_PROPERTIES`, taken from the plugin's own property map), and `require-logical-keywords`, with the non-left/right properties ignored.
  - `declaration-property-value-disallowed-list` catches the forms the plugin can't see: 4-value shorthands (`margin`, `padding`, `inset`, `scroll-margin`, `scroll-padding`, `border-{width,style,color}`) whose right and left values differ, found by a back-reference regex that treats `calc(var(--a) + 1px)` as one value; `border-radius` whose left and right corners differ; `background-position(-x)` and `transform-origin` with `left`/`right`; horizontal `translate`/`translateX`/`translate3d` unless the offset uses `var(--ralysa-dir-sign)`; and `outline: none|0` (§7.7).
- **ESLint** (`react-ui`):
  - `eslint-plugin-better-tailwindcss` `enforce-logical-properties`, with block-axis and sizing classes ignored.
  - `no-restricted-classes` (the list is in `tooling/eslint-config/tailwind.js`) and `no-unknown-classes`. They use the plugin's default selectors, which cover `className`, `class`, `cn`, `clsx`, `cva` and `tv`.
  - `ralysa/no-physical-inline-style`.
  - All of these apply to UI source, not tests. `reactUi({ tailwindEntryPoint })` points the plugin at the workspace's Tailwind entry point.
- **`packages/ui`**:
  - `src/styles/tailwind.css` is the entry point (`tailwindcss` plus the token theme), exported as `@ralysa/ui/tailwind.css`. `eslint.config.js` passes it to `reactUi`.
  - `tokens.css` now defines `--ralysa-dir-sign`.

### Recorded decisions and deviations

| # | Type | What | Why |
|---|---|---|---|
| T07-1 | **Design deviation** | The Tailwind theme is generated into `packages/ui/src/styles/theme.css` (committed, drift-checked by `check:generated`, and compared with the source by `test/tokens.test.ts`) instead of `dist/css/theme.css`. `@ralysa/ui/theme.css` points there. `tokens.css` stays in `dist/`. | The lint loads the theme through the entry point. With the theme in `dist/`, `packages/ui` `lint` would depend on its own `build`, and every UI workspace's lint and the scaffold test (TC-F-001-46) would depend on build order. The theme holds only `var()` references (no colour values), so keeping it in `src/` doesn't weaken the raw-colour rules. |
| T07-2 | Implementation choice | Without `tailwindEntryPoint`, `reactUi()` uses `tailwind/no-theme.css`, whose theme is empty (`--*: initial`), so every token-backed class is reported as unknown. | If the entry point were missing, the plugin would fall back to Tailwind's default theme, and `bg-red-500` would pass. With the empty-theme fallback, a forgotten option fails loudly instead. The scaffold templates keep `reactUi()`: their slot components use no classes. |
| T07-3 | Implementation choice | The mirroring pattern is an `ltr:`/`rtl:` pair: any class with an `ltr:` or `rtl:` variant is exempt from the `translate-x-*`, `bg-left/right*`, `origin-*left/right` and `bg-linear-to-l/r*` restrictions. | §7.3.3 asks the messages to give "the `rtl:` variant pattern". A pair is the only way to write a mirrored directional utility, so it has to pass. |
| T07-4 | Refinement | `border-radius` values like `4px 4px 0 0` (top corners equal, bottom corners equal) pass. | §7.3.2 says "multi-value `border-radius` unless all values are equal". A value whose top corners match and whose bottom corners match mirrors onto itself, so flagging it would be a false positive on a common pattern (a top-rounded panel). Every value whose left and right corners differ still fails. |
| T07-5 | Additions | `transform-origin` with `left`/`right`, `scroll-margin`/`scroll-padding` 4-value shorthands, and physical Tailwind arbitrary properties (`[margin-left:…]`, `[text-align:right]`) are errors too. | These are the same physical forms as the listed ones, and the parallel Tailwind or property rule already covers them in another notation. |
| T07-6 | Scope note | `outline: none` is an error everywhere, not only in `:focus` contexts (§7.7). | `declaration-property-value-disallowed-list` can't scope by selector. The escape hatch is a described disable. |
| T07-7 | Implementation note | Tailwind 4.3.3 was checked to know every logical replacement class the plugin suggests (`inset-s-*`, `pbs-*`, `rounded-ss-*`, `scroll-ms-*`, and so on). This matters because `enforce-logical-properties` stays silent when its replacement class is unknown. The token theme's spacing reset was checked too: `p-7` doesn't exist, while `p-4` and `p-0.5` do. | Probed with Tailwind's own compiler before wiring. |
| T07-8 | Note | `--ralysa-dir-sign` is emitted by the token generator into `tokens.css` (`:root, [dir='ltr']` → 1, `[dir='rtl']` → -1). | The translate rule allows only that pattern, so the variable has to exist. |

### Versions (npm registry, 2026-09-25 ~10:10 UTC)

| Package | Design | Pinned | Notes |
|---|---|---|---|
| `stylelint-plugin-logical-css` | 2.1.x | **2.1.0** | Published 2026-03-29. MIT, no dependencies, no install scripts; peer `stylelint ^14…^17`. |
| `eslint-plugin-better-tailwindcss` | 4.7.x | **4.7.0** | Published 2026-07-19. MIT; peer `eslint ^7…^10` (optional), `tailwindcss ^3.3 \|\| ^4.1.17`. No install scripts in its tree (`synckit`, `jiti`, `valibot`, `enhanced-resolve`, `tailwind-csstree`, `tsconfig-paths-webpack-plugin`, `@eslint/css-tree`). |
| `tailwindcss` | 4.3.x | **4.3.3** (catalog) | Also a dependency of `@ralysa/eslint-config`, so the plugin and the fallback entry point resolve it. |
| `@types/estree` | (not pinned) | **1.0.9** | Already in the lockfile through ESLint. It is a devDependency of `@ralysa/eslint-config` for the rule JSDoc types. |

### Tests added (T07)

- **TC-F-001-08**, CSS: `tooling/stylelint-config/test/logical.test.ts` (74 cases).
  - 19 inline-axis properties, each an error, with its logical equivalent passing.
  - 14 block-axis and sizing properties allowed.
  - 7 keyword pairs; non-directional keywords allowed.
  - 22 shorthand and value pairs (4-value shorthands including `calc()` operands, radii, positions, origins, `transform` and `translate`, the `--ralysa-dir-sign` pattern).
  - Outline removal, with a described disable as the escape hatch.
  - Tailwind v4 at-rules parse cleanly.
- **TC-F-001-08**, ESLint: `tooling/eslint-config/test/logical.test.ts` (113 cases).
  - `RuleTester` for `ralysa/no-physical-inline-style`: every listed key, `textAlign`/`float`/`clear` values, string keys, conditional, `&&`, spread, and `as`/`satisfies` wrappers.
  - Through the composed preset with a fixture theme: 24 physical Tailwind classes → `enforce-logical-properties`, each logical fix passing; 13 block-axis and sizing classes allowed; 14 restricted forms, each with a passing alternative, including the `ltr:`/`rtl:` pairs; class strings in the `cn`/`clsx`/`cva`/`tv` callees; test files exempt; the empty-theme fallback fails loudly.
- **TC-F-001-07**, Tailwind part: arbitrary colours (`bg-[#fff]`, `text-[rgb(…)]`, `border-[oklch(…)]`, `bg-[color:#…]`) → `no-restricted-classes`; `bg-red-500`, `text-slate-900`, `bg-white`, `p-7` and `rounded-3xl` → `no-unknown-classes`.
- A manual check, not a test: `eslint --stdin` in `packages/ui` with the real entry point reported `bg-red-500` (unknown), `ml-4` (logical) and `marginLeft` (inline style). `bg-canvas`, `p-4`, `text-fg-muted` and `h-control-md` passed.

## Version confirmations (npm registry, 2026-09-25 ~08:20 UTC)

Policy (§2.2): the latest patch of a line GA for at least 30 days, and `minimumReleaseAge` holds back anything under 3 days old. Cut-off for the 3-day rule: 2026-09-22T08:20Z.

| Tool | Design | Pinned | Registry facts and deviation |
|---|---|---|---|
| Node.js | 24.x (24.21.0) | **24.21.0** | Latest 24 LTS. As designed. |
| pnpm | 11.27.N | **11.27.1** | `latest-11` = 11.27.1 (2026-09-20). pnpm 12.6.0 is `latest`; the 12 line is under 30 days old (12.0.0 on 2026-08-26). As designed. |
| Turborepo | 2.11.x | **2.11.2** | **Deviation.** 2.11.3 (2026-09-22T20:39Z) and 2.11.4 (2026-09-24) are inside the 3-day window, and pnpm rejected the old lockfile's 2.11.3 with `ERR_PNPM_MINIMUM_RELEASE_AGE_VIOLATION`. The 2.11 line itself is only 7 days old (2.11.0 on 2026-09-18), so it doesn't meet the 30-day policy either. Kept on 2.11 because the design pins it and the previous lockfile already used 2.11.3. Move to the newest 2.11 patch after the window passes. |
| TypeScript | 6.0.x (6.0.3) | **6.0.3** | `latest` is 7.0.2; typescript-eslint 8.70.1 declares `typescript >=4.8.4 <6.1.0`. As designed. |
| ESLint | 10.x | **10.11.0** | 2026-09-18. `@eslint/js` is 10.0.1 (its latest). As designed. |
| typescript-eslint | 8.70.x | **8.70.1** | Peer `eslint ^8.57 \|\| ^9 \|\| ^10`. As designed. |
| `@eslint-react/eslint-plugin` | 5.20.x | **5.20.5** | **Minor deviation.** 5.20.6 to 5.20.8 were all published 2026-09-23 (inside the 3-day window); 5.20.5 is the newest allowed 5.20 patch. |
| `eslint-plugin-react-hooks` | 7.1.x | **7.1.1** | As designed. |
| `eslint-plugin-jsx-a11y` | 6.10.2 via `@eslint/compat` 2.1.x | **6.10.2**, `@eslint/compat` **2.1.1** | Spike passed (see T02). |
| `@eslint-community/eslint-plugin-eslint-comments` | (not pinned in the design) | **4.8.1** | Peer includes ESLint ^10. Needed for the T02 lint-comment rules. |
| Prettier | 3.9.x | **3.9.8** | **Minor deviation.** 3.9.9 (2026-09-23) is inside the 3-day window. |
| Vitest | 4.1.x | **4.1.11** | Peer `vite ^6 \|\| ^7 \|\| ^8`. Vitest 5.0.1 is `latest`, but the 5 line is under 30 days old. As designed. |
| Vite | 8.3.x | **8.3.0** | **Minor deviation.** 8.3.1 (2026-09-24) is inside the 3-day window. 8.3.0 (2026-09-10) is 15 days old, under the 30-day policy but pinned because the design names 8.3.x. |
| `@vitejs/plugin-react` | 6.1.x | **6.1.1** | As designed. |
| React / React DOM / types | 19.x | **19.3.0** | As designed. |
| zod | 4.6.x | **4.6.5** | As designed. |
| `@types/node` | (not pinned) | **24.13.6** | Matches Node 24. |
| `globals` | (not pinned) | **17.12.0** | |
| `yaml` | (new) | **2.9.1** | **New dependency** of `@ralysa/repo-scripts` (ISC, no dependencies, no install scripts), used to read `pnpm-workspace.yaml` for the `allowBuilds`, `enablePrePostScripts` and `packs/` rules. |

No dependency added by T01 to T03 runs a build script: `allowBuilds` is still `{}`, and `strictDepBuilds` would have failed the install otherwise. The only `pnpm peers check` finding is jsx-a11y's ESLint ≤ 9 peer range (covered by the spike).

## Left incomplete / follow-ups

- **TC-F-001-02 in CI.** It needs a throw-away PR; see above. Run it on the first PR from this branch.
- **The first CI run of `repo-checks` and `quality`** is unverified: nothing has been pushed to a PR yet. Things to watch: Corepack's download of pnpm on the runner, `pnpm store path` before the first install, and job time against the §8.3 budget.
- **Guard fixtures in `repo-checks`** (`node --test .claude/hooks/test/`) arrive with T15 (human merge).
- **T15 and required-checks.json:** T15 must keep T03's `required-checks.json` content (T03-2).
- Bump Turbo, Prettier, Vite and `@eslint-react` to their newest patches once those are outside the 3-day window.
