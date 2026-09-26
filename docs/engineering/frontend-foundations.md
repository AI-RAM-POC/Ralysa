# Frontend foundations

How to build UI in Ralysa: design tokens, RTL-safe layout, i18n keys, icons, dependencies, and the visual and shaping snapshots. It describes what `packages/ui`, `apps/ui-lab` and the lint tooling do today (F-001, design §7). The package READMEs have the file-by-file detail:

- [`packages/ui/README.md`](../../packages/ui/README.md): tokens, i18n runtime, fonts, icons, components
- [`apps/ui-lab/README.md`](../../apps/ui-lab/README.md): the demo app and the E2E harness
- [`tooling/eslint-config/README.md`](../../tooling/eslint-config/README.md) and [`tooling/stylelint-config/README.md`](../../tooling/stylelint-config/README.md): the lint rules
- [`tooling/repo-scripts/README.md`](../../tooling/repo-scripts/README.md): `check-i18n`, `check-contrast`, `check-no-demo`, `check-banned-deps`

**Scope.** The rules apply to every UI workspace, meaning any workspace with `"ralysa": { "ui": true }` in its `package.json` (today `packages/ui`, `apps/web` and `apps/ui-lab`; later `apps/desktop`, `packages/workbench` and `packages/views`). `check-ui-lint` fails a UI workspace whose `lint` script doesn't run ESLint with `reactUi()` and Stylelint with `@ralysa/stylelint-config`. Every rule is an error; there is no warning phase.

## Quick checklist

