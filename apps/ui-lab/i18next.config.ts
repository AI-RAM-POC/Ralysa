// i18next-cli (F-001 design §7.4.4, §7.4.5). Used offline only: `extract --ci --dry-run` in lint,
// `types` in check:generated. The `ui` namespace belongs to @ralysa/ui: extract never writes it
// here, and the types read it from the ui package so `t('ui:…')` is typed too.
import { defineConfig } from 'i18next-cli';

export default defineConfig({
  locales: ['en', 'ar'],
  extract: {
    input: ['src/**/*.{ts,tsx}'],
    ignore: ['src/**/*.test.{ts,tsx}', 'src/**/*.d.ts'],
    output: 'locales/{{language}}/{{namespace}}.json',
    primaryLanguage: 'en',
    defaultNS: 'lab',
    nsSeparator: ':',
    keySeparator: '.',
    functions: ['t', '*.t'],
    transComponents: ['Trans', 'T'],
    useTranslationNames: ['useTranslation'],
    ignoreNamespaces: ['ui'],
    removeUnusedKeys: false,
    extractFromComments: false,
    sort: true,
    indentation: 2,
  },
  types: {
    input: ['locales/en/*.json', '../../packages/ui/src/locales/en/*.json'],
    output: 'src/i18n/generated/i18next.d.ts',
    resourcesFile: 'src/i18n/generated/resources.d.ts',
  },
});
