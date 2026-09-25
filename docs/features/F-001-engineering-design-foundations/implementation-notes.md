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
| T03-4 | Implementation choice | TC-F-001-46 (`tooling/repo-scripts/test/scaffold.test.ts`) scaffolds the five kinds into a temp copy of the working tree and **does not run `pnpm install`**. Each new package's `node_modules` is a symlink to a real workspace with the same dependency set (`apps/web` for `library`/`app`, `tooling/repo-scripts` for the Node kinds), and the package's own `lint`/`typecheck`/`test`/`build` scripts run with that `.bin` on `PATH`. | An offline install in the copy fails: pnpm 11's supply-chain verification (`minimumReleaseAge`, `trustPolicy`) and `catalog:` resolution need registry metadata that isn't cached (`ERR_PNPM_NO_OFFLINE_META`). Going online would make `test` non-hermetic (§2.1), and switching the policies off in the copy would defeat them. The templates use no dependency outside those two sets. `pnpm scaffold apps/web --kind app` in the real repo, followed by a real `pnpm install`, covers the install path once. |
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
