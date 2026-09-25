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
