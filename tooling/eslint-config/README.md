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

`boundaries.js` is the single source for the boundary lists that ESLint, dependency-cruiser and the repo checks share. T02 created the slots, and T04 and T16 fill them.

jsx-a11y 6.10.2 declares a peer range of ESLint ≤ 9. It is wrapped with `fixupPluginRules`, and `test/presets.test.ts` asserts that its rules still fire under ESLint 10. The T02 spike result is in `docs/features/F-001-engineering-design-foundations/implementation-notes.md`.

`pnpm build` emits `.d.ts` files into `dist/` so consumers type-check against declarations, not the JS source. There are no environment variables.
