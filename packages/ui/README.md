# ui

Design system: tokens, components, themes, RTL (F-001 design §7).

## Design tokens (F-001-T06)

| Path | What |
|---|---|
| `tokens/core.tokens.json` | Primitives (`palette.*`) and the theme-independent tokens: typography, spacing, sizing, radius, z-index layers, motion. DTCG Format 2025.10. |
| `tokens/semantic.{light,dark}.tokens.json` | Semantic colours and shadows, as aliases into the palette. Both files must have the same keys. |
| `tokens/contrast-pairs.json` | Every foreground/background pair used for text or UI boundaries, checked in both themes (AC-11), plus the exempt tokens with their reason. |
| `scripts/build-tokens.ts` | Validates the source against `src/contracts/tokens.ts` and emits the three outputs below. |
| `dist/css/tokens.css` (`@ralysa/ui/tokens.css`) | `--ralysa-*` custom properties: light on `:root`, dark on `[data-theme='dark']` and under `prefers-color-scheme` when no theme is set, `:lang(ar)` overrides, 0 ms durations under `prefers-reduced-motion`. Also `--ralysa-dir-sign` (1 in LTR, -1 in RTL), for direction-aware horizontal offsets. |
| `src/styles/theme.css` (`@ralysa/ui/theme.css`) | Tailwind v4 `@theme inline`. The default namespaces are reset, so `bg-red-500` and friends don't exist; the token-backed names are `bg-canvas`, `bg-surface`, `bg-subtle`, `text-fg`, `text-fg-muted`, `bg-accent`, `border-border-control`, `ring-focus-ring`, `p-4`, `h-control-md`, `rounded-md`, `shadow-md` and so on. Generated and committed (drift-checked) so the lint can load it before a build. |
| `src/styles/tailwind.css` (`@ralysa/ui/tailwind.css`) | The Tailwind entry point: `tailwindcss` plus the theme. UI workspaces pass it to `reactUi({ tailwindEntryPoint })`. |
| `src/tokens/generated.ts` | Typed token names (`TokenName`, `TOKEN_CSS_VARS`). Committed; `check:generated` regenerates it and CI fails on drift. |

Components use **semantic** tokens only. Palette values are never emitted as CSS variables.

`ThemeProvider` writes `data-theme` on `<html>` (`light`, `dark`, or nothing for `system`); `resolveInitialTheme()` reads `?theme=` and then `localStorage` (`ralysa.theme`, a development convenience).

## Scripts

| Script | Does |
|---|---|
| `build` | `build-tokens.ts`, then `tsc -p tsconfig.build.json` (browser library emit: no Node types in `src/`) |
| `check:generated` | Regenerates the token outputs (CI then runs `git status --porcelain`) |
| `lint` | ESLint (`base`, `react-ui` against `src/styles/tailwind.css`, `tests`) and Stylelint (`@ralysa/stylelint-config`): raw colours, logical layout and token-backed classes only (AC-3, AC-4) |
| `test` | Vitest: token schema and generator (TC-F-001-06), contrast gate on the real pairs (TC-F-001-23), theme plumbing |
| `typecheck` | `tsc -p tsconfig.json` (src, tests and scripts) |

After changing a token, run `pnpm --filter @ralysa/ui build` and commit `src/tokens/generated.ts` and `src/styles/theme.css`. If you add a colour token, add its pairs to `contrast-pairs.json` or list it as exempt with a reason; the test fails otherwise.

There are no environment variables or runtime configuration.