- Colours, spacing, sizes, radii, shadows and motion come from **tokens**: a token-backed Tailwind class (`bg-surface`, `p-4`, `rounded-md`) or `var(--ralysa-*)`. Never a hex value, `rgb()` or a named colour.
- Layout is **logical**: `ms-*`/`me-*`, `ps-*`/`pe-*`, `inset-s-*`, `text-start`, `border-s`, `rounded-s-*`. Never `ml-*`, `left-*`, `text-left` or `margin-left`.
- Every user-visible string is an **i18n key** in `en` and `ar`, with an entry in `review.json`. No text in JSX or in `aria-label`, `title`, `alt`, `placeholder` or `label`.
- Icons go through `<Icon name>`, never `lucide-react` directly.
- File paths, identifiers, URLs, commands and version strings go in `<Code>`, `<CodeBlock>` or `<Ltr>`. Interpolated values go through `<T>` or `isolate()`.
- A visual change updates the baselines with `pnpm --filter @ralysa/ui-lab e2e:update`, and the reviewer approves the image diff.
- A new dependency follows [Dependencies](#dependencies) below.

## Design tokens

**Source** (`packages/ui/tokens/`, DTCG Format 2025.10):

| File | Holds |
|---|---|
| `core.tokens.json` | Primitives (`palette.*`: gray, blue, red, green, amber, shadow) and the theme-independent tokens: `font` (family, size, weight, lineHeight, letterSpacing), `space`, `size` (control, icon, container, focusRing), `radius`, `elevation.layer` (z-index) and `motion` (duration, easing) |
| `semantic.light.tokens.json`, `semantic.dark.tokens.json` | Semantic colours and shadows as aliases into the palette. Both themes must have the same keys. |
| `contrast-pairs.json` | Every foreground/background pair used for text or a UI boundary, with its kind (`text`, `largeText`, `nonText`, `focus`), plus the exempt tokens and why |

The semantic colours are `color.bg.{canvas,surface,surfaceRaised,subtle}`, `color.fg.{default,muted,onAccent,disabled}`, `color.accent.{default,hover}`, `color.border.{decor,control}`, `color.focus.ring`, `color.link` and `color.status.{danger,success,warning}`. The values are neutral placeholders. Brand values will replace them through the token files only (design §7.1.3), and the contrast gate reruns when they do.

**Generator.** `packages/ui/scripts/build-tokens.ts` (in-house, run by the package's `build` and `check:generated`) validates the source against `src/contracts/tokens.ts` and writes:

- `dist/css/tokens.css` (`@ralysa/ui/tokens.css`): `--ralysa-*` custom properties. Light values go on `:root` and `[data-theme='light']`, dark values on `[data-theme='dark']` and, when no theme is set, under `prefers-color-scheme: dark`. It also holds the `:lang(ar)` overrides (body line height 1.7, letter spacing 0), sets every duration to `0ms` under `prefers-reduced-motion: reduce`, and defines `--ralysa-dir-sign` (1 in LTR, -1 in RTL).
- `src/styles/theme.css` (`@ralysa/ui/theme.css`): the Tailwind v4 `@theme inline` block. It resets Tailwind's default namespaces, so `bg-red-500`, `p-7` and the like **don't exist**, and maps token-backed names to the variables: `bg-canvas`, `bg-surface`, `bg-surface-raised`, `bg-subtle`, `text-fg`, `text-fg-muted`, `bg-accent`, `border-border-control`, `ring-focus-ring`, `p-4`, `h-control-md`, `size-icon-md`, `rounded-md`, `shadow-md`, `ease-standard` and so on.
- `src/tokens/generated.ts`: typed token names (`TokenName`, `TOKEN_CSS_VARS`).

`theme.css` and `generated.ts` are committed. CI's `check:generated` step regenerates them and fails on any drift.

**Using tokens:**

- Components use **semantic** tokens only. Palette values are never emitted as CSS variables, so a component can't reach them.
- The shared focus ring is the `focus-ring` utility in `src/styles/tailwind.css`: write `focus-visible:focus-ring`. It is a 2 px outline in `color.focus.ring` with a 2 px offset, from the `size.focusRing` tokens.
- An app imports `@ralysa/ui/tokens.css` and then `@ralysa/ui/fonts.css` once in its entry point (see `apps/web/src/main.tsx`). An app that uses Tailwind classes imports `@ralysa/ui/tailwind.css` in its own CSS entry and adds `@source` for `packages/ui/src` (see `apps/ui-lab/src/styles.css`).
- `ThemeProvider` writes `data-theme` on `<html>` (`light`, `dark`, or nothing for `system`). `resolveInitialTheme()` reads `?theme=` and then `localStorage` `ralysa.theme`, which is a development convenience.

**Changing a token.** Edit the JSON, run `pnpm --filter @ralysa/ui build`, and commit `src/tokens/generated.ts` and `src/styles/theme.css` with it. A new colour token needs its pairs in `contrast-pairs.json`, or an entry in the exempt list with a reason; the test fails otherwise.

**Contrast gate (AC-11).** `packages/ui`'s `test` runs `check-contrast` (from `@ralysa/repo-scripts/check-contrast`) on every pair in both themes. The minimums are text 4.5, large text 3, non-text 3 and focus 3. The gate also fails on a translucent colour, an unresolved token, or an exempt token used in a pair. Axe's `color-contrast` rule on the rendered ui-lab pages is the backstop for combinations that `contrast-pairs.json` doesn't declare. `/?view=tokens` in ui-lab shows every semantic colour with its live contrast against the canvas.

**What the lint rejects (AC-3).**

- Stylelint: hex colours, named colours, and the colour functions `rgb`, `rgba`, `hsl`, `hsla`, `hwb`, `lab`, `lch`, `oklab`, `oklch` and `color`. `color-mix()` over `var()` operands is allowed.
- ESLint `ralysa/no-raw-color`: colour literals in `.ts`/`.tsx`, including arbitrary classes such as `bg-[#fff]`, and named colours in colour-typed style keys.
- `better-tailwindcss/no-unknown-classes`: any class the token theme doesn't define.

The token source files (`packages/ui/tokens/**`) and the generated `dist/css/tokens.css` are exempt.

## RTL and logical CSS

Arabic is a first-class locale, so every screen must work in both directions from the start. Direction comes from `<html dir>`, which `LocaleProvider` sets. Components never branch on direction in code.

**Layout rules (AC-4).**

| Instead of | Use |
|---|---|
| `ml-*`, `mr-*`, `pl-*`, `pr-*` | `ms-*`, `me-*`, `ps-*`, `pe-*` |
| `left-*`, `right-*` | `inset-s-*`, `inset-e-*` |
| `border-l`, `border-r` | `border-s`, `border-e` |
| `rounded-l-*`, `rounded-tr-*`, … | `rounded-s-*`, `rounded-se-*`, … |
| `text-left`, `text-right`, `float-left`, `clear-right` | `text-start`, `text-end`, `float-start`, `clear-end` |
| CSS `margin-left`, `padding-right`, `left`, `border-left`, `text-align: left` | `margin-inline-start`, `padding-inline-end`, `inset-inline-start`, `border-inline-start`, `text-align: start` |
| `style={{ marginLeft: … }}` | `style={{ marginInlineStart: … }}` |

- Block-axis and sizing properties (`top`, `bottom`, `mt-*`, `pb-*`, `w-*`, `h-*`, `width`, `height`) are allowed, because they don't depend on text direction in horizontal writing.
- **ESLint** (`reactUi()`): `better-tailwindcss/enforce-logical-properties` flags and auto-fixes physical classes. `no-restricted-classes` flags directional utilities with no logical form: unpaired `translate-x-*`, `bg-left*`, `origin-*left/right` and `bg-linear-to-l/r…`. `ralysa/no-physical-inline-style` flags physical `style` keys. Class strings are checked in `className`, `class`, and calls to `cn`, `clsx`, `cva` and `tv` (`packages/ui` uses `cn` from `src/lib/cn.ts`).
- **Stylelint** (`@ralysa/stylelint-config`): `stylelint-plugin-logical-css` flags inline-axis physical properties and `left`/`right` keywords. A disallowed-value list catches what the plugin can't see: 4-value `margin`, `padding`, `inset` and `border-*` shorthands whose 2nd and 4th values differ; uneven `border-radius`; `background-position` and `transform-origin` with `left`/`right`; and a horizontal `translate`.
- **Horizontal offsets.** A directional utility needs its mirrored partner in the same class list: `ltr:translate-x-2 rtl:-translate-x-2` (`ralysa/no-unpaired-direction-variant`). In CSS, multiply by the sign: `translate: calc(var(--ralysa-dir-sign) * 1rem) 0`.
- **Escape hatch.** `eslint-disable-next-line <rule> -- <reason>` or `stylelint-disable-next-line <rule> -- <reason>`. A disable without a reason fails the lint, so every exception is visible in review.

**Mirroring.**

- Build regions with flex or grid in DOM reading order. `dir="rtl"` then places inline-start regions on the right with no extra rule. `AppShell` renders `header`, `nav` (inline-start), `main` and `aside` (inline-end) this way.
- Directional icons mirror through the registry (see [Icons](#icons)). Non-directional icons never mirror.
- Progress and slider fills follow `dir`.
- Media (images, video, charts) are **not** mirrored.
- Keyboard order follows the DOM, so in `ar` Tab moves right to left. Radix arrow keys follow the direction that `LocaleProvider` feeds to `DirectionProvider`: in `ar`, ArrowLeft moves forward.

**Bidi: LTR islands and isolation (AC-7, AC-8).**

- `<Code>` renders `<code dir="ltr">` and `<CodeBlock>` renders `<pre dir="ltr">`, which wraps rather than scrolls. `<Ltr>` renders `<bdi dir="ltr" data-ltr>`. All three are `translate="no"`. Use them for file paths, identifiers, URLs, command lines and version strings.
- `<T i18nKey values>` renders a translation with each interpolated value in its own `<bdi>`, so a Latin file name in an Arabic sentence can't reorder the text around it. For plain-text attributes (`aria-label`, `title`) use `t(key, isolateValues(values))`, which wraps each value in FSI…PDI (U+2068…U+2069).
- Give an inline span in another language its own `lang` (WCAG 3.1.2).
- Locale-aware digits and date formats are out of scope for now (REQ-107, F-021). Text renders digits as written.

**Typography.** `@ralysa/ui/fonts.css` self-hosts Noto Sans, Noto Sans Arabic and Noto Sans Mono (variable) from the `@fontsource-variable/*` packages. The `font.family.sans` stack takes Latin glyphs from Noto Sans and falls through to Noto Sans Arabic for Arabic, so mixed runs are consistent. Under `:lang(ar)` the body line height is 1.7 and letter spacing is 0, because tracking breaks cursive joining. There is **no font CDN**: the app's Vite build must add the `fontLicenses()` plugin from `@ralysa/ui/font-licenses`, which bundles the woff2 files, writes each `OFL.txt` and `THIRD_PARTY_NOTICES` into `dist/`, never inlines a font as a data URI, and fails the build for a font file from an unreviewed package.

## i18n keys

**Runtime.** i18next with react-i18next. Each app creates one instance with `createI18n({ catalogs, locale, defaultNS, mode })` and wraps the tree in `LocaleProvider`. `en` is the source locale and is bundled. `ar` is loaded by a dynamic import the first time it's used. There is no HTTP backend and no cloud service. `resolveInitialLocale()` reads `?lang=`, then `localStorage` `ralysa.locale`, then `navigator.languages`, then falls back to `en`. Switching locale re-renders and never reloads the page. `LocaleProvider` sets `<html lang dir>`. `mode: 'test'` (ui-lab, unit tests) throws `MissingKeyError` on a missing key and turns off the `en` fallback. Production apps use the default `mode: 'production'`.

**Namespaces and catalogs.** The locales are `en` and `ar`. The namespaces are `ui` (design system), `web` (`apps/web`) and `lab` (`apps/ui-lab`). Catalogs live at `<workspace>/locales/<locale>/<ns>.json`, or under `src/locales/` in `packages/ui` so that the library build emits them. Components call `useTranslation('ui')` explicitly. An app's own namespace is its `defaultNS`.

**Key grammar** (`KEY_RE` in `packages/ui/src/contracts/i18n.ts`): 2 to 5 lowerCamel segments separated by dots, such as `textField.error.required` or `appShell.nav.label`. Refer to a key as `ns:key`, as in `t('ui:textField.error.required')`. Plural keys add a CLDR suffix: `en` needs `_one` and `_other`, and `ar` needs all six categories (`_zero`, `_one`, `_two`, `_few`, `_many`, `_other`).

**Adding a string:**

1. Use the key in code: `t('web:area.element')`, `<T i18nKey="…" values={…} />`, or a component's `labelKey` prop.
2. Add it to `en` **and** `ar` in the same namespace, with the same `{{interpolation}}` names.
3. Add the `ar` key to the workspace's `review.json` as `"needs-native-review"`. It becomes `{ "reviewer": "<name>", "date": "YYYY-MM-DD" }` once a native Arabic speaker approves it (OQ-D8). Machine-assisted Arabic is marked as such in the PR.
4. Run the workspace's `check:generated` to refresh the typed keys in `src/i18n/generated/`, and commit them. A key that doesn't exist is then a type error.

**What fails (AC-5, AC-6):**

- `i18next/no-literal-string` (JSX-only mode) on JSX text and string children. Only strings with no letters are exempt.
- `ralysa/no-literal-attribute-text` on literal text in `aria-label`, `aria-description`, `aria-roledescription`, `aria-placeholder`, `aria-valuetext`, `title`, `alt`, `placeholder` and `label` on any element, and in `value` on submit, reset and button inputs.
- `i18next-cli extract --ci --dry-run` in each UI workspace's `lint`, on a key used in code that is missing from the `en` catalog.
- `check-i18n` (in `pnpm repo:check`) on:
  - locale folders other than exactly `en` and `ar`, or a missing namespace file
  - different key sets between locales (allowing for plurals)
  - a key that breaks the grammar, or an empty value
  - different interpolation names between locales
  - an `ar` key missing from `review.json`, or a `review.json` entry with no key

  An `ar` value that equals its `en` value and contains Latin letters is a warning. The run prints how many strings still need native review.
- At runtime in test mode, a missing key throws. Playwright's console guard fails the test.

Test files and `e2e/**` are exempt from the literal-string rules. Demo sample text is not exempt: it lives in JSON data (`apps/ui-lab/src/samples/`), not in TSX.

## Icons

- `packages/ui/src/icons/registry.ts` is the **only** module that imports `lucide-react`. The `icon-set` group in `tooling/eslint-config/boundaries.js` bans it everywhere else, and ESLint, dependency-cruiser (`check-imports`) and `check-banned-deps` all enforce that.
- Render an icon with `<Icon name="…" size="sm|md|lg" />`. The sizes come from the `size.icon` tokens.
- Each registry entry says whether the icon is `directional`:
  - **Directional** icons are drawn for LTR and mirrored in RTL with `rtl:-scale-x-100`: `back`, `forward`, `chevronStart`, `chevronEnd`, `send`, `undo`, `redo`.
  - **Non-directional** icons never mirror: `search`, `check`, `close`, `chevronDown`, `minus`, `alert`, `info`, `lock`, `inbox`, `loading`, `language` and the three theme icons.
  - Name an icon by its meaning in reading order (`chevronEnd`, not `chevronRight`).
- `<Icon>` renders `data-icon` and `data-icon-directional`, which the E2E mirroring spec reads (TC-F-001-13).
- An icon is decorative (`aria-hidden`) unless it gets a translated `label`. An icon-only control uses `IconButton`, whose `labelKey` (a typed i18n key) is required.
- **Adding an icon:** import it in `registry.ts`, add an entry with the right `directional` flag, and use it through `<Icon>`. Unused icons are tree-shaken.

## Components

`packages/ui` has the Phase 0 set:

| Group | Components |
|---|---|
| Layout | `AppShell`, `SkipLink`, `VisuallyHidden` |
| Text | `Text`, `Heading`, `Code`, `CodeBlock`, `Ltr`, `T` |
| Actions | `Button`, `IconButton`, `Link` |
| Forms (Radix) | `TextField`, `Checkbox`, `RadioGroup`, `Select`, `Tabs` |
| States | `EmptyState`, `LoadingState`, `ErrorState`, `PermissionDenied` |
| Preferences | `LocaleSwitcher`, `ThemeSwitcher`, `LocaleProvider`, `ThemeProvider` |

Use these rather than new primitives, and use the four state components for every data view's empty, loading, error and denied states. A new component follows the same rules: translated text or a typed key as props, semantic token classes, logical layout, and `focus-visible:focus-ring`. It also gets a `*.examples.tsx` registered in `ALL_EXAMPLES` (`@ralysa/ui/examples`). Examples hold no text of their own: the gallery passes `labels` from ui-lab's `lab` catalog. The ui-lab gallery then scans every example with axe in `en` and `ar`, light and dark (AC-10).

## Dependencies

**What the UI stack uses.** Versions come from the `catalog:` in `pnpm-workspace.yaml` or are pinned exactly in the workspace:

| Need | Package |
|---|---|
| UI runtime | `react`, `react-dom` (`packages/ui` has React as a peer) |
| Accessible primitives | `radix-ui`, `@radix-ui/react-direction` |
| i18n | `i18next`, `react-i18next`; `i18next-cli` (dev, offline extract and types) |
| Icons | `lucide-react`, pinned exactly and imported only by the registry |
| Fonts | `@fontsource-variable/noto-sans`, `-noto-sans-arabic`, `-noto-sans-mono`, pinned exactly and licence-checked (`FONT_PACKAGES` in `packages/ui/scripts/font-licenses.ts`) |
| Styling | `tailwindcss`, `@tailwindcss/vite` |
| Build and test | `vite`, `@vitejs/plugin-react`, `vitest`, `jsdom`, `@playwright/test`, `@axe-core/playwright` |

**Not allowed in UI code:**

- Vendor telemetry and analytics SDKs (`telemetry-vendor` group, ADR-0024)
- Model-provider SDKs and the Agent SDK (SR-03, ADR-0012)
- Model-provider API hostnames in source (`check-provider-hosts`)
- Font CDNs, remote i18n backends and any other runtime fetch of assets from a third party (residency, air-gapped installs)
- `apps/ui-lab` as a dependency of anything (AC-13)

The ban lists are in `tooling/eslint-config/boundaries.js`, and ESLint, dependency-cruiser and `check-banned-deps` enforce them.

**Adding a dependency:**

1. Check whether the existing set already covers the need. Prefer a small in-house helper over a new package for something a few lines can do: the token generator, `cn()` and the contrast check are in-house for this reason.
2. Choose the latest patch of a release line that has been generally available for at least 30 days (design §2.2). pnpm's `minimumReleaseAge` (3 days) holds back anything younger.
3. Use a registry version, `catalog:` or `workspace:*` only. `npm:`, `file:`, `link:`, git and tarball specifiers fail `check-workspaces`. If more than one workspace needs the package, add it to the catalog.
4. If the package wants to run an install script, `strictDepBuilds` fails the install. A reviewed `allowBuilds` entry needs a matching entry in `tooling/repo-scripts/allow-builds.json`.
5. In the PR, record the new-dependency review: the maintainer, known advisories, the licence (and for a font, the licence and Reserved Font Name check in `font-licenses.ts`), and install scripts (RF-6). The code-reviewer agent's checklist carries the same items once the T18 proposal to `.claude/agents/code-reviewer.md` is merged (a human merge). `pnpm-lock.yaml` is a CODEOWNERS path, so every dependency change is a protected-path change.

`docs/engineering/repo-conventions.md` ("Dependencies") has the full supply-chain settings.

## Visual and shaping snapshots

The E2E harness lives in `apps/ui-lab/e2e/` and runs against `vite preview` of the **production builds** of ui-lab and `apps/web`. CI runs it in the `ui-e2e` job inside a pinned Playwright image.

| Spec | Baselines | What |
|---|---|---|
| `visual.spec.ts` (TC-F-001-18, AC-9), chromium | 8 | Full-page showcase in `en`/`ar` × light/dark at 1280×800 and 360×740 |
| `shaping.spec.ts` (TC-F-001-15, AC-8), chromium, firefox, webkit | 60 | `document.fonts.check()` for Noto Sans Arabic, then each of the 20 Arabic samples on its own, per engine |

- Baselines are in `apps/ui-lab/e2e/__screenshots__/<engine>/` (`snapshotPathTemplate: '{testDir}/__screenshots__/{projectName}/{arg}{ext}'`). The comparison uses `maxDiffPixelRatio` 0.001 and `threshold` 0.2.
- `updateSnapshots: 'none'`: a missing baseline fails the run. **CI never writes baselines**, because committing them from CI would need `contents: write` on PR runs (RF-2).

**Updating baselines (`e2e:update`):**

```sh
pnpm --filter @ralysa/ui-lab e2e:update                                    # visual and shaping specs
pnpm --filter @ralysa/ui-lab e2e:update -- e2e/visual.spec.ts --grep "ar dark"
```

- `scripts/e2e-update.sh` runs `scripts/e2e-container.sh` with `--update-snapshots=changed`, `E2E_WRITE_SNAPSHOTS=1` and `E2E_PLATFORM=linux/amd64`. Only changed or missing baselines are written. You need Docker.
- The container uses the **same image digest** as the CI `ui-e2e` job. `check-ci-invariants` (`ci/playwright-digest`) fails when the two differ, so bump them together. The container copies in the files git knows about, installs with the frozen lockfile, builds both apps and runs Playwright. Nothing from the host's `node_modules` or `dist/` is used.
- Baselines must come from CI's platform. On Apple silicon amd64 is emulated, which is slower but gives identical output. `E2E_PLATFORM=linux/arm64` is quicker for a plain `e2e:container` run, but it refuses to write snapshots.
- Commit the PNGs. **The reviewer approves the image diff in the PR** (design §5.4). The Arabic baselines render placeholder strings that still need a native speaker's review (OQ-D8): approving a baseline approves the rendering, not the wording.

To run the whole harness locally in CI's image, use `pnpm --filter @ralysa/ui-lab e2e:container [-- <playwright args>]`. To run it on the host, use `pnpm --filter @ralysa/ui-lab e2e` after building `apps/ui-lab` and `apps/web`. The other specs cover axe (TC-F-001-20), the keyboard walker (TC-F-001-24), the locale switch (TC-F-001-11), mirroring (TC-F-001-13) and no demo content in `apps/web` (TC-F-001-28). The table is in `apps/ui-lab/README.md`.

## Accessibility

WCAG 2.1 AA is a requirement. `jsx-a11y` (strict) runs in the lint as an early signal. The authoritative gates are runtime: axe in `en`/`ar` × light/dark with 0 serious or critical findings (AC-10), and the keyboard walker (AC-12), which checks that every focusable element is reached once in reading order with a ring of at least 2 px and at least 3:1. Don't use a positive `tabindex`. Don't remove an outline without a replacement ring (Stylelint fails it). Only modal patterns trap focus, and they close on Escape and return focus to the trigger.
