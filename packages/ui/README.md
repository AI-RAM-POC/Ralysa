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
| `src/styles/tailwind.css` (`@ralysa/ui/tailwind.css`) | The Tailwind entry point: `tailwindcss` plus the theme. UI workspaces pass it to `reactUi({ workspaceDir, tailwindEntryPoint })`. |
| `src/tokens/generated.ts` | Typed token names (`TokenName`, `TOKEN_CSS_VARS`). Committed; `check:generated` regenerates it and CI fails on drift. |

Components use **semantic** tokens only. Palette values are never emitted as CSS variables.

`ThemeProvider` writes `data-theme` on `<html>` (`light`, `dark`, or nothing for `system`); `resolveInitialTheme()` reads `?theme=` and then `localStorage` (`ralysa.theme`, a development convenience).

## i18n (F-001-T08)

| Path | What |
|---|---|
| `src/contracts/i18n.ts` | `LOCALES` (`en`, `ar`; `en` is the source), `NAMESPACES` (`ui`, `web`, `lab`), `KEY_RE` (2–5 lowerCamel segments), `PLURAL_CATEGORIES`. |
| `src/i18n/createI18n.ts` | `createI18n({ catalogs, locale, defaultNS, mode })`: one i18next instance per app. `en` is bundled; other locales are loaded by dynamic import on first use (no HTTP backend, no cloud). `mode: 'test'` throws `MissingKeyError` on a missing key and turns off the `en` fallback. |
| `src/i18n/LocaleProvider.tsx` | Sets `lang` and `dir` on `<html>` whenever the language changes, feeds Radix `DirectionProvider`, and exposes `useLocale()` → `{ locale, dir, options, setLocale }`. Switching is a re-render, not a reload. |
| `src/i18n/locale.ts` | `resolveInitialLocale({ search, storage, languages })`: `?lang=`, then `localStorage` `ralysa.locale`, then `navigator.languages` by primary subtag, then `en`. `browserStorage()` returns `null` where storage throws. |
| `src/locales/{en,ar}/ui.json`, `uiCatalog` | The `ui` namespace. Kept under `src/` so the library build emits them next to the code. |
| `src/locales/review.json` | Native-review status of every `ar` string. Placeholder Arabic is `"needs-native-review"` until a native speaker approves it (OQ-D8); `check-i18n` fails on a missing entry. |
| `i18next.config.ts` | i18next-cli, offline only: `lint` runs `extract --ci --dry-run` (a key used in code but missing from a catalog fails), `check:generated` runs `types`. |
| `src/i18n/generated/` | Typed keys (`resources.d.ts`, `i18next.d.ts`): `t('ui:nonexistent.key')` is a type error. Not formatted by Prettier (it's regenerated). |

Components call `useTranslation('ui')` explicitly; an app's own namespace is its `defaultNS`.

## Fonts, icons and text (F-001-T09)

| Path | What |
|---|---|
| `src/styles/fonts.css` (`@ralysa/ui/fonts.css`) | Noto Sans, Noto Sans Arabic and Noto Sans Mono (variable weight), self-hosted from the `@fontsource-variable/*` packages: the app's build bundles the woff2 files, with **no font CDN** and no network fetch (residency, air-gapped installs). Also the base typography: the `font.family.sans` stack, body line height and letter spacing from tokens, re-applied under `:lang(ar)` (line height 1.7, letter spacing 0), mono for `code`/`pre`. Import it once in an app after `tokens.css`. |
| `scripts/font-licenses.ts` (`@ralysa/ui/font-licenses`) | The reviewed font packages (`FONT_PACKAGES`) and their licence check: `package.json` must say `OFL-1.1` and the licence's copyright notice must declare no Reserved Font Name. `build` writes `dist/licenses/fonts/<font>/OFL.txt` and `dist/THIRD_PARTY_NOTICES`. **`fontLicenses()`** is the Vite plugin every app that imports `fonts.css` adds: it emits the same files next to the bundle, never inlines a font as a data URI, and fails the build for a font file from any other package. |
| `scripts/font-coverage.ts` (`@ralysa/ui/font-coverage`) | Reads the real woff2 cmaps (Brotli via `node:zlib`, cmap formats 4 and 12) and the `@font-face` `unicode-range`s, and reports the code points a font stack can't draw. Used by the coverage tests here and in `apps/ui-lab`. |
| `src/icons/registry.ts`, `<Icon name>` | The icon registry: the **only** module that imports `lucide-react` (the `icon-set` group in `tooling/eslint-config/boundaries.js` bans it everywhere else, for ESLint, dependency-cruiser and `check-banned-deps`). Each icon is `directional` (mirrored in RTL with `rtl:-scale-x-100`: back, forward, chevrons, send, undo, redo) or not (never mirrored). `<Icon>` is decorative (`aria-hidden`) unless given a translated `label`, and renders `data-icon` and `data-icon-directional`. Unused icons are tree-shaken. |
| `src/components/text/` | `Text`, `Heading`, and the LTR islands `Code` (`<code dir="ltr">`), `CodeBlock` (`<pre dir="ltr">`, wraps rather than scrolls) and `Ltr` (`<bdi dir="ltr" data-ltr>`), all `translate="no"`. `<T i18nKey values>` renders a translation with each interpolated value in `<bdi>`; `isolate()` / `isolateValues()` wrap values in FSI…PDI for attribute text (`aria-label`, `title`). |
| `src/examples/` (`@ralysa/ui/examples`) | Every component's `*.examples.tsx`, collected in `ALL_EXAMPLES` for the `apps/ui-lab` gallery. A separate entry point, so apps never bundle them. Examples hold no text: the gallery passes `labels` (`EXAMPLE_LABELS`) from its own `lab` catalog, so example copy stays out of the shipped `ui` catalog. |

## Components (F-001-T10, T11)

Every component takes translated text (or an i18n key), uses semantic token classes only, logical layout only, and shows the shared focus ring (`focus-visible:focus-ring`, defined in `src/styles/tailwind.css`). Each has a `*.examples.tsx` registered in `ALL_EXAMPLES`.

| Group | Components | Notes |
|---|---|---|
| Layout | `AppShell`, `SkipLink`, `VisuallyHidden` | `AppShell` renders `header`, a named `nav` (inline-start), `main` (`id="main"`, `tabIndex=-1`) and a named `aside` (inline-end) with flex in reading order, so RTL mirrors them with no extra rule; each region has `data-region`. The skip link is its first focusable element. |
| Actions | `Button` (`primary`, `secondary`, `ghost`, `danger`; `sm`, `md`, `lg`; optional decorative `icon`), `IconButton` (required typed `labelKey`), `Link` | Native `<button>`/`<a>`. `Button` defaults to `type="button"`. |
| States | `EmptyState`, `LoadingState`, `ErrorState`, `PermissionDenied` | Default copy from the `ui` catalog. `LoadingState`: `role="status"`, `aria-busy`, spinner only under `motion-safe`. `ErrorState`: `role="alert"`, no error-object prop (raw error text never renders), optional retry and bidi-isolated reference id. `PermissionDenied`: bidi-isolated resource name and an optional "Request access" link (spec §6.1.3). |

## Scripts

| Script | Does |
|---|---|
| `build` | `build-tokens.ts`, `font-licenses.ts` (licence check and copies), then `tsc -p tsconfig.build.json` (browser library emit: no Node types in `src/`) |
| `check:generated` | Regenerates the token outputs and the i18n key types (CI then runs `git status --porcelain`) |
| `lint` | ESLint (`base`, `react-ui` against `src/styles/tailwind.css`, `tests`), Stylelint (`@ralysa/stylelint-config`) and `i18next-cli extract --ci --dry-run`: raw colours, logical layout, token-backed classes, no hard-coded strings, no missing keys (AC-3 to AC-6) |
| `test` | Vitest: token schema and generator (TC-F-001-06), contrast gate on the real pairs (TC-F-001-23), theme plumbing, i18n runtime and locale switch (AC-6), extract `--ci` behaviour (TC-F-001-12), contract parity with `check-i18n` and typed keys |
| `typecheck` | `tsc -p tsconfig.json` (src, tests and scripts). Emits declarations only, into the ignored `.tsc/`, because apps reference this project and TypeScript rejects a reference to a no-emit project (TS6310). See "Referenceable libraries" in `docs/engineering/repo-conventions.md`. |

After changing a token, run `pnpm --filter @ralysa/ui build` and commit `src/tokens/generated.ts` and `src/styles/theme.css`. If you add a colour token, add its pairs to `contrast-pairs.json` or list it as exempt with a reason; the test fails otherwise.

There are no environment variables or runtime configuration.
