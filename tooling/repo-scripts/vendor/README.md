# Vendored files

| File | What | Pinned by |
|---|---|---|
| `gitleaks-8.30.1-default.toml` | gitleaks' own `config/gitleaks.toml` at tag `v8.30.1`, byte for byte (git blob `256f64790ea6d954f0041024be2938089ae1e7a7`, checked with the GitHub contents API on 2026-09-25). | sha256 in `SHA256SUMS` and `VENDORED_DEFAULT_SHA256` in `src/check-gitleaks-config.ts` |

`.gitleaks.artefacts.toml` copies high-value rules from it instead of inheriting the whole default (and its global allow-list) through `[extend]` (F-001 T05-1). `check-gitleaks-config` and `test/gitleaks-default-sync.test.ts` compare each copied rule with this file, so a gitleaks upgrade that changes a rule shows up as drift. Never edit it by hand: replace it with the new tag's file and update both sha256 records.
