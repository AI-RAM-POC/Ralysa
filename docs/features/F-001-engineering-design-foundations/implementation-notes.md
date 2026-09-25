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
- Root scripts `repo:check` and `scaffold` arrive with T02 and T03. `e2e`, `tools:install` and `hooks:install` arrive with T13, T05 and T17, the tasks that create what they run.
