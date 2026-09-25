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
| `typecheck`, `check:generated` | `tsc` (source, tests, `e2e/`); i18n key types |
| `e2e` | Playwright (`playwright.config.ts`) against `vite preview` of the **production builds** of ui-lab (port 4173) and `apps/web` (port 4174). Build both first. CI runs it in the `ui-e2e` job, inside the pinned Playwright image |
| `e2e:update` | `scripts/e2e-update.sh`: rewrites the changed or missing **visual and shaping baselines** (`e2e/__screenshots__/`) by running `e2e:container` on linux/amd64 (CI's platform; emulated on Apple silicon). Default specs `e2e/visual.spec.ts e2e/shaping.spec.ts`; pass others as arguments. Commit the PNGs; the reviewer approves the image diff. CI never writes baselines (§5.4) |
| `e2e:container` | `scripts/e2e-container.sh`: the same run inside the **same pinned image** as CI (Docker required). Copies the files git knows about into the container, installs with the frozen lockfile, builds and runs Playwright; the HTML report comes back to `playwright-report/`. Extra arguments go to Playwright: `pnpm --filter @ralysa/ui-lab e2e:container -- --project=chromium e2e/locale.spec.ts` |

The app itself has no environment variables or runtime configuration.

## End-to-end harness (`e2e/`, F-001-T13)

| Spec | Test case | Checks |
|---|---|---|
| `a11y.spec.ts` | TC-F-001-20 (AC-10) | axe (WCAG 2.0/2.1 A and AA) on the showcase, the whole component gallery and the tokens view, in en and ar, light and dark: 0 serious or critical. Every violation is attached as JSON |
| `a11y-selftest.spec.ts` | TC-F-001-21 | A fixture with an unlabelled image and button fails the same assertion; the fixed page passes |
| `keyboard.spec.ts` | TC-F-001-24 (AC-12), chromium and firefox | The keyboard walker: every visible focusable element reached once in DOM order, the edge of the page reached, Tab follows the reading direction (right-to-left in ar), every focus ring ≥ 2 px and ≥ 3:1; Shift+Tab reverses; Select (Enter, Space, Escape returns focus, typeahead), Checkbox (Space), RadioGroup (arrows follow the direction), buttons (Enter, Space) |
| `locale.spec.ts` | TC-F-001-11 (AC-6) | The LocaleSwitcher changes `html[lang]`, `html[dir]` and the strings with no reload (a `window` marker survives, history and navigation entries unchanged) |
| `mirroring.spec.ts` | TC-F-001-13 (AC-7) | Region order per direction; directional icons `scale: -1 1` in ar only; code, pre and `[data-ltr]` stay `ltr` |
| `no-demo-in-web.spec.ts` | TC-F-001-28 (AC-13) | The `apps/web` preview at `/ui-lab`, `/demo`, `/__demo`, `?view=showcase`, `?view=components` has no sentinel, sample text or ui-lab hook |
| `visual.spec.ts` | TC-F-001-18 (AC-9), chromium | Full-page showcase in en/ar × light/dark at 1280×800 and 360×740 (8 baselines), `maxDiffPixelRatio` 0.001, `threshold` 0.2 |
| `shaping.spec.ts` | TC-F-001-15 (AC-8), chromium, firefox, webkit | `document.fonts.check()` for Noto Sans Arabic, then each of the 20 samples alone, with baselines per engine (60) |
| `harness-selftest.spec.ts` | (harness) | The walker catches a focus trap, a Tab order against the reading direction and missing or faint rings; the console guard fails a test on an uncaught error |

Every spec uses `e2e/helpers/fixtures.ts`, whose automatic **console guard** fails a test on any console error or uncaught exception. i18n runs in test mode here, so that is also the runtime missing-key check (TC-F-001-12). `e2e/global-setup.ts` stops the run when Node doesn't satisfy `engines.node` (AR-4 b) or a build is missing.

| Variable (e2e:container only) | Default | Effect |
|---|---|---|
| `E2E_PLATFORM` | `linux/amd64` | Docker platform. CI runs amd64; on Apple silicon `linux/arm64` runs natively and is quicker, but snapshots can't be written from it |
| `E2E_WRITE_SNAPSHOTS` | `0` | `1` copies `e2e/__screenshots__/` back to the working tree (`e2e:update` sets it) |

**Baselines** (`e2e/__screenshots__/<engine>/`): a missing one fails the run (`updateSnapshots: 'none'`). The Arabic baselines render machine-assisted placeholder strings that still need a native speaker's review (OQ-D8); approving a baseline approves the rendering, not the wording.

The image digest in `scripts/e2e-container.sh` must equal the `ui-e2e` job's; `check-ci-invariants` (`ci/playwright-digest`) fails otherwise. Bump both together.
