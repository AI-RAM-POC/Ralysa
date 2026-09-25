# web

Vite SPA: /ide, /me, /dept, /admin

**Status (F-001-T03):** a minimal Vite + React shell with no end-user screens. It renders an empty `main` landmark, and T08 adds the one i18n'd heading. It is the production-build target for the F-001 artefact checks (AC-2, AC-13): `ralysa.shipped: true`, artefacts `dist/`.

```sh
pnpm --filter @ralysa/web dev       # local dev server
pnpm --filter @ralysa/web build     # production bundle in dist/
```

There are no environment variables or runtime configuration yet.
