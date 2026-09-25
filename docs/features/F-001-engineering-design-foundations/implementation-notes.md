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

## T04: boundary rules

Branch `feat/F-001-boundaries-secrets` (T04, T05 and T16 together, one commit per task). Date: 2026-09-25.

### What landed

- **`tooling/eslint-config/boundaries.js`** now holds the lists. `BANNED_PACKAGE_GROUPS` has four groups, in this order, and a package belongs to the first one that matches it:
  - `agent-sdk`: `@anthropic-ai/claude-agent-sdk` and its `-*` platform packages.
  - `anthropic-sdk-peer`: `@anthropic-ai/sdk`.
  - `model-provider`: the §6.1 SR-03 list, scope bans included, with no `@ai-sdk/react` exemption.
  - `telemetry-vendor`: the AR-9 list.

  Each group has `importAllowedIn` (ESLint and dependency-cruiser) and `graphAllowedThrough` (check-banned-deps). The file also has `RESTRICTED_SYNTAX` (the loading ban), `LOADING_EXCEPTIONS` (empty), `WORKSPACE_DEPENDENCY_RULES` (web/packages → agent-host, anything → ui-lab) and the shared glob helpers. Platform package names were checked on npm: `@anthropic-ai/claude-agent-sdk@0.3.282` has optional deps `-darwin-arm64`, `-linux-x64-musl` and so on, and peer `@anthropic-ai/sdk >=0.93.0`.
- **`base.js`**: `no-restricted-imports` gets one `regex` pattern per group, covering the package and any subpath. `base()` works out the workspace from `tsconfigRootDir` and adds a block only for the allowed paths inside it. `services/agent-host` gets `src/engine/claude/**` (Agent SDK plus peer), and `services/model-gateway` gets `**` (providers plus `@anthropic-ai/sdk`). Every other rule stays in force there. The `no-restricted-syntax` loading ban, the eslint-comments rules and the `tests` preset keep their shape.
- **`.dependency-cruiser.cjs`** (root). It `require`s the ESM `boundaries.js`, which Node 24 supports. It has one rule per group, plus `no-ui-lab`, `no-packs` and the four layering rules. It scans `apps packages services tooling packs` through **`ralysa-repo check-imports`**.
- **`check-banned-deps`**: builds the lockfile v9 graph (importers with prod, dev and optional deps; snapshots with deps and optional deps; `link:` edges to workspaces; aliases resolved by key). It runs one BFS per importer over (node, progress along each allowed sequence) states, and reports each banned package once per importer with a witness path. It fails closed on another lockfile version and on an entry it can't resolve.
- `repo-check` (and therefore `pnpm repo:check` and the CI `repo-checks` job) runs `check-banned-deps` and `check-imports` after the existing checks. `main` in `cli.ts` became async for dependency-cruiser's API.

### Recorded decisions and deviations

