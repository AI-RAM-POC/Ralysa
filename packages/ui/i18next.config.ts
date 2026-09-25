// i18next-cli (F-001 design §7.4.4, §7.4.5). Used offline only: `extract --ci --dry-run` in lint
// (fails when code uses a key missing from the catalogs), `types` in check:generated (typed keys).
// The Locize commands are never used.
import { defineConfig } from 'i18next-cli';

export default defineConfig({
  locales: ['en', 'ar'],
  extract: {
    input: ['src/**/*.{ts,tsx}'],
    ignore: ['src/**/*.test.{ts,tsx}', 'src/**/*.d.ts'],
    output: 'src/locales/{{language}}/{{namespace}}.json',
    primaryLanguage: 'en',
    defaultNS: 'ui',
    nsSeparator: ':',
    keySeparator: '.',
    functions: ['t', '*.t'],
    transComponents: ['Trans', 'T'],
    useTranslationNames: ['useTranslation'],
    // Keep keys the code can't show statically; a new key missing from a catalog still fails.
    removeUnusedKeys: false,
    extractFromComments: false,
    sort: true,
    indentation: 2,
  },
  types: {
    input: ['src/locales/en/*.json'],
    output: 'src/i18n/generated/i18next.d.ts',
    resourcesFile: 'src/i18n/generated/resources.d.ts',
  },
});
