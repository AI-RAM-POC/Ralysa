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
| Logical properties (AC-4, §7.3.2) | `logical-css/require-logical-properties` (stylelint-plugin-logical-css) with the block-axis and sizing properties in `ignore` (`BLOCK_AXIS_PROPERTIES`) | `margin-left` → `margin-inline-start`, `left` → `inset-inline-start`, `border-right*` → `border-inline-end*`, `border-top-left-radius` → `border-start-start-radius`, `scroll-padding-right` → `scroll-padding-inline-end`. `top`, `width`, `margin-top` and so on stay allowed: they don't depend on text direction. |
| Logical keywords (AC-4) | `logical-css/require-logical-keywords` | `text-align`, `text-align-last`, `float` and `clear` with `left`/`right` → `start`/`end`, `inline-start`/`inline-end`. |
| Shorthands and values (AC-4) | `declaration-property-value-disallowed-list` | 4-value `margin`, `padding`, `inset`, `scroll-margin`, `scroll-padding` and `border-{width,style,color}` whose right and left values differ; `border-radius` whose left and right corners differ (one value, all equal, or `a a b b` pass); `background`, `background-position(-x)` and `transform-origin` with a `left`/`right` keyword (not inside a path such as `url(img/left.png)`); a horizontal `translate`/`translateX`/`translate3d` unless the offset uses `var(--ralysa-dir-sign)` (1 in LTR, -1 in RTL; defined in `@ralysa/ui/tokens.css`). |
| Focus (§7.7) | `declaration-property-value-disallowed-list` | `outline: none\|0`, `outline-style: none` and `outline-width: 0` are errors. Where a replacement ring is drawn another way, disable the line with a description. |
| Disables | `reportDescriptionlessDisables`, `reportNeedlessDisables`, `reportInvalidScopeDisables` | Every exception is visible in review: `/* stylelint-disable-next-line <rule> -- <reason> */`. |

Token definition files are exempt: `ignoreFiles` is anchored to the config base (the UI workspace that runs Stylelint): `tokens/**` (the workspace-root token source, `packages/ui/tokens/`, JSON today), `dist/**` (the generated `dist/css/tokens.css`), `coverage/**` and `**/node_modules/**`. A `tokens/` folder anywhere else, such as `src/components/tokens/`, is linted. The 4-value regex comes from `@ralysa/eslint-config/css-values`, shared with the inline-style ESLint rule.

The logical-css plugin is passed to Stylelint as an imported object, so consuming workspaces don't need it as a dependency.

`test/` lints fixtures through the real config: raw colours (TC-F-001-07), and a physical and a logical fixture for every AC-4 form (TC-F-001-08). There are no environment variables.