| # | Type | What | Why |
|---|---|---|---|
| T04-1 | Version | **dependency-cruiser 18.2.0**, not the newest 18.4.0. | This follows the §2.2 policy, applied per minor line as in the T01 notes. 18.2.0 was published 2026-08-10 (46 days ago), while 18.3.x (2026-09-13/14) and 18.4.0 (2026-09-20) are under 30 days old. 18.2.0 has provenance (SLSA v1 attestation), `engines.node ^22‖^24‖>=26`, MIT, and no `preinstall`/`install`/`postinstall`. Its `prepare` (husky) and `prepack` scripts don't run for registry installs, and `strictDepBuilds` passed. It adds 36 packages, all its own closure. The rest of the lockfile diff is the same packages re-keyed with a `supports-color` peer suffix, because `debug`'s optional peer now resolves. No base version changed (compared name@version lists before and after). |
| T04-2 | Placement | dependency-cruiser is a dependency of `@ralysa/repo-scripts` and runs through its API (`check-imports`), not a root devDependency with a CLI step. | It gives the same `Finding` output as the other checks, it can be tested with fixtures, and it's part of `repo-check`. |
| T04-3 | Design deviation (small) | `.dependency-cruiser.cjs` uses **no `includeOnly`**, and its `exclude` is anchored to workspace output folders (`^(apps\|packages\|services\|tooling\|packs)/[^/]+/(dist\|coverage\|.turbo\|.tsc)/`). §6.1 says "`includeOnly` and `exclude` are set so …". | Found while testing. `includeOnly: '^(apps\|…)/'`, or an unanchored `node_modules`/`dist` exclude, also removes every dependency on a package (`node_modules/.pnpm/vite@…/vite/dist/…`) and every unresolved one (`openai`). The banned-package rules then silently never fire. With the first draft, the real repo reported 0 violations while `apps/web/vite.config.ts` showed no dependencies at all. **Guard:** `check-imports` fails with `imports/graph-sanity` when dependencies were cruised but none points at a package. |
| T04-4 | Implementation note | `check-imports` cruises the **real path** of the root. | enhanced-resolve returns real paths. Under a symlinked root (macOS `/var` → `/private/var`), every cross-folder target came back as `../../../../private/var/…`, so no path rule matched. The fixture tests caught it. |
| T04-5 | Implementation note | `conditionNames` is `import, require, node, default` (no `types`). | Our tooling packages list `types: ./dist/*.d.ts` first in `exports`. Before a build, that condition wins and then fails, which leaves `@ralysa/*` unresolved. |
| T04-6 | Interpretation | `@anthropic-ai/sdk` has its own group. Imports are allowed in agent-host `engine/claude/**` **and** in `services/model-gateway/**`. In the graph it's allowed through `@ralysa/agent-host` → `@anthropic-ai/claude-agent-sdk`, or through `@ralysa/model-gateway`. | §6.1: `@anthropic-ai/*` is a provider scope allowed in the gateway, and AR-6 makes the SDK peer the one standing exception inside agent-host. F-004 may narrow the gateway path. |
| T04-7 | Scope note | ESLint's layer covers static `import`/`export … from` (including `import type`). `require('x')` and `import('x')` with a literal are dependency-cruiser's job, as §6.1 assigns. | `no-restricted-imports` doesn't inspect `require` or `ImportExpression`. Non-literal forms are banned by `no-restricted-syntax`. |
| T04-8 | Implementation choice | The loading ban matches any mention of `createRequire`, `getBuiltinModule` and `eval` (`Identifier[name=…]`), plus the computed-member forms, instead of call shapes only. | This also catches `import { createRequire as cr }`, `(0, globalThis.eval)(…)` and a stored reference. A search of the tracked sources found no such code, so the rule lands at 0 findings. |

### Tests added (T04)

- `tooling/eslint-config/test/boundaries.test.ts` (79):
  - **TC-F-001-29, ESLint layer.** 29 banned names are errors, including subpaths, platform packages, `ai`, `@ai-sdk/react`, `@ai-sdk/gateway` and `@openrouter/*`. They fire in test, test-helper, script and config paths too. Look-alikes are allowed. The type-only and re-export forms are banned.
  - **Allowed paths.** Only agent-host `engine/claude/**` may use the Agent SDK. The gateway may use providers in every file. A look-alike workspace (`services/model-gateway-v2`) gets no exception. The isomorphic preset keeps the bans.
  - **TC-F-001-42, loading ban.** Errors: non-literal `import()` and `require()`, `createRequire`, `module.createRequire`, the computed form, `getBuiltinModule`, direct and indirect `eval`, `new Function` and `Function()`. Allowed: literal `import()`, literal `require()` and `import.meta.glob`.
  - **TC-F-001-42, disable comments.** A described disable, a bare block disable and inline config aimed at the boundary rules are all errors.
- `tooling/repo-scripts/test/check-banned-deps.test.ts` (20):
  - The real lockfile passes.
  - A provider two levels down a **dev** closure fails, with the witness path. Optional deps and the root are checked.
  - `@ai-sdk/react` → `ai` → `@ai-sdk/gateway` fails on all three.
  - An `npm:` alias fails, both at the top level and inside a dependency.
  - The gateway may hold providers but not telemetry.
  - The Agent SDK passes in agent-host, and through agent-host from `apps/cli`. A direct dependency from `apps/cli` fails for the SDK, its peer and its platform package. A bare `@anthropic-ai/sdk` in agent-host fails.
  - `apps/web` → `packages/ui` → `agent-host` fails for both. Any dependency on ui-lab fails.
  - Cycles terminate.
  - It fails closed on a bad lockfile version, an unresolvable entry and a dangling `link:`.
- `tooling/repo-scripts/test/check-imports.test.ts` (10):
  - The real repo passes, and so does a clean tree.
  - **TC-F-001-26:** `apps/web` → `apps/ui-lab` fails, by path and by package name.
  - `require()`, `import()` and `import type` of banned packages are caught.
  - Test, script, config and tooling files are scanned.
  - `packs/**` is scanned, and nothing may import it.
  - The Agent SDK and the providers are held to their allowed paths.
  - The four layering rules and the graph-sanity guard are covered.
- TC-F-001-30 (`packs/*` not a workspace glob) was already covered by T02's `check-workspaces`, which runs in `repo-checks`.

## T05: CI secret scan

### What landed

