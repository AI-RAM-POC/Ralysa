# @ralysa/stylelint-config

Stylelint 17 config for the UI workspaces (`ralysa.ui: true`; F-001 design §7.3).

```js
// stylelint.config.js in a UI workspace
import config from '@ralysa/stylelint-config';
export default config;
```

```sh
stylelint "**/*.css" --allow-empty-input   # the workspace's lint script runs this after eslint
```

| Group | Rules | Why |
|---|---|---|
| Raw colours (AC-3, §7.3.4) | `color-no-hex`, `color-named: never`, `function-disallowed-list` for `rgb`, `rgba`, `hsl`, `hsla`, `hwb`, `lab`, `lch`, `oklab`, `oklch`, `color` | Colours come from design tokens: `var(--ralysa-…)` or a token-backed Tailwind class. `color-mix()` over `var()` operands, `currentcolor`, `transparent` and the CSS-wide keywords are allowed. |
| Disables | `reportDescriptionlessDisables`, `reportNeedlessDisables`, `reportInvalidScopeDisables` | Every exception is visible in review: `/* stylelint-disable-next-line <rule> -- <reason> */`. |

Token definition files are exempt: `packages/ui/tokens/**` is JSON, and `**/tokens/**` and `**/dist/**` (the generated `tokens.css` and `theme.css`) are in `ignoreFiles`.

`test/` lints fixtures through the real config (TC-F-001-07). There are no environment variables.
