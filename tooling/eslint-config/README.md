# @ralysa/eslint-config

Flat-config presets for ESLint 10 (F-001 design §2, §6.1, §7.8).

```js
// eslint.config.js in a workspace
import { base, reactUi, tests } from '@ralysa/eslint-config';

/** @type {import('eslint').Linter.Config[]} */
const config = [...base({ tsconfigRootDir: import.meta.dirname }), ...reactUi(), ...tests()];
export default config;
```

| Preset | Applies to | Contents |
|---|---|---|
| `base` | every JS/TS file: source, tests, scripts, `*.config.*` | `@eslint/js` recommended; typescript-eslint `strict-type-checked` (type info through `projectService`, switched off for plain JS files); the **boundary rules** (`no-restricted-imports`, `no-restricted-syntax`) fed from `boundaries.js`; eslint-comments rules: no bare `eslint-disable`, no inline rule config, `eslint-disable-next-line` only and always with a `-- reason`, and never for a boundary rule (RC-3, SEC-F001-09 f) |
| `isomorphic` | `library-isomorphic` workspaces | Adds the Node built-in module ban to the boundary rules |
| `reactUi` | UI workspaces (`ralysa.ui: true`) | `@eslint-react` recommended-type-checked, `react-hooks` recommended, `jsx-a11y` strict through `@eslint/compat`. The logical-layout, raw-colour and i18n rules join in T06 to T08. |
| `tests` | `*.test.*`, `test/**`, `e2e/**` | Relaxes a few type-strictness rules. It never touches the boundary or lint-comment rules; `test/presets.test.ts` checks this. |

`boundaries.js` is the single source for the boundary lists that ESLint, dependency-cruiser (`.dependency-cruiser.cjs`) and the repo checks (`check-banned-deps`, `check-imports`, `check-workspaces`) share (design §6.1):

- `BANNED_PACKAGE_GROUPS`: the Agent SDK, its `@anthropic-ai/sdk` peer, model-provider SDKs and in-process inference runtimes (SR-03), and vendor APM/analytics SDKs (ADR-0024). Each group names the files that may import it (`importAllowedIn`, repo-relative globs) and the dependency paths that may reach it (`graphAllowedThrough`). A package belongs to the first group that matches it.
- `RESTRICTED_SYNTAX`: the non-literal loading ban (`import(x)`, `require(x)`, `createRequire`, `process.getBuiltinModule`, `eval`, `Function`); `LOADING_EXCEPTIONS` holds reviewed per-path exceptions and starts empty.
- `PROVIDER_HOSTS` and `PROVIDER_HOSTS_ALLOWED_IN`: the model-provider API hostnames that `check-provider-hosts` bans outside the gateway (SEC-F001-09 d).
- `WORKSPACE_DEPENDENCY_RULES`, `SPECIFIER_ALLOWLIST`, and the matching helpers.

`base()` derives the workspace from `tsconfigRootDir` (its path under the folder holding `pnpm-workspace.yaml`) and adds a config block only for the allowed paths inside that workspace, so `services/agent-host` gets `src/engine/claude/**` and `services/model-gateway` gets every file. Nothing else relaxes the rules, and `tests` never touches them.

jsx-a11y 6.10.2 declares a peer range of ESLint ≤ 9. It is wrapped with `fixupPluginRules`, and `test/presets.test.ts` asserts that its rules still fire under ESLint 10. The T02 spike result is in `docs/features/F-001-engineering-design-foundations/implementation-notes.md`.

`pnpm build` emits `.d.ts` files into `dist/` so consumers type-check against declarations, not the JS source. There are no environment variables.