- **`tooling/repo-scripts/bin/tool-hashes.txt`** pins gitleaks **8.30.1** for `linux_x64`, `darwin_arm64` and `darwin_x64`. Each line holds the URL, the archive SHA-256 and the extracted-binary SHA-256.
- **`bin/install-tool.sh`** (POSIX sh) checks the archive, extracts only the binary and checks it too, then moves it into `.tools/gitleaks/8.30.1/`. It never reads a downloaded checksums file. An existing binary is re-verified, and a mismatch fails and is not replaced. `--verify` only verifies.
- **`.gitleaks.toml`** and **`.gitleaks.artefacts.toml`** share the same five custom rules (`azure-openai-key`, `litellm-key`, `mistral-api-key`, `groq-api-key`, `ralysa-selftest-canary`), each with keywords and an entropy floor.
  - The repo config uses `[extend] useDefault = true`.
  - The artefact config has **no `[extend]` and no allow-list**. It carries 25 rules copied from the gitleaks default instead (see T05-1, decided).
- **`src/secret-scan.ts`**, **`src/secret-scan-selftest.ts`** and **`src/secret-scan-cli.ts`** (`pnpm secret-scan pr|tree|history|artefacts|selftest`). They are dependency-free, so the `secret-scan` job has no install. Every call re-hashes the binary, uses explicit `--config` and the fixed flags, and treats exit codes as 0 = pass, 1 = findings, anything else = scanner error. It also treats exit 1 with an empty report, and exit 0 with findings, as scanner errors. The PR scan asserts a non-empty `base..head`, and a missing artefact path fails.
- **`check-gitleaks-config`** and **`check-ci-invariants`**, both in `repo-check`.
- **CI:**
  - A new **`secret-scan`** job: `fetch-depth: 0`, no install and no build, the gitleaks cache keyed on `tool-hashes.txt` and re-verified, then the PR range (PRs), tree, full history (push to `main`) and self-tests. Reports are uploaded on failure.
  - In **`quality`**: gitleaks is installed before the Turbo run (see T05-6), and `secret-scan artefacts` runs after the build, outside Turbo.
  - `required-checks.json` adds `secret-scan`.
- Root scripts `tools:install` and `secret-scan`.

### Versions and hashes (checked 2026-09-25)

| Item | Pinned | Evidence |
|---|---|---|
| gitleaks | **8.30.1** (MIT), released 2026-03-21, the `Latest` GitHub release (8.30.0 was 2025-11-26) | `gh release view v8.30.1 --repo gitleaks/gitleaks` asset digests = the lines in the release's `gitleaks_8.30.1_checksums.txt` = `shasum -a 256` of each downloaded tarball, for all three platforms. |
| archive `linux_x64` | `551f6fc83ea457d62a0d98237cbad105af8d557003051f41f3e7ca7b3f2470eb` | as above |
| archive `darwin_arm64` | `b40ab0ae55c505963e365f271a8d3846efbc170aa17f2607f13df610a9aeb6a5` | as above |
| archive `darwin_x64` | `dfe101a4db2255fc85120ac7f3d25e4342c3c20cf749f2c20a18081af1952709` | as above |
| binary `linux_x64` | `88f91962aa2f93ac6ab281d553b9e125f5197bbbce38f9f2437f7299c32e5509` | sha256 of `gitleaks` extracted from the verified tarball |
| binary `darwin_arm64` | `ba52fb1bfabbcde42f032afad3d6e0b19dff8ed105229a16e7caa338bbc0e84f` | as above; `gitleaks version` prints `8.30.1` |
| binary `darwin_x64` | `cee01fea7173f1b779dff188e1c26ecbcb4027d394acc573b23aaf0be260e291` | as above |
| smol-toml | **1.8.0** (BSD-3-Clause, no dependencies, no install scripts, SLSA provenance) | New dependency of `@ralysa/repo-scripts` for `check-gitleaks-config`. 1.9.0 (2026-09-22) is under 30 days old; 1.8.0 is from 2026-08-11. The lockfile adds only this package. |

### Recorded decisions and deviations

