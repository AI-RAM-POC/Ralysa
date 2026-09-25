# web

Vite SPA: /ide, /me, /dept, /admin

**Status (F-001-T08):** a minimal Vite + React shell with no end-user screens. It renders a `main` landmark with one heading, the app name from the `web` catalog (`web:app.name`). `main.tsx` imports `@ralysa/ui/tokens.css`, creates the i18n instance (`ui` and `web` catalogs; initial locale from `?lang=`, `localStorage` `ralysa.locale`, `navigator.languages`, then `en`) and wraps the app in `LocaleProvider` (sets `<html lang dir>`) and `ThemeProvider` (`?theme=`, `localStorage` `ralysa.theme`). It is the production-build target for the F-001 artefact checks (AC-2, AC-13): `ralysa.shipped: true`, artefacts `dist/`.

```sh
pnpm --filter @ralysa/web dev       # local dev server (try ?lang=ar and ?theme=dark)
pnpm --filter @ralysa/web build     # production bundle in dist/; the ar catalogs are separate chunks
```

- Catalogs: `locales/{en,ar}/web.json`. Native-review status: `locales/review.json`. The Arabic app name is a placeholder transliteration (`needs-native-review`, OQ-D8, OQ-F001-1).
- `i18next.config.ts`: `lint` runs `i18next-cli extract --ci --dry-run`; `check:generated` runs `i18next-cli types`. The types include the `ui` namespace, so `t('ui:…')` is typed here too. The generated files in `src/i18n/generated/` are committed.
- ESLint lints Tailwind classes against `@ralysa/ui/tailwind.css`.

There are no environment variables or runtime configuration.
