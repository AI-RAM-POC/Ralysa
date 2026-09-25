// The `ui` namespace catalog (F-001 design §7.4.3): en bundled, other locales loaded on first use.
// The files live under src/ so the library build (rootDir src) emits them next to this module.
import type { SecondaryLocale } from '../contracts/i18n.js';
import type { Catalog, NamespaceCatalog } from './createI18n.js';
import en from '../locales/en/ui.json';

// One loader per secondary locale; the Record type makes a new locale a compile error here.
const loaders: Record<SecondaryLocale, () => Promise<Catalog>> = {
  ar: async () => (await import('../locales/ar/ui.json')).default,
};

export const uiCatalog: NamespaceCatalog = {
  namespace: 'ui',
  source: en,
  load: (locale) => loaders[locale](),
};
