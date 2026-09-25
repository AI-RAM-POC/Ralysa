# ui-lab

`@ralysa/ui-lab`: the **internal** design-system demo app (F-001 design §7.6). It is never shipped: `ralysa.shipped: false`, no artefacts, no Dockerfile, nothing in `deploy/` references it, and nothing may depend on it (boundaries.js, dependency-cruiser and `check-banned-deps`; AC-13). Created with `pnpm scaffold apps/ui-lab --kind app`.

## Views

Query parameters, no router dependency (`src/router.ts`). Every link keeps `lang` and `theme`.

| URL | Shows |
|---|---|
| `/?view=showcase` (default) | The demo screen: `AppShell` with the locale and theme switchers in the header, `nav` (inline-start), `main` and `aside` (inline-end); a request form (TextField, Select, RadioGroup, Checkbox, submit and cancel); the directional and non-directional icon strips (`data-icon-strip`); the **20-string Arabic sample panel** (`data-sample-id`, each `lang="ar" dir="rtl"`); code, paths and identifiers as LTR islands; the four state patterns. |
| `/?view=components[&c=<Component>]` | Every example from `@ralysa/ui/examples` (`data-component`, `data-example="<Component>/<id>"`), or one component's. |
| `/?view=tokens` | Every semantic colour token with its live value and contrast against the canvas colour (the same WCAG function as `check-contrast`). |
| `&lang=en\|ar`, `&theme=light\|dark\|system` | The start-up locale and theme (`resolveInitialLocale`, `resolveInitialTheme`). |

i18n runs in **test mode** in every build of this app, so a missing key throws instead of falling back to English. The E2E harness (T13) relies on it.

## Demo data and the sentinel

- `src/samples/arabic-samples.json`: the 20 synthetic Arabic samples (8 pure, 6 mixed Arabic/English, 3 with Western digits, 3 with Arabic-Indic digits, one of them Extended). `src/samples/example-data.json`: synthetic code, paths, identifiers, a placeholder address and a reference id. No real names, IDs or customer text.
- Both files carry `"__RALYSA_DEMO_ONLY__": true`, the app root carries `data-demo-sentinel="__RALYSA_DEMO_ONLY__"`, and `index.html` a `ralysa-demo` meta tag.
- **`check-no-demo`** (`node tooling/repo-scripts/src/cli.ts check-no-demo`, in the CI `quality` job after the build) searches every shipped build for the sentinel and every sample string, and uses this app's `dist/` as the positive control. Build both apps first.

## i18n

- `locales/{en,ar}/lab.json`: the `lab` namespace, including `examples.*`, the labels `@ralysa/ui`'s component examples render. `test/App.test.tsx` checks that the catalog has exactly the translatable `EXAMPLE_LABELS`.
- `locales/review.json`: every Arabic string is `needs-native-review` (OQ-D8).
- `i18next.config.ts`: `lint` runs `extract --ci --dry-run`; `check:generated` writes the typed keys in `src/i18n/generated/`.

## Scripts

| Script | Does |
|---|---|
| `dev` / `build` / `preview` | Vite with `@tailwindcss/vite` (scanning this app and `packages/ui/src`, `src/styles.css`) and `fontLicenses()` |
| `lint` | ESLint (`base`, `react-ui` against `@ralysa/ui/tailwind.css`, `tests`), Stylelint and `i18next-cli extract --ci` |
| `test` | Vitest (jsdom): every view in en and ar, the router, the example labels, the sample set and **TC-F-001-14** for the samples (0 missing glyphs in the bundled fonts) |
| `typecheck`, `check:generated` | `tsc`; i18n key types |

There are no environment variables or runtime configuration.
