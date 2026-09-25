# @ralysa/tsconfig

Shared TypeScript 6.0 base configs (F-001 design §2, §2.1). Every workspace's `tsconfig.json` extends one of them.

| Base | For |
|---|---|
| `base.json` | Strict ESM defaults: `verbatimModuleSyntax`, `noUncheckedIndexedAccess`, `composite`. It is **no-emit**, so a workspace's `tsconfig.json` type-checks `src/`, `test/` and config files together. |
| `build.json` | Emit overlay. A workspace's `tsconfig.build.json` extends `["./tsconfig.json", "@ralysa/tsconfig/build.json"]` to compile `src/` into `dist/`. |
| `lib-isomorphic.json` | Libraries that load in browsers and Node (`packages/protocol`, `auth`, `sdk`). No DOM lib and no Node types. |
| `lib-node.json` | Node libraries and tooling (`types: ["node"]`). |
| `lib-dom.json`, `react-lib.json` | Browser libraries bundled by Vite (`moduleResolution: Bundler`); `react-lib` adds `jsx: react-jsx`. |
| `vite-app.json` | Vite + React apps. Vite emits the bundle; tsc only type-checks. |
| `node-service.json` | Node services (ES2024). |
| `node-cli.json` | Node CLIs (ES2024, `jsx: react-jsx` for Ink). |

Notes:
- TypeScript 6 defaults `types` to `[]`, so each base names its ambient types explicitly.
- No base uses an option that TypeScript 6.0 deprecates (AR-4 c). `@ralysa/repo-scripts` `test/tsconfig-bases.test.ts` compiles a fixture against each base to prove it.
- Paths use `${configDir}`, so `rootDir`, `outDir` and the build-info file resolve against the extending workspace.

There are no environment variables.