| # | Type | What | Why |
|---|---|---|---|
| T05-1 | **Design gap: decided 2026-09-25** (coordinator, under standing authorization; implemented in the follow-up commit "artefact scan without inherited allow-list"; see "T05-1 decision" below) | *As found:* `[extend] useDefault = true` made both configs inherit **gitleaks' default global allow-list**, so the artefact config is not allow-list-free, as §6.2.2 ("None, ever") and SEC-F001-05 intend. From the v8.30.1 `config/gitleaks.toml`, it skips any path matching, among others: `gitleaks\.toml` (unanchored, so any file whose path contains it); image and font extensions (`.svg`, `.png`, `.woff2` …); `(?:^\|/)node_modules(?:/.*)?$`; lockfiles; and `(?:^\|/)(?:angular\|bootstrap\|jquery(?:-?ui)?\|plotly\|swagger-?ui)[a-zA-Z0-9.-]*(?:\.min)?\.js(?:\.map)?$`. It also has content regexes (`true\|false\|null`, `${VAR}` shapes) and stopwords. So a Vite chunk named `swagger-ui-<hash>.js`, or a secret inside an `.svg` in `dist/`, would not be reported. gitleaks has no option to extend the default rules without their global allow-list. `check-gitleaks-config` can't see it, because it is inside the binary's default, not in our file. | The design mandates both `useDefault = true` and an allow-list-free artefact config, and in gitleaks 8.30.1 the two conflict. The self-test's `dist/assets/index-abc123.js` path is not affected, so TC-F-001-38 passes as specified. **Options for the security reviewer:** (a) accept the residual risk and record it; (b) in the artefact config, vendor the default rules without `[extend]` (about 3,200 lines to keep in sync on every gitleaks upgrade; `check-gitleaks-config` could diff them against the pinned release); (c) add artefact self-test cases for the skipped shapes so the gap is visible. **Decision:** (b) with a curated rule set, plus (c). |
| T05-2 | Hardening within the design's intent | **`.gitleaksignore` is neutralised.** The wrapper passes `--gitleaks-ignore-path <empty folder>` and **refuses a target that holds a `.gitleaksignore`**. `check-gitleaks-config` fails on any tracked `.gitleaksignore`. | Checked with 8.30.1: a `.gitleaksignore` in the scanned directory's root suppressed a matching finding **even with `-i` pointing at an empty folder** (a nested one doesn't). That is a second allow-list outside the configs, which §6.2.2 rules out ("the configs are the only allow-list"). A `public/.gitleaksignore` would be copied into `dist/` by Vite. |
| T05-3 | Open (design allows) | `azure-openai-key` covers the **32-hex format only**. | §6.2.2 asks to add the newer long Azure key format "if T05 confirms it". I couldn't confirm it from an authoritative source (web search; the GitGuardian detector page publishes no format). Add it when Microsoft or GitHub secret-scanning documentation gives the pattern. |
| T05-4 | Implementation choice | `check-gitleaks-config` also fails on `[extend] path`/`url` (either config), `[extend] disabledRules` (artefact config), content allow-lists (`regexes`, `stopwords`, `commits`) in the repo config, and a custom rule with no keywords or an entropy floor below 3. | Each enforces a sentence of §6.2.2: the artefact config "can never inherit an allow-list", there are "no content allow-list entries", and each rule has "keyword context and an entropy floor". |
| T05-5 | Implementation choice | The scans run through a **separate, dependency-free entry `src/secret-scan-cli.ts`**, not a `ralysa-repo` subcommand. | `cli.ts` imports `yaml`, `typescript` and dependency-cruiser, and the `secret-scan` job has no install (§8.2). The same constraint shaped `pre-install-gate.ts`. |
| T05-6 | Sequencing and developer impact | In `quality`, gitleaks is installed **before** the Turbo run, and the `@ralysa/repo-scripts` tests that need it **fail** (they don't skip) with "run pnpm tools:install" when it is missing. `pnpm test` therefore needs a one-time `pnpm tools:install` per checkout, including each git worktree. | TC-F-001-03, -37, -38 and -39 prove detection with the real, hash-pinned scanner, so a fake would prove nothing, and a skip could let CI pass without running them. §9 already makes `pnpm tools:install` a one-time developer step. |
| T05-7 | Implementation choice | `tool-hashes.txt` also holds the **URL** and the **binary** hash, not only the archive hash per platform. | The binary hash is what every wrapper call re-verifies (§6.2.1). The URL in the reviewed file lets the tests run `install-tool.sh` against a `file://` archive, with no network and no test-only environment variables. |
| T05-8 | Implementation note | The keyword rules match the keyword, then up to 40 characters of anything (`.{0,40}?`), then the value. | A narrower character class missed `…openai.azure.com"; const k = "<key>"`. Values that come **before** the keyword aren't matched. |
| T05-9 | Implementation note | `check-ci-invariants` also enforces "no install, no build" in the `secret-scan` job. The Playwright digest check passes vacuously until T13/T14 add an image. | §8.2 states the first; the second is in TC-F-001-44 and becomes live with T13. |
| T05-10 | Implementation choice | The self-test fixtures build every token prefix with `frag('AK', 'IA')` and similar calls. No token body or prefix-shaped literal is in the source. | §6.2.5: "no matching literal exists in the repo". The lint rule `no-unnecessary-template-expression` rejected the first `${'AK'}${'IA'}` form, and its autofix would have joined the prefixes. |

### Local results (2026-09-25, darwin_arm64)

- `pnpm tools:install`: downloaded, archive and binary verified. A second run printed "gitleaks 8.30.1 verified".
- `pnpm secret-scan selftest`: dir, git, artefact and canary ✓. `tree`, `history` (all commits) and `artefacts` (`apps/web/dist`): **0 findings**. `pr --base 99c55d6 --head <T04 commit>`: 0 findings. With `--base` = `--head`: exit 2, "scan range is empty; is the base commit fetched?".
- **Not done:** TC-F-001-04 (the manual throw-away-branch PR) and the first CI run of the `secret-scan` job. Both need a PR, and this task says not to open one.

### Tests added (T05)

- `test/secret-scan-selftest.test.ts` (20):
  - The four self-test cases.
  - **TC-F-001-03:** every synthetic credential is reported at file:line, and the planted values are absent from the JSON report (redaction).
  - **TC-F-001-37:** the git range finds the set and ties it to the commit, and a clean range passes. The range helper fails on an empty range, a missing SHA and a non-SHA. The wrapper fails on exit 2, exit 126, a signal, exit 1 with no report, and exit 0 with findings. A target holding a `.gitleaksignore` is refused.
  - **The canary** fires with both of our configs and not with a default-only config.
  - **Re-verification:** a tampered or missing binary is refused.
  - **TC-F-001-38:** the exact CI command (`secret-scan-cli.ts artefacts`) on a throw-away repo finds a key under `apps/web/dist/assets/index-abc123.js`. A missing `dist` fails. A tampered binary makes `artefacts`, `tree` and `selftest` exit 2.
- `test/gitleaks-rules.test.ts` (3), **TC-F-001-39:** 11 positive fixtures across the five custom rules fire in both configs. 11 negatives trigger no custom rule: bare 32-hex hashes, a UUID next to `AZURE_OPENAI`, a keyword more than 40 characters away, `sk-` without context, LiteLLM context without a key, a low-entropy or 31-character Mistral value, a short `gsk_`, and a lowercase or short canary.
- `test/check-gitleaks-config.test.ts` (16), **TC-F-001-38 config part:** the real files pass. It fails on an artefact `[allowlist]`, `[[allowlists]]`, an empty `[allowlist]`, a rule-level allow-list, and `disabledRules`; on an unanchored repo path (an anchored one passes); on content allow-lists; on diverging rules; on a missing rule; on a weak entropy floor; on `useDefault = false` or `[extend] path`; and on a tracked `.gitleaksignore`.
- `test/check-ci-invariants.test.ts` (22), **TC-F-001-44:** five bad `packageManager` values; a missing `fetch-depth: 0`; four gitleaks calls without `--config` (in a workflow and in a hook), while five `--config`/`-c`/comment/wrapper forms pass; an unconditional `cancel-in-progress` at the top level and in a job; an install in `secret-scan`; and Playwright digests (same passes, different fails, tag-only fails).
- `test/install-tool.test.ts` (8), **TC-F-001-44 (install-tool part):** install and print the path; re-verify instead of downloading; `--verify` and install both fail on a tampered cached binary and leave it untouched; `--verify` fails when the binary is missing; an archive or binary hash mismatch installs nothing; an unknown tool or bad option fails; the real register pins 8.30.1 × 3 GitHub URLs.

### T05-1 decision: artefact scan without an inherited allow-list (2026-09-25)

**Decision** (coordinator, under the standing authorization): `.gitleaks.artefacts.toml` must not use `[extend]`, so it inherits no built-in global allow-list. It carries our custom rules plus a copy of the high-value default rules, and has no allow-list of any kind. This departs from design §6.2.2 ("Both use `[extend] useDefault = true`") in favour of the same section's "None, ever" for the artefact config.

**What changed**

- **`tooling/repo-scripts/vendor/gitleaks-8.30.1-default.toml`**: gitleaks' own `config/gitleaks.toml` at tag `v8.30.1`, byte for byte.
  - Its git blob `256f64790ea6d954f0041024be2938089ae1e7a7` equals the GitHub contents API's value for that path at the tag.
  - sha256 `e163e53b9e7e8a8511e77271e2b323ed057759542a6d988258afe3a1fa329caf` is recorded in `vendor/SHA256SUMS` and in `VENDORED_DEFAULT_SHA256`.
- **`.gitleaks.artefacts.toml`** has no `[extend]` and no global or rule-level allow-list. It holds:
  - the 5 custom rules, identical to `.gitleaks.toml`;
  - **25 copied default rules**: `aws-access-token`, `gcp-api-key`, `azure-ad-client-secret` (the only Azure rule in the default), `anthropic-api-key`, `anthropic-admin-api-key`, `openai-api-key`, `github-pat`, `github-fine-grained-pat`, `github-oauth`, `github-app-token`, `github-refresh-token`, `gitlab-pat`, `gitlab-pat-routable`, the 9 `slack-*` token and webhook rules, `stripe-access-token`, `private-key` and `jwt`.
  - Each copied rule's `id`, `regex`, `path`, `secretGroup`, `entropy` and `keywords` are taken verbatim; its rule-level allow-lists are dropped.
- **`check-gitleaks-config`** now fails when:
  - the artefact config has any `[extend]` or any allow-list;
  - a copied rule drifts from the vendored default;
  - a required copied rule is missing, or a rule is neither custom nor in the default;
  - the repo config holds non-custom rules;
  - the vendored file isn't the pinned one.
- **Anchored entry in `.gitleaks.toml`.** The vendored default's own text matches the `aws-amazon-bedrock-api-key-short-lived` rule, and the tree scan reported it. `.gitleaks.toml` therefore gets one exact, anchored path entry: `^tooling/repo-scripts/vendor/gitleaks-8\.30\.1-default\.toml$`. §6.2.2 allows root-anchored path entries, and the sha256 pin means the file's content can't change under the entry. The artefact config still has none.
- **Wrapper change.** For anchors to work, `dir` scans now run gitleaks with `cwd` = target and scan `.`, so reported paths are relative to the target. The target, config and report paths are resolved to absolute paths first.

**Not copied, and why**

- **`generic-api-key`.** It is not low-noise without its stopword allow-list. On a corpus of `apps/web/dist` plus 58 real production packages from our store (React DOM, Vite, TypeScript, Babel, ESLint, zod and others), it reported **1,174 false positives**, for example `exports.getEnv = …`. With it excluded, the same corpus gave 2 findings, both `jwt` on example JWTs in zod's **test sources**, which are never bundled.
- **A GCP service-account rule.** gitleaks 8.30.1 has none. A service-account key is JSON around a PEM `private_key`, which `private-key` covers.

**Self-tests.** The artefact case now plants the full synthetic set in `assets/index-abc123.js`, so the copied AWS, GitHub, Anthropic and PEM rules fire, not only the custom ones. It also plants a GitHub PAT and the canary in each shape the old allow-list skipped: `assets/logo-abc123.svg`, `assets/swagger-ui-abc123.js`, `node_modules/vendored-lib/index.js`, `assets/inter-abc123.woff2` (text content) and a path containing `gitleaks.toml`. All are found. **Control test:** the same shapes scanned with `.gitleaks.toml` (`useDefault`) are all skipped, which proves the self-test would catch a regression back to `[extend]`.

**Tests**

- `test/gitleaks-default-sync.test.ts` (28): the vendored file matches its sha256 and `SHA256SUMS`, and the pinned binary is 8.30.1. Each of the 25 copied rules equals the default in `id`, `regex`, `keywords`, `entropy`, `path` and `secretGroup`, and has no allow-list. The config holds exactly custom plus copied, with no `[extend]` or global allow-list. `generic-api-key` exists in the default but isn't copied.
- `test/check-gitleaks-config.test.ts` (25) fails on:
  - `[extend] useDefault`, `[extend] path` or an empty `[extend]` in the artefact config;
  - a global `[allowlist]` with paths, `[[allowlists]]`, an empty `[allowlist]` or a rule-level allow-list;
  - a copied rule's changed regex, entropy or keywords;
  - a removed `private-key`, or an unknown rule;
  - an edited vendored file.
  Together with the earlier cases.
- `test/secret-scan-selftest.test.ts` (26): the five shapes are found with the artefact config and skipped in the control.

**Results:**
- `secret-scan artefacts` on `apps/web/dist`: **0 findings**.
- `tree`, `history` and `selftest` (dir, git, artefact, canary): pass.

## T16: provider-hostname check

### What landed

- **`PROVIDER_HOSTS`** and **`PROVIDER_HOSTS_ALLOWED_IN`** in `tooling/eslint-config/boundaries.js`, plus `providerHostSource()`. That helper matches a whole hostname, case-insensitively. It allows a listed host under a subdomain (`eu.<host>`), and doesn't match a longer label (`myapi.…`) or a longer TLD (`….company`).
- **`check-provider-hosts`**:
  - **Source mode** runs in `repo-check`. It covers every tracked (and untracked-not-ignored) file outside `services/model-gateway/**`, `docs/**`, `requirements/**`, `*.md`/`**/*.md` and `boundaries.js`.
  - **`--artefacts`** runs as a new `quality` step after the artefact secret scan, outside Turbo. It covers every file of every `shipped: true` artefact path, and a missing path fails.
- **0 findings on `main`.** The one hit when the check first ran was the T05 rule fixture's Azure endpoint URL, which is now split with `frag()`. The check fires on its own test file too, which is why every positive hostname there is derived from `PROVIDER_HOSTS` at runtime.

### List confirmation (design §6.1: "Confirm the list in T16")

The design's 16 entries are kept unchanged. Checked 2026-09-25:
- Microsoft Learn (Foundry "Azure OpenAI v1 API" and "switching endpoints"): inference base URLs are `https://<resource>.openai.azure.com/openai/v1/` and `https://<resource>.services.ai.azure.com/openai/v1/`. Both are covered by the two `*.` entries.
- `cognitiveservices.azure.com` appears in those pages only as the Entra token scope (`https://cognitiveservices.azure.com/.default`), not as an inference host, so it was **not** added.
- The Vertex (`<region>-aiplatform.googleapis.com`) and Bedrock (`bedrock-runtime.<region>.amazonaws.com`) wildcards match the regional hosts. The other entries are the providers' documented API hosts.
- Providers outside the SR-03 SDK list (for example xAI or DeepSeek) are not added. Adding one is a reviewed change to `boundaries.js`.

### Recorded decisions and deviations

| # | Type | What | Why |
|---|---|---|---|
| T16-1 | Implementation choice | Files are read as latin1 (byte-preserving), only the first 32 MiB of each. There is no binary-file skip. | ASCII hostnames are found in any encoding of a bundle, source map or `.wasm` string table. Our bundles are far below 32 MiB. |
| T16-2 | Scope note | Source mode also covers `packs/**`, tests, scripts and configs (they're all tracked and outside the allowed paths). The `.claude/**` agent files are Markdown, so they're excluded like other docs. | This keeps the check the same shape as the RC-3 boundary rules. |

### Tests added (T16)

- `test/check-provider-hosts.test.ts` (33), **TC-F-001-42, hostname part:**
  - Each of the 16 patterns matches its sample host, in lower and upper case. A subdomain matches and the line is reported.
  - 11 look-alikes don't match: `myapi.…`, `.company`, `-proxy`, the provider marketing and docs hosts, the `@aws-sdk/client-bedrock-runtime` import, the Bedrock control plane, `huggingface.co`, a suffixed Azure host, and blob storage.
  - Source mode: the real repo has 0 findings. It fails in `apps/web` source and config, `packages/sdk` tests, `services/control-plane`, a look-alike `services/model-gateway-v2` and `packs/**`. It passes in the gateway, docs, Markdown, `requirements/` and `boundaries.js`.
  - Artefact mode: a host inside `dist/assets/index-abc123.js` fails; a clean bundle and an unshipped ui-lab pass; a missing `dist` fails.

## Code review of T04/T05/T16 ("Request changes", 2026-09-25)

| Finding | Fix | Tests |
|---|---|---|
| **1 (Major)** `check-gitleaks-config` looked keys up case-sensitively, but gitleaks (viper) matches them case-insensitively. So `[Allowlist]`, `[[AllowLists]]`, `[Extend]` and `UseDefault` took effect in gitleaks while the check saw nothing. | Both configs are validated against a **strict, exact-case key schema** (`CONFIG_KEYS`). Top level: `title`, `description`, `rules`, plus `extend`/`allowlists` in the repo config only. Rules: `id`, `description`, `regex`, `secretGroup`, `entropy`, `keywords`, `path`, `tags`. `[extend]`: `useDefault` only. `[[allowlists]]`: `description`, `paths` only. Any other key, including another capitalisation of an allowed one, is a finding that names the exact spelling. | `check-gitleaks-config.test.ts`: artefact `[Extend] UseDefault`, `[EXTEND]`, `[Allowlist]`, `[[AllowLists]]`, `[ALLOWLIST]`, rule-level `[[rules.Allowlists]]`/`AllowList`, `[[Rules]]`, a rule `Regex` and an unknown top-level key; repo `[Allowlist]`, `[[AllowLists]]`, `[Extend]` and `UseDefault`. |
| **2 (Major)** `extend.disabledRules` wasn't rejected in `.gitleaks.toml`, so it could switch default rules off in the PR, tree and history scans. | The `[extend]` schema allows `useDefault` only. `disabledRules` (any spelling), `path` and `url` are rejected, each with its reason. | `disabledRules = ["github-pat"]`, `DisabledRules`, `path`, `url`. |
| **3 (Minor)** Any entry starting with `^` counted as "anchored", so `^.*` and `^.*\.env$` passed. | A path entry must be **one exact file**: `ANCHORED_LITERAL_PATH` = `^` + a literal repo path (letters, digits, `_ @ / -`, escaped dots) + `$`. No wildcards, classes, groups, directory prefixes, leading `/` or unescaped dots. | Fails: `dist/`, `^.*`, `^.*\.env$`, `^.+/secrets\.txt$`, `^apps/`, `^apps/web/fixtures/`, `^[a-z]+/x\.txt$`, `^apps/web/(a\|b)\.txt$`, `^/etc/passwd$`, `^apps/web/x.txt$`. Passes: `^apps/web/fixtures/sample-1\.txt$`. |
| **4 (Minor)** `check-provider-hosts --artefacts` used the repo walker, which skips `node_modules`. | New `artefactFiles()` walker that skips only `.git`. The secret-scan side has no such filter: `scanArtefacts` hands each artefact folder straight to gitleaks, and with no `[extend]` gitleaks scans `node_modules` (confirmed by the attack re-run 4b and the artefact self-test shape). | `dist/node_modules/vendored-lib/index.js` and a dot-folder both fail. |
| **5 (Minor)** The `require` ban needed a bare `require` callee, so `module.require('op'+'enai')` and `process.mainModule.require` got through. | New selectors: a member call to `require` (named or computed) with a non-literal argument, and any `mainModule` member access, named or computed, which also covers aliases (`const m = process.mainModule`). | `boundaries.test.ts`: `module.require` with a concatenation or a variable, `module['require'](n)`, `process.mainModule.require(...)`, an alias of `mainModule` and `process['mainModule']` are errors. `module.require('./local.cjs')` passes. |
| **6 (Nit)** The exit-1-with-empty-report branch in `secret-scan.ts` was untested. | Test with a fake binary that writes `[]` to `--report-path` and exits 1. | **Mutation check:** with the branch disabled (`if (false && …)`), the test fails ("1 failed"); restored, it passes. |

**Attack re-run.** The reviewer's harnesses (`mut.mjs`, `plant2.mjs`) were read in full, then driven with payloads for findings 1 to 5. All 13 attacks now fail the gate with rc=1:
- Finding 1:
  - 1a `[Allowlist]` paths, artefact config
  - 1b `[[AllowLists]]`, artefact config
  - 1c `[Extend] UseDefault`, artefact config
  - 1d `[Allowlist] .*`, repo config
  - 1e `UseDefault`, repo config
- Finding 2: `disabledRules = ["github-pat"]`, repo config.
- Finding 3: 3a `^.*` and 3b `^.*\.env$`, repo config.
- Finding 4:
  - 4a `plant2.mjs nmhost`, a provider host under `dist/node_modules`, blocked by `check-provider-hosts --artefacts`
  - 4b a synthetic GitHub PAT under `dist/node_modules`, found by `secret-scan artefacts`
- Finding 5, each an `eslint` error from `no-restricted-syntax`:
  - 5a `module.require('op'+'enai')`
  - 5b `process.mainModule.require(...)`
  - 5c an alias of `process.mainModule`

`design.md` §6.2.2 is updated to match the T05-1 decision and this schema (recorded in its revision log).

### Round-2 nits (branch `fix/F-001-boundary-nits`, after PR #13)

| Item | Fix | Tests |
|---|---|---|
| The `require` ban only caught direct calls, so the handle could escape: `module.require.bind(module)`, `Reflect.apply(module.require, …)`, `const { require: rq } = module`. | Any `require` member access (named or computed) is banned **unless** it is the callee of a call whose first argument is a literal: `MemberExpression[property.name='require']:not(CallExpression[arguments.0.type='Literal'] > MemberExpression.callee)`. Destructuring `require` out of an object (`ObjectPattern > Property[key.name/value='require']`) is banned too. These replace the two call-only selectors. | `boundaries.test.ts` fails on `.bind`, `{ require: rq }`, `{ 'require': rq }`, `Reflect.apply(module.require, …)`, a stored `module.require`, and `module.require()` with no argument. `module.require('./local.cjs')` still passes, which exercises the `:not(...)` side. |
| An exact-file allow-list entry couldn't start with an escaped dot (a dot-folder). | `ANCHORED_LITERAL_PATH` = `/^\^(?:[A-Za-z0-9_@-]\|\\\.)(?:[A-Za-z0-9_@/-]\|\\\.)*\$$/`. | Passes `^\.github/fixtures/sample\.txt$`. Fails `^\.github/.*$`, `^.github/fixtures/sample\.txt$` (unescaped dot) and `^/x\.txt$`. |

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
